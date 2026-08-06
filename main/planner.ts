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
import {
  readAnchors,
  mergeCalendarSources,
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

const toIso = (dateISO: string, min: number) =>
  `${dateISO}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00`;
const fromIso = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

export async function braindump(db: Db, doctrineDir: string, llm: LlmClient | null, text: string, dateISO: string) {
  const doctrine = loadDoctrine(doctrineDir);
  const { tasks, usedLlm } = await parseBraindump(text, doctrine, llm);
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

export async function generatePlan(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  dateISO: string
) {
  const doctrine: Doctrine = loadDoctrine(doctrineDir);

  // anchors: external GCal events + locked blocks from prior plans for this date
  const anchors: Anchor[] = [];
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
      appleEvents.push({
        uid: ev.uid,
        title: ev.title,
        startMin: ev.startMin,
        endMin: ev.endMin,
        blockType: appleBlockType(ev.title, ev.calendar),
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
      icsEvents.push({
        uid: ev.uid,
        title: ev.title,
        startMin: ev.startMin,
        endMin: ev.endMin,
        blockType: icsBlockType(ev.title),
      });
    }
  } catch (e) {
    console.warn(`ics anchors unavailable: ${(e as Error).message}`);
  }

  // One event living in two systems must block the day exactly once. The join is the
  // RFC 5545 UID, which survives cross-system sync — so a renamed or rescheduled event
  // is still recognised as the same event.
  const merged = mergeCalendarSources(googleAnchors, [...appleEvents, ...icsEvents]);
  for (const a of merged.anchors) {
    anchors.push({ startMin: a.startMin, endMin: a.endMin, blockType: a.blockType, title: a.title });
  }

  const lockedRows = db
    .prepare("SELECT block_type, title, starts_at, ends_at FROM block WHERE is_locked = 1 AND date(starts_at) = ?")
    .all(dateISO) as { block_type: string; title: string; starts_at: string; ends_at: string }[];
  for (const b of lockedRows) {
    anchors.push({
      startMin: fromIso(b.starts_at),
      endMin: fromIso(b.ends_at),
      blockType: b.block_type as Anchor["blockType"],
      title: b.title ?? "(locked)",
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
  const narration = await narrate(result, doctrine, llm);

  // persist: replace any prior un-accepted plan for the date
  const persist = db.transaction(() => {
    const old = db
      .prepare("SELECT id FROM plan WHERE plan_date = ? AND accepted_at IS NULL")
      .all(dateISO) as { id: number }[];
    for (const o of old) db.prepare("DELETE FROM plan WHERE id = ?").run(o.id); // blocks cascade
    const { lastInsertRowid } = db
      .prepare("INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks) VALUES (?, ?, ?, ?, ?)")
      .run(dateISO, ENGINE_VERSION, JSON.stringify(doctrine), narration,
        JSON.stringify(result.unplaced.map((u) => ({ taskId: u.task.id, title: u.task.title, reason: u.reason }))));
    const planId = Number(lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id, capacity_score_at_placement)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const b of result.blocks) {
      ins.run(b.taskId ?? null, b.blockType, b.title, toIso(dateISO, b.startMin), toIso(dateISO, b.endMin),
        b.isAnchor ? 1 : 0, planId, b.capacityAtPlacement ?? null);
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
