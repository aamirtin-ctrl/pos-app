// A day that gains work after it was planned must notice.
//
// Re-planning had two triggers: the calendar moved (anchor fingerprint) and the solver
// changed (engine version). Neither sees the third way a stored plan goes stale — the day
// gained a task after it was solved. Work deferred in from the day before, imported from
// Google Tasks or Notion for a future date, or typed for Saturday all land on a day that
// already has a plan, and tasksAwaitingPlan deliberately returns 0 there.
//
// So the task sat with a plan_date and no block: invisible on the calendar, indistinguishable
// from having been thrown away. That is the same shape as the deferral bug fixed on
// 2026-08-06 — this is the half of it that was left open. Audited 2026-08-08.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { tasksUnaccountedFor, tasksAwaitingPlan } from "../main/planner.ts";

const DATE = "2026-08-12";
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-unaccounted-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const addTask = (status = "inbox", planDate = DATE): number =>
  Number(
    db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                           is_mit, status, plan_date)
         VALUES ('work', 'focused_work', 3, 60, 60, 0, ?, ?)`
      )
      .run(status, planDate).lastInsertRowid
  );

const addPlan = (unplaced: unknown[] = []): number =>
  Number(
    db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
         VALUES (?, '1.0.0', '{}', '', ?)`
      )
      .run(DATE, JSON.stringify(unplaced)).lastInsertRowid
  );

const addBlock = (planId: number, taskId: number | null) =>
  db
    .prepare(
      `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
       VALUES (?, 'focused_work', 'work', ?, ?, 0, ?)`
    )
    .run(taskId, `${DATE}T09:00:00`, `${DATE}T10:00:00`, planId);

describe("tasksUnaccountedFor", () => {
  it("flags a task the plan has never seen", () => {
    addPlan();
    addTask();
    expect(tasksUnaccountedFor(db, DATE)).toBe(1);
  });

  it("a task the plan SCHEDULED is accounted for", () => {
    const planId = addPlan();
    const t = addTask();
    addBlock(planId, t);
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
  });

  it("a task the plan honestly reported as unplaced is accounted for", () => {
    // A day that said "I could not fit this" is not stale. Re-planning it on a loop every
    // 15 minutes would be churn with no new answer.
    const t = addTask();
    addPlan([{ taskId: t, title: "work", reason: "no_eligible_slot" }]);
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
  });

  it("only the NEWEST plan for the day counts", () => {
    const old = addPlan();
    const t = addTask();
    addBlock(old, t); // accounted for by the superseded plan…
    addPlan(); // …but the current one has never seen it
    expect(tasksUnaccountedFor(db, DATE)).toBe(1);
  });

  it("done and deferred work is not schedulable, so it is never flagged", () => {
    addPlan();
    addTask("done");
    addTask("deferred");
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
  });

  it("returns 0 when the day has no plan — that is tasksAwaitingPlan's job", () => {
    addTask();
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
    expect(tasksAwaitingPlan(db, DATE)).toBe(1);
  });

  it("unreadable unplaced bookkeeping does not cause a re-plan loop", () => {
    const planId = Number(
      db
        .prepare(
          `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
           VALUES (?, '1.0.0', '{}', '', 'not json')`
        )
        .run(DATE).lastInsertRowid
    );
    const t = addTask();
    addBlock(planId, t);
    // The block still accounts for it; the garbage is ignored rather than throwing.
    expect(() => tasksUnaccountedFor(db, DATE)).not.toThrow();
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
  });

  it("counts several newcomers at once", () => {
    const planId = addPlan();
    const known = addTask();
    addBlock(planId, known);
    addTask();
    addTask();
    expect(tasksUnaccountedFor(db, DATE)).toBe(2);
  });
});
