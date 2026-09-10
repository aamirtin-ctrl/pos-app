// Daily carry-over (owner ask 2026-08-16): "if a task isn't completed, it should carry over to
// the next day… for the AI learning one in specific, it should update the Notion accordingly,
// moving everything down one."
//
// Two behaviors, deliberately different:
//
//   • ORDINARY tasks (one-off, non-recurring): an unfinished task whose day has passed moves to
//     today. The planner re-solves today around it, and the existing Google Tasks reconcile
//     pushes the new date — no new write path.
//
//   • CURRICULUM instances (the "Learn agentic coding" daily recurring task enriched from the
//     Notion 30-day plan): the day's TOPIC is what was missed, and the sequence matters. So the
//     Notion calendar itself shifts — every not-done row from the missed day onward moves later
//     by the number of missed days — and the stale local instances are reset so the normal
//     enrichment pass re-fills them from the shifted dates. Notion stays the source of truth.
//
// Habit instances (gym / Instagram) are DROPPED when their day passes un-done (owner spec
// 2026-08-20: the Tasks tab shows today's three habits and nothing more). Tomorrow always
// materializes its own instance, so the drop IS the roll-over — carrying yesterday's forward
// would double it. Their Google rows are taken down by the push's dropped-cleanup pass.
//
// Untouched on purpose:
//   • window tasks (window_end set): the planner already owns advancing those day by day.
//   • templates: they are definitions, not work.

import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { AGENTIC_CURRICULUM_MARKER_PREFIX, curriculumDbIdFromNotes, shiftCurriculumDates } from "./notion.ts";

const INCOMPLETE = "('inbox','planned','in_progress')";

export function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO.slice(0, 10)}T12:00:00Z`).getTime();
  const b = new Date(`${toISO.slice(0, 10)}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export interface RolloverDeps {
  shiftCurriculum: typeof shiftCurriculumDates;
}

export interface RolloverResult {
  moved: number; // ordinary tasks carried to today
  curriculumShifted: number; // Notion rows pushed down the line
  curriculumFrom: string | null; // the missed date the shift started from
  droppedHabits: number; // missed habit instances self-cleaned (tomorrow's instance is the roll)
}

/**
 * Carry unfinished past work into today. Idempotent for a given day (the caller gates it on a
 * once-per-day setting key; re-running is also harmless — moved tasks stop matching).
 */
export async function rolloverMissedTasks(
  db: Db,
  secrets: SecretStore,
  todayISO: string,
  deps: RolloverDeps = { shiftCurriculum: shiftCurriculumDates }
): Promise<RolloverResult> {
  // ── ordinary one-off tasks → today ──
  const moved = db
    .prepare(
      `UPDATE task SET plan_date = ?, updated_at = datetime('now')
        WHERE plan_date IS NOT NULL AND plan_date < ?
          AND status IN ${INCOMPLETE}
          AND recurrence_parent_id IS NULL
          AND (recurrence IS NULL OR recurrence = '')
          AND window_end IS NULL`
    )
    .run(todayISO, todayISO).changes;

  // ── curriculum: shift the Notion plan, reset local instances, let enrichment re-fill ──
  let curriculumShifted = 0;
  let curriculumFrom: string | null = null;
  if (secrets.get("NOTION_TOKEN")) {
    const templates = db
      .prepare(
        `SELECT id, title, notes FROM task
          WHERE recurrence = 'daily' AND recurrence_parent_id IS NULL AND notes LIKE ?`
      )
      .all(`%${AGENTIC_CURRICULUM_MARKER_PREFIX}%`) as { id: number; title: string; notes: string | null }[];

    for (const t of templates) {
      const dbId = curriculumDbIdFromNotes(t.notes);
      if (!dbId) continue;
      const missed = db
        .prepare(
          `SELECT id, plan_date FROM task
            WHERE recurrence_parent_id = ? AND plan_date IS NOT NULL AND plan_date < ?
              AND status IN ${INCOMPLETE}
            ORDER BY plan_date ASC`
        )
        .all(t.id, todayISO) as { id: number; plan_date: string }[];
      if (!missed.length) continue;

      const from = missed[0].plan_date;
      const delta = daysBetweenISO(from, todayISO);
      // Notion first: if the shift throws, nothing local is touched and the next day retries.
      const s = await deps.shiftCurriculum(secrets, dbId, from, delta);
      curriculumShifted += s.shifted;
      curriculumFrom = curriculumFrom ?? from;

      // The missed instances' topics now live on later days — drop the stale local copies.
      const ids = missed.map((m) => m.id).join(",");
      db.prepare(`UPDATE task SET status = 'dropped', updated_at = datetime('now') WHERE id IN (${ids})`).run();

      // Already-enriched instances from today onward carry topics that just moved. Reset them
      // to the template's generic title — that equality IS enrichment's "not yet enriched"
      // sentinel, so the regular pass re-fetches each day's (new) topic from Notion.
      db.prepare(
        `UPDATE task SET title = ?, notes = NULL, updated_at = datetime('now')
          WHERE recurrence_parent_id = ? AND plan_date >= ? AND status IN ${INCOMPLETE} AND title <> ?`
      ).run(t.title, t.id, todayISO, t.title);
    }
  }

  // ── habit instances: a missed day self-cleans; tomorrow's instance is the roll-over ──
  // Curriculum children are excluded: their missed days are handled by the Notion shift above
  // (and, with no Notion token, deliberately wait rather than silently skipping a topic).
  const droppedHabits = db
    .prepare(
      `UPDATE task SET status = 'dropped', updated_at = datetime('now')
        WHERE recurrence_parent_id IS NOT NULL
          AND recurrence_parent_id NOT IN
            (SELECT id FROM task WHERE notes LIKE '%${AGENTIC_CURRICULUM_MARKER_PREFIX}%')
          AND plan_date IS NOT NULL AND plan_date < ?
          AND status IN ${INCOMPLETE}`
    )
    .run(todayISO).changes;

  return { moved, curriculumShifted, curriculumFrom, droppedHabits };
}
