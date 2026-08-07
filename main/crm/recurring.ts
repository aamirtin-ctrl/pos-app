// Materializing "everyday" as an actual instance on every day.
//
// Owner ask 2026-08-06: "I texted myself I need time to workout and gym everyday… it should
// have realized this is a preference and to add it in to my calendars." A recurring template
// (task.recurrence = 'daily', see migration 15) is not itself schedulable on any day but its
// own — this is what turns it into a normal task for whichever day is about to be planned, so
// the solver, windows, day-parts and every other rule apply unchanged. No separate scheduling
// path for recurring work; it is a regular task that appears on time.

import type { Db } from "../db/db.ts";

/**
 * Ensure every 'daily' template has an instance for `dateISO`. The template's OWN row already
 * counts as its first day's instance, so nothing is created for that date. Never touches a
 * date in the past — a recurring task does not retroactively appear on days already lived.
 */
export function materializeRecurringTasks(db: Db, dateISO: string, today: string): number {
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
    insert.run(
      t.title, t.block_type, t.cognitive_load ?? 3, t.estimated_minutes ?? 30, t.raw_estimate_minutes ?? 30,
      t.splittable, t.estimate_source ?? "stated", dateISO, t.day_part, t.id
    );
    created++;
  }
  if (created > 0) console.log(`recurring: materialized ${created} instance(s) for ${dateISO}`);
  return created;
}
