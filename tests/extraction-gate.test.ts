// Commitment-quality layers, end to end:
//   1. passesCommitmentGate — the deterministic sanity gate, proven against the six
//      REAL junk tasks the pipeline shipped on 2026-08-04.
//   2. The deterministic fallback path caps confidence at 0.5 and runs the gate.
//   3. autoTentativeTasks only converts confidence >= 0.8 AND gate-passing rows;
//      everything else stays open/unconfirmed for the "Needs review" queue.
//   4. cleanupTentativeTasks — the one-time repair of that morning's junk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import {
  extractCommitmentsLlm,
  passesCommitmentGate,
  listCommitments,
  FALLBACK_CONFIDENCE,
} from "../main/crm/commitments.ts";
import {
  autoTentativeTasks,
  cleanupTentativeTasks,
  cleanupTentativeTasksV2,
  AUTO_CONVERT_CONFIDENCE,
  CLEANUP_TENTATIVE_KEY,
  CLEANUP_TENTATIVE_V2_KEY,
} from "../main/workers.ts";
import type { SecretStore } from "../main/secrets.ts";

// isGoogleConnected() only calls .get("GOOGLE_OAUTH_TOKENS") — null = not connected,
// so every Google push/cleanup path short-circuits without touching the network.
const noGoogle = { get: () => null } as unknown as SecretStore;

// The owner's real failure report: raw iMessage snippets that became Google Tasks.
const REAL_NEGATIVES = [
  "do you want eggs?",
  "Give cash to contact",
  "find something, call you",
  "This is the health plan you can upload for approval. There are high chances they will decline the first time around",
  "what do you wanna inquire about?",
  "looking at 345 Westwood Court on Google Maps",
];

// The owner's SECOND failure report (2026-08-05): junk that survived the first gate.
const REAL_NEGATIVES_V2 = [
  // explanatory chatter (prepositional opener, no imperative anywhere)
  "for our school it's a little different because for girls to come to our helco they have to have one of us take them…",
  // old first-person logistics fragment (was ALSO wrongly due TODAY)
  "I wanna be back here at 5:30 latest",
  // verb + vague pronoun: nothing anyone can act on
  "find something",
];

describe("passesCommitmentGate (pure)", () => {
  it("rejects all six real junk extractions from the 2026-08-04 incident", () => {
    for (const junk of REAL_NEGATIVES) {
      expect(passesCommitmentGate(junk), `should reject: ${junk}`).toBe(false);
    }
  });

  it("rejects the three junk survivors from the 2026-08-05 report", () => {
    for (const junk of REAL_NEGATIVES_V2) {
      expect(passesCommitmentGate(junk), `should reject: ${junk}`).toBe(false);
    }
  });

  it("rejects contentless verb+pronoun objects but keeps concrete ones", () => {
    expect(passesCommitmentGate("find something")).toBe(false);
    expect(passesCommitmentGate("handle it")).toBe(false);
    expect(passesCommitmentGate("do that thing")).toBe(false);
    expect(passesCommitmentGate("find a hotel for the SF trip")).toBe(true); // concrete object survives
  });

  it("accepts properly rewritten imperative tasks", () => {
    const positives = [
      "Bring cash for Ahmed", // imperative -ing-ending verb head must survive
      "Send Sarah the pitch deck",
      "Follow up with Cory about the seed round intro",
      "Collect the signed lease from Dev",
      "we should catch up soon!", // deterministic-fallback shape still flows to review
      "let's grab coffee next week (due 2026-08-10)",
    ];
    for (const good of positives) {
      expect(passesCommitmentGate(good), `should accept: ${good}`).toBe(true);
    }
  });

  it("rejects questions, fragments, over-length, URLs, and address fragments", () => {
    expect(passesCommitmentGate("")).toBe(false);
    expect(passesCommitmentGate("   ")).toBe(false);
    expect(passesCommitmentGate("Can you send the file over when you get a chance?")).toBe(false); // ends with ?
    expect(passesCommitmentGate("when are we meeting")).toBe(false); // interrogative opener
    expect(passesCommitmentGate("Lunch")).toBe(false); // bare topic word, no action
    expect(passesCommitmentGate("https://maps.google.com/?q=345+Westwood+Court")).toBe(false); // bare URL
    expect(passesCommitmentGate("345 Westwood Court")).toBe(false); // digit-leading address fragment
    expect(passesCommitmentGate("Waiting on the inspection report")).toBe(false); // gerund head = status
    expect(passesCommitmentGate("Send over the " + "very ".repeat(30) + "long deck")).toBe(false); // way over length
    // Length ceiling tightened to 120 (was 140): a 121+-char "task" is chatter.
    expect(passesCommitmentGate("Send " + "x".repeat(120))).toBe(false); // 125 chars
    expect(passesCommitmentGate("Send Sarah the " + "x".repeat(100))).toBe(true); // 115 chars, still a task
  });
});

