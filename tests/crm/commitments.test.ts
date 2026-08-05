// Deterministic (llm = null) path of the commitment extractor, plus the LLM path's
// context/date plumbing (fake LLM): thread context + date-reference table in the
// prompt, LLM due_at respected, parseWhen cross-check, gate applied to LLM output.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import type { LlmClient } from "../../main/llm/provider.ts";
import {
  extractCommitmentsLlm,
  buildAnchoredDateReference,
  confirmCommitment,
  dropCommitment,
  listCommitments,
} from "../../main/crm/commitments.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-commit-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addInteraction(subject: string | null, body: string | null, occurredAt: string): number {
  const r = db
    .prepare(
      "INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id) VALUES (1, 'gmail', 'inbound', ?, ?, ?, ?)"
    )
    .run(occurredAt, subject, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

describe("extractCommitmentsLlm (llm = null → deterministic fallback)", () => {
  it("extracts a follow-up as an unconfirmed commitment (confidence capped at 0.5, i_owe_them)", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(1);
    expect(res.needsReview).toBe(1); // 0.5 < REVIEW_CONFIDENCE — always queued for review

    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: 1,
      direction: "i_owe_them",
      confidence: 0.5, // deterministic fragments never clear the autonomy threshold
      confirmed_by_user: 0,
      status: "open",
      source_interaction_id: id,
    });
  });

  it("dated plan yields a due_at; chatter yields nothing", async () => {
    const plan = addInteraction(null, "let's grab coffee next week", yesterday);
    const chatter = addInteraction(null, "haha that's hilarious", yesterday);
    const res = await extractCommitmentsLlm(db, null, [plan, chatter]);
    expect(res.processed).toBe(2);
    const rows = listCommitments(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].due_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].source_interaction_id).toBe(plan);
  });

  it("sets interaction.extracted_at so re-runs skip", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    await extractCommitmentsLlm(db, null, [id]);
    const row = db.prepare("SELECT extracted_at FROM interaction WHERE id = ?").get(id) as {
      extracted_at: string | null;
    };
    expect(row.extracted_at).toBeTruthy();

    const rerun = await extractCommitmentsLlm(db, null, [id]);
    expect(rerun.processed).toBe(0);
    expect(rerun.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(1); // no duplicates
  });

  it("gerund-headed fragments (subject-line status updates) are gated out", async () => {
    // Subject + body join to "Catching up — we should catch up soon!" — a status-update
    // head, not an imperative task, so the sanity gate rejects it before insert.
    const id = addInteraction("Catching up", "we should catch up soon!", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });

  it("automated/OTP interactions never produce commitments", async () => {
    const id = addInteraction(null, "Your verification code is 482913. Do not reply.", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.inserted).toBe(0);
    expect(res.processed).toBe(1); // still marked extracted
  });

  it("confirm / drop / list lifecycle", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    await extractCommitmentsLlm(db, null, [id]);
    const c = listCommitments(db, "open")[0];

    confirmCommitment(db, c.id);
    expect(listCommitments(db, "open")[0].confirmed_by_user).toBe(1);

    dropCommitment(db, c.id);
    expect(listCommitments(db, "open")).toHaveLength(0);
    const dropped = listCommitments(db, "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].resolved_at).toBeTruthy();
  });

  it("empty input is a no-op", async () => {
    expect(await extractCommitmentsLlm(db, null, [])).toEqual({
      inserted: 0,
      needsReview: 0,
      processed: 0,
    });
  });
});

// ── LLM path: the batched TWO-query pipeline (fake LLM) ─────────────────────

interface FakeLlm extends LlmClient {
  /** Every call made, in order — the quota proof. */
  calls: { feature: string; prompt: string }[];
}

/**
 * Fake LlmClient for the two-query pipeline. `classify` answers query 1 (defaults to
 * "every candidate is a commitment"), `normalize` answers query 2. Both receive the prompt
 * and every call is recorded, so tests can assert the call COUNT as well as the content.
 */
