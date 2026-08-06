// Planner orchestration: braindump → tasks → grid+solve → narrate → persist.
// Ties the four engine stages to the DB and Google anchors. Push is explicit.

import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import type { LlmClient } from "./llm/provider.ts";
import { loadDoctrine, type Doctrine } from "./engine/doctrine.ts";
import { parseBraindump } from "./engine/parse.ts";
import {
  solve,
  ENGINE_VERSION,
  DEFERRED_REASON,
  nextDayInWindow,
  type PlannerTask,
} from "./engine/solver.ts";
import type { Anchor } from "./engine/grid.ts";
import { narrate, deterministicNarration } from "./engine/narrate.ts";
import { withPreferences } from "./preferences.ts";
import {
  readAnchors,
  mergeCalendarSources,
  inferFlexibility,
  pushPlan,
  pushTasks,
  persistDayCache,
  readDayCache,
  type GcalPushDeps,
  type MergeableGoogleAnchor,
  type MergeableAppleEvent,
} from "./gcal/sync.ts";
import { getSetting } from "./db/db.ts";
import { hasCalendarWriteScope, isGoogleConnected, RECONSENT_REQUIRED } from "./gcal/auth.ts";
import { readAppleEvents, appleBlockType, excludedCalendarNames } from "./applecal.ts";
import { eventsForDate as icsEventsForDate, icsBlockType } from "./icscal.ts";
import { wakeTimeFor } from "./wake.ts";

const toIso = (dateISO: string, min: number) =>
  `${dateISO}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;
const fromIso = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

export async function braindump(db: Db, doctrineDir: string, llm: LlmClient | null, text: string, dateISO: string) {
  const doctrine = loadDoctrine(doctrineDir);
  // The braindump parse is a JUDGMENT call ("is this deep work?", "how long will it take?"),
  // so the owner's own preferences ride along with it. engine/parse.ts takes no context
  // argument and owns its prompt, so the block is injected at the LLM client instead of
  // through the signature — see withPreferences() in main/preferences.ts.
  const { tasks, usedLlm } = await parseBraindump(
    text,
    doctrine,
    withPreferences(llm, doctrineDir, ["plan_parse"]),
    dateISO
  );
  const ins = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
       is_mit, hard_deadline_at, status, splittable, estimate_source, plan_date, notes,
       window_start, window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const t of tasks) {
      // A window is written ONLY for work he said was flexible across a range (migration 9's
      // invariant). "Tomorrow" also carries a date, but it is a commitment to a day, and a
      // window_end there would license the planner to shuffle it — the opposite of what he said.
      const windowEnd = t.flexible && t.windowEnd && t.windowEnd > dateISO ? t.windowEnd : null;
      ins.run(
        t.title, t.blockType, t.cognitiveLoad, t.estimatedMinutes, t.rawEstimateMinutes,
        t.isMit ? 1 : 0,
        t.hardDeadlineAt ? `${dateISO}T${t.hardDeadlineAt}:00` : null,
        t.splittable ? 1 : 0, t.estimateSource, dateISO,
        t.personHint ? `person: ${t.personHint}` : null,
        windowEnd ? dateISO : null, windowEnd
      );
    }
  });
  tx();
  return { tasks: listTasks(db, dateISO), usedLlm };
}

/**
 * Statuses a task can be scheduled from. A WHITELIST on purpose: the old rule was
 * `status != 'done'`, which quietly means "anything unexpected is schedulable".
 *
 * That bit on 2026-08-06. Merging the owner's two duplicate Stanford tasks, the redundant one
 * was retired with status 'dropped' — which is a COMMITMENT status; a task's are
 * inbox/planned/in_progress/done/deferred. It did not match 'done', so the solver happily
 * put "Set time later this week" back on his calendar. A typo should cost a row, not
 * resurrect work he was told had been merged away.
 */
export const SCHEDULABLE_TASK_STATUSES = ["inbox", "planned", "in_progress"] as const;

/**
 * Everything that may legitimately be scheduled on `dateISO`.
 *
 * Two pools, and the second one is the point (owner ask 2026-08-06: "I want the system to be
 * completely adaptable to a bunch of calendar changes and still fit stuff in free spaces as
 * they pop up or move stuff around. Right now for today I initially had, like, a three hour
 * hangout block that I deleted, so now there's a bunch of free space where I can do stuff"):
 *
 *   1. plan_date == dateISO — the day's own work, as always.
 *   2. WINDOWED work parked on a LATER day whose window still covers this one.
 *
 * Without (2) deferral is a one-way door. His advising task moved to Friday while the day was
 * tight; he then deleted a three-hour hangout, today reopened with nearly six hours free, and
 * the task could not come back because the solve only ever looked at `plan_date = today`. The
 * engine was re-solving a day it could no longer see the work for.
 *
 * A window means "any day in here", so it has to mean that in BOTH directions. Same-day work
 * still outranks it (solver.windowRank), so pulling back can never cost today's own work its
 * place — it only ever spends time that would otherwise sit empty.
 */
export function listTasks(db: Db, dateISO: string) {
  const status = SCHEDULABLE_TASK_STATUSES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM task
        WHERE status IN (${status})
          AND (
            plan_date = ?
            OR (
              -- parked later, but this day is inside its window: eligible to come back
              window_end IS NOT NULL
              AND plan_date > ?
              AND window_end >= ?
              AND COALESCE(window_start, '0000-01-01') <= ?
            )
          )
        ORDER BY id`
    )
    .all(...SCHEDULABLE_TASK_STATUSES, dateISO, dateISO, dateISO, dateISO) as Record<string, unknown>[];
}

/**
 * Every external event for a date, from all three sources, merged and TIERED.
 *
 * Extracted from generatePlan so `replanIfConflicted` compares the accepted plan against
 * exactly the same anchor set the next generation would use — a re-plan triggered by a
 * different view of the day than the one that re-plans it would be a bug generator.
 *
 * Each anchor carries the `flexibility` inferred at its source (gcal/sync.inferFlexibility).
 * Anything that declares no tier defaults to `fixed` inside the engine, so a source that
 * has not been taught about flexibility still behaves as it always did.
 *
 * Every source is best-effort — a dead feed or a revoked permission must never break
 * planning — but "best-effort" and "there is nothing on the calendar" are indistinguishable
 * in the return value, and one of them means the opposite of the other. Pass `problems` to
 * learn which happened: it collects one message per source that failed. The re-plan path
 * uses it to refuse to treat an unreachable Google as "he deleted everything".
 */
export async function externalAnchors(
  db: Db,
  secrets: SecretStore,
  dateISO: string,
  problems?: string[]
): Promise<Anchor[]> {
  const googleAnchors: MergeableGoogleAnchor[] = [];
  if (isGoogleConnected(secrets)) {
    try {
      googleAnchors.push(...(await readAnchors(db, secrets, dateISO)));
    } catch (e) {
      const msg = `gcal anchors unavailable: ${(e as Error).message}`;
      console.warn(msg);
      problems?.push(msg);
    }
  }

  // Apple Calendar (Calendar.app) events anchor the day too, so a Mac-only event still
  // blocks time in POS. Best-effort: a missing permission must never break planning.
  const appleEvents: MergeableAppleEvent[] = [];
  try {
    for (const ev of await readAppleEvents(dateISO, { exclude: excludedCalendarNames(db) })) {
      if (ev.allDay) continue; // same rule as the Google path — all-day never blocks
      const blockType = appleBlockType(ev.title, ev.calendar);
      appleEvents.push({
        uid: ev.uid,
        title: ev.title,
        startMin: ev.startMin,
        endMin: ev.endMin,
        blockType,
        // Apple gives us no attendee list, so the title and the calendar name are the
        // whole evidence set — the same rules, just less to go on.
        flexibility: inferFlexibility({ title: ev.title, calendarName: ev.calendar, blockType }),
      });
    }
  } catch (e) {
    const msg = `apple calendar anchors unavailable: ${(e as Error).message}`;
    console.warn(msg);
    problems?.push(msg);
  }

  // Subscribed webcal/ICS feeds anchor the day too. Same shape as Apple events —
  // their RFC 5545 UID rides along so the merge can recognise an event that also
  // reaches us through Google or Apple. Best-effort: a dead feed never breaks planning.
  const icsEvents: MergeableAppleEvent[] = [];
  try {
    for (const ev of await icsEventsForDate(db, dateISO)) {
      if (ev.allDay) continue; // same rule as the Google/Apple paths — all-day never blocks
      const blockType = icsBlockType(ev.title);
      icsEvents.push({
        uid: ev.uid,
        title: ev.title,
        startMin: ev.startMin,
        endMin: ev.endMin,
        blockType,
        flexibility: inferFlexibility({ title: ev.title, blockType }),
      });
    }
  } catch (e) {
    const msg = `ics anchors unavailable: ${(e as Error).message}`;
    console.warn(msg);
    problems?.push(msg);
  }

  // One event living in two systems must block the day exactly once. The join is the
  // RFC 5545 UID, which survives cross-system sync — so a renamed or rescheduled event
  // is still recognised as the same event.
  const merged = mergeCalendarSources(googleAnchors, [...appleEvents, ...icsEvents]);
  return merged.anchors.map((a) => ({
    startMin: a.startMin,
    endMin: a.endMin,
    blockType: a.blockType,
    title: a.title,
    flexibility: a.flexibility,
  }));
}