// ── DB-backed layers ─────────────────────────────────────────────────────────

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-gate-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function addInteraction(body: string): number {
  const r = db
    .prepare(
      "INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id) VALUES (1, 'imessage', 'inbound', ?, NULL, ?, ?)"
    )
    .run(yesterday, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

function addCommitment(
  description: string,
  confidence: number,
  opts: { status?: string; confirmed?: number; dueAt?: string | null } = {}
): number {
  const r = db
    .prepare(
      "INSERT INTO commitment (person_id, direction, description, due_at, status, confidence, confirmed_by_user) VALUES (1, 'i_owe_them', ?, ?, ?, ?, ?)"
    )
    .run(description, opts.dueAt ?? null, opts.status ?? "open", confidence, opts.confirmed ?? 0);
  return Number(r.lastInsertRowid);
}

function addTask(commitmentId: number, opts: { status?: string; createdAt: string; gtasksId?: string | null }): number {
  const r = db
    .prepare(
      "INSERT INTO task (title, block_type, commitment_id, status, gtasks_id, created_at) VALUES ('t', 'admin', ?, ?, ?, ?)"
    )
    .run(commitmentId, opts.status ?? "inbox", opts.gtasksId ?? null, opts.createdAt);
  return Number(r.lastInsertRowid);
}

describe("deterministic path (llm = null) confidence cap + gate", () => {
  it("caps fallback confidence at 0.5", async () => {
    const id = addInteraction("we should catch up soon!");
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.inserted).toBe(1);
    const rows = listCommitments(db, "open");
    expect(rows[0].confidence).toBe(FALLBACK_CONFIDENCE);
    expect(rows[0].confidence).toBeLessThan(AUTO_CONVERT_CONFIDENCE); // can never auto-convert
  });

  it("gate-failing fallback proposals never insert", async () => {
    // "wanna" is a forward-intent cue, so the followups extractor proposes the raw
    // fragment — but it ends with "?" and the gate must kill it before insert.
    const id = addInteraction("wanna grab lunch?");
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });
});

describe("autoTentativeTasks autonomy threshold", () => {
  it("converts only confidence >= 0.8 AND gate-passing; the rest stay open for review", async () => {
    const good = addCommitment("Send Sarah the pitch deck", 0.9);
    const lowConf = addCommitment("Send Omar the signed contract", 0.6);
    const junkHighConf = addCommitment("do you want eggs?", 0.95); // gate failure beats confidence

    const created = await autoTentativeTasks(db, noGoogle, 0);
    expect(created).toBe(1);

    // The high-confidence, gate-passing one converted: local task + scheduled + confirmed.
    const goodTask = db.prepare("SELECT id FROM task WHERE commitment_id = ?").get(good);
    expect(goodTask).toBeTruthy();
    const g = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(good) as any;
    expect(g.status).toBe("scheduled");
    expect(g.confirmed_by_user).toBe(1);

    // The others were left completely untouched — review queue, no tasks, no Google.
    for (const id of [lowConf, junkHighConf]) {
      expect(db.prepare("SELECT id FROM task WHERE commitment_id = ?").get(id)).toBeUndefined();
      const c = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id) as any;
      expect(c.status).toBe("open");
      expect(c.confirmed_by_user).toBe(0);
    }
  });

  it("respects beforeMaxId (only NEW commitments are considered)", async () => {
    const old = addCommitment("Send Sarah the pitch deck", 0.9);
    expect(await autoTentativeTasks(db, noGoogle, old)).toBe(0);
    expect(db.prepare("SELECT id FROM task WHERE commitment_id = ?").get(old)).toBeUndefined();
  });

  it("undated commitments become inbox items with NO plan date — never today (2026-08-05 fix)", async () => {
    // "Reconnect with Grace Katzen in September" WITHOUT a resolved date must not land
    // on today's list — and neither may any other undated commitment.
    const id = addCommitment("Reconnect with Grace Katzen", 0.9); // no due_at
    expect(await autoTentativeTasks(db, noGoogle, 0)).toBe(1);
    const t = db
      .prepare("SELECT status, plan_date, hard_deadline_at FROM task WHERE commitment_id = ?")
      .get(id) as any;
    expect(t.status).toBe("inbox");
    expect(t.plan_date).toBeNull(); // NOT today
    expect(t.hard_deadline_at).toBeNull(); // Google task would get NO due date
  });

  it("dated commitments plan on the stated due date, not today", async () => {
    // "meetup in SF … late September" → due_at resolved to 2026-09-25 by extraction.
    const id = addCommitment("Plan the SF meetup with Jordan", 0.9, { dueAt: "2026-09-25" });
    expect(await autoTentativeTasks(db, noGoogle, 0)).toBe(1);
    const t = db
      .prepare("SELECT plan_date, hard_deadline_at FROM task WHERE commitment_id = ?")
      .get(id) as any;
    expect(t.plan_date).toBe("2026-09-25");
    expect(t.hard_deadline_at).toBe("2026-09-25T00:00:00");
  });
});

