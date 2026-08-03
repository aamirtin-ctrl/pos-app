import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import {
  captureOutcomes, recomputeMultipliers, adjustCurve, applyLearning, CURVE_ADJUST_CAP,
} from "../../main/engine/learning.ts";

let dir: string;
let db: Db;
const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-learn-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Insert a block + outcome where actual took `ratio`× the planned 60 minutes. */
function seedOutcome(type: string, ratio: number, day = "2026-08-01") {
  const start = `${day}T10:00:00`;
  const end = `${day}T11:00:00`;
  const actualEnd = new Date(new Date(`${day}T10:00:00Z`).getTime() + 60 * ratio * 60000)
    .toISOString()
    .replace("Z", "");
  const { lastInsertRowid } = db
    .prepare("INSERT INTO block (block_type, title, starts_at, ends_at) VALUES (?, 'x', ?, ?)")
    .run(type, start, end);
  captureOutcomes(db, [
    { blockId: Number(lastInsertRowid), completed: true, actualStartAt: `${day}T10:00:00`, actualEndAt: actualEnd },
  ]);
}

describe("learning loop (§5.8)", () => {
  it("recomputes multipliers from the rolling actual/estimated ratio (>=5 samples)", () => {
    for (let i = 0; i < 6; i++) seedOutcome("deep_work", 1.4);
    const next = recomputeMultipliers(db, { deep_work: 1.25, admin: 1.15 });
    expect(next.deep_work).toBeGreaterThan(1.25); // consistently over → multiplier grows
    expect(next.deep_work).toBeLessThanOrEqual(2.0); // clamped
    expect(next.admin).toBe(1.15); // untouched, no samples
  });

  it("needs >=5 samples per category before touching a multiplier", () => {
    for (let i = 0; i < 3; i++) seedOutcome("admin", 3.0);
    const next = recomputeMultipliers(db, { admin: 1.15 });
    expect(next.admin).toBe(1.15);
  });

  it("curve does not move with <30 days of data", () => {
    for (let i = 0; i < 10; i++) seedOutcome("deep_work", 1.0);
    const curve = adjustCurve(db, doctrine);
    expect(curve).toEqual(doctrine.energy_curve);
  });

  it("curve adjustment is capped at ±15 per revision", () => {
    // 35 distinct days of low-focus outcomes at 10:00 (≈2.5h after 07:30 wake)
    for (let i = 1; i <= 35; i++) {
      const day = `2026-07-${String((i % 28) + 1).padStart(2, "0")}`;
      const start = `${day}T10:00:00`;
      const { lastInsertRowid } = db
        .prepare("INSERT INTO block (block_type, title, starts_at, ends_at) VALUES ('deep_work','x',?,?)")
        .run(start, `${day}T11:00:00`);
      // duplicate days are fine; distinct-day count needs 30 → use unique days
      db.prepare(
        "INSERT INTO block_outcome (block_id, completed, perceived_focus) VALUES (?, 1, 1)"
      ).run(lastInsertRowid);
    }
    // ensure 30+ distinct days
    for (let i = 1; i <= 31; i++) {
      const day = `2026-06-${String(i <= 30 ? i : 30).padStart(2, "0")}`;
      const { lastInsertRowid } = db
        .prepare("INSERT INTO block (block_type, title, starts_at, ends_at) VALUES ('deep_work','x',?,?)")
        .run(`${day}T10:00:00`, `${day}T11:00:00`);
      db.prepare("INSERT INTO block_outcome (block_id, completed, perceived_focus) VALUES (?, 1, 1)").run(
        lastInsertRowid
      );
    }
    const curve = adjustCurve(db, doctrine);
    // control point near 2.0-3.0h after wake: perceived focus 1 → signal 20, but capped fall of 15
    const pt2 = curve.find((p) => p.hours_after_wake === 2.0)!;
    const orig = doctrine.energy_curve.find((p) => p.hours_after_wake === 2.0)!;
    expect(orig.capacity - pt2.capacity).toBeLessThanOrEqual(CURVE_ADJUST_CAP);
    expect(pt2.capacity).toBeLessThan(orig.capacity); // it did move down
  });

  it("applyLearning NEVER touches hard_constraints", () => {
    for (let i = 0; i < 6; i++) seedOutcome("deep_work", 1.5);
    const { yaml: out } = applyLearning(DEFAULT_DOCTRINE_YAML, db);
    const before = parseDoctrine(DEFAULT_DOCTRINE_YAML);
    const after = parseDoctrine(out);
    expect(after.hard_constraints).toEqual(before.hard_constraints);
    expect(after.estimation.category_multipliers.deep_work).not.toBe(
      before.estimation.category_multipliers.deep_work
    );
  });
});