/**
 * What a block IS, independent of when it was scheduled — the join that lets a re-plan
 * recognise a block it already has a Google event for.
 *
 * A task-backed block is identified by its task: the whole point is that moving "Stanford
 * advising" from 10:45 to 14:00 updates one event rather than deleting and recreating it.
 * Everything else (rituals, breaks, meals, comms windows) has no task, so it falls back to
 * type + title, which is stable for exactly the blocks doctrine generates every day.
 */
export function blockIdentity(b: { task_id: number | null; block_type: string; title: string | null }): string {
  return b.task_id != null ? `t:${b.task_id}` : `k:${b.block_type}|${(b.title ?? "").trim().toLowerCase()}`;
}

/** How long the push fired by plan GENERATION may run before the plan is returned anyway. */
export const GENERATE_PUSH_TIMEOUT_MS = 10_000;

export async function generatePlan(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  dateISO: string,
  deps?: ReplanDeps
) {
  const stored: Doctrine = loadDoctrine(doctrineDir);

  // Plan against the wake time that ACTUALLY happened, when the owner reported one
  // (main/wake.ts). The whole doctrine is expressed in hours-after-wake — the energy curve,
  // the first-hour cognitive ban, every ritual offset, and therefore the shutdown boundary —
  // so overriding this one field shifts the entire day correctly and nothing downstream
  // needs to know about it.
  //
  // A COPY, for this date's plan only: the stored doctrine.yaml is the owner's intention and
  // is never rewritten by an observation. Tomorrow, with no wake reported, falls back to it.
  const wakeTime = wakeTimeFor(db, dateISO, stored);
  const doctrine: Doctrine =
    wakeTime === stored.chronotype.wake_time
      ? stored
      : { ...stored, chronotype: { ...stored.chronotype, wake_time: wakeTime } };

  // anchors: external GCal events + locked blocks from prior plans for this date.
  // `deps.anchors` exists so the re-plan path (and its tests) can hand the SAME anchor set
  // to the check and to the regeneration it triggers — reading the calendar twice could
  // otherwise re-plan the day around an event the new plan never sees.
  const anchors: Anchor[] = await readExternal(db, secrets, dateISO, deps);

  // What the day looked like OUTSIDE this app at generation time. Stored below so the
  // re-plan sweep can tell "the calendar changed since this plan was made" from "the
  // calendar is exactly what this plan was already built around" — see anchorFingerprint.
  const externalFingerprint = anchorFingerprint(anchors);

  const lockedRows = db
    .prepare("SELECT task_id, block_type, title, starts_at, ends_at FROM block WHERE is_locked = 1 AND date(starts_at) = ?")
    .all(dateISO) as {
    task_id: number | null; block_type: string; title: string; starts_at: string; ends_at: string;
  }[];
  // ── a pinned block IS that task's placement ────────────────────────────────
  //
  // Owner report 2026-08-06: "it duplicated the stanford math test and then locked it."
  //
  // A pin becomes a fixed ANCHOR, and anchors carry no task_id — so the task behind it stayed
  // in the pool and the solver dutifully scheduled it a second time. His day ended up with the
  // pinned "Take Stanford math test" at 13:45 AND a fresh one at 16:45. The pin has to remove
  // the task from the pool, not just reserve the minutes.
  const pinnedTaskIds = new Set(
    lockedRows.map((b) => b.task_id).filter((id): id is number => id != null)
  );
  // …and the block the regeneration inserts for that anchor has to get the task link back,
  // or the popover loses it and the Google event identity changes on every re-solve.
  const pinnedTaskBySpan = new Map(
    lockedRows
      .filter((b) => b.task_id != null)
      .map((b) => [`${fromIso(b.starts_at)}|${fromIso(b.ends_at)}`, b.task_id as number])
  );
  // The spans the owner has PINNED, so the regenerated blocks can carry the pin forward.
  // Without this a pin survives exactly one regeneration — lockedRows is read before the
  // old plan is deleted, but the new blocks were inserted with is_locked = 0, so the next
  // re-plan found nothing locked and moved the block back. A pin that silently expires is
  // worse than no pin: the owner drags something, watches it stay, and finds it moved later.
  const pinnedSpans = new Set(
    lockedRows.map((b) => `${fromIso(b.starts_at)}|${fromIso(b.ends_at)}`)
  );
  for (const b of lockedRows) {
    anchors.push({
      startMin: fromIso(b.starts_at),
      endMin: fromIso(b.ends_at),
      blockType: b.block_type as Anchor["blockType"],
      title: b.title ?? "(locked)",
      // The owner pinned this placement himself. That is the strongest signal there is —
      // it outranks whatever tier the event carried before he pinned it.
      flexibility: "fixed",
    });
  }

  // ── the past is not schedulable ────────────────────────────────────────────
  //
  // Owner report 2026-08-06 at 11:40: "when I move stuff in my schedule around, it can't add
  // or change events into times that have already passed. I think it added unpack travel bag
  // from nine AM to nine thirty. But it's eleven forty right now, that already passed."
  //
  // Nothing in the engine knew what time it was. Every re-solve treated the whole day as
  // available, so the morning was handed out again hours after it was gone — and today has
  // been re-solved many times. Two halves: a FLOOR so nothing new lands in the past, and the
  // blocks that already happened carried forward as fixed anchors so his morning does not
  // simply vanish from the plan (and from Google) the first time the day is re-solved.
  // Titles already covered by a block carried forward from earlier today. A ritual whose work
  // is already on the day must NOT be placed again — that is what put two Lunches on his
  // calendar (one carried forward from 13:15, one freshly placed at 14:00).
  const carriedLabels = new Set<string>();
  const nowFloor = floorFor(dateISO, deps?.now ?? new Date());
  if (nowFloor !== null) {
    const pastRows = db
      .prepare(
        `SELECT b.task_id, b.block_type, b.title, b.starts_at, b.ends_at
           FROM block b JOIN plan p ON p.id = b.plan_id
          WHERE p.plan_date = ? AND b.starts_at < ?
            -- Only what is OURS. An external calendar anchor must not be carried forward:
            -- readExternal re-reads it if it still exists, and if it does not, carrying it
            -- would resurrect an appointment he CANCELLED. (Caught by the freed-window test:
            -- a cancelled dentist appointment came back from the morning's plan.)
            AND (b.is_anchor = 0 OR b.is_locked = 1)
          ORDER BY b.starts_at`
      )
      .all(dateISO, toIso(dateISO, nowFloor)) as {
      task_id: number | null; block_type: string; title: string; starts_at: string; ends_at: string;
    }[];
    for (const b of pastRows) {
      const startMin = fromIso(b.starts_at);
      const endMin = fromIso(b.ends_at);
      if (endMin <= startMin) continue; // malformed row — never anchor on it
      const span = `${startMin}|${endMin}`;
      if (pinnedTaskBySpan.has(span) || anchors.some((a) => a.startMin === startMin && a.endMin === endMin)) continue;
      anchors.push({
        startMin,
        endMin,
        blockType: b.block_type as Anchor["blockType"],
        title: b.title ?? "(earlier today)",
        // It already happened. Nothing outranks that.
        flexibility: "fixed",
      });
      // Pinned by reality: it already happened. Recording the span here makes the regenerated
      // block carry is_locked=1, which is what gets it PUSHED — pushPlan skips plain anchors,
      // so without this his morning stayed local while stale copies lingered in Google.
      pinnedSpans.add(span);
      if (b.task_id != null) {
        pinnedTaskIds.add(b.task_id);
        pinnedTaskBySpan.set(span, b.task_id);
      }
      carriedLabels.add((b.title ?? "").trim());
    }
  }

  // A task already placed — pinned by a drag, or sitting in a block that has already begun —
  // must not be offered to the solver again. Offering it is what duplicated his math test.
  const allTaskRows = listTasks(db, dateISO);
  const taskRows = allTaskRows.filter((r: any) => !pinnedTaskIds.has(r.id as number));

  // Windowed work parked on a LATER day that this solve is allowed to reclaim. Tracked so the
  // deferral bookkeeping below can tell "this day's own work slipped" from "another day's work
  // was offered this day's leftovers and didn't take them" — the second is not a deferral and
  // must never move the date the task is already parked on.
  const pulledBack = new Map<number, string>(
    taskRows
      .filter((r: any) => r.plan_date && r.plan_date !== dateISO)
      .map((r: any) => [r.id as number, r.plan_date as string])
  );
  const tasks: PlannerTask[] = taskRows.map((r: any) => ({
    id: r.id,
    title: r.title,
    blockType: r.block_type,
    cognitiveLoad: r.cognitive_load ?? 3,
    estimatedMinutes: r.estimated_minutes ?? 30,
    isMit: !!r.is_mit,
    deadlineMin: r.hard_deadline_at && String(r.hard_deadline_at).startsWith(dateISO) ? fromIso(r.hard_deadline_at) : null,
    project: r.project ?? null,
    splittable: !!r.splittable,
    // A window makes plan_date a CHOICE rather than a commitment — the solver may hand this
    // task back as `deferred_within_window` and it is moved below.
    windowEnd: (r.window_end as string | null) ?? null,
    // Every task is offered to the solver AS THIS DAY'S candidate, including one reclaimed
    // from later: `planDate` is what the solver ranks and defers against, and the question it
    // is answering is "does this belong today?". The real parked date lives in `pulledBack`.
    planDate: dateISO,
  }));

  // Drop the rituals a carried-forward block already satisfies, so the day is not given a
  // second Lunch (or a second morning routine) on top of the one he already had.
  const doctrineForSolve: Doctrine =
    carriedLabels.size === 0
      ? doctrine
      : { ...doctrine, fixed_rituals: doctrine.fixed_rituals.filter((r) => !carriedLabels.has(r.label)) };

  const result = solve(tasks, doctrineForSolve, anchors, { floorMin: nowFloor ?? undefined });

  // Work reclaimed from a later day and actually seated here — its date follows the block.
  const reclaimed = result.blocks
    .filter((b) => b.taskId != null && pulledBack.has(b.taskId))
    .map((b) => b.taskId as number);
  // The days those tasks came FROM are now wrong: they still hold a plan built around work
  // that has moved here. Their un-accepted plans are dropped so the sweep re-solves them
  // (blocks cascade, so their Google events are withdrawn by the tombstone trigger).
  const releasedDates = [...new Set(reclaimed.map((id) => pulledBack.get(id)!))];

  // ── deadline windows: the task that has all week actually moves ─────────────
  //
  // Owner report 2026-08-06. He captured "two hours to go through my Stanford academic
  // advising stuff — I could do this the rest of the week, it doesn't have to be today" and,
  // the next day, "two hours for a Stanford math test today". The advising task was pinned to
  // one day, so it spent that day competing with a test that genuinely had to happen. His
  // expectation, verbatim: the app should have remembered the work was due anytime this week
  // and moved it.
  //
  // `deferred_within_window` is the solver saying "not today, and it still has time". Acting
  // on it is what makes the promise real — tomorrow's plan reads plan_date and picks the task
  // up with no further intervention. Nothing else about the task changes: not its window, not
  // its estimate, not its status (it stays `inbox` for the day it lands on, which is why this
  // runs BEFORE the status sweep below).
  const deferrals = result.unplaced
    .filter((u) => u.reason === DEFERRED_REASON)
    .map((u) => ({ task: u.task, movedTo: nextDayInWindow(u.task) }))
    .filter((d): d is { task: PlannerTask; movedTo: string } => d.movedTo !== null);
  // Same injection for the narration: a chief of staff explaining the day should know the
  // owner's standing preferences, not just the blocks that came out of the solver.
  const narration = deps?.fast
    ? deterministicNarration(result, doctrine)
    : await narrate(result, doctrine, withPreferences(llm, doctrineDir, ["narration"]));

  // persist: replace any prior un-accepted plan for the date
  const persist = db.transaction(() => {
    // ── carry Google's event ids across the re-plan ───────────────────────────
    //
    // Since pushing became automatic, a re-plan is a calendar edit. Without this map every
    // regeneration would DELETE the day's events and create fresh ones — the owner would
    // watch his calendar flicker, and anything he had dragged in Google would lose the
    // identity that reconcileMovedEvents uses to notice he moved it. Matching on what the
    // block IS lets an unchanged block keep its event and simply be updated in place.
    const carry = new Map<string, string>(
      (
        db
          .prepare(
            `SELECT b.task_id, b.block_type, b.title, b.gcal_event_id
               FROM block b JOIN plan p ON p.id = b.plan_id
              WHERE p.plan_date = ? AND b.gcal_event_id IS NOT NULL AND b.is_anchor = 0`
          )
          .all(dateISO) as { task_id: number | null; block_type: string; title: string | null; gcal_event_id: string }[]
      ).map((b) => [blockIdentity(b), b.gcal_event_id])
    );

    const old = db
      .prepare("SELECT id FROM plan WHERE plan_date = ? AND accepted_at IS NULL")
      .all(dateISO) as { id: number }[];
    for (const o of old) db.prepare("DELETE FROM plan WHERE id = ?").run(o.id); // blocks cascade → tombstoned

    // An ACCEPTED plan's row survives (it owns the day's outcome history), but it is no
    // longer the live schedule, so it must give up its events — otherwise Google would show
    // this plan and its predecessor stacked on the same hours. Tombstone them explicitly,
    // since no DELETE fires here for the trigger to catch.
    db.prepare(
      `INSERT OR IGNORE INTO gcal_tombstone (event_id, calendar_id)
       SELECT b.gcal_event_id, (SELECT value FROM setting WHERE key = 'pos_calendar_id')
         FROM block b JOIN plan p ON p.id = b.plan_id
        WHERE p.plan_date = ? AND b.gcal_event_id IS NOT NULL`
    ).run(dateISO);
    db.prepare(
      `UPDATE block SET gcal_event_id = NULL
        WHERE plan_id IN (SELECT id FROM plan WHERE plan_date = ?)`
    ).run(dateISO);
    // The snapshot is the EFFECTIVE doctrine (observed wake folded in), not the file on
    // disk: it exists to explain why this plan looks the way it does, and a 06:40 wake is
    // the reason half of it moved.
    const { lastInsertRowid } = db
      .prepare("INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks) VALUES (?, ?, ?, ?, ?)")
      .run(dateISO, ENGINE_VERSION, JSON.stringify(doctrine), narration,
        JSON.stringify(result.unplaced.map((u) => ({
          taskId: u.task.id,
          title: u.task.title,
          reason: u.reason,
          // Only ever present on a deferral: where the work went, so the surface reading this
          // can say "moved to Friday" instead of listing it as something that fell off.
          ...(u.reason === DEFERRED_REASON ? { movedTo: nextDayInWindow(u.task) } : {}),
        }))));
    const planId = Number(lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id,
         capacity_score_at_placement, flexibility, gcal_event_id, is_locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const reclaim = db.prepare("DELETE FROM gcal_tombstone WHERE event_id = ?");
    // ── one day, one Lunch ────────────────────────────────────────────────────
    //
    // Owner report 2026-08-06, with a screenshot: two Lunches, and after the first fix still
    // two. A carried-forward block reserves the minutes it already occupied, and the doctrine
    // ritual is then solved on top; filtering the ritual by label ahead of the solve was
    // supposed to prevent that and demonstrably did not on his real data.
    //
    // Rather than keep chasing which path emits the second one, this is the invariant itself:
    // a plan may not contain the same ritual twice. Task-backed blocks are exempt — splittable
    // deep work is legitimately two blocks with one title — so this only collapses the
    // scaffolding, which is the only thing that was ever duplicated.
    const seenRitual = new Set<string>();
    const ritualKey = (b: { taskId?: number; blockType: string; title: string }) =>
      b.taskId != null ? null : `${b.blockType}|${(b.title ?? "").trim().toLowerCase()}`;
    for (const b of result.blocks) {
      const rk = ritualKey(b);
      if (rk !== null) {
        if (seenRitual.has(rk)) continue; // the earlier placement wins; this one is a repeat
        seenRitual.add(rk);
      }
      // A block that survived the re-plan takes its predecessor's event back — and with it,
      // the deletion that was just queued against it. `delete` first, `take` once: the map
      // entry is consumed so two same-titled blocks can never claim one event.
      const key = blockIdentity({ task_id: b.taskId ?? null, block_type: b.blockType, title: b.title });
      const inherited = b.isAnchor ? undefined : carry.get(key);
      if (inherited) { carry.delete(key); reclaim.run(inherited); }
      const span = `${b.startMin}|${b.endMin}`;
      // An anchor sitting on a pinned span is that task's block — give it its task back.
      const taskId = b.taskId ?? (b.isAnchor ? pinnedTaskBySpan.get(span) ?? null : null);
      ins.run(taskId, b.blockType, b.title, toIso(dateISO, b.startMin), toIso(dateISO, b.endMin),
        b.isAnchor ? 1 : 0, planId, b.capacityAtPlacement ?? null,
        // The solver stamps every block; the fallback only covers a hand-built PlacedBlock.
        b.flexibility ?? (b.isAnchor ? "fixed" : "flexible"),
        inherited ?? null,
        // Carry the pin: a block landing on a span the owner pinned stays pinned, so the
        // NEXT regeneration still sees it as fixed rather than quietly reclaiming the time.
        pinnedSpans.has(`${b.startMin}|${b.endMin}`) ? 1 : 0);
    }
    // Move the deferred work off this day BEFORE the status sweep, so it lands on its new day
    // as `inbox` — it was not planned today, it was postponed. The guard clause is the pin: a
    // task whose placement the owner locked for this date is his decision, never the engine's
    // to revisit, however much window it has left.
    const defer = db.prepare(
      `UPDATE task SET plan_date = ?, window_start = COALESCE(window_start, ?)
        WHERE id = ? AND plan_date = ?
          AND NOT EXISTS (
            SELECT 1 FROM block b
             WHERE b.task_id = task.id AND b.is_locked = 1 AND date(b.starts_at) = ?
          )`
    );
    for (const d of deferrals) defer.run(d.movedTo, dateISO, d.task.id, dateISO, dateISO);
    // Work reclaimed from a later day moves ONTO this one, so the day that was holding it
    // stops holding it and the next solve of that day no longer sees it. Without this the
    // task would be scheduled twice — here, and again where it was parked.
    const moveTaskHere = db.prepare("UPDATE task SET plan_date = ? WHERE id = ?");
    for (const id of reclaimed) moveTaskHere.run(dateISO, id);
    // …and the day it left is re-opened. Only un-accepted plans: a day the owner locked is
    // his, and a task cannot be quietly pulled out from under a schedule he committed to.
    const release = db.prepare("DELETE FROM plan WHERE plan_date = ? AND accepted_at IS NULL");
    for (const d of releasedDates) release.run(d);
    db.prepare("UPDATE task SET status = 'planned' WHERE plan_date = ? AND status = 'inbox'").run(dateISO);
    persistDayCache(db, ANCHOR_FINGERPRINT_PREFIX, dateISO, JSON.stringify(externalFingerprint));
    return planId;
  });
  const planId = persist();

  // ── the plan reaches Google because it exists, not because it was approved ──
  //
  // Owner directive 2026-08-06: "it should automatically populate to my Google Calendar, it
  // shouldn't require me to press a button." Pushing was already automatic — but only from
  // acceptPlan, and accepting was a button. His plan for the day therefore sat with
  // accepted_at NULL and never left the laptop.
  //
  // Best-effort and time-boxed: a slow or unreachable Google delays the answer by at most
  // GENERATE_PUSH_TIMEOUT_MS and never costs him the plan itself, because `pushed_at` stays
  // NULL and workers.sweepAutoPush retries on the next tick.
  if (deps?.fast) {
    // Fire and forget: the owner's day is already correct on screen, and sweepAutoPush
    // retries anything that does not land.
    if (autoPushEnabled(db)) {
      void pushPlanToGoogle(db, secrets, planId, deps?.push).catch((e: Error) =>
        console.warn(`planner: background push failed (${e.message})`)
      );
    }
    const quick = getPlan(db, dateISO, planId);
    return quick ? { ...quick, push: { pushed: 0, tasks: 0, withdrawn: 0 } } : null;
  }

  const push: PlanPushResult = autoPushEnabled(db)
    ? await withTimeout(
        pushPlanToGoogle(db, secrets, planId, deps?.push),
        GENERATE_PUSH_TIMEOUT_MS,
        "Google push timed out"
      ).catch((e: Error) => ({ pushed: 0, tasks: 0, withdrawn: 0, error: e.message }))
    : { pushed: 0, tasks: 0, withdrawn: 0, error: "auto_push_off" };

  const view = getPlan(db, dateISO, planId);
  return view ? { ...view, push } : null;
}

// ── dragging a block, and letting the day rebuild around it ──────────────────
//
// Owner ask 2026-08-06: "You should make it possible for me to move around different events
// in the app. And when I move around the events, the breaks and whatever else can change
// accordingly to the scheduling best practices."
//
// The mechanism already existed for GOOGLE: move a POS event in Google Calendar and
// reconcileMovedEvents pins the block (is_locked = 1) so the planner treats it as immovable
// and re-solves everything else around it. This is the same contract, driven from inside the
// app — the drag PINS, and the day is then re-solved from scratch, so breaks, transitions and
// recovery time are recomputed by doctrine rather than dragged along by hand.

/** Drags snap to the solver's own slot size — a block off-grid could never be re-placed. */
export const MOVE_SNAP_MIN = 15;

/** Typed refusals, so the UI can explain rather than just fail. */
export type MoveBlockError = "not_found" | "external_event" | "past_day";

export interface MoveBlockResult {
  moved: boolean;
  error?: MoveBlockError;
  /** The re-solved day, when the move went through. */
  plan?: unknown;
}

const clampMin = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Move one block to a new start time, pin it there, and re-solve its day around the pin.
 *
 * External calendar events are refused: they belong to Google (or Apple), and moving them
 * here would put the two copies out of step with no way to tell which is right. The owner
 * moves those in the calendar they came from, and reconcileMovedEvents picks the change up.
 */
export async function moveBlock(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  blockId: number,
  newStartMin: number,
  deps?: ReplanDeps
): Promise<MoveBlockResult> {
  const row = db
    .prepare(
      `SELECT b.id, b.is_anchor, b.is_locked, b.starts_at, b.ends_at, p.plan_date
         FROM block b JOIN plan p ON p.id = b.plan_id
        WHERE b.id = ?`
    )
    .get(blockId) as
    | { id: number; is_anchor: number; is_locked: number; starts_at: string; ends_at: string; plan_date: string }
    | undefined;
  if (!row) return { moved: false, error: "not_found" };
  // `is_anchor` alone is the wrong test, and using it locked him out of his own blocks: past
  // blocks are carried forward as anchors and pins are re-read as anchors, so after one drag
  // most of the day was is_anchor=1 and nothing could be moved again. An anchor he PINNED is
  // his own placement. An anchor he did not is an external calendar event (or already behind
  // him), and that is the one this refuses.
  if (row.is_anchor === 1 && row.is_locked !== 1) return { moved: false, error: "external_event" };

  const dateISO = row.plan_date;
  const duration = Math.max(MOVE_SNAP_MIN, fromIso(row.ends_at) - fromIso(row.starts_at));
  // Snap to the grid and keep the block inside the day it belongs to; the length is the
  // owner's estimate and a drag never changes it.
  // The latest start that keeps the whole block inside its OWN date, on the grid. A block
  // ending at exactly 24:00 would be written as hour 24 — which Date reads as the next day at
  // 00:00, so `fromIso` returns 0 and the block appears to have negative length. The last
  // usable slot is therefore the last grid step that ends before midnight.
  const latestStart = Math.max(0, Math.floor((24 * 60 - 1 - duration) / MOVE_SNAP_MIN) * MOVE_SNAP_MIN);
  const snapped = Math.round(newStartMin / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
  const start = clampMin(snapped, 0, latestStart);

  db.prepare("UPDATE block SET starts_at = ?, ends_at = ?, is_locked = 1 WHERE id = ?").run(
    toIso(dateISO, start),
    toIso(dateISO, start + duration),
    blockId
  );

  // Re-solve: generatePlan re-reads pinned blocks as FIXED anchors, so this placement is
  // honoured exactly and everything else — breaks, transitions, recovery after deep work —
  // is recomputed from doctrine rather than shuffled by hand. It also pushes to Google.
  const plan = await generatePlan(db, doctrineDir, secrets, llm, dateISO, { ...deps, fast: true });
  return { moved: true, plan };
}

/**
 * Change a block's LENGTH by dragging one of its edges, pin it, and re-solve around it.
 *
 * Owner ask 2026-08-06: "make it so i can easily move the top/bottom of events to
 * extend/limit time."
 *
 * The difference from moveBlock is what it means, not just what it writes. Moving a block says
 * "do this later"; resizing says "this takes longer than you thought". So when the block came
 * from a task, the task's ESTIMATE is updated to match — otherwise the correction lives only in
 * one day's pin, and every future plan keeps budgeting the number he just told us was wrong.
 */
export async function resizeBlock(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  blockId: number,
  newStartMin: number,
  newEndMin: number,
  deps?: ReplanDeps
): Promise<MoveBlockResult> {
  const row = db
    .prepare(
      `SELECT b.id, b.task_id, b.is_anchor, b.is_locked, b.starts_at, b.ends_at, p.plan_date
         FROM block b JOIN plan p ON p.id = b.plan_id
        WHERE b.id = ?`
    )
    .get(blockId) as
    | {
        id: number; task_id: number | null; is_anchor: number; is_locked: number;
        starts_at: string; ends_at: string; plan_date: string;
      }
    | undefined;
  if (!row) return { moved: false, error: "not_found" };
  if (row.is_anchor === 1 && row.is_locked !== 1) return { moved: false, error: "external_event" };

  const dateISO = row.plan_date;
  const snap = (m: number) => Math.round(m / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
  // Both edges land on the solver's grid, the block keeps at least one slot, and it stays
  // inside its own date — hour 24 would be read as the next day and invert the block.
  const latestEnd = Math.floor((24 * 60 - 1) / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
  const start = clampMin(snap(newStartMin), 0, latestEnd - MOVE_SNAP_MIN);
  const end = clampMin(snap(newEndMin), start + MOVE_SNAP_MIN, latestEnd);

  db.prepare("UPDATE block SET starts_at = ?, ends_at = ?, is_locked = 1 WHERE id = ?").run(
    toIso(dateISO, start),
    toIso(dateISO, end),
    blockId
  );
  // The correction outlives the day: this is his estimate now, not ours.
  if (row.task_id != null) {
    db.prepare("UPDATE task SET estimated_minutes = ?, estimate_source = 'stated' WHERE id = ?").run(
      end - start,
      row.task_id
    );
  }

  const plan = await generatePlan(db, doctrineDir, secrets, llm, dateISO, { ...deps, fast: true });
  return { moved: true, plan };
}

/** Release a pin so the planner may site this work itself again. Re-solves the day. */
export async function unpinBlock(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  blockId: number,
  deps?: ReplanDeps
): Promise<MoveBlockResult> {
  const row = db
    .prepare(
      `SELECT b.id, b.starts_at, p.plan_date FROM block b JOIN plan p ON p.id = b.plan_id WHERE b.id = ?`
    )
    .get(blockId) as { id: number; starts_at: string; plan_date: string } | undefined;
  if (!row) return { moved: false, error: "not_found" };
  db.prepare("UPDATE block SET is_locked = 0 WHERE id = ?").run(blockId);
  const plan = await generatePlan(db, doctrineDir, secrets, llm, row.plan_date, { ...deps, fast: true });
  return { moved: true, plan };
}

export function getPlan(db: Db, dateISO: string, planId?: number) {
  const plan = (planId
    ? db.prepare("SELECT * FROM plan WHERE id = ?").get(planId)
    : db.prepare("SELECT * FROM plan WHERE plan_date = ? ORDER BY generated_at DESC LIMIT 1").get(dateISO)) as
    | Record<string, unknown>
    | undefined;
  if (!plan) return null;
  const blocks = db
    .prepare("SELECT * FROM block WHERE plan_id = ? ORDER BY starts_at")
    .all(plan.id) as Record<string, unknown>[];
  return { plan, blocks, unplaced: JSON.parse((plan.unplaced_tasks as string) ?? "[]") };
}

// ── re-solve when the calendar moves under a plan ────────────────────────────
//
// Owner ask 2026-08-05: "Sometimes I add Google Calendar events after the fact — typically
// that means it's something I have to go to, and my calendar should adjust around it."
//
// The miss that rewrote this section (2026-08-06, verified in his DB): he added a three-hour
// "hangout" at 16:00–19:00 in Google AFTER that day's plan was generated, and a focused_work
// block stayed sitting at 17:15–18:30 inside it. Four separate reasons, all fixed here:
//
//   1. the check only ever ran for TODAY, and he plans days ahead     → replanUpcoming()
//   2. it only guarded ACCEPTED plans                                 → see `accepted` below
//   3. a `preferred` event could never trigger anything               → PREFERRED_OVERLAP_MIN
//   4. a DELETED event freed time and nothing noticed                 → freedByRemovedAnchors
//
// The governing distinction is ACCEPTANCE, and it now sets the THRESHOLD rather than
// eligibility. An un-accepted plan is a draft he has not read: re-solving it costs him
// nothing, so any new external event that lands on it re-solves it eagerly. An accepted plan
// is a commitment he has read, so it takes a real conflict to rewrite it — a `fixed`
// obligation, or an event of any tier that sits on a working block for at least half an hour.

/** How much of a placed block a non-`fixed` event must cover to disturb an ACCEPTED plan. */
export const PREFERRED_OVERLAP_MIN = 30;

/** How much time a vanished obligation must free to disturb an ACCEPTED plan. */
export const FREED_SPAN_MIN = 45;

/** Days the sweep looks at, counting today. He plans ahead; a conflict on Thursday is real. */
export const REPLAN_HORIZON_DAYS = 3;

/** Setting prefix holding the external anchor set each date's plan was generated against. */
export const ANCHOR_FINGERPRINT_PREFIX = "plan_anchors_fp:";

/**
 * Injection seam for the re-plan path. `anchors` replaces the live calendar read, which is
 * what makes every decision below testable without a network — and, in production, what
 * makes the check and the regeneration it triggers agree on one view of the day.
 */
/**
 * "Now" as minutes-since-midnight, but ONLY when `dateISO` is the day `now` falls on.
 * Null for any other date — tomorrow has no past, and yesterday is not re-solved.
 */
export function floorFor(dateISO: string, now: Date): number | null {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (dateISO !== today) return null;
  return now.getHours() * 60 + now.getMinutes();
}

export interface ReplanDeps {
  anchors?: (dateISO: string) => Promise<Anchor[]>;
  /** Injectable clock, so "the past is not schedulable" is testable without waiting. */
  now?: Date;
  /**
   * Interactive path: skip the LLM narration and do not WAIT on the Google push.
   *
   * A drag re-solves the whole day, and awaiting a model call plus a push made the move take
   * the better part of a minute (owner report 2026-08-06: "it didn't update in real time… a
   * minute later updated"). The re-solve itself is deterministic and instant; only the two
   * network round-trips were slow, and neither has to happen before the owner sees his day.
   * The push still goes out — it is just not blocking, and the 15-minute sweep is its net.
   */
  fast?: boolean;
  /** The Google write surface, injected so the generate-time push is testable offline. */
  push?: Partial<GcalPushDeps>;
}

/** Live external anchors for a date, honoring an injected reader. */
async function readExternal(
  db: Db,
  secrets: SecretStore,
  dateISO: string,
  deps?: ReplanDeps,
  problems?: string[]
): Promise<Anchor[]> {
  if (deps?.anchors) return deps.anchors(dateISO);
  return externalAnchors(db, secrets, dateISO, problems);
}

/**
 * A stable, order-independent summary of an external anchor set. Two reads of an unchanged
 * calendar produce the same string; any add, delete, move or rename produces a different one.
 *
 * This is the STRUCTURAL guarantee that the re-plan cannot loop. The semantic checks below
 * already settle on their own (after a re-solve the new obligation is part of the plan, so
 * nothing reads as new), but they settle by argument, and the argument has edges — a
 * `preferred` anchor the solver could not find room for is absent from the plan it just
 * produced. Recording what the plan was built against turns "it should stop" into "it cannot
 * run twice for the same calendar".
 */
export function anchorFingerprint(anchors: readonly Anchor[]): string[] {
  return anchors
    .map((a) => `${a.startMin}|${a.endMin}|${a.flexibility ?? "fixed"}|${a.title.trim()}`)
    .sort();
}

export interface ReplanResult {
  /** True when the plan was regenerated. */
  replanned: boolean;
  /** Titles of the placed blocks the new event landed on, sorted, deduped. */
  displaced: string[];
  /** Titles of external anchors that DISAPPEARED and freed the time, sorted. */
  freed: string[];
}

/** One block of a plan, reduced to what the conflict scan needs. */
export interface PlannedSpan {
  title: string;
  startMin: number;
  endMin: number;
  isAnchor: boolean;
  /** The owner pinned this placement (or this exact span) himself. */
  isLocked: boolean;
  /** The block carries a `gcal_event_id` — it is certainly an external calendar event. */
  isExternal?: boolean;
}

/** How hard it is to justify disturbing this plan. */
export interface ConflictOptions {
  /** Has the owner read and accepted this plan? Un-accepted drafts re-solve freely. */
  accepted: boolean;
  /** Override for PREFERRED_OVERLAP_MIN. */
  minPreferredOverlapMin?: number;
  /** Override for FREED_SPAN_MIN. */
  minFreedSpanMin?: number;
}

const norm = (title: string) => title.trim().toLowerCase();
const overlapMinutes = (
  a: { startMin: number; endMin: number },
  b: { startMin: number; endMin: number }
) => Math.min(a.endMin, b.endMin) - Math.max(a.startMin, b.startMin);

/**
 * Which placed blocks does a newly-appeared external event land on? Pure — the decision to
 * disturb a day is testable without a calendar, a network or a database.
 *
 * What counts as "newly appeared" depends on the tier, because the tiers differ in whether
 * the SOLVER is allowed to move them:
 *
 *   fixed     — matched by span AND title. The solver never moves a fixed anchor, so a plan
 *               holding it at a different time means the event was rescheduled, and a
 *               rescheduled obligation is a new obligation as far as the day is concerned.
 *   preferred — matched by TITLE alone. The solver may displace a preferred anchor to seat
 *               something else, so a span mismatch proves nothing; requiring one would make
 *               every displaced block look new again on the next pass, forever.
 *   flexible  — never triggers. Those minutes are POS's own output pushed back to Google;
 *               treating them as an external event would have the app re-planning around
 *               itself.
 *
 * Thresholds, per the acceptance rule at the top of this section:
 *
 *   un-accepted plan — ANY overlap by a fixed or preferred event. It is a draft; re-solving
 *                      it costs him nothing and it is better done before he reads it.
 *   accepted plan    — a fixed event at any overlap, or an event of any tier covering at
 *                      least `minPreferredOverlapMin` of a placed block. A three-hour hangout
 *                      landing on a work block is a real conflict whatever its title; a
 *                      ten-minute clip of one is not worth rewriting a day he has read.
 *
 * `is_locked` blocks are excluded from the scan entirely. Re-planning cannot move them
 * (generatePlan re-reads them as anchors), so counting one as displaced would re-plan the day
 * on every tick, forever, and never resolve.
 */
export function displacedByNewAnchors(
  blocks: readonly PlannedSpan[],
  anchors: readonly Anchor[],
  opts: ConflictOptions = { accepted: true }
): string[] {
  const minOverlap = opts.minPreferredOverlapMin ?? PREFERRED_OVERLAP_MIN;
  const anchorBlocks = blocks.filter((b) => b.isAnchor);
  const knownExactly = new Set(anchorBlocks.map((b) => `${b.startMin}|${b.endMin}|${norm(b.title)}`));
  const knownByTitle = new Set(anchorBlocks.map((b) => norm(b.title)));

  const placed = blocks.filter((b) => !b.isAnchor && !b.isLocked);
  const displaced = new Set<string>();

  for (const a of anchors) {
    const tier = a.flexibility ?? "fixed"; // an untiered anchor is an obligation (grid.ts)
    if (tier === "flexible") continue; // our own output; see above
    const isNew =
      tier === "fixed"
        ? !knownExactly.has(`${a.startMin}|${a.endMin}|${norm(a.title)}`)
        : !knownByTitle.has(norm(a.title));
    if (!isNew) continue; // the plan was already built around this
    for (const b of placed) {
      const over = overlapMinutes(a, b);
      if (over <= 0) continue;
      if (!opts.accepted || tier === "fixed" || over >= minOverlap) displaced.add(b.title);
    }
  }
  return [...displaced].sort();
}

/** A window an external event used to occupy and no longer does. */
export interface FreedWindow {
  title: string;
  startMin: number;
  endMin: number;
}

/**
 * The reverse trigger: which external anchors has the plan reserved time for that the
 * calendar no longer has? Pure, for the same reason as its sibling above.
 *
 * Owner's stance, stated explicitly: he does NOT expect the old arrangement back when an
 * event is cancelled. A fresh solve into the newly free time is the correct answer, so this
 * only reports the freed windows — the caller decides whether there is work waiting to use
 * them (`hasWorkWaiting`) before re-solving.
 *
 * An anchor block is considered GONE when the live anchor set contains nothing at its span
 * and nothing with its title. Either match is enough on purpose: a `preferred` anchor the
 * solver moved keeps its title, and an event whose title was edited keeps its span, and
 * neither of those is a cancellation.
 *
 * Excluded:
 *   - locked blocks. The owner pinned that time himself; it is not the calendar's to free,
 *     and it re-materialises as an anchor in every regenerated plan, so treating it as a
 *     removal would re-plan the day forever.
 *   - windows shorter than `minFreedSpanMin` on an ACCEPTED plan. A cancelled 15-minute call
 *     must not rewrite a day he is already reading. Un-accepted drafts have no floor.
 *
 * This cannot loop: the re-solve it triggers builds the new plan from the anchor set that no
 * longer contains the removed event, so the next pass has no anchor block to miss.
 */
export function freedByRemovedAnchors(
  blocks: readonly PlannedSpan[],
  anchors: readonly Anchor[],
  opts: ConflictOptions = { accepted: true }
): FreedWindow[] {
  const liveSpans = new Set(anchors.map((a) => `${a.startMin}|${a.endMin}`));
  const liveTitles = new Set(anchors.map((a) => norm(a.title)));
  const floor = opts.accepted ? (opts.minFreedSpanMin ?? FREED_SPAN_MIN) : 1;

  return blocks
    .filter((b) => b.isAnchor && !b.isLocked)
    .filter((b) => !liveSpans.has(`${b.startMin}|${b.endMin}`) && !liveTitles.has(norm(b.title)))
    .filter((b) => b.endMin - b.startMin >= floor)
    .map((b) => ({ title: b.title, startMin: b.startMin, endMin: b.endMin }))
    .sort((x, y) => x.startMin - y.startMin || x.title.localeCompare(y.title));
}

/**
 * Is there anything for a freed window to be spent on? True when the plan gave up on a task
 * (`unplaced_tasks`) or when a task for the date is still waiting — `inbox` or `planned` with
 * no block on this plan. Without this, a cancellation would re-shuffle a day that had nothing
 * more to fit into it.
 */
export function hasWorkWaiting(db: Db, dateISO: string, planId: number): boolean {
  const row = db.prepare("SELECT unplaced_tasks FROM plan WHERE id = ?").get(planId) as
    | { unplaced_tasks: string | null }
    | undefined;
  try {
    const unplaced = JSON.parse(row?.unplaced_tasks ?? "[]");
    if (Array.isArray(unplaced) && unplaced.length > 0) return true;
  } catch {
    /* unreadable JSON is not evidence of waiting work */
  }
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM task t
        WHERE t.plan_date = ? AND t.status IN ('inbox','planned')
          AND NOT EXISTS (SELECT 1 FROM block b WHERE b.plan_id = ? AND b.task_id = t.id)`
    )
    .get(dateISO, planId) as { n: number };
  return n > 0;
}

/**
 * Compare the LATEST plan for `dateISO` against the current external anchors and regenerate
 * it when the calendar has moved under it — either a new event landing on placed work, or a
 * cancelled event freeing time that waiting work could use.
 *
 * Deliberately not restricted to accepted plans any more: an un-accepted plan is one he has
 * not read, so re-solving it is free, and leaving it stale is exactly how a work block ends
 * up sitting inside a hangout. Acceptance now only raises the bar (see ConflictOptions).
 *
 * `is_locked` blocks survive the regeneration untouched — generatePlan re-reads them as
 * anchors — which is also why they are excluded from both scans: re-planning cannot move
 * them, so treating one as displaced or freed would re-plan the day on every tick forever.
 *
 * Safe to call repeatedly. The anchor fingerprint recorded by generatePlan short-circuits an
 * unchanged calendar outright, and each scan independently reads a regenerated plan as
 * settled.
 */
export async function replanIfConflicted(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  dateISO: string,
  deps?: ReplanDeps
): Promise<ReplanResult> {
  const none: ReplanResult = { replanned: false, displaced: [], freed: [] };

  const plan = db
    .prepare(
      "SELECT id, accepted_at FROM plan WHERE plan_date = ? ORDER BY generated_at DESC, id DESC LIMIT 1"
    )
    .get(dateISO) as { id: number; accepted_at: string | null } | undefined;
  if (!plan) return none; // nothing planned for this date — generatePlan is the entry point
  const opts: ConflictOptions = { accepted: plan.accepted_at != null };

  // A source that FAILED reads as an empty calendar, and an empty calendar reads as "he
  // deleted everything". Never let an unreachable Google trigger the removal path.
  const problems: string[] = [];
  const anchors = await readExternal(db, secrets, dateISO, deps, problems);

  // Nothing outside this app has changed since the plan was built → nothing to decide.
  const fingerprint = readDayCache<string[]>(db, ANCHOR_FINGERPRINT_PREFIX, dateISO);
  if (fingerprint && JSON.stringify(fingerprint) === JSON.stringify(anchorFingerprint(anchors))) {
    return none;
  }

  const rows = db
    .prepare(
      "SELECT title, starts_at, ends_at, is_anchor, is_locked, gcal_event_id FROM block WHERE plan_id = ?"
    )
    .all(plan.id) as {
    title: string | null;
    starts_at: string;
    ends_at: string;
    is_anchor: number;
    is_locked: number;
    gcal_event_id: string | null;
  }[];

  // Every span the owner has pinned for this date, from ANY plan. A regenerated plan carries
  // the pinned span forward as a plain anchor (generatePlan re-reads it), so matching on the
  // span — not just this row's is_locked flag — is what keeps a pin excluded from both scans
  // for the whole life of the date.
  const lockedSpans = new Set(
    (
      db
        .prepare("SELECT starts_at, ends_at FROM block WHERE is_locked = 1 AND date(starts_at) = ?")
        .all(dateISO) as { starts_at: string; ends_at: string }[]
    ).map((b) => `${fromIso(b.starts_at)}|${fromIso(b.ends_at)}`)
  );

  const spans: PlannedSpan[] = rows.map((b) => {
    const startMin = fromIso(b.starts_at);
    const endMin = fromIso(b.ends_at);
    return {
      title: b.title ?? "(untitled)",
      startMin,
      endMin,
      isAnchor: b.is_anchor === 1,
      isLocked: b.is_locked === 1 || lockedSpans.has(`${startMin}|${endMin}`),
      isExternal: !!b.gcal_event_id,
    };
  });

  const displaced = displacedByNewAnchors(spans, anchors, opts);
  const freedWindows =
    problems.length > 0 ? [] : freedByRemovedAnchors(spans, anchors, opts);
  const freed =
    freedWindows.length > 0 && hasWorkWaiting(db, dateISO, plan.id)
      ? freedWindows.map((f) => f.title)
      : [];

  if (displaced.length === 0 && freed.length === 0) return none;

  // Same anchor set the decision was made on — see ReplanDeps.
  await generatePlan(db, doctrineDir, secrets, llm, dateISO, { ...deps, anchors: async () => anchors });
  return { replanned: true, displaced, freed };
}

/** `days` ISO dates starting at `today`, in order. UTC arithmetic — no DST surprises. */
/**
 * Schedulable work sitting on a date that has NO plan at all.
 *
 * The signal that a day needs planning rather than re-planning. Zero for a date that already
 * has a plan (however stale — that is the stale-engine sweep's job) and zero for an empty
 * day, so this never manufactures a plan out of nothing.
 */
export function tasksAwaitingPlan(db: Db, dateISO: string): number {
  const planned = db.prepare("SELECT 1 FROM plan WHERE plan_date = ? LIMIT 1").get(dateISO);
  if (planned) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM task
          WHERE plan_date = ?
            AND status IN (${SCHEDULABLE_TASK_STATUSES.map(() => "?").join(",")})`
      )
      .get(dateISO, ...SCHEDULABLE_TASK_STATUSES) as { n: number }
  ).n;
}

export function upcomingDates(today: string, days: number): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, days); i++) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export interface ReplanSweepResult {
  /** Dates examined, in order. */
  checked: string[];
  /** Dates whose plan was regenerated. */
  replanned: string[];
  /** date → titles of the blocks a new event landed on. */
  displaced: Record<string, string[]>;
  /** date → titles of the cancelled events whose time was reclaimed. */
  freed: Record<string, string[]>;
}