describe("cleanupTentativeTasks (one-time junk repair)", () => {
  it("round-trip: junk tasks deleted, commitments back to review, legit + out-of-window kept, flag set", async () => {
    // Junk shipped on the bad morning: gate-failing despite high confidence.
    const junk = addCommitment("do you want eggs?", 0.95, { status: "scheduled", confirmed: 1 });
    const junkTask = addTask(junk, { createdAt: "2026-08-04 09:00:00", gtasksId: "g-junk" });
    // Low-confidence but gate-passing: also auto-converted by the old pipeline — reverted.
    const lowConf = addCommitment("Send Omar the signed contract", 0.5, { status: "scheduled", confirmed: 1 });
    const lowConfTask = addTask(lowConf, { status: "planned", createdAt: "2026-08-04 10:00:00" });
    // Legitimate: high confidence AND gate-passing — untouched.
    const good = addCommitment("Send Sarah the pitch deck", 0.9, { status: "scheduled", confirmed: 1 });
    const goodTask = addTask(good, { createdAt: "2026-08-04 11:00:00" });
    // Junk from BEFORE the window — untouched (the repair is scoped to the incident).
    const oldJunk = addCommitment("what do you wanna inquire about?", 0.2, { status: "scheduled", confirmed: 1 });
    const oldTask = addTask(oldJunk, { createdAt: "2026-08-01 09:00:00" });
    // Already-done task linked to junk — untouched (status filter).
    const doneTask = addTask(junk, { status: "done", createdAt: "2026-08-04 09:30:00" });

    const res = await cleanupTentativeTasks(db, noGoogle);
    expect(res.deletedTasks).toBe(2);
    expect(res.reopenedCommitments).toBe(2);

    // Junk + low-confidence tasks gone; their commitments reopened for review.
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(junkTask)).toBeUndefined();
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(lowConfTask)).toBeUndefined();
    for (const id of [junk, lowConf]) {
      const c = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id) as any;
      expect(c.status).toBe("open");
      expect(c.confirmed_by_user).toBe(0);
    }

    // Everything else survived exactly as it was.
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(goodTask)).toBeTruthy();
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(oldTask)).toBeTruthy();
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(doneTask)).toBeTruthy();
    const g = db.prepare("SELECT status FROM commitment WHERE id = ?").get(good) as any;
    expect(g.status).toBe("scheduled");

    // Flag set after success → the repair never runs twice.
    expect(getSetting(db, CLEANUP_TENTATIVE_KEY)).toBeTruthy();
    const newJunk = addCommitment("do you want eggs?", 0.1, { status: "scheduled", confirmed: 1 });
    const newJunkTask = addTask(newJunk, { createdAt: "2026-08-04 12:00:00" });
    const rerun = await cleanupTentativeTasks(db, noGoogle);
    expect(rerun).toEqual({ deletedTasks: 0, reopenedCommitments: 0 });
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(newJunkTask)).toBeTruthy();
  });
});

