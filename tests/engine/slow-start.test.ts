// A slower start on a lighter day.
//
// Owner ask 2026-08-06: "when possible, it should let me have a slower start to the morning
// versus when I'm more to do that day. And it should be able to determine which is best. like
// a smart assistant."
//
// The morning routine was a flat 30 minutes — his own words from 2026-08-05, "half an hour to
// shower and read". But he said that as a FLOOR, and a constant spends an empty Saturday
// exactly like a day with a test in it. The stated duration stays the floor; the room the day
// has left buys the difference.

import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { buildGrid } from "../../main/engine/grid.ts";
import { solve, dayRoomFactor, ritualDuration, MORNING_SLOW_START_MAX, type PlannerTask } from "../../main/engine/solver.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const MORNING = "Morning routine (shower, reading)";

let seq = 0;
const mkTask = (over: Partial<PlannerTask> = {}): PlannerTask => ({
  id: ++seq,
  title: `Task ${seq}`,
  blockType: "focused_work",
  cognitiveLoad: 3,
  estimatedMinutes: 60,
  isMit: false,
  deadlineMin: null,
  project: null,
  splittable: false,
  ...over,
});

const morningBlock = (r: { blocks: { title: string; startMin: number; endMin: number }[] }) =>
  r.blocks.find((b) => b.title === MORNING);

describe("ritualDuration", () => {
  const morning = { type: "personal" as const, at_hours_after_wake: 0, duration: 30 };

  it("gives the stated floor when the day has no room at all", () => {
    expect(ritualDuration(morning, 0)).toBe(30);
  });

  it("expands toward the ceiling as the day empties", () => {
    expect(ritualDuration(morning, 1)).toBe(MORNING_SLOW_START_MAX);
    const half = ritualDuration(morning, 0.5);
    expect(half).toBeGreaterThan(30);
    expect(half).toBeLessThan(MORNING_SLOW_START_MAX);
  });

  it("never drops below what he actually asked for", () => {
    for (const room of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      expect(ritualDuration(morning, room)).toBeGreaterThanOrEqual(30);
    }
  });

  it("leaves every other ritual exactly as it was — a comms window has no reason to grow", () => {
    const comms = { type: "comms" as const, at_hours_after_wake: 2, duration: 25 };
    const lunch = { type: "meal" as const, at_hours_after_wake: 5.5, duration: 40 };
    const shutdown = { type: "shutdown" as const, duration: 15 };
    for (const room of [0, 0.5, 1]) {
      expect(ritualDuration(comms, room)).toBe(25);
      expect(ritualDuration(lunch, room)).toBe(40);
      expect(ritualDuration(shutdown, room)).toBe(15);
    }
  });

  it("honours an explicit doctrine ceiling over the wake-anchored default", () => {
    const capped = { ...morning, expand_to: 45 };
    expect(ritualDuration(capped, 1)).toBe(45);
    // A ceiling at or below the floor is simply not an expansion.
    expect(ritualDuration({ ...morning, expand_to: 20 }, 1)).toBe(30);
  });
});

describe("dayRoomFactor", () => {
  const grid = buildGrid(doctrine, []);

  it("is 1 on a day with nothing on it", () => {
    expect(dayRoomFactor([], grid)).toBe(1);
  });

  it("falls as work is added, and bottoms out rather than going negative", () => {
    const light = dayRoomFactor([mkTask({ estimatedMinutes: 60 })], grid);
    const heavy = dayRoomFactor(
      [1, 2, 3, 4, 5, 6].map(() => mkTask({ estimatedMinutes: 90 })),
      grid
    );
    expect(light).toBeGreaterThan(heavy);
    expect(heavy).toBeGreaterThanOrEqual(0);

    const absurd = dayRoomFactor(
      Array.from({ length: 40 }, () => mkTask({ estimatedMinutes: 120 })),
      grid
    );
    expect(absurd).toBe(0);
  });

  it("counts an external anchor as a fuller day, without being told", () => {
    // The four-hour hangout he added to Google on 2026-08-06 is not "a light day".
    const withHangout = buildGrid(doctrine, [
      { startMin: 16 * 60, endMin: 19 * 60, blockType: "personal", title: "Hangout" },
    ]);
    const t = [mkTask({ estimatedMinutes: 120 })];
    expect(dayRoomFactor(t, withHangout)).toBeLessThan(dayRoomFactor(t, grid));
  });
});

describe("the morning actually moves", () => {
  it("runs long on an empty day and drops to the floor on an over-committed one", () => {
    const empty = morningBlock(solve([], doctrine, []))!;
    // Genuinely more work than the day holds — the wake-to-shutdown window is ~13h, so this
    // is what "no room" actually means. (9h of demand is a busy day, not a full one, and
    // correctly still earns a slightly longer morning.)
    const full = morningBlock(
      solve(Array.from({ length: 12 }, () => mkTask({ estimatedMinutes: 90 })), doctrine, [])
    )!;
    expect(empty).toBeTruthy();
    expect(full).toBeTruthy();

    const emptyLen = empty.endMin - empty.startMin;
    const fullLen = full.endMin - full.startMin;
    expect(emptyLen).toBeGreaterThan(fullLen);
    expect(fullLen).toBe(30); // the floor he stated, never less
    expect(emptyLen).toBeLessThanOrEqual(MORNING_SLOW_START_MAX);
  });

  it("scales in between rather than flipping — a busy day still beats an overloaded one", () => {
    const len = (mins: number, n: number) => {
      const b = morningBlock(solve(Array.from({ length: n }, () => mkTask({ estimatedMinutes: mins })), doctrine, []))!;
      return b.endMin - b.startMin;
    };
    const quiet = len(60, 1);
    const busy = len(90, 6);
    const overloaded = len(90, 12);
    expect(quiet).toBeGreaterThan(busy);
    expect(busy).toBeGreaterThan(overloaded);
  });

  it("still starts at wake, however long it runs", () => {
    for (const tasks of [[], [mkTask()], [mkTask(), mkTask(), mkTask()]]) {
      const b = morningBlock(solve(tasks, doctrine, []))!;
      expect(b.startMin).toBe(buildGrid(doctrine, []).wakeMin);
    }
  });

  it("is deterministic — same day twice, same morning", () => {
    const tasks = () => [mkTask({ id: 101, estimatedMinutes: 90 }), mkTask({ id: 102, estimatedMinutes: 45 })];
    const a = morningBlock(solve(tasks(), doctrine, []))!;
    const b = morningBlock(solve(tasks(), doctrine, []))!;
    expect([a.startMin, a.endMin]).toEqual([b.startMin, b.endMin]);
  });

  it("a longer morning never eats the work the day actually has", () => {
    // The slow start is a luxury of a light day; it must not become the reason work is cut.
    const tasks = [mkTask({ estimatedMinutes: 90 }), mkTask({ estimatedMinutes: 60 })];
    const r = solve(tasks, doctrine, []);
    expect(r.unplaced).toHaveLength(0);
    for (const t of tasks) expect(r.blocks.some((b) => b.taskId === t.id)).toBe(true);
  });
});
