// Degraded-work backfill queue (main/backfill.ts).
//
// Owner ask 2026-08-05: "when my Gemini credits refill — I think hourly — it should go back
// and fix the stuff it couldn't summarize or abridge at the time because credits were
// exhausted." When the LLM is down, extraction degrades to the deterministic followups path
// and commitment titles come out as near-verbatim message text at confidence 0.5. These
// tests pin the three halves of the fix:
//   1. the schema-free queue in `setting` (round-trip + the 200-entry cap),
//   2. marking at the point of degradation — and NOT when a healthy model simply said "none
//      of these are commitments",
//   3. the sweep: refuses to run on red health, rewrites a fallback title into the model's
//      headline, drops what the model now rejects, never touches the owner's own edits, and
//      spends exactly ONE call for a whole queue.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import type { SecretStore } from "../main/secrets.ts";
import { resetFailureCache, recordFailure } from "../main/llm/meter.ts";
import {
  markDegraded,
  listDegraded,
  clearDegraded,
  degradedKey,
  backfillDegraded,
  QUEUE_CAP,
} from "../main/backfill.ts";
import { extractCommitmentsLlm, confirmCommitment, listCommitments } from "../main/crm/commitments.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-backfill-"));
  db = openDb(path.join(dir, "pos.db"));
  resetFailureCache(); // the failure cache is per-process, not per-test
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A secret store holding exactly the named keys. */
const keys = (present: Record<string, string> = {}): SecretStore =>
  ({ get: (n: string) => present[n] ?? null }) as unknown as SecretStore;