function twoQueryLlm(handlers: {
  classify?: (prompt: string) => unknown;
  normalize?: (prompt: string) => unknown;
}): FakeLlm {
  const calls: { feature: string; prompt: string }[] = [];
  const client = {
    calls,
    call: async (feature: string, _tier: string, prompt: string) => {
      calls.push({ feature, prompt });
      const isClassify = feature === "commitments-classify";
      const handler = isClassify ? handlers.classify : handlers.normalize;
      // Default classification: every numbered snippet in the prompt is a commitment.
      const fallback = () =>
        isClassify
          ? [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => ({
              n: Number(m[1]),
              is_commitment: true,
              confidence: 0.9,
            }))
          : [];
      return {
        text: JSON.stringify(handler ? handler(prompt) : fallback()),
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  return client as unknown as FakeLlm;
}

describe("extractCommitmentsLlm (fake LLM → two batched queries)", () => {
  it("spends exactly TWO calls for a 10-candidate batch, and titles come from query 2", async () => {
    // Ten distinct messages — the old shape would have been one call per batch and the
    // owner's worry is one call per item. Either way: this must cost exactly 2.
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(addInteraction(null, `please send me document number ${i}`, yesterday));

    const llm = twoQueryLlm({
      normalize: (prompt) =>
        [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => ({
          n: Number(m[1]),
          title: `Send Cory document number ${Number(m[1]) - 1}`,
          direction: "i_owe_them",
          due_at: null,
          kind: "task",
          start_time: null,
          confidence: 0.9,
        })),
    });

    const res = await extractCommitmentsLlm(db, llm, ids);
    expect(llm.calls).toHaveLength(2); // quota proof: 10 candidates, 2 requests
    expect(llm.calls.map((c) => c.feature)).toEqual(["commitments-classify", "commitments-normalize"]);
    expect(res.inserted).toBe(10);

    // Every stored description is the query-2 headline, never the raw snippet.
    for (const row of listCommitments(db, "open")) {
      expect(row.description).toMatch(/^Send Cory document number \d$/);
      expect(row.description).not.toContain("please send me");
    }
  });

  it("query 1 rejections are never sent to query 2 and never inserted", async () => {
    const keep = addInteraction(null, "can you send me the pitch deck by friday", yesterday);
    const junk = addInteraction(null, "do you want eggs?", yesterday);

    const llm = twoQueryLlm({
      classify: () => [
        { n: 1, is_commitment: true, confidence: 0.9 },
        { n: 2, is_commitment: false, confidence: 0.95 },
      ],
      normalize: () => [
        { n: 1, title: "Send Cory the pitch deck", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
      ],
    });
    const res = await extractCommitmentsLlm(db, llm, [keep, junk]);
    expect(res.inserted).toBe(1);
    expect(llm.calls).toHaveLength(2);
    // The normalize prompt's SNIPPETS section carries only the survivor (the rejected
    // message can still appear in the thread-context block — that is context, not a task).
    const snippets = llm.calls[1].prompt.split("SNIPPETS:")[1];
    expect(snippets).toContain("pitch deck");
    expect(snippets).not.toContain("do you want eggs");
  });

  it("an all-false classification costs ONE call and inserts nothing", async () => {
    const id = addInteraction(null, "looking at 345 Westwood Court on Google Maps", yesterday);
    const llm = twoQueryLlm({ classify: () => [{ n: 1, is_commitment: false, confidence: 0.9 }] });
    const res = await extractCommitmentsLlm(db, llm, [id]);
    expect(llm.calls).toHaveLength(1); // no survivors → the expensive query never runs
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });

  it("both prompts carry thread context; query 2 carries the anchored date-reference table", async () => {
    // The mom-thread case: an earlier message establishes WHAT "my list" is…
    addInteraction("Stanford dorm packing", "Stanford dorm packing list so far: sheets, mattress topper, shower caddy", yesterday);
    db.prepare("UPDATE interaction SET direction = 'outbound' WHERE id = 1").run();
    // …and the new message only references it.
    const id = addInteraction(null, "add a boot tray to my list", yesterday);

    const llm = twoQueryLlm({
      // The model, given context, rewrites the reference into a resolved task.
      normalize: () => [
        {
          n: 1,
          title: "Add boot tray to the Stanford dorm packing list",
          direction: "i_owe_them",
          due_at: null,
          kind: "task",
          start_time: null,
          confidence: 0.9,
        },
      ],
    });
    const res = await extractCommitmentsLlm(db, llm, [id]);
    expect(res.inserted).toBe(1);

    const [classify, normalize] = llm.calls.map((c) => c.prompt);
    // Thread context in BOTH: the contact's name and their recent messages, direction-labeled.
    for (const p of [classify, normalize]) {
      expect(p).toContain("Cory Levy");
      expect(p).toContain("Stanford dorm packing list so far");
      expect(p).toContain("[outbound");
      expect(p).toContain("[inbound");
    }
    // Date reference (query 2 only): anchored to the message's SENT date, month anchors.
    expect(normalize).toContain(`- messages sent ${yesterday.slice(0, 10)}:`);
    expect(normalize).toContain("month anchors:");
    // Drop-unresolvable + never-default-today instructions are present.
    expect(normalize).toContain("DROP the item entirely");
    expect(normalize).toContain("NEVER default to the sent date or to today");
    // The headline instruction: a rewrite, never a quote.
    expect(normalize).toContain("never a quote");

    // The resolved rewrite landed, undated (no invented due date).
    const row = listCommitments(db, "open")[0];
    expect(row.description).toBe("Add boot tray to the Stanford dorm packing list");
    expect(row.due_at).toBeNull();
    expect(row.kind).toBe("task");
    expect(row.start_time).toBeNull();
  });

  it("stores the LLM-resolved due_at ('in September' → the month anchor), no today-default", async () => {
    const id = addInteraction(null, "want to reconnect with Grace Katzen in September", yesterday);
    const llm = twoQueryLlm({
      normalize: () => [
        {
          n: 1,
          title: "Reconnect with Grace Katzen",
          direction: "i_owe_them",
          due_at: "2026-09-15", // month-only → mid anchor, per the prompt rules
          kind: "task",
          start_time: null,
          confidence: 0.85,
        },
      ],
    });
    await extractCommitmentsLlm(db, llm, [id]);
    const row = listCommitments(db, "open")[0];
    expect(row.due_at).toBe("2026-09-15");
  });

  it("stores kind='event' + start_time for a calendar-shaped commitment", async () => {
    const id = addInteraction(null, "dinner thursday 7pm at the usual place", yesterday);
    const llm = twoQueryLlm({
      normalize: () => [
        {
          n: 1,
          title: "Dinner with Cory",
          direction: "i_owe_them",
          due_at: "2026-12-10",
          kind: "event",
          start_time: "19:00",
          confidence: 0.9,
        },
      ],
    });
    await extractCommitmentsLlm(db, llm, [id]);
    const row = listCommitments(db, "open")[0];
    expect(row.kind).toBe("event");
    expect(row.start_time).toBe("19:00");
  });

  it("parseWhen cross-check attaches a stated FUTURE date when the LLM gives none", async () => {
    const id = addInteraction(null, "let's plan the SF meetup in 2 weeks", yesterday);
    const llm = twoQueryLlm({
      normalize: () => [
        {
          n: 1,
          title: "Plan the SF meetup with Cory",
          direction: "i_owe_them",
          due_at: null, // model missed the date — the deterministic parser catches it
          kind: "task",
          start_time: null,
          confidence: 0.85,
        },
      ],
    });
    await extractCommitmentsLlm(db, llm, [id]);
    const anchor = new Date(yesterday);
    const expected = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) + 14 * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    expect(listCommitments(db, "open")[0].due_at).toBe(expected);
  });

  it("parseWhen cross-check never attaches a PAST date (stale fragments stay undated)", async () => {
    // An old message: "friday" anchored to its send date resolves far in the past.
    const id = addInteraction(null, "let's meet on friday for coffee", "2025-01-06T12:00:00.000Z");
    const llm = twoQueryLlm({
      normalize: () => [
        { n: 1, title: "Meet Cory for coffee", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.85 },
      ],
    });
    await extractCommitmentsLlm(db, llm, [id]);
    expect(listCommitments(db, "open")[0].due_at).toBeNull(); // undated inbox item, not "today"
  });

  it("the gate still applies to query-2 titles — the 2026-08-05 junk never inserts", async () => {
    const id = addInteraction(null, "misc chatter", yesterday);
    const llm = twoQueryLlm({
      normalize: () => [
        { n: 1, title: "for our school it's a little different because for girls to come to our helco they have to have one of us take them…", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
        { n: 1, title: "I wanna be back here at 5:30 latest", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
        { n: 1, title: "find something", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
      ],
    });
    const res = await extractCommitmentsLlm(db, llm, [id]);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });

  it("a failed query 2 degrades the batch to the deterministic path", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    const llm = {
      call: async (feature: string) =>
        feature === "commitments-classify"
          ? { text: JSON.stringify([{ n: 1, is_commitment: true, confidence: 0.9 }]), model: "fake", inputTokens: 0, outputTokens: 0 }
          : null, // the normalization call fails — no titles at all
    } as unknown as LlmClient;
    const res = await extractCommitmentsLlm(db, llm, [id]);
    expect(res.inserted).toBe(1);
    expect(listCommitments(db, "open")[0].confidence).toBe(0.5); // fallback cap
  });
});

// ── thread-resolution awareness at extraction time ───────────────────────────

describe("extractCommitmentsLlm (thread resolution — resolved in the chain never inserts)", () => {
  const laterThanYesterday = new Date(Date.now() - 82_800_000).toISOString(); // yesterday + 1h

  it("LLM path: a later 'sent it!' in the thread drops the candidate before query 2 even runs", async () => {
    const ask = addInteraction(null, "can you send me the pitch deck?", yesterday);
    addInteraction(null, "sent it!", laterThanYesterday); // the fulfillment, later in the same thread

    // The classifier (wrongly) still calls it a commitment — the deterministic
    // reinforcement must drop it because a later message fulfilled it.
    const llm = twoQueryLlm({
      normalize: () => [
        { n: 1, title: "Send Cory the pitch deck", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
      ],
    });
    const res = await extractCommitmentsLlm(db, llm, [ask]);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
    expect(llm.calls).toHaveLength(1); // resolved in-thread → the second call is never spent

    // The classify prompt itself teaches thread resolution, with the fulfil/cancel phrases.
    expect(llm.calls[0].prompt).toContain("Anything the thread already resolved");
    expect(llm.calls[0].prompt).toContain('"sent it"');
    expect(llm.calls[0].prompt).toContain('"nvm"');
  });

  it("LLM path: unrelated later chatter does NOT drop the candidate", async () => {
    const ask = addInteraction(null, "can you send me the pitch deck?", yesterday);
    addInteraction(null, "lol see you at the game", laterThanYesterday);
    const llm = twoQueryLlm({
      normalize: () => [
        { n: 1, title: "Send Cory the pitch deck", direction: "i_owe_them", due_at: null, kind: "task", start_time: null, confidence: 0.9 },
      ],
    });
    const res = await extractCommitmentsLlm(db, llm, [ask]);
    expect(res.inserted).toBe(1);
    expect(listCommitments(db, "open")[0].description).toBe("Send Cory the pitch deck");
  });

  it("fallback path (llm = null): a later cancellation ('nvm') drops the proposal", async () => {
    const ask = addInteraction(null, "we should catch up soon!", yesterday);
    addInteraction(null, "nvm don't worry about it", laterThanYesterday);
    const res = await extractCommitmentsLlm(db, null, [ask]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });
});

describe("buildAnchoredDateReference (pure)", () => {
  it("maps the week after the send date and early/mid/late month anchors", () => {
    const ref = buildAnchoredDateReference(new Date("2026-08-04T15:00:00Z")); // a Tuesday
    expect(ref).toContain("Tue=2026-08-04 (sent day)");
    expect(ref).toContain("Wed=2026-08-05 (day after)");
    expect(ref).toContain("Mon=2026-08-10"); // weekday math precomputed
    expect(ref).toContain("August 2026: early=2026-08-05, mid=2026-08-15, late=2026-08-25");
    expect(ref).toContain("September 2026: early=2026-09-05, mid=2026-09-15, late=2026-09-25");
  });
});
