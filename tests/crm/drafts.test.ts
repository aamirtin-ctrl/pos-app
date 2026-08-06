// Auto-drafting, batched (owner standing directive: never one LLM call per item).
// generateDrafts answers up to DRAFT_BATCH messages per `auto_draft` call; this suite
// covers what the batching must NOT break — the per-channel voice still governing each
// individual reply, and every degrade path leaving the message re-draftable next run
// rather than silently dropped. DB-only: the LlmClient is a fake, nothing hits the network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../../main/db/db.ts";
import type { LlmClient } from "../../main/llm/provider.ts";
import {
  DRAFT_BATCH,
  DRAFT_CONTEXT_MSGS,
  buildDraftsPrompt,
  generateDrafts,
  listDrafts,
  unansweredInbound,
  type DraftCandidate,
} from "../../main/crm/drafts.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-drafts-"));
  db = openDb(path.join(dir, "pos.db"));
  // Learned voices already on record, so synthesizeVoices never fires in these tests.
  for (const [cat, tone] of [
    ["email", "polite, concise"],
    ["text", "lowercase casual"],
  ]) {
    setSetting(
      db,
      `voice_${cat}`,
      JSON.stringify({ category: cat, tone, greeting: "", signoff: "", avgWords: 20, notes: [] })
    );
  }
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let extSeq = 0;
function addPerson(name: string, bio?: string): number {
  return Number(
    db.prepare("INSERT INTO person (display_name, bio) VALUES (?, ?)").run(name, bio ?? null).lastInsertRowid
  );
}
function addInteraction(
  personId: number,
  body: string,
  o: { channel?: string; direction?: string; minutesAgo?: number } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        personId,
        o.channel ?? "imessage",
        o.direction ?? "inbound",
        new Date(Date.now() - (o.minutesAgo ?? 60) * 60_000).toISOString(),
        body,
        `ext-${extSeq++}`
      ).lastInsertRowid
  );
}

/** Fake LlmClient: counts calls, hands each prompt to `reply`, returns strict JSON. */
function fakeLlm(reply: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const client = {
    prompts,
    call: async (_feature: string, _tier: string, prompt: string) => {
      prompts.push(prompt);
      const out = reply(prompt);
      if (out === null) return null;
      return {
        text: typeof out === "string" ? out : JSON.stringify(out),
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  return client as typeof client & LlmClient;
}

const draftBodies = () =>
  (db.prepare("SELECT body FROM draft ORDER BY id").all() as { body: string }[]).map((r) => r.body);

// ── the batch shape ──────────────────────────────────────────────────────────

describe("buildDraftsPrompt", () => {
  const item = (over: Partial<DraftCandidate> = {}): DraftCandidate => ({
    n: 1,
    id: 1,
    personId: 1,
    channel: "imessage",
    who: "Cory",
    category: "text",
    voice: { category: "text", tone: "lowercase casual", greeting: "", signoff: "", avgWords: 12, notes: ["no caps"] },
    bio: "Runs a solar startup.",
    subject: null,
    inbound: "you free thursday?",
    history: [],
    ...over,
  });

  it("carries EACH item's own voice profile inline (not one voice for the batch)", () => {
    const prompt = buildDraftsPrompt([
      item(),
      item({
        n: 2,
        channel: "gmail",
        category: "email",
        who: "Dr. Reyes",
        voice: { category: "email", tone: "formal, warm", greeting: "Hi", signoff: "Best", avgWords: 60, notes: [] },
      }),
    ]);
    expect(prompt).toContain('1. REPLY AS THE USER on imessage (text voice), to Cory');
    expect(prompt).toContain('2. REPLY AS THE USER on gmail (email voice), to Dr. Reyes');
    expect(prompt).toContain('tone "lowercase casual"');
    expect(prompt).toContain('tone "formal, warm"');
    expect(prompt.match(/VOICE:/g)).toHaveLength(2);
  });

  it("keeps the original per-message rules and asks for a strict JSON array keyed by n", () => {
    const prompt = buildDraftsPrompt([item()]);
    expect(prompt).toContain("sound exactly like the voice, not like an assistant");
    expect(prompt).toContain("propose one concrete option");
    expect(prompt).toContain("STRICT JSON ONLY");
    expect(prompt).toContain('[{ "n": <number>, "body": "<the reply text>" }]');
    expect(prompt).toContain("never merge two entries, never skip one");
  });

  it("bounds the prompt by TRUNCATING context, never by dropping an item", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      direction: "inbound",
      subject: null,
      body_summary: `old message ${i}`,
    }));
    const prompt = buildDraftsPrompt([item({ history, inbound: "x".repeat(2000) })]);
    expect(prompt).toContain("old message 0");
    expect(prompt).not.toContain(`old message ${DRAFT_CONTEXT_MSGS}`); // only the newest few
    expect(prompt).not.toContain("x".repeat(700)); // the inbound snippet is capped
  });
});

