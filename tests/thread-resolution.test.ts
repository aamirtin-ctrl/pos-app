// Thread-resolution awareness (owner spec 2026-08-05 #3): something resolved IN the
// message chain must not live on as an open task/commitment.
//   1. threadResolves — the conservative deterministic keyword check.
//   2. resolveFromThreads — the post-hoc layer: open commitments closed by NEW
//      messages (fast-tier LLM when available, deterministic single-commitment
//      fallback otherwise), linked tasks closed alongside.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import type { SecretStore } from "../main/secrets.ts";
import { threadResolves } from "../main/crm/commitments.ts";
import { resolveFromThreads } from "../main/workers.ts";

// isGoogleConnected() only calls .get("GOOGLE_OAUTH_TOKENS") — null = not connected,
// so closeGoogleTask short-circuits without touching the network.
const noGoogle = { get: () => null } as unknown as SecretStore;

describe("threadResolves (pure, conservative)", () => {
  it("fulfillment phrases in later messages resolve the obligation", () => {
    expect(threadResolves("Send Sarah the pitch deck", ["sent it!"])).toBe(true);
    expect(threadResolves("Send Sarah the pitch deck", ["just sent it over"])).toBe(true);
    expect(threadResolves("Send Cory the packing list", ["here you go"])).toBe(true);
    expect(threadResolves("Pick up the game tickets", ["got them, thanks"])).toBe(true);
    expect(threadResolves("Fix the login bug for Dev", ["done"])).toBe(true); // bare "done" message
    expect(threadResolves("Upload the health plan", ["just did it"])).toBe(true);
  });

  it("cancellation phrases resolve it too — from either side", () => {
    expect(threadResolves("Grab the tickets for Omar", ["nvm don't worry about it"])).toBe(true);
    expect(threadResolves("Send the wifi password", ["never mind, figured it out"])).toBe(true);
    expect(threadResolves("Book the flight for mom", ["all set, took care of it"])).toBe(true);
  });

  it("unrelated later chatter resolves nothing", () => {
    expect(
      threadResolves("Send Sarah the pitch deck", ["lol that was wild", "see you at the game", "haha"])
    ).toBe(false);
    expect(threadResolves("Send Sarah the pitch deck", [])).toBe(false);
  });

  it("a later message with a NEW ask never resolves (the thread stays open)", () => {
    expect(threadResolves("Send Sarah the pitch deck", ["sent it! also can you review the memo?"])).toBe(false);
    expect(threadResolves("Send Sarah the pitch deck", ["did you send it?"])).toBe(false);
    expect(threadResolves("Send Sarah the pitch deck", ["when you're done can you ping me"])).toBe(false);
  });

  it("promises and negated/deferred 'done' are not completion reports", () => {
    expect(threadResolves("Send Omar the contract", ["got it, will send tomorrow"])).toBe(false);
    expect(threadResolves("Send Omar the contract", ["it's not done yet"])).toBe(false);
    expect(threadResolves("Send Omar the contract", ["almost done with it"])).toBe(false);
  });

  it("empty commitment text or malformed input resolves nothing", () => {
    expect(threadResolves("", ["sent it!"])).toBe(false);
    expect(threadResolves("   ", ["done"])).toBe(false);
  });
});

// ── resolveFromThreads: post-hoc round-trip on a seeded DB ───────────────────

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-threadres-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hourAgo = new Date(Date.now() - 3_600_000).toISOString();

