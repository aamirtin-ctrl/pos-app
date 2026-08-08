// Property-based fuzzing of the solver.
//
// The hand-written suites check cases someone thought of. This checks the INVARIANTS that
// must hold for every input, over a few thousand randomly generated days — which is how the
// remaining bugs in a carefully-written solver get found. Every failure this can produce is
// a real one: a day where the planner double-books, invents a block outside the clock, drops
// work without saying so, or answers differently to the same question twice.
//
// Deterministic by construction: a seeded LCG, never Math.random, so a failure reproduces
// exactly and the suite can never be flaky.

import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML, BLOCK_TYPES, type BlockType } from "../../main/engine/doctrine.ts";
import { solve, type PlannerTask } from "../../main/engine/solver.ts";
import type { Anchor, Flexibility } from "../../main/engine/grid.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

/** Numerical Recipes LCG — tiny, deterministic, good enough to shake a scheduler. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TIERS: Flexibility[] = ["fixed", "preferred", "flexible"];

function randomDay(seed: number): { tasks: PlannerTask[]; anchors: Anchor[] } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  const tasks: PlannerTask[] = [];
  for (let i = 0; i < int(0, 8); i++) {
    tasks.push({
      id: i + 1,
      title: `t${i}`,
      blockType: pick(BLOCK_TYPES) as BlockType,
      cognitiveLoad: int(1, 5),
      estimatedMinutes: int(1, 240),
      isMit: r() < 0.2,
      deadlineMin: r() < 0.25 ? int(0, 1440) : null,
      project: null,
      splittable: r() < 0.3,
    });
  }

  const anchors: Anchor[] = [];
  for (let i = 0; i < int(0, 5); i++) {
    const startMin = int(0, 1400);
    anchors.push({
      startMin,
      endMin: Math.min(1440, startMin + int(1, 300)),
      blockType: pick(["meeting", "personal"]) as Anchor["blockType"],
      title: `a${i}`,
      flexibility: pick(TIERS),
    });
  }
  return { tasks, anchors };
}

const overlaps = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) =>
  a.startMin < b.endMin && a.endMin > b.startMin;

const SEEDS = 3000;

describe("solver invariants over random days", () => {
  it("never emits a block outside the clock or with a non-positive length", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, anchors } = randomDay(seed);
      const r = solve(tasks, doctrine, anchors);
      for (const b of r.blocks) {
        const where = `seed ${seed}: "${b.title}" ${b.startMin}-${b.endMin}`;
        expect(Number.isFinite(b.startMin), where).toBe(true);
        expect(Number.isFinite(b.endMin), where).toBe(true);
        expect(b.endMin, where).toBeGreaterThan(b.startMin);
        expect(b.startMin, where).toBeGreaterThanOrEqual(0);
        expect(b.endMin, where).toBeLessThanOrEqual(1440);
      }
    }
  });

  it("never double-books a minute of planner-placed work", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, anchors } = randomDay(seed);
      const r = solve(tasks, doctrine, anchors);
      const placed = r.blocks.filter((b) => !b.isAnchor);
      for (const p of placed) {
        for (const other of r.blocks) {
          if (other === p) continue;
          expect(
            overlaps(p, other),
            `seed ${seed}: "${p.title}" ${p.startMin}-${p.endMin} overlaps "${other.title}" ${other.startMin}-${other.endMin}`
          ).toBe(false);
        }
      }
    }
  });

  it("accounts for every task exactly once — placed or unplaced with a reason", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, anchors } = randomDay(seed);
      const r = solve(tasks, doctrine, anchors);
      const placedIds = r.blocks.filter((b) => b.taskId != null).map((b) => b.taskId!);
      const unplacedIds = r.unplaced.map((u) => u.task.id);
      for (const t of tasks) {
        const isPlaced = placedIds.includes(t.id);
        const isUnplaced = unplacedIds.includes(t.id);
        expect(
          isPlaced || isUnplaced,
          `seed ${seed}: task ${t.id} vanished — neither placed nor reported unplaced`
        ).toBe(true);
        // A SPLITTABLE task may legitimately be both: one chunk seated, the remainder
        // reported. That is the documented contract, not a leak. Anything else is.
        if (!t.splittable) {
          expect(isPlaced && isUnplaced, `seed ${seed}: task ${t.id} both placed and unplaced`).toBe(false);
        }
      }
      for (const u of r.unplaced) expect(u.reason, `seed ${seed}`).toBeTruthy();
    }
  });

  it("is deterministic — the same day solved twice is the same answer", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const a = randomDay(seed);
      const b = randomDay(seed);
      expect(JSON.stringify(solve(a.tasks, doctrine, a.anchors)), `seed ${seed}`).toBe(
        JSON.stringify(solve(b.tasks, doctrine, b.anchors))
      );
    }
  });

  it("never schedules work before a floor the caller set", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, anchors } = randomDay(seed);
      const floorMin = (seed * 37) % 1400;
      const r = solve(tasks, doctrine, anchors, { floorMin });
      for (const b of r.blocks.filter((x) => !x.isAnchor)) {
        expect(
          b.startMin,
          `seed ${seed}: placed "${b.title}" at ${b.startMin}, before floor ${floorMin}`
        ).toBeGreaterThanOrEqual(floorMin);
      }
    }
  });

  it("honours every hard deadline it claims to have placed", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { tasks, anchors } = randomDay(seed);
      const r = solve(tasks, doctrine, anchors);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const b of r.blocks) {
        if (b.taskId == null) continue;
        const t = byId.get(b.taskId);
        if (!t?.deadlineMin) continue;
        expect(
          b.endMin,
          `seed ${seed}: "${t.title}" ends ${b.endMin} but its deadline is ${t.deadlineMin}`
        ).toBeLessThanOrEqual(t.deadlineMin);
      }
    }
  });
});