/**
 * Run the conflict check across the planning HORIZON, not just today.
 *
 * This is the first of the four fixes and the one that made the others visible: he plans days
 * ahead, so the day a new obligation lands on is very often not today, and a check wired to
 * `new Date()` could never have caught it.
 *
 * One date failing (an LLM outage during the re-solve, say) must not cost the others their
 * check, so each date is contained. Deterministic: dates run in order, and the anchor set for
 * each is read once and used for both the decision and the regeneration.
 */
export async function replanUpcoming(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  opts: { days?: number; today?: string; deps?: ReplanDeps } = {}
): Promise<ReplanSweepResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const out: ReplanSweepResult = { checked: [], replanned: [], displaced: {}, freed: {} };

  for (const dateISO of upcomingDates(today, opts.days ?? REPLAN_HORIZON_DAYS)) {
    out.checked.push(dateISO);
    try {
      // ── a day with work on it and no plan yet gets one ──
      //
      // Owner report 2026-08-06: "Why did you completely delete the Stanford two hour block
      // thing from earlier?" It had not been deleted — it was DEFERRED to the next day inside
      // its window, exactly as intended. But deferral was only half a feature: nothing ever
      // planned a fresh day. replanIfConflicted returns early when a date has no plan ("that
      // is generatePlan's job"), and generatePlan only ran when he braindumped.
      //
      // So the task sat in `inbox` with tomorrow's date and no block anywhere, and from the
      // calendar it was indistinguishable from having been thrown away. A deferral that lands
      // on a day nobody plans IS a deletion, whatever the database says.
      if (tasksAwaitingPlan(db, dateISO) > 0) {
        await generatePlan(db, doctrineDir, secrets, llm, dateISO, opts.deps);
        out.replanned.push(dateISO);
        continue;
      }
      const r = await replanIfConflicted(db, doctrineDir, secrets, llm, dateISO, opts.deps);
      if (!r.replanned) continue;
      out.replanned.push(dateISO);
      if (r.displaced.length > 0) out.displaced[dateISO] = r.displaced;
      if (r.freed.length > 0) out.freed[dateISO] = r.freed;
    } catch (e) {
      console.warn(`replan check failed for ${dateISO}: ${(e as Error).message}`);
    }
  }
  return out;
}

