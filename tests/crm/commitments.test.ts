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

// ── LLM path: context-aware extraction + date resolution (fake LLM) ──────────

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

describe("extractCommitmentsLlm (fake LLM → context + dates)", () => {
  it("prompt carries per-person thread context and an anchored date-reference table", async () => {
    // The mom-thread case: an earlier message establishes WHAT "my list" is…
    addInteraction("Stanford dorm packing", "Stanford dorm packing list so far: sheets, mattress topper, shower caddy", yesterday);
    db.prepare("UPDATE interaction SET direction = 'outbound' WHERE id = 1").run();
    // …and the new message only references it.
    const id = addInteraction(null, "add a boot tray to my list", yesterday);

    let seenPrompt = "";
    const llm = fakeLlm((prompt) => {
      seenPrompt = prompt;
      // The model, given context, rewrites the reference into a resolved task.
      return [
        {
          interaction_id: id,
          description: "Add boot tray to the Stanford dorm packing list",
          direction: "i_owe_them",
          due_at: null,
          confidence: 0.9,
        },
      ];
    });
    const res = await extractCommitmentsLlm(db, llm, [id]);
    expect(res.inserted).toBe(1);

    // Thread context: the contact's name and their recent messages, direction-labeled.
    expect(seenPrompt).toContain("Cory Levy");
    expect(seenPrompt).toContain("Stanford dorm packing list so far");
    expect(seenPrompt).toContain("[outbound");
    expect(seenPrompt).toContain("[inbound");
    // Date reference: anchored to the message's SENT date, with month anchors.
    expect(seenPrompt).toContain(`- messages sent ${yesterday.slice(0, 10)}:`);
    expect(seenPrompt).toContain("month anchors:");
    // Drop-unresolvable + never-default-today instructions are present.
    expect(seenPrompt).toContain("DROP the item entirely");
    expect(seenPrompt).toContain("NEVER default to the sent date or to today");

    // The resolved rewrite landed, undated (no invented due date).
    const row = listCommitments(db, "open")[0];
    expect(row.description).toBe("Add boot tray to the Stanford dorm packing list");
    expect(row.due_at).toBeNull();
  });

  it("stores the LLM-resolved due_at ('in September' → the month anchor), no today-default", async () => {
    const id = addInteraction(null, "want to reconnect with Grace Katzen in September", yesterday);
    const llm = fakeLlm(() => [
      {
        interaction_id: id,
        description: "Reconnect with Grace Katzen",
        direction: "i_owe_them",
        due_at: "2026-09-15", // month-only → mid anchor, per the prompt rules
        confidence: 0.85,
      },
    ]);
    await extractCommitmentsLlm(db, llm, [id]);
    const row = listCommitments(db, "open")[0];
    expect(row.due_at).toBe("2026-09-15");
  });

  it("parseWhen cross-check attaches a stated FUTURE date when the LLM gives none", async () => {
    const id = addInteraction(null, "let's plan the SF meetup in 2 weeks", yesterday);
    const llm = fakeLlm(() => [
      {
        interaction_id: id,
        description: "Plan the SF meetup with Cory",
        direction: "i_owe_them",
        due_at: null, // model missed the date — the deterministic parser catches it
        confidence: 0.85,
      },
    ]);
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
    const llm = fakeLlm(() => [
      {
        interaction_id: id,
        description: "Meet Cory for coffee",
        direction: "i_owe_them",
        due_at: null,
        confidence: 0.85,
      },
    ]);
    await extractCommitmentsLlm(db, llm, [id]);
    expect(listCommitments(db, "open")[0].due_at).toBeNull(); // undated inbox item, not "today"
  });

  it("the gate still applies to LLM output — the 2026-08-05 junk never inserts", async () => {
    const id = addInteraction(null, "misc chatter", yesterday);
    const llm = fakeLlm(() => [
      { interaction_id: id, description: "for our school it's a little different because for girls to come to our helco they have to have one of us take them…", direction: "i_owe_them", due_at: null, confidence: 0.9 },
      { interaction_id: id, description: "I wanna be back here at 5:30 latest", direction: "i_owe_them", due_at: null, confidence: 0.9 },
      { interaction_id: id, description: "find something", direction: "i_owe_them", due_at: null, confidence: 0.9 },
    ]);
    const res = await extractCommitmentsLlm(db, llm, [id]);
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
