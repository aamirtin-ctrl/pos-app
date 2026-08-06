// CALL-COUNT REGRESSION SUITE — the owner's standing directive in executable form:
// never spend one LLM call on one item when a batch would do. He is on Gemini's free
// tier (~250 fast-tier REQUESTS a day, not tokens), and a heavy sync used to burn it on
// five per-item loops: one draft call per unanswered message, one synthesis call per
// person, one mining call per person, one msgplans call per conversation, one
// thread-resolution call per person.
//
// Every test here counts INVOCATIONS of a fake LlmClient. They are deliberately blunt:
// N items in, exactly ONE call out. If someone reintroduces a per-item loop, these fail
// even when the feature still "works".
//
// The item-level behavior of each pass lives in its own suite (crm/drafts.test.ts,
// crm/enrich.test.ts, msgplans.test.ts, thread-resolution.test.ts) — this file only
// guards the request budget.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, setSetting, type Db } from "../main/db/db.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import type { SecretStore } from "../main/secrets.ts";
import { generateDrafts } from "../main/crm/drafts.ts";
import { synthesizeProfiles, mineBios } from "../main/crm/enrich.ts";
import { runMsgPlans } from "../main/msgplans.ts";
import { resolveFromThreads } from "../main/workers.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-llm-batch-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Google is not connected, so every gcal/gtasks path short-circuits offline. */
const noSecrets = { get: () => null } as unknown as SecretStore;

/**
 * Fake LlmClient that COUNTS invocations (per feature and in total) and answers with
 * whatever `reply(prompt, feature)` returns, serialized as strict JSON.
 */
function countingLlm(reply: (prompt: string, feature: string) => unknown) {
  const byFeature = new Map<string, number>();
  const prompts: string[] = [];
  let total = 0;
  const client = {
    calls: () => total,
    callsFor: (feature: string) => byFeature.get(feature) ?? 0,
    prompts,
    call: async (feature: string, _tier: string, prompt: string) => {
      total++;
      byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
      prompts.push(prompt);
      return { text: JSON.stringify(reply(prompt, feature)), model: "fake", inputTokens: 0, outputTokens: 0 };
    },
  };
  return client as typeof client & LlmClient;
}

let extSeq = 0;
function addPerson(name: string): number {
  return Number(db.prepare("INSERT INTO person (display_name) VALUES (?)").run(name).lastInsertRowid);
}
function addInteraction(
  personId: number,
  body: string,
  o: { direction?: string; channel?: string; occurredAt?: string } = {}
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
        o.occurredAt ?? new Date(Date.now() - 3_600_000).toISOString(),
        body,
        `ext-${extSeq++}`
      ).lastInsertRowid
  );
}

// ── 1. drafts: 12 unanswered messages → ONE auto_draft call ──────────────────

describe("generateDrafts", () => {
  it("answers 12 unanswered messages in ONE call (was 12)", async () => {
    // Pre-seed the learned voices so synthesizeVoices never fires — this test is about
    // the draft loop, and the counter below is scoped to the auto_draft feature anyway.
    for (const cat of ["email", "text", "linkedin", "slack"]) {
      setSetting(
        db,
        `voice_${cat}`,
        JSON.stringify({ category: cat, tone: "warm, direct", greeting: "", signoff: "", avgWords: 20, notes: [] })
      );
    }
    for (let i = 0; i < 12; i++) {
      const p = addPerson(`Contact ${i}`);
      addInteraction(p, `question number ${i}, are you free thursday?`, {
        channel: i % 2 ? "imessage" : "gmail",
      });
    }

    const llm = countingLlm(() =>
      Array.from({ length: 12 }, (_, i) => ({ n: i + 1, body: `reply ${i + 1}` }))
    );
    const res = await generateDrafts(db, llm);

    expect(llm.callsFor("auto_draft")).toBe(1);
    expect(llm.calls()).toBe(1);
    expect(res.drafted).toBe(12);
    expect((db.prepare("SELECT COUNT(*) AS n FROM draft").get() as { n: number }).n).toBe(12);
    // Each entry carried its OWN channel voice inline — that is what replaced the
    // per-channel (and then per-message) call.
    expect(llm.prompts[0].match(/VOICE:/g)).toHaveLength(12);
  });
});

