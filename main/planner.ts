// Planner orchestration: braindump → tasks → grid+solve → narrate → persist.
// Ties the four engine stages to the DB and Google anchors. Push is explicit.

import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import type { LlmClient } from "./llm/provider.ts";
import { loadDoctrine, type Doctrine } from "./engine/doctrine.ts";
import { parseBraindump } from "./engine/parse.ts";
import { solve, ENGINE_VERSION, type PlannerTask } from "./engine/solver.ts";
import type { Anchor } from "./engine/grid.ts";
import { narrate } from "./engine/narrate.ts";
import { withPreferences } from "./preferences.ts";
import {
  readAnchors,
  mergeCalendarSources,
  inferFlexibility,
  pushPlan,
  pushTasks,
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
    withPreferences(llm, doctrineDir, ["plan_parse"])
  );
  const ins = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
       is_mit, hard_deadline_at, status, splittable, estimate_source, plan_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const t of tasks) {
      ins.run(
        t.title, t.blockType, t.cognitiveLoad, t.estimatedMinutes, t.rawEstimateMinutes,
        t.isMit ? 1 : 0,
        t.hardDeadlineAt ? `${dateISO}T${t.hardDeadlineAt}:00` : null,
        t.splittable ? 1 : 0, t.estimateSource, dateISO,
        t.personHint ? `person: ${t.personHint}` : null
      );
    }
  });
  tx();
  return { tasks: listTasks(db, dateISO), usedLlm };
}

