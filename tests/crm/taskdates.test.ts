// Giving undated tasks a real day — owner report 2026-08-06: "the google tasks populated by
// the app are not dated. everything needs to be on a certain day. this might require Gemini
// and that's fine."
//
// This is deliberately the LLM-shaped half of the fix (the deterministic vocabulary handles
// everything with a date-shaped word in it — see keyword-vocabulary.test.ts). What's left is
// text with nothing to parse, only something to judge, so these tests exercise the batching,
// the never-today guardrail, and the "only fill NULL, never overwrite" contract against a fake
// LlmClient — no network, same pattern as tests/dedupe.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import type { LlmClient } from "../../main/llm/provider.ts";
import { dateUndatedTasks, TASK_DATE_BATCH } from "../../main/crm/taskdates.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-taskdates-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeLlm extends LlmClient {
  calls: { feature: string; prompt: string }[];
}

/** Fake LLM: `handler(prompt)` returns the array the real model would answer with. */
function fakeLlm(handler: (prompt: string) => unknown): FakeLlm {
  const calls: { feature: string; prompt: string }[] = [];
  return {
    calls,
    call: async (feature: string, _tier: string, prompt: string) => {
      calls.push({ feature, prompt });
      return { text: JSON.stringify(handler(prompt)), model: "fake", inputTokens: 0, outputTokens: 0 };
    },
  } as unknown as FakeLlm;
}

function addTask(title: string, opts: { planDate?: string | null; status?: string } = {}): number {
  return Number(
    db
      .prepare(
        "INSERT INTO task (title, block_type, status, plan_date) VALUES (?, 'deep_work', ?, ?)"
      )
      .run(title, opts.status ?? "inbox", opts.planDate ?? null).lastInsertRowid
  );
}

const NOW = new Date("2026-08-06T15:00:00Z");

describe("dateUndatedTasks", () => {
  it("is a no-op with no LLM (health-gated, not a crash)", async () => {
    const id = addTask("Put the coolers away");
    const res = await dateUndatedTasks(db, null, NOW);
    expect(res).toEqual({ dated: 0, skipped: "llm_unavailable" });
    expect((db.prepare("SELECT plan_date FROM task WHERE id = ?").get(id) as any).plan_date).toBeNull();
  });

  it("is a no-op when there is nothing undated to date", async () => {
    addTask("Already dated", { planDate: "2026-08-10" });
    const llm = fakeLlm(() => []);
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res).toEqual({ dated: 0, skipped: "empty" });
    expect(llm.calls.length).toBe(0);
  });

  it("dates an undated task from a single batched call", async () => {
    const id = addTask("Spend another night in Como");
    const llm = fakeLlm((prompt) =>
      [...prompt.matchAll(/^(\d+)\. "/gm)].map((m) => ({ n: Number(m[1]), date: "2026-08-09", confidence: 0.8 }))
    );
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res.dated).toBe(1);
    expect(llm.calls.length).toBe(1); // one call, not one-per-task
    expect((db.prepare("SELECT plan_date FROM task WHERE id = ?").get(id) as any).plan_date).toBe("2026-08-09");
  });

  it("refuses a model-picked date in the past, no matter what the model says", async () => {
    const id = addTask("Old undated thing");
    const llm = fakeLlm(() => [{ n: 1, date: "2026-08-01", confidence: 0.9 }]);
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res.dated).toBe(0);
    expect((db.prepare("SELECT plan_date FROM task WHERE id = ?").get(id) as any).plan_date).toBeNull();
  });

  it("never overwrites a plan_date already set between the read and the write", async () => {
    const id = addTask("Race condition guard");
    // Simulate: something else dated it while the LLM call was in flight.
    const llm = fakeLlm((prompt) => {
      db.prepare("UPDATE task SET plan_date = '2026-08-07' WHERE id = ?").run(id);
      return [...prompt.matchAll(/^(\d+)\. "/gm)].map((m) => ({ n: Number(m[1]), date: "2026-08-20", confidence: 0.9 }));
    });
    await dateUndatedTasks(db, llm, NOW);
    // The earlier write wins; the LLM's answer for an already-dated task is discarded.
    expect((db.prepare("SELECT plan_date FROM task WHERE id = ?").get(id) as any).plan_date).toBe("2026-08-07");
  });

  it("only ever asks about TASK_DATE_BATCH tasks in one pass", async () => {
    for (let i = 0; i < TASK_DATE_BATCH + 5; i++) addTask(`Undated ${i}`);
    const llm = fakeLlm((prompt) =>
      [...prompt.matchAll(/^(\d+)\. "/gm)].map((m) => ({ n: Number(m[1]), date: "2026-08-09", confidence: 0.7 }))
    );
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res.dated).toBe(TASK_DATE_BATCH);
    expect(llm.calls.length).toBe(1);
  });

  it("degrades gracefully on unparseable model output instead of throwing", async () => {
    addTask("Whatever this is");
    const llm: FakeLlm = {
      calls: [],
      call: async () => ({ text: "not json at all", model: "fake", inputTokens: 0, outputTokens: 0 }),
    } as unknown as FakeLlm;
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res).toEqual({ dated: 0, skipped: "bad_response" });
  });

  it("only considers schedulable statuses, leaving done/cancelled tasks alone", async () => {
    addTask("Done already", { status: "done" });
    addTask("Cancelled", { status: "cancelled" });
    const llm = fakeLlm(() => []);
    const res = await dateUndatedTasks(db, llm, NOW);
    expect(res).toEqual({ dated: 0, skipped: "empty" });
  });
});