describe("cleanupTentativeTasksV2 (full reset onto the fixed pipeline)", () => {
  it("removes ALL still-open commitment-linked tasks since 2026-08-04 — even v1's 'legitimate' survivors", async () => {
    // v1 kept this (high confidence + gate-passing) — but its description/date came
    // from the context-blind, today-defaulting pipeline, so v2 resets it too.
    const survivor = addCommitment("Send Sarah the pitch deck", 0.9, { status: "scheduled", confirmed: 1 });
    const survivorTask = addTask(survivor, { createdAt: "2026-08-04 11:00:00", gtasksId: "g-survivor" });
    // Junk that (hypothetically) still lingers in the window — also reset.
    const junk = addCommitment("I wanna be back here at 5:30 latest", 0.85, { status: "scheduled", confirmed: 1 });
    const junkTask = addTask(junk, { status: "planned", createdAt: "2026-08-05 09:00:00" });
    // Out of the incident window — untouched.
    const old = addCommitment("Collect the signed lease from Dev", 0.9, { status: "scheduled", confirmed: 1 });
    const oldTask = addTask(old, { createdAt: "2026-08-01 09:00:00" });
    // Already done — untouched (never yank a completed task).
    const done = addCommitment("Bring cash for Ahmed", 0.9, { status: "scheduled", confirmed: 1 });
    const doneTask = addTask(done, { status: "done", createdAt: "2026-08-04 12:00:00" });

    const res = await cleanupTentativeTasksV2(db, noGoogle);
    expect(res.deletedTasks).toBe(2);
    expect(res.reopenedCommitments).toBe(2);

    // Both in-window open tasks are gone; their commitments are back in review.
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(survivorTask)).toBeUndefined();
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(junkTask)).toBeUndefined();
    for (const id of [survivor, junk]) {
      const c = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id) as any;
      expect(c.status).toBe("open");
      expect(c.confirmed_by_user).toBe(0);
    }

    // Out-of-window and done tasks survive with their commitments untouched.
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(oldTask)).toBeTruthy();
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(doneTask)).toBeTruthy();
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(old) as any).status).toBe("scheduled");
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(done) as any).status).toBe("scheduled");

    // Flag set → one-shot; a rerun touches nothing.
    expect(getSetting(db, CLEANUP_TENTATIVE_V2_KEY)).toBeTruthy();
    const late = addCommitment("Send Omar the signed contract", 0.9, { status: "scheduled", confirmed: 1 });
    const lateTask = addTask(late, { createdAt: "2026-08-05 12:00:00" });
    expect(await cleanupTentativeTasksV2(db, noGoogle)).toEqual({ deletedTasks: 0, reopenedCommitments: 0 });
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(lateTask)).toBeTruthy();
  });

  it("is independent of the v1 flag (runs even where v1 already completed)", async () => {
    await cleanupTentativeTasks(db, noGoogle); // v1 runs on an empty DB, sets its flag
    const c = addCommitment("Send Sarah the pitch deck", 0.9, { status: "scheduled", confirmed: 1 });
    const t = addTask(c, { createdAt: "2026-08-04 11:00:00" });
    const res = await cleanupTentativeTasksV2(db, noGoogle);
    expect(res.deletedTasks).toBe(1);
    expect(db.prepare("SELECT id FROM task WHERE id = ?").get(t)).toBeUndefined();
  });
});