// ── 2/3. enrichment: 10 stale profiles → ONE call; 5 mine candidates → ONE ───

/** Three content-bearing messages: the minimum that makes a person a candidate. */
function seedConversation(personId: number): void {
  const msgs = [
    "Just closed the seed round for the solar analytics company.",
    "Moving the research lab to Austin next month, it has been a haul.",
    "Teaching a materials science seminar at UVA this fall.",
  ];
  msgs.forEach((m, i) =>
    addInteraction(personId, m, {
      direction: i % 2 ? "outbound" : "inbound",
      occurredAt: new Date(Date.now() - (10 - i) * 86_400_000).toISOString(),
    })
  );
}

describe("synthesizeProfiles", () => {
  it("synthesizes 10 stale profiles in ONE call (was 10)", async () => {
    for (let i = 0; i < 10; i++) seedConversation(addPerson(`Person ${i}`));

    const llm = countingLlm(() =>
      Array.from({ length: 10 }, (_, i) => ({
        n: i + 1,
        bio: `Bio ${i + 1}.`,
        relationship_summary: `Summary ${i + 1}.`,
      }))
    );
    const res = await synthesizeProfiles(db, llm, { limit: 10, budget: 10 });

    expect(llm.calls()).toBe(1);
    expect(res).toMatchObject({ attempted: 10, updated: 10, failed: 0 });
    // The budget still counts PEOPLE: ten ledger rows, ten units of budget spent.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM enrichment_attempt WHERE source = 'synthesis'").get() as { n: number }).n
    ).toBe(10);
    expect(res.budgetLeft).toBe(0);
  });
});

describe("mineBios", () => {
  it("mines 5 candidates in ONE call (was 5)", async () => {
    for (let i = 0; i < 5; i++) seedConversation(addPerson(`Miner ${i}`));

    const llm = countingLlm(() =>
      Array.from({ length: 5 }, (_, i) => ({ n: i + 1, facts: [`Durable fact ${i + 1}.`] }))
    );
    const res = await mineBios(db, llm, { limit: 5, budget: 10 });

    expect(llm.calls()).toBe(1);
    expect(res).toMatchObject({ attempted: 5, mined: 5, failed: 0 });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM enrichment_attempt WHERE source = 'bio-mining'").get() as { n: number }).n
    ).toBe(5);
  });
});

// ── 4. msgplans: 8 signalling conversations → ONE call ───────────────────────

const APPLE_EPOCH_MS = 978_307_200_000;
const nsAt = (unixMs: number): bigint => BigInt(unixMs - APPLE_EPOCH_MS) * 1_000_000n;

