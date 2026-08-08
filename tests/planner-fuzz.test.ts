// Property-based fuzzing of generatePlan — the whole planner layer, against a real DB.
//
// tests/engine/solver-fuzz.test.ts covers the pure solver. This covers everything wrapped
// around it: reading the task pool, materializing recurrences, carrying pinned work forward,
// writing plan and block rows, recording what could not be placed. That layer is where the
// bugs found on 2026-08-07/08 actually lived — a stale template re-infecting instances, a
// task both scheduled and reported missing, an anchor that produced a corrupt block row.
//
// The invariants below are the ones the DAY has to satisfy for the app to be trustworthy:
// what is written is internally consistent, nothing is double-booked, nothing silently
// vanishes, and asking twice gives the same answer.
//
// Seeded LCG, no network, no LLM (llm = null exercises the outage path too).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { generatePlan, tasksUnaccountedFor } from "../main/planner.ts";
import { BLOCK_TYPES } from "../main/engine/doctrine.ts";
import type { Anchor } from "../main/engine/grid.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DATE = "2026-08-12";
const NOW = new Date(`${DATE}T06:00:00`); // pinned: generatePlan floors today's plan at the clock

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-planner-fuzz-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine");
  secrets = new SecretStore(path.join(dir, "secrets"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Seed a random day's worth of tasks; return the anchors to plan against. */
function seedDay(seed: number): Anchor[] {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  const insert = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                       is_mit, status, splittable, estimate_source, plan_date, recurrence)
     VALUES (?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)`
  );
  for (let i = 0; i < int(0, 7); i++) {
    const raw = int(5, 200);
    insert.run(
      `task-${i}`,
      pick(BLOCK_TYPES),
      int(1, 5),
      raw,
      raw,
      r() < 0.2 ? 1 : 0,
      r() < 0.25 ? 1 : 0,
      r() < 0.5 ? "stated" : "inferred",
      DATE,
      r() < 0.15 ? "daily" : null
    );
  }

  const anchors: Anchor[] = [];
  for (let i = 0; i < int(0, 4); i++) {
    const startMin = int(0, 1380);
    anchors.push({
      startMin,
      endMin: Math.min(1440, startMin + int(15, 240)),
      blockType: pick(["meeting", "personal"]) as Anchor["blockType"],
      title: `anchor-${i}`,
      flexibility: pick(["fixed", "preferred", "flexible"]) as Anchor["flexibility"],
    });
  }
  return anchors;
}

const deps = (anchors: Anchor[]) => ({ anchors: async () => anchors, now: NOW });

/** generatePlan returns a view object, not a row — the id lives in the DB. */
const newestPlanId = (): number =>
  (db.prepare("SELECT MAX(id) AS id FROM plan WHERE plan_date = ?").get(DATE) as { id: number }).id;

const blocksOf = (planId: number) =>
  db
    .prepare("SELECT id, task_id, title, starts_at, ends_at, is_anchor FROM block WHERE plan_id = ? ORDER BY starts_at")
    .all(planId) as { id: number; task_id: number | null; title: string; starts_at: string; ends_at: string; is_anchor: number }[];

const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/** Kept modest: each iteration is a real solve plus real SQLite writes. */
const SEEDS = 120;

describe("generatePlan invariants over random days", () => {
  it("writes only well-formed blocks — real times, positive length, on the planned day", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      const plan = await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      expect(plan, `seed ${seed}`).toBeTruthy();
      for (const b of blocksOf(newestPlanId())) {
        const where = `seed ${seed}: "${b.title}" ${b.starts_at}..${b.ends_at}`;
        expect(b.starts_at.slice(0, 10), where).toBe(DATE);
        expect(Number.isNaN(Date.parse(b.starts_at)), where).toBe(false);
        expect(Number.isNaN(Date.parse(b.ends_at)), where).toBe(false);
        expect(Date.parse(b.ends_at), where).toBeGreaterThan(Date.parse(b.starts_at));
      }
      db.prepare("DELETE FROM task").run();
    }
  });

  it("never double-books a minute in the stored day", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      const pid = newestPlanId();
      const placed = blocksOf(pid).filter((b) => !b.is_anchor);
      for (const p of placed) {
        for (const other of blocksOf(pid)) {
          if (other.id === p.id) continue;
          const overlap =
            minutesOf(p.starts_at) < minutesOf(other.ends_at) && minutesOf(p.ends_at) > minutesOf(other.starts_at);
          expect(
            overlap,
            `seed ${seed}: "${p.title}" ${p.starts_at}-${p.ends_at} overlaps "${other.title}" ${other.starts_at}-${other.ends_at}`
          ).toBe(false);
        }
      }
      db.prepare("DELETE FROM task").run();
    }
  });

  it("unplaced_tasks is valid JSON naming real tasks, each with a reason", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      const raw = (db.prepare("SELECT unplaced_tasks u FROM plan WHERE id = ?").get(newestPlanId()) as { u: string }).u;
      let parsed: unknown;
      expect(() => (parsed = JSON.parse(raw)), `seed ${seed}: ${raw}`).not.toThrow();
      expect(Array.isArray(parsed), `seed ${seed}`).toBe(true);
      for (const u of parsed as { taskId: number; reason: string }[]) {
        expect(u.reason, `seed ${seed}`).toBeTruthy();
        const exists = db.prepare("SELECT 1 FROM task WHERE id = ?").get(u.taskId);
        expect(exists, `seed ${seed}: unplaced names task ${u.taskId}, which does not exist`).toBeTruthy();
      }
      db.prepare("DELETE FROM task").run();
    }
  });

  it("no schedulable task silently vanishes — it is placed or explained", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      const pid = newestPlanId();
      const placedIds = new Set(blocksOf(pid).map((b) => b.task_id).filter((x): x is number => x != null));
      const unplaced = JSON.parse(
        (db.prepare("SELECT unplaced_tasks u FROM plan WHERE id = ?").get(pid) as { u: string }).u
      ) as { taskId: number }[];
      const explained = new Set(unplaced.map((u) => u.taskId));
      // Only tasks still sitting on this day: the planner may legitimately defer windowed
      // work to another date, which moves plan_date rather than dropping it.
      const onThisDay = db
        .prepare("SELECT id FROM task WHERE plan_date = ? AND status IN ('inbox','planned','in_progress')")
        .all(DATE) as { id: number }[];
      for (const t of onThisDay) {
        expect(
          placedIds.has(t.id) || explained.has(t.id),
          `seed ${seed}: task ${t.id} is on ${DATE} but neither scheduled nor reported unplaced`
        ).toBe(true);
      }
      db.prepare("DELETE FROM task").run();
    }
  });

  it("the stale-plan trigger CONVERGES — a solved day never asks to be solved again", async () => {
    // tasksUnaccountedFor drives a re-plan (planner.replanUpcoming). If any task could be
    // neither scheduled nor reported, the trigger would fire on every tick forever: a
    // 15-minute loop that re-solves and re-pushes his calendar with no new answer. This is
    // the property that rules that out, checked against the same random corpus.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      expect(
        tasksUnaccountedFor(db, DATE),
        `seed ${seed}: the day still reports unaccounted work immediately after being solved`
      ).toBe(0);
      db.prepare("DELETE FROM task").run();
    }
  });

  it("re-planning the same untouched day produces the same schedule", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const anchors = seedDay(seed);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      const a = blocksOf(newestPlanId()).map((b) => `${b.title}|${b.starts_at}|${b.ends_at}`);
      await generatePlan(db, doctrineDir, secrets, null, DATE, deps(anchors));
      const b = blocksOf(newestPlanId()).map((x) => `${x.title}|${x.starts_at}|${x.ends_at}`);
      expect(b, `seed ${seed}: re-planning an unchanged day moved it`).toEqual(a);
      db.prepare("DELETE FROM task").run();
    }
  });
});

// ── the two days a year that are not 24 hours long ──────────────────────────
//
// Twice a year his day is 23 or 25 hours. Every date bug found on 2026-08-08 was some form of
// assuming otherwise, so the whole-day outcome is worth asserting rather than inferring from
// the unit fixes: the grid is a wall clock bounded by wake and the shutdown ritual, so a DST
// day should look exactly like any other. This is the test that notices if that stops being
// true.
describe("planning across a DST transition", () => {
  const DST_DAYS = [
    ["2027-03-13", "the day before spring forward"],
    ["2027-03-14", "the 23-hour day"],
    ["2027-03-15", "the day after"],
    ["2027-11-06", "the day before fall back"],
    ["2027-11-07", "the 25-hour day"],
    ["2027-11-08", "the day after"],
  ] as const;

  for (const [DAY, label] of DST_DAYS) {
    it(`${DAY} — ${label} — plans like any other day`, async () => {
      const ins = db.prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                           is_mit, status, plan_date, estimate_source)
         VALUES (?, 'focused_work', 3, 90, 90, 0, 'inbox', ?, 'stated')`
      );
      for (let i = 0; i < 3; i++) ins.run(`task-${i}`, DAY);

      await generatePlan(db, doctrineDir, secrets, null, DAY, {
        anchors: async () => [],
        now: new Date(`${DAY}T06:00:00`),
      });
      const pid = (db.prepare("SELECT MAX(id) id FROM plan WHERE plan_date = ?").get(DAY) as { id: number }).id;
      const rows = db
        .prepare("SELECT title, starts_at, ends_at FROM block WHERE plan_id = ? ORDER BY starts_at")
        .all(pid) as { title: string; starts_at: string; ends_at: string }[];

      expect(rows.length, "the day is still a day").toBeGreaterThan(0);
      for (const b of rows) {
        expect(b.starts_at.slice(0, 10), `${b.title} escaped the date`).toBe(DAY);
        expect(Date.parse(b.ends_at), `${b.title} ends before it starts`).toBeGreaterThan(Date.parse(b.starts_at));
      }
      for (let i = 1; i < rows.length; i++) {
        expect(
          Date.parse(rows[i].starts_at),
          `"${rows[i].title}" overlaps "${rows[i - 1].title}"`
        ).toBeGreaterThanOrEqual(Date.parse(rows[i - 1].ends_at));
      }
      const unplaced = JSON.parse(
        (db.prepare("SELECT unplaced_tasks u FROM plan WHERE id = ?").get(pid) as { u: string }).u
      ) as unknown[];
      expect(unplaced, "three 90-minute tasks fit in any of these days").toHaveLength(0);
      db.prepare("DELETE FROM task").run();
    });
  }
});
