// Learning loop (§5.8). After each day: one outcome prompt, then recompute
// category multipliers from the rolling 30-day actual/estimated ratio, and adjust
// energy-curve control points toward observed reality — capped at ±15 capacity
// points per revision so one bad week can't wreck the model.
// NEVER auto-modifies hard_constraints. Those are edited by the user only.

import type { Db } from "../db/db.ts";
import { hhmmToMin, parseDoctrine, type Doctrine } from "./doctrine.ts";
import yaml from "js-yaml";

export const CURVE_ADJUST_CAP = 15;
export const MULTIPLIER_FLOOR = 1.0;
export const MULTIPLIER_CEIL = 2.0;

/**
 * Marker suffix on `block_outcome.note` for rows POS derived from Apple Screen Time
 * rather than rows the owner typed (see main/screentime.ts). block_outcome has no
 * provenance column, so the note carries it — which also means the owner can SEE the
 * provenance in the same place he reads the evidence.
 */
export const AUTO_OUTCOME_NOTE_SUFFIX = "auto from Screen Time";
const AUTO_NOTE_LIKE = `%${AUTO_OUTCOME_NOTE_SUFFIX}`;

export interface OutcomeEntry {
  blockId: number;
  completed: boolean;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  /**
   * 1-5. MAY BE MACHINE-DERIVED: screentime.autoCaptureOutcomes writes a proxy computed
   * from the focus-category share of the block's app usage. The multiplier and curve math
   * below is unchanged and treats it identically to a self-report — deliberately, since
   * the proxy is calibrated to the same 1-5 scale. Provenance is recoverable from `note`
   * (AUTO_OUTCOME_NOTE_SUFFIX) and is reported separately by adherenceStats().
   */
  perceivedFocus?: number | null;
  note?: string | null;
}

export function captureOutcomes(db: Db, entries: OutcomeEntry[]): number {
  const ins = db.prepare(
    `INSERT INTO block_outcome (block_id, completed, actual_start_at, actual_end_at, perceived_focus, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: OutcomeEntry[]) => {
    for (const e of rows)
      ins.run(e.blockId, e.completed ? 1 : 0, e.actualStartAt ?? null, e.actualEndAt ?? null,
        e.perceivedFocus ?? null, e.note ?? null);
  });
  tx(entries);
  return entries.length;
}

/**
 * Rolling-30-day ratio of actual to estimated duration per category — the personal
 * planning-fallacy coefficient. Only categories with >= 5 samples update.
 */
export function recomputeMultipliers(db: Db, current: Record<string, number>): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT b.block_type AS type,
              SUM((julianday(o.actual_end_at) - julianday(o.actual_start_at)) * 1440.0) AS actual,
              SUM((julianday(b.ends_at) - julianday(b.starts_at)) * 1440.0) AS planned,
              COUNT(*) AS n
       FROM block_outcome o
       JOIN block b ON b.id = o.block_id
       WHERE o.actual_start_at IS NOT NULL AND o.actual_end_at IS NOT NULL
         AND o.actual_end_at > o.actual_start_at
         AND b.created_at >= datetime('now', '-30 days')
       GROUP BY b.block_type`
    )
    .all() as { type: string; actual: number; planned: number; n: number }[];

  const next = { ...current };
  for (const r of rows) {
    if (r.n < 5 || !r.planned) continue;
    const ratio = r.actual / r.planned;
    // The stored multiplier already inflated the estimate; fold the observed ratio in.
    const base = current[r.type] ?? 1.25;
    const proposed = base * ratio;
    next[r.type] = Math.round(Math.min(MULTIPLIER_CEIL, Math.max(MULTIPLIER_FLOOR, proposed)) * 100) / 100;
  }
  return next;
}

/**
 * Correlate perceived focus + completion against hours_after_wake and pull each
 * energy-curve control point toward observed reality, ±CURVE_ADJUST_CAP max.
 * Needs >= 30 days of data (distinct outcome days) before it moves anything.
 */