// ── accepting a plan pushes it (owner directive 2026-08-05) ──────────────────
//
// "It should push AUTOMATICALLY — I shouldn't have to press anything." Accept is now the
// whole gesture: the local accept commits first and unconditionally, then the Google push
// runs time-boxed and best-effort. A push failure NEVER un-accepts the plan; it comes back
// in `push.error` so the UI can explain it and offer a retry, and `pushed_at` stays NULL so
// the worker sweep picks the plan up on the next tick.

/** Setting key gating every automatic push. Absent = on. */
export const AUTO_PUSH_KEY = "auto_push";

/** Auto-push is on unless the owner explicitly turned it off ("0"). */
export function autoPushEnabled(db: Db): boolean {
  return (getSetting(db, AUTO_PUSH_KEY) ?? "1") !== "0";
}

/** How long an automatic push may run before we give up and report it. */
export const AUTO_PUSH_TIMEOUT_MS = 30_000;

export interface PlanPushResult {
  /** Calendar blocks written. */
  pushed: number;
  /** Google Tasks written. */
  tasks: number;
  /** Stale events withdrawn — blocks a re-plan removed (see gcal/sync.ts drainTombstones). */
  withdrawn: number;
  /** Typed failure — `reconsent_required`, "skipped: …", or a raw message. */
  error?: string;
}