/** A minimal chat.db with one 1:1 conversation per entry (the real column shapes). */
function buildChatDb(chatDbPath: string, convs: { handle: string; texts: string[] }[]) {
  const chat = new Database(chatDbPath);
  chat.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
      attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
  `);
  let rowid = 0;
  convs.forEach((c, ci) => {
    const idx = ci + 1;
    chat.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(idx, c.handle);
    chat.prepare("INSERT INTO chat (ROWID, guid, display_name) VALUES (?, ?, NULL)").run(idx, `iMessage;-;${c.handle}`);
    chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(idx, idx);
    c.texts.forEach((t, ti) => {
      rowid++;
      chat
        .prepare(
          "INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, NULL, ?, ?, ?)"
        )
        .run(rowid, `g-${rowid}`, t, nsAt(Date.now() - (10 - ti) * 60_000), ti % 2 === 1 ? 1 : 0, idx);
      chat.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(idx, rowid);
    });
  });
  chat.close();
}

describe("runMsgPlans", () => {
  it("decides 8 signalling conversations in ONE call (was 8)", async () => {
    const chatDbPath = path.join(dir, "chat.db");
    buildChatDb(
      chatDbPath,
      Array.from({ length: 8 }, (_, i) => ({
        handle: `+1415555${String(1000 + i)}`,
        texts: ["wanna grab dinner saturday?", "down", "lets say 8"],
      }))
    );

    // action "none" for every conversation: the gate skips them, so nothing reaches
    // Google Calendar and the test stays offline. The COUNT is the point.
    const llm = countingLlm(() =>
      Array.from({ length: 8 }, (_, i) => ({
        n: i + 1,
        is_plan: false,
        action: "none",
        title: null,
        start: null,
        end: null,
        all_day: false,
        confidence: 0.2,
        reason: "still deciding",
      }))
    );

    const report = await runMsgPlans({ db, secrets: noSecrets, llm }, { chatDbPath });
    expect(report.error).toBeUndefined();
    expect(llm.calls()).toBe(1);
    expect(llm.callsFor("msgplans")).toBe(1);
    // One numbered block per conversation, one shared date-reference table.
    expect(llm.prompts[0]).toContain("CONVERSATIONS (8)");
    expect(llm.prompts[0].match(/Recent messages \(oldest first\):/g)).toHaveLength(8);
    expect(llm.prompts[0].match(/Date reference \(use these EXACT dates/g)).toHaveLength(1);
  });
});

// ── 5. thread resolution: 6 people with open commitments → ONE call ──────────

describe("resolveFromThreads", () => {
  it("checks 6 people with open commitments in ONE call (was 6)", async () => {
    const ids: number[] = [];
    const commitments: number[] = [];
    for (let i = 0; i < 6; i++) {
      const p = addPerson(`Owed ${i}`);
      commitments.push(
        Number(
          db
            .prepare(
              "INSERT INTO commitment (person_id, direction, description, status, confidence, confirmed_by_user) VALUES (?, 'i_owe_them', ?, 'open', 0.9, 1)"
            )
            .run(p, `Send Owed ${i} the pitch deck`).lastInsertRowid
        )
      );
      ids.push(addInteraction(p, "sent it!", { direction: "outbound" }));
    }

    // Batched shape: one object per numbered person, carrying only that person's ids.
    const llm = countingLlm(() =>
      commitments.map((id, i) => ({ n: i + 1, resolved_ids: [id], reason: "sent in the thread" }))
    );
    const res = await resolveFromThreads(db, noSecrets, llm, ids);

    expect(llm.calls()).toBe(1);
    expect(llm.callsFor("thread-resolution")).toBe(1);
    expect(res).toMatchObject({ peopleChecked: 6, resolved: 6 });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM commitment WHERE status = 'done'").get() as { n: number }).n
    ).toBe(6);
  });

  it("a person's ids are never applied to another person", async () => {
    const a = addPerson("A");
    const b = addPerson("B");
    const ca = Number(
      db
        .prepare(
          "INSERT INTO commitment (person_id, direction, description, status, confidence, confirmed_by_user) VALUES (?, 'i_owe_them', 'Send A the deck', 'open', 0.9, 1)"
        )
        .run(a).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO commitment (person_id, direction, description, status, confidence, confirmed_by_user) VALUES (?, 'i_owe_them', 'Send B the deck', 'open', 0.9, 1)"
    ).run(b);
    const ids = [addInteraction(a, "sent it!"), addInteraction(b, "still thinking")];

    // Entry 2 (person B) claims person A's commitment id — it must resolve NOTHING.
    const llm = countingLlm(() => [{ n: 2, resolved_ids: [ca], reason: "cross-talk" }]);
    const res = await resolveFromThreads(db, noSecrets, llm, ids);

    expect(llm.calls()).toBe(1);
    expect(res.resolved).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM commitment WHERE status = 'open'").get() as { n: number }).n
    ).toBe(2);
  });
});