export function adjustCurve(db: Db, doctrine: Doctrine): Doctrine["energy_curve"] {
  const days = db
    .prepare(
      `SELECT COUNT(DISTINCT date(b.starts_at)) AS d
       FROM block_outcome o JOIN block b ON b.id = o.block_id`
    )
    .get() as { d: number };
  if (days.d < 30) return doctrine.energy_curve;

  const wakeMin = hhmmToMin(doctrine.chronotype.wake_time);
  const rows = db
    .prepare(
      `SELECT b.starts_at AS s, o.perceived_focus AS f, o.completed AS c
       FROM block_outcome o JOIN block b ON b.id = o.block_id
       WHERE b.created_at >= datetime('now', '-90 days')
         AND b.block_type IN ('deep_work','focused_work')`
    )
    .all() as { s: string; f: number | null; c: number | null }[];

  // observations as (hours-after-wake, capacity signal) pairs.
  // perceived_focus here may be the owner's self-report OR the Screen Time proxy
  // (screentime.autoCaptureOutcomes) — both are on the same 1-5 scale, and the ±15
  // per-revision cap below is what keeps either source from wrecking the model.
  const obs: { haw: number; signal: number }[] = [];
  for (const r of rows) {
    const d = new Date(r.s);
    const min = d.getHours() * 60 + d.getMinutes();
    const haw = (min - wakeMin) / 60;
    if (haw < 0 || haw > 18) continue;
    // observed capacity signal: perceived focus (1-5 → 20-100), completion as weak signal
    const signal = r.f != null ? r.f * 20 : r.c != null ? (r.c ? 75 : 40) : null;
    if (signal === null) continue;
    obs.push({ haw, signal });
  }

  return doctrine.energy_curve.map((pt) => {
    // observations within ±0.75h of this control point
    const near = obs.filter((o) => Math.abs(o.haw - pt.hours_after_wake) <= 0.75);
    if (near.length < 3) return pt;
    const observed = near.reduce((s, o) => s + o.signal, 0) / near.length;
    const delta = Math.max(-CURVE_ADJUST_CAP, Math.min(CURVE_ADJUST_CAP, observed - pt.capacity));
    return { ...pt, capacity: Math.round(Math.max(0, Math.min(100, pt.capacity + delta))) };
  });
}

export interface AdherenceRow {
  blockType: string;
  planned: number;
  /** Completed, from ANY source. */
  completed: number;
  rate: number;
  /** Of `completed`, how many the owner recorded himself. */
  completedManual: number;
  /** Of `completed`, how many Screen Time derived. */
  completedAuto: number;
  /** Outcome rows of each provenance (completed or not). */
  outcomesManual: number;
  outcomesAuto: number;
  /** Share of this row's outcome rows that are machine-derived, 0-1. */
  autoShare: number;
}

/**
 * Adherence per block type — if gym gets skipped 70% of the time, the doctrine or the
 * placement is wrong.
 *
 * Manual and auto (Screen Time) outcomes are counted SEPARATELY. A week of auto-captures
 * must not be readable as "the owner reported he did all of this": the aggregate rate is
 * only as trustworthy as autoShare is low, and the caller can see that here.
 */
export function adherenceStats(db: Db): AdherenceRow[] {
  const rows = db
    .prepare(
      `SELECT b.block_type AS t, COUNT(*) AS planned,
              SUM(COALESCE(o.completed, 0)) AS done,
              SUM(CASE WHEN o.completed = 1 AND o.note LIKE $auto THEN 1 ELSE 0 END) AS done_auto,
              SUM(CASE WHEN o.id IS NOT NULL AND o.note LIKE $auto THEN 1 ELSE 0 END) AS out_auto,
              SUM(CASE WHEN o.id IS NOT NULL AND (o.note IS NULL OR o.note NOT LIKE $auto) THEN 1 ELSE 0 END) AS out_manual
       FROM block b LEFT JOIN block_outcome o ON o.block_id = b.id
       WHERE b.is_anchor = 0 AND b.created_at >= datetime('now', '-30 days')
       GROUP BY b.block_type ORDER BY b.block_type`
    )
    .all({ auto: AUTO_NOTE_LIKE }) as {
      t: string; planned: number; done: number; done_auto: number; out_auto: number; out_manual: number;
    }[];
  return rows.map((r) => {
    const outcomes = r.out_auto + r.out_manual;
    return {
      blockType: r.t,
      planned: r.planned,
      completed: r.done,
      rate: r.planned ? Math.round((r.done / r.planned) * 100) / 100 : 0,
      completedManual: r.done - r.done_auto,
      completedAuto: r.done_auto,
      outcomesManual: r.out_manual,
      outcomesAuto: r.out_auto,
      autoShare: outcomes ? Math.round((r.out_auto / outcomes) * 100) / 100 : 0,
    };
  });
}

/**
 * Apply learned values back into the doctrine YAML — multipliers + curve ONLY.
 * hard_constraints are copied through untouched, by construction.
 */
export function applyLearning(yamlText: string, db: Db): { yaml: string; changed: boolean } {
  const doctrine = parseDoctrine(yamlText);
  const doc = yaml.load(yamlText) as Record<string, any>;
  const before = JSON.stringify([doc.estimation.category_multipliers, doc.energy_curve]);
  doc.estimation.category_multipliers = recomputeMultipliers(db, doctrine.estimation.category_multipliers);
  doc.energy_curve = adjustCurve(db, doctrine);
  const changed = JSON.stringify([doc.estimation.category_multipliers, doc.energy_curve]) !== before;
  return { yaml: yaml.dump(doc, { lineWidth: 100 }), changed };
}