export interface AcceptPlanResult {
  accepted: true;
  push: PlanPushResult;
}

/** Reject-after-timeout. Does not cancel `p` — the local DB state is already consistent. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * Push one plan's blocks AND the task list to Google, best-effort. Never throws: every
 * failure — not connected, auto-push off, a stale grant, a timeout — is reported in
 * `error`. Calendar and tasks are counted separately so a partial success still shows what
 * landed.
 */
export async function pushPlanToGoogle(
  db: Db,
  secrets: SecretStore,
  planId: number,
  deps?: Partial<GcalPushDeps>
): Promise<PlanPushResult> {
  const out: PlanPushResult = { pushed: 0, tasks: 0, withdrawn: 0 };
  if (!isGoogleConnected(secrets)) return { ...out, error: "not_connected" };
  if (!hasCalendarWriteScope(secrets)) return { ...out, error: RECONSENT_REQUIRED };
  try {
    await withTimeout(
      (async () => {
        const cal = await pushPlan(db, secrets, planId, deps);
        out.pushed = cal.pushed;
        out.withdrawn = cal.withdrawn;
        // Tasks are a separate surface: a calendar push that landed must still be
        // reported even if the task push then fails.
        const tasks = await pushTasks(db, secrets, deps);
        out.tasks = tasks.pushed;
      })(),
      AUTO_PUSH_TIMEOUT_MS,
      "Google push timed out"
    );
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

/**
 * Mark a plan accepted, then push it. The accept is committed before any network work, so
 * a Google outage can never cost the owner his decision.
 *
 * `secrets` omitted (or auto-push turned off) → the accept still happens and `push` reports
 * why nothing went out.
 */
export async function acceptPlan(
  db: Db,
  planId: number,
  secrets?: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<AcceptPlanResult> {
  db.prepare("UPDATE plan SET accepted_at = datetime('now') WHERE id = ?").run(planId);
  if (!secrets) return { accepted: true, push: { pushed: 0, tasks: 0, withdrawn: 0, error: "not_connected" } };
  if (!autoPushEnabled(db)) return { accepted: true, push: { pushed: 0, tasks: 0, withdrawn: 0, error: "auto_push_off" } };
  return { accepted: true, push: await pushPlanToGoogle(db, secrets, planId, deps) };
}

/** Yesterday's (or any day's) accepted blocks needing outcome capture — one prompt, not per block. */
export function outcomesNeeded(db: Db, dateISO: string) {
  return db
    .prepare(
      `SELECT b.id, b.block_type, b.title, b.starts_at, b.ends_at
       FROM block b JOIN plan p ON p.id = b.plan_id
       WHERE p.plan_date = ? AND p.accepted_at IS NOT NULL AND b.is_anchor = 0
         AND b.block_type NOT IN ('break','transition','meal')
         AND NOT EXISTS (SELECT 1 FROM block_outcome o WHERE o.block_id = b.id)
       ORDER BY b.starts_at`
    )
    .all(dateISO) as Record<string, unknown>[];
}


// ── the Google Tasks strip ───────────────────────────────────────────────────
//
// Owner ask 2026-08-06: "maybe you should add little test [tasks] that are, like, on the
// calendar that are shown with the drop down list, like Google test [Tasks], and you can
// always place it at, like, a four AM time slot. It's not actually a calendar event, but it's
// just a place for me to see the Google tasks."
//
// The gap it closes: a task only becomes visible once the solver gives it a block. Anything
// undated — which is most of what arrives from Google Tasks, and everything the "only explicit
// dates schedule things" rule leaves alone — existed in the database and appeared nowhere he
// looks. He asked whether things had populated and could not tell, which is the whole problem.
//
// Deliberately NOT a block: it occupies no minutes, the solver never sees it, and it cannot be
// dragged. It is a reading surface parked at 04:00 where the day is always empty.

export interface DayTaskRow {
  id: number;
  title: string;
  status: string;
  /** ISO date it is planned for, or null for an undated inbox item. */
  planDate: string | null;
  /** True when this task came from (or is mirrored to) Google Tasks. */
  fromGoogle: boolean;
  /** True when the solver has given it a block on this day — already visible on the grid. */
  scheduled: boolean;
}

/**
 * What to show in the strip for `dateISO`: the day's own tasks, plus every UNDATED task, which
 * is the pile that would otherwise be invisible. Done and deferred work is excluded — the strip
 * is what is outstanding, not an archive.
 */
export function tasksForStrip(db: Db, dateISO: string): DayTaskRow[] {
  const status = SCHEDULABLE_TASK_STATUSES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.plan_date, t.gtasks_id,
              EXISTS (
                SELECT 1 FROM block b JOIN plan p ON p.id = b.plan_id
                 WHERE b.task_id = t.id AND p.plan_date = ?
              ) AS scheduled
         FROM task t
        WHERE t.status IN (${status})
          AND (t.plan_date = ? OR t.plan_date IS NULL)
        ORDER BY t.plan_date IS NULL, t.id`
    )
    .all(dateISO, ...SCHEDULABLE_TASK_STATUSES, dateISO) as {
    id: number; title: string; status: string; plan_date: string | null;
    gtasks_id: string | null; scheduled: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    planDate: r.plan_date,
    fromGoogle: r.gtasks_id != null,
    scheduled: r.scheduled === 1,
  }));
}