// ── generateDrafts ───────────────────────────────────────────────────────────

describe("generateDrafts", () => {
  it("writes one draft per numbered entry, in one call", async () => {
    const cory = addPerson("Cory", "Runs a solar startup.");
    const reyes = addPerson("Dr. Reyes");
    addInteraction(cory, "you free thursday?");
    addInteraction(reyes, "can you confirm the appointment?", { channel: "gmail" });

    const llm = fakeLlm(() => [
      { n: 1, body: "thursday works, 6?" },
      { n: 2, body: "Confirmed — see you then." },
    ]);
    const res = await generateDrafts(db, llm);

    expect(llm.prompts).toHaveLength(1);
    expect(res).toEqual({ drafted: 2, skipped: null });
    expect(draftBodies().sort()).toEqual(["Confirmed — see you then.", "thursday works, 6?"]);
    // Channel is carried through per item, not taken from the first message.
    expect((listDrafts(db) as { channel: string }[]).map((d) => d.channel).sort()).toEqual(["gmail", "imessage"]);
  });

  it("makes a SECOND call only when more than DRAFT_BATCH messages remain", async () => {
    for (let i = 0; i < DRAFT_BATCH + 3; i++) {
      addInteraction(addPerson(`P${i}`), `question ${i}?`);
    }
    const llm = fakeLlm((prompt) => {
      const count = (prompt.match(/REPLY AS THE USER/g) ?? []).length;
      return Array.from({ length: count }, (_, i) => ({ n: i + 1, body: `reply ${i}` }));
    });
    const res = await generateDrafts(db, llm);

    expect(llm.prompts).toHaveLength(2); // 15 messages = 2 requests, not 15
    expect(llm.prompts[0].match(/REPLY AS THE USER/g)).toHaveLength(DRAFT_BATCH);
    expect(llm.prompts[1].match(/REPLY AS THE USER/g)).toHaveLength(3);
    expect(res.drafted).toBe(DRAFT_BATCH + 3);
  });

  it("an unparseable batch reply drafts nothing — the messages stay draftable next run", async () => {
    const p = addPerson("Cory");
    addInteraction(p, "you free thursday?");

    const llm = fakeLlm(() => "sorry, I cannot help with that");
    expect(await generateDrafts(db, llm)).toEqual({ drafted: 0, skipped: null });
    expect(draftBodies()).toEqual([]);
    // Still unanswered, so the next run picks it up again (nothing was silently lost).
    expect(unansweredInbound(db)).toHaveLength(1);
  });

  it("a null response drafts nothing and leaves the batch for the next run", async () => {
    addInteraction(addPerson("Cory"), "you free thursday?");
    const llm = fakeLlm(() => null);
    expect(await generateDrafts(db, llm)).toEqual({ drafted: 0, skipped: null });
    expect(unansweredInbound(db)).toHaveLength(1);
  });

  it("a SHORT reply keeps the entries it did return and re-queues the rest", async () => {
    const a = addPerson("A");
    const b = addPerson("B");
    addInteraction(a, "question one?", { minutesAgo: 30 });
    addInteraction(b, "question two?", { minutesAgo: 60 });

    const llm = fakeLlm(() => [{ n: 1, body: "answer one" }]); // entry 2 missing
    const res = await generateDrafts(db, llm);
    expect(res.drafted).toBe(1);
    expect(draftBodies()).toEqual(["answer one"]);
    expect(unansweredInbound(db)).toHaveLength(1); // the undrafted one is still pending
  });

  it("degrades with a message (and zero calls) when there is no LLM key", async () => {
    addInteraction(addPerson("Cory"), "you free thursday?");
    const res = await generateDrafts(db, null);
    expect(res.drafted).toBe(0);
    expect(res.skipped).toMatch(/AI key/);
    expect(draftBodies()).toEqual([]);
  });

  it("costs zero calls when nothing is unanswered", async () => {
    const llm = fakeLlm(() => {
      throw new Error("must not be called");
    });
    expect(await generateDrafts(db, llm)).toEqual({ drafted: 0, skipped: null });
    expect(llm.prompts).toHaveLength(0);
  });

  it("accepts a bare object for a one-item batch (models answer a single item that way)", async () => {
    addInteraction(addPerson("Cory"), "you free thursday?");
    const llm = fakeLlm(() => ({ body: "thursday works" }));
    expect((await generateDrafts(db, llm)).drafted).toBe(1);
    expect(draftBodies()).toEqual(["thursday works"]);
  });
});