/** Gemini key present, no spend, no failure → llmHealth().ok is true. */
const healthy = keys({ GEMINI_API_KEY: "g" });
/** No key at all → llmHealth().ok is false with reason 'no_key'. */
const noKey = keys();

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function addInteraction(body: string, occurredAt = yesterday): number {
  const r = db
    .prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id)
       VALUES (1, 'imessage', 'inbound', ?, NULL, ?, ?)`
    )
    .run(occurredAt, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

/** A commitment exactly as the deterministic fallback writes it: raw text, confidence 0.5. */
function addFallbackCommitment(description: string, sourceId: number): number {
  const r = db
    .prepare(
      `INSERT INTO commitment (person_id, direction, description, due_at, status, source_interaction_id,
                               confidence, confirmed_by_user, kind)
       VALUES (1, 'i_owe_them', ?, NULL, 'open', ?, 0.5, 0, 'task')`
    )
    .run(description, sourceId);
  return Number(r.lastInsertRowid);
}

interface FakeLlm extends LlmClient {
  calls: { feature: string; prompt: string }[];
}

/** Fake LlmClient recording every call; `normalize` answers the batched repair query. */
function fakeLlm(normalize?: (prompt: string) => unknown, opts: { fail?: boolean } = {}): FakeLlm {
  const calls: { feature: string; prompt: string }[] = [];
  return {
    calls,
    call: async (feature: string, _tier: string, prompt: string) => {
      calls.push({ feature, prompt });
      if (opts.fail) return null; // provider.call's never-throw contract
      return {
        text: JSON.stringify(normalize ? normalize(prompt) : []),
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  } as unknown as FakeLlm;
}

/** The candidate numbers the prompt actually carried, in order. */
const promptNs = (prompt: string) => [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => Number(m[1]));

// ── 1. the queue itself ──────────────────────────────────────────────────────

describe("degraded queue (setting-backed, schema-free)", () => {
  it("mark → list → clear round-trips, and re-marking the same id never duplicates", () => {
    markDegraded(db, "commitment", 7, "llm_unavailable");
    markDegraded(db, "commitment", 9, "llm_unavailable");

    const entries = listDegraded(db, "commitment");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id).sort((a, b) => a - b)).toEqual([7, 9]);
    expect(entries[0]).toMatchObject({ kind: "commitment", reason: "llm_unavailable" });
    expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The value lives in the existing `setting` table under a predictable key — no migration.
    expect(getSetting(db, degradedKey("commitment", 7))).toContain('"kind":"commitment"');

    markDegraded(db, "commitment", 7, "llm_unavailable"); // same row again mid-outage
    expect(listDegraded(db, "commitment")).toHaveLength(2);

    clearDegraded(db, "commitment", 7);
    expect(listDegraded(db, "commitment").map((e) => e.id)).toEqual([9]);
    expect(getSetting(db, degradedKey("commitment", 7))).toBeNull();
    clearDegraded(db, "commitment", 7); // clearing something already gone is a no-op
    expect(listDegraded(db, "commitment")).toHaveLength(1);
  });

  it(`caps the queue at ${QUEUE_CAP} entries, dropping the oldest`, () => {
    // A multi-day outage: 205 fallback inserts. Distinct timestamps make "oldest" exact.
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    for (let i = 1; i <= QUEUE_CAP + 5; i++) {
      markDegraded(db, "commitment", i, "llm_unavailable", new Date(t0 + i * 1000));
    }
    const entries = listDegraded(db, "commitment");
    expect(entries).toHaveLength(QUEUE_CAP);
    const ids = entries.map((e) => e.id);
    expect(ids[0]).toBe(6); // the first five were trimmed
    expect(ids[ids.length - 1]).toBe(QUEUE_CAP + 5); // newest survives
    for (const gone of [1, 2, 3, 4, 5]) expect(ids).not.toContain(gone);
    // The cap is over the whole `degraded:` namespace, not just what listDegraded parses.
    const raw = db
      .prepare("SELECT COUNT(*) AS c FROM setting WHERE key LIKE 'degraded:%'")
      .get() as { c: number };
    expect(raw.c).toBe(QUEUE_CAP);
  });
});

// ── 2. marking at the point of degradation ───────────────────────────────────

describe("marking at the point of degradation (crm/commitments.ts)", () => {
  it("enqueues the commitment the deterministic fallback wrote when the LLM was unavailable", async () => {
    const id = addInteraction("we should catch up soon!");
    const res = await extractCommitmentsLlm(db, null, [id]); // llm === null → fallback path
    expect(res.inserted).toBe(1);

    const row = listCommitments(db, "open")[0];
    expect(row.confidence).toBe(0.5); // the fallback signature
    const queue = listDegraded(db, "commitment");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ kind: "commitment", id: row.id, reason: "llm_unavailable" });
  });

  it("a HEALTHY call that classifies everything as not-a-commitment enqueues nothing", async () => {
    const id = addInteraction("haha that's hilarious, anyway I have to run");
    // Query 1 answers honestly: nothing here is a commitment. That is a verdict, not an
    // outage — nothing is inserted and nothing may be queued for a "repair".
    const classifyingLlm = {
      call: async (_feature: string, _tier: string, prompt: string) => ({
        text: JSON.stringify(promptNs(prompt).map((n) => ({ n, is_commitment: false, confidence: 0.9 }))),
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
      }),
    } as unknown as LlmClient;

    const res = await extractCommitmentsLlm(db, classifyingLlm, [id]);
    expect(res.inserted).toBe(0);
    expect(listDegraded(db, "commitment")).toEqual([]);
  });
});

// ── 3. the sweep ─────────────────────────────────────────────────────────────

describe("backfillDegraded", () => {
  it("no-ops with red health and leaves the queue completely intact", async () => {
    const src = addInteraction("can you send me the pitch deck when you get a sec");
    const cid = addFallbackCommitment("send me the pitch deck when you get a sec", src);
    markDegraded(db, "commitment", cid, "llm_unavailable");

    const llm = fakeLlm(() => [{ n: 1, title: "Send Cory the pitch deck", confidence: 0.9 }]);

    // (a) no key at all
    expect(await backfillDegraded(db, noKey, llm)).toEqual({
      repaired: 0,
      dropped: 0,
      skipped: "llm_unavailable",
    });
    // (b) key present, but the provider just told us the quota is gone
    recordFailure(db, new Error('got status: 429 … "status":"RESOURCE_EXHAUSTED"'));
    expect(await backfillDegraded(db, healthy, llm)).toEqual({
      repaired: 0,
      dropped: 0,
      skipped: "llm_unavailable",
    });

    expect(llm.calls).toHaveLength(0); // not one request spent while credits are out
    expect(listDegraded(db, "commitment").map((e) => e.id)).toEqual([cid]);
    expect(listCommitments(db, "open")[0].description).toBe("send me the pitch deck when you get a sec");
  });

  it("skips (with 'empty') when the queue is clear", async () => {
    const llm = fakeLlm();
    expect(await backfillDegraded(db, healthy, llm)).toEqual({ repaired: 0, dropped: 0, skipped: "empty" });
    expect(llm.calls).toHaveLength(0);
  });

  it("rewrites a fallback-titled commitment into the model's headline and dequeues it", async () => {
    const src = addInteraction("can you send me the pitch deck when you get a sec");
    const cid = addFallbackCommitment("send me the pitch deck when you get a sec", src);
    markDegraded(db, "commitment", cid, "llm_unavailable");

    const llm = fakeLlm((prompt) =>
      promptNs(prompt).map((n) => ({
        n,
        title: "Send Cory the pitch deck",
        direction: "i_owe_them",
        due_at: "2026-08-14",
        kind: "task",
        start_time: null,
        confidence: 0.92,
      }))
    );

    const res = await backfillDegraded(db, healthy, llm);
    expect(res).toEqual({ repaired: 1, dropped: 0 });

    const row = listCommitments(db, "open")[0];
    expect(row.id).toBe(cid);
    expect(row.description).toBe("Send Cory the pitch deck"); // the headline, not his words
    expect(row.due_at).toBe("2026-08-14");
    expect(row.kind).toBe("task");
    expect(row.confidence).toBeCloseTo(0.92); // no longer stuck under the autonomy threshold
    expect(row.dedupe_key).toContain("send-cory-the-pitch-deck");
    expect(listDegraded(db, "commitment")).toEqual([]); // dequeued — never repaired twice

    // The repair reuses the extraction pipeline's normalize prompt: same source text, same
    // per-person thread context, one numbered candidate.
    expect(llm.calls[0].prompt).toContain("Cory Levy");
    expect(llm.calls[0].prompt).toContain("can you send me the pitch deck");
  });

  it("drops one the model now rejects, keeping it for audit", async () => {
    const keepSrc = addInteraction("can you send me the pitch deck when you get a sec");
    const junkSrc = addInteraction("do you want eggs?");
    const keep = addFallbackCommitment("send me the pitch deck when you get a sec", keepSrc);
    const junk = addFallbackCommitment("do you want eggs", junkSrc);
    markDegraded(db, "commitment", keep, "llm_unavailable");
    markDegraded(db, "commitment", junk, "llm_unavailable");

    // The model answers for the real one and OMITS the question entirely.
    const llm = fakeLlm(() => [
      {
        n: 1,
        title: "Send Cory the pitch deck",
        direction: "i_owe_them",
        due_at: null,
        kind: "task",
        start_time: null,
        confidence: 0.9,
      },
    ]);

    const res = await backfillDegraded(db, healthy, llm);
    expect(res).toEqual({ repaired: 1, dropped: 1 });

    const dropped = db.prepare("SELECT status, resolved_at FROM commitment WHERE id = ?").get(junk) as {
      status: string;
      resolved_at: string | null;
    };
    expect(dropped.status).toBe("dropped"); // outage-era false positive, cleaned up
    expect(dropped.resolved_at).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS c FROM commitment").get()).toEqual({ c: 2 }); // kept for audit
    expect(listDegraded(db, "commitment")).toEqual([]); // both dequeued
  });

  it("skips and dequeues a commitment the owner confirmed — his edits are never overwritten", async () => {
    const src = addInteraction("can you send me the pitch deck when you get a sec");
    const cid = addFallbackCommitment("Pitch deck for Cory — MY OWN WORDING", src);
    markDegraded(db, "commitment", cid, "llm_unavailable");
    confirmCommitment(db, cid); // the same flag the IPC hand-edit path sets

    const llm = fakeLlm((prompt) =>
      promptNs(prompt).map((n) => ({ n, title: "Send Cory the pitch deck", kind: "task", confidence: 0.95 }))
    );

    const res = await backfillDegraded(db, healthy, llm);
    expect(res).toEqual({ repaired: 0, dropped: 0 });
    expect(llm.calls).toHaveLength(0); // nothing left to ask about — no call at all

    const row = db.prepare("SELECT description, status, confidence FROM commitment WHERE id = ?").get(cid) as {
      description: string;
      status: string;
      confidence: number;
    };
    expect(row).toMatchObject({
      description: "Pitch deck for Cory — MY OWN WORDING",
      status: "open",
      confidence: 0.5,
    });
    expect(listDegraded(db, "commitment")).toEqual([]); // dequeued untouched
  });

  it("spends exactly ONE call for a 10-item queue", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const src = addInteraction(`please send me document number ${i} when you can`);
      ids.push(addFallbackCommitment(`send me document number ${i} when you can`, src));
    }
    for (const id of ids) markDegraded(db, "commitment", id, "llm_unavailable");

    const llm = fakeLlm((prompt) =>
      promptNs(prompt).map((n) => ({
        n,
        title: `Send Cory document number ${n - 1}`,
        direction: "i_owe_them",
        due_at: null,
        kind: "task",
        start_time: null,
        confidence: 0.9,
      }))
    );

    const res = await backfillDegraded(db, healthy, llm);
    expect(llm.calls).toHaveLength(1); // quota proof: 10 repairs, ONE request
    expect(llm.calls[0].feature).toBe("commitments-backfill");
    expect(res).toEqual({ repaired: 10, dropped: 0 });
    for (const row of listCommitments(db, "open")) {
      expect(row.description).toMatch(/^Send Cory document number \d$/);
    }
    expect(listDegraded(db, "commitment")).toEqual([]);
  });

  it("honours `limit`, leaving the rest of the queue for the next pass", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const src = addInteraction(`please send me document number ${i} when you can`);
      ids.push(addFallbackCommitment(`send me document number ${i} when you can`, src));
    }
    for (const id of ids) markDegraded(db, "commitment", id, "llm_unavailable");

    const llm = fakeLlm((prompt) =>
      promptNs(prompt).map((n) => ({ n, title: `Send Cory document number ${n - 1}`, kind: "task", confidence: 0.9 }))
    );
    const res = await backfillDegraded(db, healthy, llm, { limit: 2 });
    expect(res).toEqual({ repaired: 2, dropped: 0 });
    expect(listDegraded(db, "commitment").map((e) => e.id)).toEqual(ids.slice(2));
  });

  it("a call that fails mid-pass leaves the queue intact for the next tick", async () => {
    const src = addInteraction("can you send me the pitch deck when you get a sec");
    const cid = addFallbackCommitment("send me the pitch deck when you get a sec", src);
    markDegraded(db, "commitment", cid, "llm_unavailable");

    const llm = fakeLlm(undefined, { fail: true }); // health was green, the request wasn't
    const res = await backfillDegraded(db, healthy, llm);
    expect(res).toEqual({ repaired: 0, dropped: 0, skipped: "llm_unavailable" });
    expect(listDegraded(db, "commitment").map((e) => e.id)).toEqual([cid]);
    expect(listCommitments(db, "open")[0].description).toBe("send me the pitch deck when you get a sec");
  });

  it("dequeues a row that was already resolved or deleted, without a call", async () => {
    const src = addInteraction("can you send me the pitch deck when you get a sec");
    const done = addFallbackCommitment("send me the pitch deck when you get a sec", src);
    db.prepare("UPDATE commitment SET status = 'done' WHERE id = ?").run(done);
    markDegraded(db, "commitment", done, "llm_unavailable");
    markDegraded(db, "commitment", 9999, "llm_unavailable"); // row no longer exists

    const llm = fakeLlm();
    expect(await backfillDegraded(db, healthy, llm)).toEqual({ repaired: 0, dropped: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(listDegraded(db, "commitment")).toEqual([]);
  });
});
