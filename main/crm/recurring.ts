// Materializing "everyday" as an actual instance on every day.
//
// Owner ask 2026-08-06: "I texted myself I need time to workout and gym everyday… it should
// have realized this is a preference and to add it in to my calendars." A recurring template
// (task.recurrence = 'daily', see migration 15) is not itself schedulable on any day but its
// own — this is what turns it into a normal task for whichever day is about to be planned, so
// the solver, windows, day-parts and every other rule apply unchanged. No separate scheduling
// path for recurring work; it is a regular task that appears on time.

import type { Db } from "../db/db.ts";
import { bufferedMinutes, type Doctrine, type BlockType } from "../engine/doctrine.ts";

/**
 * Ensure every 'daily' template has an instance for `dateISO`. The template's OWN row already
 * counts as its first day's instance, so nothing is created for that date. Never touches a
 * date in the past — a recurring task does not retroactively appear on days already lived.
 */
export function materializeRecurringTasks(
  db: Db,
  dateISO: string,
  today: string,
  /**
   * When given, each instance RECOMPUTES its estimated_minutes from the template's raw
   * estimate instead of copying the template's cached one.
   *
   * A template is long-lived and its cached estimate can be stale for reasons that have
   * nothing to do with today: a doctrine change, or a bug fixed after the template was
   * created. His gym template is the real case (2026-08-07). It was written when stated
   * durations were still inflated by the planning-fallacy multiplier, so it holds raw 75 /
   * estimated 105. Migration 16 recomputed the live rows but skipped the template itself
   * (it only touched status inbox/planned/in_progress, and the template had been completed),
   * so every day materialized afterwards inherited 105 and his 1.25-hour gym came back as
   * 1h45m — the exact complaint that started the day, reappearing on Aug 9 and Aug 10 after
   * Aug 7 and Aug 8 had been repaired.
   *
   * Deriving from raw makes the template's cached value irrelevant, which is the only way
   * this stops recurring.
   */
  doctrine?: Doctrine
): number {
  if (dateISO < today) return 0;

  const templates = db
    .prepare(
      `SELECT id, title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
              estimate_source, splittable, day_part, plan_date
         FROM task
        WHERE recurrence = 'daily' AND recurrence_parent_id IS NULL`
    )
    .all() as {
    id: number; title: string; block_type: string; cognitive_load: number | null;
    estimated_minutes: number | null; raw_estimate_minutes: number | null; estimate_source: string | null;
    splittable: number; day_part: string | null; plan_date: string | null;
  }[];
  if (templates.length === 0) return 0;

  const hasInstance = db.prepare(
    "SELECT 1 FROM task WHERE recurrence_parent_id = ? AND plan_date = ? LIMIT 1"
  );
  const insert = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
       is_mit, status, splittable, estimate_source, plan_date, day_part, recurrence_parent_id)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', ?, ?, ?, ?, ?)`
  );

  let created = 0;
  for (const t of templates) {
    // The template's own row already IS today's-of-its-creation instance.
    if (t.plan_date === dateISO) continue;
    if (hasInstance.get(t.id, dateISO)) continue;
    const raw = t.raw_estimate_minutes ?? t.estimated_minutes ?? 30;
    const source = t.estimate_source ?? "stated";
    const estimated = doctrine
      ? bufferedMinutes(doctrine, t.block_type as BlockType, raw, source === "stated" ? "stated" : "inferred")
      : t.estimated_minutes ?? 30;
    insert.run(
      t.title, t.block_type, t.cognitive_load ?? 3, estimated, raw,
      t.splittable, source, dateISO, t.day_part, t.id
    );
    created++;
  }
  if (created > 0) console.log(`recurring: materialized ${created} instance(s) for ${dateISO}`);
  return created;
}