function addInteraction(body: string, opts: { personId?: number; direction?: string; occurredAt?: string } = {}): number {
  const r = db
    .prepare(
      "INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id) VALUES (?, 'imessage', ?, ?, NULL, ?, ?)"
    )
    .run(opts.personId ?? 1, opts.direction ?? "outbound", opts.occurredAt ?? hourAgo, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

function addCommitment(description: string, opts: { personId?: number; status?: string; dueAt?: string | null } = {}): number {
  const r = db
    .prepare(
      "INSERT INTO commitment (person_id, direction, description, due_at, status, confidence, confirmed_by_user) VALUES (?, 'i_owe_them', ?, ?, ?, 0.9, 1)"
    )
    .run(opts.personId ?? 1, description, opts.dueAt ?? null, opts.status ?? "open");
  return Number(r.lastInsertRowid);
}

function addTask(commitmentId: number, opts: { status?: string; gtasksId?: string | null } = {}): number {
  const r = db
    .prepare(
      "INSERT INTO task (title, block_type, commitment_id, status, gtasks_id) VALUES ('t', 'admin', ?, ?, ?)"
    )
    .run(commitmentId, opts.status ?? "inbox", opts.gtasksId ?? null);
  return Number(r.lastInsertRowid);
}

const commitmentRow = (id: number) =>
  db.prepare("SELECT status, resolved_at FROM commitment WHERE id = ?").get(id) as {
    status: string;
    resolved_at: string | null;
  };
const taskRow = (id: number) =>
  db.prepare("SELECT status, completed_at FROM task WHERE id = ?").get(id) as {
    status: string;
    completed_at: string | null;
  };

/** Fake LlmClient: hands the prompt to `handler`, returns its value as strict JSON. */
function fakeLlm(handler: (prompt: string) => unknown): LlmClient {
  return {
    call: async (_feature: string, _tier: string, prompt: string) => ({
      text: JSON.stringify(handler(prompt)),
      model: "fake",
      inputTokens: 0,
      outputTokens: 0,
    }),
  } as unknown as LlmClient;
}

describe("resolveFromThreads (LLM path)", () => {
  it("round-trip: a resolving message closes the commitment AND its open task", async () => {
    const cid = addCommitment("Send Cory the pitch deck", { status: "scheduled" });
    const tid = addTask(cid, { status: "planned", gtasksId: "g-1" });
    const iid = addInteraction("sent it!");

    let seenPrompt = "";
    const llm = fakeLlm((prompt) => {
      seenPrompt = prompt;
      return [{ id: cid, resolved: true, reason: "user sent the deck" }];
    });

    const res = await resolveFromThreads(db, noGoogle, llm, [iid]);
    expect(res).toMatchObject({ resolved: 1, tasksClosed: 1, peopleChecked: 1 });

    // The prompt carried the open commitment (id + description) and the new message.
    expect(seenPrompt).toContain(`id ${cid}: Send Cory the pitch deck`);
    expect(seenPrompt).toContain("sent it!");
    expect(seenPrompt).toContain("Cory Levy");
    expect(seenPrompt).toContain("STRICT JSON");

    const c = commitmentRow(cid);
    expect(c.status).toBe("done");
    expect(c.resolved_at).toBeTruthy();
    const t = taskRow(tid);
    expect(t.status).toBe("done");
    expect(t.completed_at).toBeTruthy();
  });

  it("unsure (omitted / resolved:false / unknown id) leaves everything untouched", async () => {
    const cid = addCommitment("Send Cory the pitch deck");
    const tid = addTask(cid);
    const iid = addInteraction("interesting, let me think about it");

    const llm = fakeLlm(() => [
      { id: cid, resolved: false, reason: "not clearly resolved" },
      { id: 99_999, resolved: true, reason: "hallucinated id" },
    ]);
    const res = await resolveFromThreads(db, noGoogle, llm, [iid]);
    expect(res.resolved).toBe(0);
    expect(res.tasksClosed).toBe(0);

    expect(commitmentRow(cid)).toEqual({ status: "open", resolved_at: null });
    expect(taskRow(tid).status).toBe("inbox");
  });

  it("already-done tasks are not touched again; only open ones close", async () => {
    const cid = addCommitment("Send Cory the pitch deck", { status: "scheduled" });
    const doneTask = addTask(cid, { status: "done" });
    const openTask = addTask(cid, { status: "inbox" });
    const iid = addInteraction("sent it!");

    const llm = fakeLlm(() => [{ id: cid, resolved: true, reason: "sent" }]);
    const res = await resolveFromThreads(db, noGoogle, llm, [iid]);
    expect(res.tasksClosed).toBe(1);
    expect(taskRow(openTask).status).toBe("done");
    // The pre-existing done task keeps its (null) completed_at — untouched.
    expect(taskRow(doneTask).completed_at).toBeNull();
  });

  it("a person with NO open commitments costs zero LLM calls", async () => {
    addCommitment("Old thing", { status: "done" });
    addCommitment("Dropped thing", { status: "dropped" });
    const iid = addInteraction("sent it!");

    let calls = 0;
    const llm = fakeLlm(() => {
      calls++;
      return [];
    });
    const res = await resolveFromThreads(db, noGoogle, llm, [iid]);
    expect(calls).toBe(0);
    expect(res).toEqual({ resolved: 0, tasksClosed: 0, peopleChecked: 0 });
  });

  it("empty interaction list is a no-op", async () => {
    addCommitment("Send Cory the pitch deck");
    const llm = fakeLlm(() => {
      throw new Error("must not be called");
    });
    expect(await resolveFromThreads(db, noGoogle, llm, [])).toEqual({
      resolved: 0,
      tasksClosed: 0,
      peopleChecked: 0,
    });
  });
});

describe("resolveFromThreads (llm = null → deterministic path)", () => {
  it("a single open commitment + a clear resolving message → done, task done", async () => {
    const cid = addCommitment("Send Cory the pitch deck", { status: "scheduled" });
    const tid = addTask(cid, { status: "planned" });
    const iid = addInteraction("sent it!");

    const res = await resolveFromThreads(db, noGoogle, null, [iid]);
    expect(res).toMatchObject({ resolved: 1, tasksClosed: 1 });
    expect(commitmentRow(cid).status).toBe("done");
    expect(taskRow(tid).status).toBe("done");
  });

  it("a cancellation message ('nvm') closes it too", async () => {
    const cid = addCommitment("Grab the tickets for Cory");
    const iid = addInteraction("nvm don't worry about it", { direction: "inbound" });
    const res = await resolveFromThreads(db, noGoogle, null, [iid]);
    expect(res.resolved).toBe(1);
    expect(commitmentRow(cid).status).toBe("done");
  });

  it("unrelated chatter resolves nothing", async () => {
    const cid = addCommitment("Send Cory the pitch deck");
    const iid = addInteraction("lol see you at the game");
    const res = await resolveFromThreads(db, noGoogle, null, [iid]);
    expect(res.resolved).toBe(0);
    expect(commitmentRow(cid).status).toBe("open");
  });

  it("multiple open commitments = ambiguous — the keyword path resolves NOTHING", async () => {
    const a = addCommitment("Send Cory the pitch deck");
    const b = addCommitment("Bring Cory cash for the tickets");
    const iid = addInteraction("sent it!");
    const res = await resolveFromThreads(db, noGoogle, null, [iid]);
    expect(res.resolved).toBe(0);
    expect(commitmentRow(a).status).toBe("open");
    expect(commitmentRow(b).status).toBe("open");
  });
});
