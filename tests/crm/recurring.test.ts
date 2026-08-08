// "Everyday" materializes as an actual instance on every day.
//
// Owner ask 2026-08-06: "I texted myself I need time to workout and gym everyday… it should
// have realized this is a preference and to add it in to my calendars." The template row is
// what he asked for; this is the mechanism that turns it into a real task on every day the app
// plans, not just the day he happened to say it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { materializeRecurringTasks } from "../../main/crm/recurring.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";

const TODAY = "2026-08-06";
const TOMORROW = "2026-08-07";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-recurring-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addTemplate(title: string, planDate: string, minutes = 75, type = "gym"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                           is_mit, status, plan_date, recurrence)
         VALUES (?, ?, 3, ?, ?, 0, 'inbox', ?, 'daily')`
      )
      .run(title, type, minutes, minutes, planDate).lastInsertRowid
  );
}

const forDay = (dateISO: string) =>
  db.prepare("SELECT title, plan_date, recurrence_parent_id FROM task WHERE plan_date = ?").all(dateISO) as any[];

describe("materializeRecurringTasks", () => {
  it("does nothing on the template's own day — it already IS that day's instance", () => {
    addTemplate("Gym", TODAY);
    expect(materializeRecurringTasks(db, TODAY, TODAY)).toBe(0);
    expect(forDay(TODAY)).toHaveLength(1);
  });

  it("gives a later day its own instance, linked to the template", () => {
    const id = addTemplate("Gym", TODAY);
    expect(materializeRecurringTasks(db, TOMORROW, TODAY)).toBe(1);
    const rows = forDay(TOMORROW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Gym", recurrence_parent_id: id });
  });

  it("is idempotent — running it twice for the same day does not duplicate", () => {
    addTemplate("Gym", TODAY);
    materializeRecurringTasks(db, TOMORROW, TODAY);
    materializeRecurringTasks(db, TOMORROW, TODAY);
    expect(forDay(TOMORROW)).toHaveLength(1);
  });

  it("carries the template's estimate and type forward", () => {
    addTemplate("Gym", TODAY, 90, "gym");
    materializeRecurringTasks(db, TOMORROW, TODAY);
    const row = db.prepare("SELECT block_type, estimated_minutes FROM task WHERE plan_date = ?").get(TOMORROW) as any;
    expect(row).toMatchObject({ block_type: "gym", estimated_minutes: 90 });
  });

  it("materializes every distinct recurring template", () => {
    addTemplate("Gym", TODAY, 75, "gym");
    addTemplate("Film content", TODAY, 30, "admin");
    expect(materializeRecurringTasks(db, TOMORROW, TODAY)).toBe(2);
    expect(forDay(TOMORROW).map((r) => r.title).sort()).toEqual(["Film content", "Gym"]);
  });

  it("never materializes into the past — a recurring task does not retroactively appear", () => {
    addTemplate("Gym", TODAY);
    expect(materializeRecurringTasks(db, "2026-08-01", TODAY)).toBe(0);
  });

  it("leaves an ordinary one-off task alone", () => {
    db.prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date)
       VALUES ('One-off errand', 'admin', 2, 30, 0, 'inbox', ?)`
    ).run(TODAY);
    expect(materializeRecurringTasks(db, TOMORROW, TODAY)).toBe(0);
    expect(forDay(TOMORROW)).toHaveLength(0);
  });
});

// ── a stale template must not re-infect every future day ────────────────────
//
// Owner-visible 2026-08-07, twice. His gym template was written while stated durations were
// still inflated by the planning-fallacy multiplier, so it holds raw 75 / estimated 105.
// Migration 16 recomputed the live rows but skipped the template — it only touched status
// inbox/planned/in_progress and the template had been completed — so the bad number survived
// in the one row every future day is copied from. Aug 7 and Aug 8 were repaired and then
// Aug 9 and Aug 10 materialized at 105 again: his 1.25-hour gym back at 1h45m, the exact
// complaint that started the day.
//
// Instances now DERIVE their estimate from the template's raw minutes, which makes the
// template's own cached value irrelevant — the only way this stops coming back.
describe("materializeRecurringTasks — estimates derive from raw, not from the template's cache", () => {
  const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

  /** His real gym template: raw 75, cached estimate 105 from the pre-fix multiplier. */
  function addStaleGymTemplate(): number {
    return Number(
      db
        .prepare(
          `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                             is_mit, status, plan_date, recurrence, estimate_source)
           VALUES ('Gym / workout', 'gym', 3, 105, 75, 0, 'done', ?, 'daily', 'stated')`
        )
        .run(TODAY).lastInsertRowid
    );
  }

  it("a stated 75 stays 75 even though the template caches 105", () => {
    addStaleGymTemplate();
    materializeRecurringTasks(db, TOMORROW, TODAY, doctrine);
    const inst = db
      .prepare("SELECT estimated_minutes e, raw_estimate_minutes r FROM task WHERE plan_date = ? AND recurrence_parent_id IS NOT NULL")
      .get(TOMORROW) as { e: number; r: number };
    expect(inst.r).toBe(75);
    expect(inst.e, "his 1.25 hours must not become 1h45m again").toBe(75);
  });

  it("an INFERRED estimate is still buffered — only stated durations are taken literally", () => {
    db.prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                         is_mit, status, plan_date, recurrence, estimate_source)
       VALUES ('Deep work', 'deep_work', 4, 60, 60, 0, 'inbox', ?, 'daily', 'inferred')`
    ).run(TODAY);
    materializeRecurringTasks(db, TOMORROW, TODAY, doctrine);
    const inst = db
      .prepare("SELECT estimated_minutes e FROM task WHERE plan_date = ? AND recurrence_parent_id IS NOT NULL")
      .get(TOMORROW) as { e: number };
    expect(inst.e).toBeGreaterThan(60);
  });

  it("without a doctrine it copies the template, as before", () => {
    addStaleGymTemplate();
    materializeRecurringTasks(db, TOMORROW, TODAY);
    const inst = db
      .prepare("SELECT estimated_minutes e FROM task WHERE plan_date = ? AND recurrence_parent_id IS NOT NULL")
      .get(TOMORROW) as { e: number };
    expect(inst.e).toBe(105);
  });
});