export function listTasks(db: Db, dateISO: string) {
  return db
    .prepare("SELECT * FROM task WHERE plan_date = ? AND status != 'done' ORDER BY id")
    .all(dateISO) as Record<string, unknown>[];
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
 */
export async function externalAnchors(db: Db, secrets: SecretStore, dateISO: string): Promise<Anchor[]> {
  const googleAnchors: MergeableGoogleAnchor[] = [];
  if (isGoogleConnected(secrets)) {
    try {
      googleAnchors.push(...(await readAnchors(db, secrets, dateISO)));
    } catch (e) {
      console.warn(`gcal anchors unavailable: ${(e as Error).message}`);
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
    console.warn(`apple calendar anchors unavailable: ${(e as Error).message}`);
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
    console.warn(`ics anchors unavailable: ${(e as Error).message}`);
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

export async function generatePlan(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  dateISO: string
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

  // anchors: external GCal events + locked blocks from prior plans for this date
  const anchors: Anchor[] = await externalAnchors(db, secrets, dateISO);

  const lockedRows = db
    .prepare("SELECT block_type, title, starts_at, ends_at FROM block WHERE is_locked = 1 AND date(starts_at) = ?")
    .all(dateISO) as { block_type: string; title: string; starts_at: string; ends_at: string }[];
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

  const taskRows = listTasks(db, dateISO);
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
  }));

  const result = solve(tasks, doctrine, anchors);
  // Same injection for the narration: a chief of staff explaining the day should know the
  // owner's standing preferences, not just the blocks that came out of the solver.
  const narration = await narrate(result, doctrine, withPreferences(llm, doctrineDir, ["narration"]));

  // persist: replace any prior un-accepted plan for the date
  const persist = db.transaction(() => {
    const old = db
      .prepare("SELECT id FROM plan WHERE plan_date = ? AND accepted_at IS NULL")
      .all(dateISO) as { id: number }[];
    for (const o of old) db.prepare("DELETE FROM plan WHERE id = ?").run(o.id); // blocks cascade
    // The snapshot is the EFFECTIVE doctrine (observed wake folded in), not the file on
    // disk: it exists to explain why this plan looks the way it does, and a 06:40 wake is
    // the reason half of it moved.
    const { lastInsertRowid } = db
      .prepare("INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks) VALUES (?, ?, ?, ?, ?)")
      .run(dateISO, ENGINE_VERSION, JSON.stringify(doctrine), narration,
        JSON.stringify(result.unplaced.map((u) => ({ taskId: u.task.id, title: u.task.title, reason: u.reason }))));
    const planId = Number(lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id,
         capacity_score_at_placement, flexibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const b of result.blocks) {
      ins.run(b.taskId ?? null, b.blockType, b.title, toIso(dateISO, b.startMin), toIso(dateISO, b.endMin),
        b.isAnchor ? 1 : 0, planId, b.capacityAtPlacement ?? null,
        // The solver stamps every block; the fallback only covers a hand-built PlacedBlock.
        b.flexibility ?? (b.isAnchor ? "fixed" : "flexible"));
    }
    db.prepare("UPDATE task SET status = 'planned' WHERE plan_date = ? AND status = 'inbox'").run(dateISO);
    return planId;
  });
  const planId = persist();
  return getPlan(db, dateISO, planId);
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

// ── re-solve when a new external obligation lands on an accepted day ─────────
//
// Owner ask 2026-08-05: "Sometimes I add Google Calendar events after the fact — typically
// that means it's something I have to go to, and my calendar should adjust around it."
//
// The accepted plan is a commitment, not a draft, so this is deliberately narrow: ONLY a
// `fixed` anchor that (a) the plan does not already know about and (b) actually lands on
// top of a placed block triggers a regeneration. A `preferred` event appearing does not —
// the solver can already bend around it, and re-planning an accepted day is a disruption
// the owner has to re-read.

export interface ReplanResult {
  /** True when the plan was regenerated. */
  replanned: boolean;
  /** Titles of the placed blocks the new obligation landed on, sorted, deduped. */
  displaced: string[];
}

/** One block of an accepted plan, reduced to what the conflict scan needs. */
export interface PlannedSpan {
  title: string;
  startMin: number;
  endMin: number;
  isAnchor: boolean;
  isLocked: boolean;
}

/**
 * The pure core of `replanIfConflicted`: which placed blocks does a newly-appeared `fixed`
 * anchor land on? Separated from the I/O so the decision to disturb an accepted day is
 * testable without a calendar, a network or a database.
 *
 * "Newly appeared" = no anchor block in the plan with the same span AND title. A
 * rescheduled event fails that test deliberately: an obligation that moved is a new
 * obligation as far as the day is concerned.
 *
 * `is_locked` blocks are excluded from the scan. Re-planning cannot move them (generatePlan
 * re-reads them as anchors), so counting one as displaced would re-plan the day on every
 * tick, forever, and never resolve.
 */
export function displacedByNewAnchors(
  blocks: readonly PlannedSpan[],
  anchors: readonly Anchor[]
): string[] {
  const known = new Set(
    blocks.filter((b) => b.isAnchor).map((b) => `${b.startMin}|${b.endMin}|${b.title.trim()}`)
  );
  const placed = blocks.filter((b) => !b.isAnchor && !b.isLocked);
  const displaced = new Set<string>();
  for (const a of anchors) {
    if ((a.flexibility ?? "fixed") !== "fixed") continue; // only obligations force a re-plan
    if (known.has(`${a.startMin}|${a.endMin}|${a.title.trim()}`)) continue; // already planned around
    for (const b of placed) {
      if (a.startMin < b.endMin && a.endMin > b.startMin) displaced.add(b.title);
    }
  }
  return [...displaced].sort();
}

/**
 * Compare the accepted plan for `dateISO` against the CURRENT external anchors and
 * regenerate it when a newly-appeared `fixed` anchor overlaps something already placed.
 * `is_locked` blocks survive the regeneration untouched — generatePlan re-reads them as
 * anchors, which is also why they are excluded from the conflict scan below: re-planning
 * cannot move them, so treating them as displaced would re-plan the day on every tick
 * forever.
 *
 * Safe to call repeatedly: after a regeneration the new anchors are part of the plan, so
 * the next call finds nothing new and does nothing.
 */
export async function replanIfConflicted(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  dateISO: string
): Promise<ReplanResult> {
  const none: ReplanResult = { replanned: false, displaced: [] };

  const accepted = db
    .prepare(
      "SELECT id FROM plan WHERE plan_date = ? AND accepted_at IS NOT NULL ORDER BY generated_at DESC, id DESC LIMIT 1"
    )
    .get(dateISO) as { id: number } | undefined;
  if (!accepted) return none; // nothing accepted for this date — generatePlan is the entry point

  const rows = db
    .prepare("SELECT title, starts_at, ends_at, is_anchor, is_locked FROM block WHERE plan_id = ?")
    .all(accepted.id) as {
    title: string | null;
    starts_at: string;
    ends_at: string;
    is_anchor: number;
    is_locked: number;
  }[];

  const spans: PlannedSpan[] = rows.map((b) => ({
    title: b.title ?? "(untitled)",
    startMin: fromIso(b.starts_at),
    endMin: fromIso(b.ends_at),
    isAnchor: b.is_anchor === 1,
    isLocked: b.is_locked === 1,
  }));

  const displaced = displacedByNewAnchors(spans, await externalAnchors(db, secrets, dateISO));
  if (displaced.length === 0) return none;

  await generatePlan(db, doctrineDir, secrets, llm, dateISO);
  return { replanned: true, displaced };
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
  const out: PlanPushResult = { pushed: 0, tasks: 0 };
  if (!isGoogleConnected(secrets)) return { ...out, error: "not_connected" };
  if (!hasCalendarWriteScope(secrets)) return { ...out, error: RECONSENT_REQUIRED };
  try {
    await withTimeout(
      (async () => {
        const cal = await pushPlan(db, secrets, planId, deps);
        out.pushed = cal.pushed;
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
  if (!secrets) return { accepted: true, push: { pushed: 0, tasks: 0, error: "not_connected" } };
  if (!autoPushEnabled(db)) return { accepted: true, push: { pushed: 0, tasks: 0, error: "auto_push_off" } };
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
