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
import { readAnchors, mergeCalendarSources, type MergeableGoogleAnchor, type MergeableAppleEvent } from "./gcal/sync.ts";
import { isGoogleConnected } from "./gcal/auth.ts";
import { readAppleEvents, appleBlockType, excludedCalendarNames } from "./applecal.ts";

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

  // One event living in two systems must block the day exactly once. The join is the
  // RFC 5545 UID, which survives cross-system sync — so a renamed or rescheduled event
  // is still recognised as the same event.
  const merged = mergeCalendarSources(googleAnchors, appleEvents);
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

export function acceptPlan(db: Db, planId: number) {
  db.prepare("UPDATE plan SET accepted_at = datetime('now') WHERE id = ?").run(planId);
  return { accepted: true };
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
