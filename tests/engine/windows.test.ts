// Deadline WINDOWS — the owner's report of 2026-08-06, in his own words:
//
//   Yesterday: "maybe about two hours in total to go through my Stanford academic advising
//   stuff — I could do this the rest of the week, it doesn't have to be today."
//   Today:     "two hours for a Stanford math test today."
//
// The advising task was pinned to a single day, so this morning it competed with the test
// instead of being deferred. What he expected: "the app should have remembered the work was
// due anytime this week and moved it."
//
// These tests pin the whole chain — the phrase is read, the solver defers instead of cramming,
// and the planner actually advances the day the task lives on — plus the two properties that
// keep it honest: on the LAST day of a window a failure is a real failure, and a task with no
// window is untouched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { solve, isDeferrable, nextDayInWindow, type PlannerTask } from "../../main/engine/solver.ts";
import { parseWindow, endOfThisWeek } from "../../main/engine/parse.ts";
import { deterministicNarration } from "../../main/engine/narrate.ts";
import type { Anchor } from "../../main/engine/grid.ts";
import { openDb, type Db } from "../../main/db/db.ts";
import { SecretStore } from "../../main/secrets.ts";
import { generatePlan, type ReplanDeps } from "../../main/planner.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const W = 7 * 60 + 30; // wake 07:30
const SLEEP = 23 * 60;

/** The real dates from his report. 2026-08-06 is a Thursday; the week closes on the 9th. */
const THU = "2026-08-06";
const FRI = "2026-08-07";
const SUN = "2026-08-09";

let nextId = 1;
function mkTask(p: Partial<PlannerTask> & { blockType: PlannerTask["blockType"] }): PlannerTask {
  return {
    id: nextId++,
    title: p.title ?? `task-${nextId}`,
    blockType: p.blockType,
    cognitiveLoad: p.cognitiveLoad ?? 3,
    estimatedMinutes: p.estimatedMinutes ?? 60,
    isMit: p.isMit ?? false,
    deadlineMin: p.deadlineMin ?? null,
    project: p.project ?? null,
    splittable: p.splittable ?? false,
    windowEnd: p.windowEnd ?? null,
    planDate: p.planDate ?? THU,
  };
}

/**
 * The advising task, captured YESTERDAY with a week of runway. Deliberately created FIRST, so
 * it holds the lower id — if the test below passed on id order alone it would prove nothing.
 */
const advising = (windowEnd: string | null) =>
  mkTask({
    blockType: "focused_work",
    estimatedMinutes: 120,
    title: "Go through Stanford academic advising",
    windowEnd,
    planDate: THU,
  });

/** The math test. Today or never. */
const mathTest = () =>
  mkTask({ blockType: "focused_work", estimatedMinutes: 120, title: "Stanford math test", planDate: THU });

/** A day whose only free stretch is 13:00–17:00 — enough for exactly one two-hour block. */
const roomForOne: Anchor[] = [
  { startMin: W, endMin: 13 * 60, blockType: "personal", title: "Out all morning" },
  { startMin: 17 * 60, endMin: SLEEP, blockType: "personal", title: "Out all evening" },
];

describe("deadline windows — the contended day (owner report 2026-08-06)", () => {
  it("the test is placed and the advising work is deferred, not dropped", () => {
    const adv = advising(SUN); // created first: lower id, and still the one that gives way
    const test = mathTest();
    const r = solve([adv, test], doctrine, roomForOne);

    const placedTest = r.blocks.find((b) => b.taskId === test.id);
    expect(placedTest, "the task that can only happen today must be the one that happens").toBeTruthy();
    expect(r.blocks.find((b) => b.taskId === adv.id)).toBeUndefined();

    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].task.id).toBe(adv.id);
    // The distinction the whole feature exists for: this is not a failure.
    expect(r.unplaced[0].reason).toBe("deferred_within_window");
    expect(nextDayInWindow(r.unplaced[0].task)).toBe(FRI);
  });

  it("without the window the SAME pair resolves the other way — the window is doing the work", () => {
    const adv = advising(null); // captured with no runway: just another task, lower id, goes first
    const test = mathTest();
    const r = solve([adv, test], doctrine, roomForOne);

    expect(r.blocks.find((b) => b.taskId === adv.id)).toBeTruthy();
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].task.id).toBe(test.id);
    expect(r.unplaced[0].reason).not.toBe("deferred_within_window");
  });

  it("a day with room for both places both — deferral is pressure relief, not a policy", () => {
    const adv = advising(SUN);
    const test = mathTest();
    const r = solve([adv, test], doctrine, []); // an open day

    expect(r.blocks.find((b) => b.taskId === test.id)).toBeTruthy();
    expect(r.blocks.find((b) => b.taskId === adv.id)).toBeTruthy();
    expect(r.unplaced).toHaveLength(0);
  });

  it("a windowed MIT gives way to same-day work rather than stranding it", () => {
    // The cross-phase case: MITs are placed before everything else, so ranking alone cannot
    // save the same-day task — the solver has to withhold the windowed one and re-solve.
    const adv = mkTask({
      blockType: "focused_work",
      estimatedMinutes: 120,
      title: "Advising (flagged MIT)",
      isMit: true,
      windowEnd: SUN,
      planDate: THU,
    });
    const test = mathTest();
    const r = solve([adv, test], doctrine, roomForOne);

    expect(r.blocks.find((b) => b.taskId === test.id)).toBeTruthy();
    expect(r.unplaced.map((u) => [u.task.id, u.reason])).toEqual([[adv.id, "deferred_within_window"]]);
  });
});

describe("deadline windows — the last day of a window is a wall, not a slope", () => {
  const slammed: Anchor[] = [{ startMin: W, endMin: SLEEP, blockType: "personal", title: "slammed" }];

  it("on its FINAL window day a windowed task fails for real (no_eligible_slot)", () => {
    const t = advising(THU); // window_end === the day being planned
    expect(isDeferrable(t)).toBe(false);
    const r = solve([t], doctrine, slammed);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].reason).toBe("no_eligible_slot");
    expect(nextDayInWindow(t)).toBeNull();
  });

  it("the same task with a day still left defers instead", () => {
    const t = advising(FRI);
    expect(isDeferrable(t)).toBe(true);
    const r = solve([t], doctrine, slammed);
    expect(r.unplaced[0].reason).toBe("deferred_within_window");
    expect(nextDayInWindow(t)).toBe(FRI);
  });

  it("a window already in the past is not a licence to move anything", () => {
    const t = advising("2026-08-01");
    expect(isDeferrable(t)).toBe(false);
    const r = solve([t], doctrine, slammed);
    expect(r.unplaced[0].reason).toBe("no_eligible_slot");
  });
});

describe("deadline windows — determinism", () => {
  it("same input twice → identical output, with windowed tasks in the mix", () => {
    const anchors: Anchor[] = [
      { startMin: 10 * 60, endMin: 10 * 60 + 30, blockType: "meeting", title: "standup" },
      { startMin: 15 * 60, endMin: 15 * 60 + 30, blockType: "meeting", title: "1:1", movable: true },
      { startMin: 13 * 60, endMin: 14 * 60, blockType: "personal", title: "Reading", flexibility: "preferred" },
    ];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 120, cognitiveLoad: 5, windowEnd: SUN, title: "windowed deep" }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "focused_work", estimatedMinutes: 120, windowEnd: FRI, title: "windowed focus" }),
      mkTask({ blockType: "admin", estimatedMinutes: 45, project: "ops", windowEnd: SUN, title: "windowed admin" }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, project: "ops", title: "same-day admin" }),
      mkTask({ blockType: "gym", estimatedMinutes: 60, title: "Gym" }),
    ];
    const r1 = solve(ts, doctrine, anchors);
    const r2 = solve(ts, doctrine, anchors);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    // and the order the tasks arrive in must not change the day either
    const r3 = solve([...ts].reverse(), doctrine, anchors);
    expect(JSON.stringify(r3.blocks)).toBe(JSON.stringify(r1.blocks));
  });
});

describe("deadline windows — narration reads as a choice, not a loss", () => {
  it("the deterministic fallback names where it went and how long it has", () => {
    const adv = advising(SUN);
    const test = mathTest();
    const text = deterministicNarration(solve([adv, test], doctrine, roomForOne), doctrine);
    expect(text).toContain("Go through Stanford academic advising moved to Friday");
    expect(text).toContain("until Sunday");
    expect(text).not.toMatch(/did not fit/);
  });

  it("real unplaced work is still reported as unplaced", () => {
    const slammed: Anchor[] = [{ startMin: W, endMin: SLEEP, blockType: "personal", title: "slammed" }];
    const text = deterministicNarration(solve([mathTest()], doctrine, slammed), doctrine);
    expect(text).toMatch(/did not fit/);
  });
});

describe("parseWindow — the five phrases, without an LLM", () => {
  it('"this week" → the coming Sunday, flexible', () => {
    expect(parseWindow("finish the advising stuff this week", THU)).toEqual({ windowEnd: SUN, flexible: true });
  });

  it('"rest of the week" → the coming Sunday, flexible', () => {
    expect(parseWindow("I could do this the rest of the week", THU)).toEqual({ windowEnd: SUN, flexible: true });
  });

  it('"by <weekday>" → that weekday, flexible', () => {
    expect(parseWindow("get the grant draft done by Friday", THU)).toEqual({ windowEnd: FRI, flexible: true });
    expect(parseWindow("by next Friday", THU)).toEqual({ windowEnd: "2026-08-14", flexible: true });
  });

  it('"next week" → the FOLLOWING Sunday, flexible', () => {
    expect(parseWindow("start the reading next week", THU)).toEqual({ windowEnd: "2026-08-16", flexible: true });
  });

  it('"today" / "tomorrow" → that day, NOT flexible', () => {
    expect(parseWindow("two hours for a Stanford math test today", THU)).toEqual({ windowEnd: THU, flexible: false });
    expect(parseWindow("submit the form tomorrow", THU)).toEqual({ windowEnd: FRI, flexible: false });
  });

  it("no timeframe at all → no window, and nothing is invented", () => {
    expect(parseWindow("go to the gym", THU)).toEqual({ windowEnd: null, flexible: false });
  });

  it("the owner's exact sentence resolves to the coming Sunday", () => {
    const sentence =
      "maybe about two hours in total to go through my Stanford academic advising stuff — " +
      "I could do this the rest of the week, it doesn't have to be today";
    // "it doesn't have to be today" contains "today"; reading it naively pins the task to the
    // one day he ruled out. This is the regression that phrasing caused.
    expect(parseWindow(sentence, THU)).toEqual({ windowEnd: SUN, flexible: true });
    expect(endOfThisWeek(THU)).toBe(SUN);
  });

  it("a Sunday reference means the week closes today — nowhere left to defer to", () => {
    expect(parseWindow("sometime this week", SUN)).toEqual({ windowEnd: SUN, flexible: true });
  });
});

// ── the planner half: the task is not just labelled, it MOVES ────────────────

describe("generatePlan advances a deferred task into its window", () => {
  let dir: string;
  let db: Db;
  let doctrineDir: string;
  let secrets: SecretStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-windows-"));
    db = openDb(path.join(dir, "pos.db"));
    doctrineDir = path.join(dir, "doctrine");
    secrets = new SecretStore(path.join(dir, "secrets")); // no token → never touches the network
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const calendar = (anchors: Anchor[]): ReplanDeps => ({ anchors: async () => anchors });

  const addTask = (p: { title: string; minutes: number; windowEnd?: string | null }): number => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status,
           plan_date, window_start, window_end)
         VALUES (?, 'focused_work', 3, ?, 0, 'inbox', ?, ?, ?)`
      )
      .run(p.title, p.minutes, THU, p.windowEnd ? THU : null, p.windowEnd ?? null);
    return Number(lastInsertRowid);
  };

  const taskRow = (id: number) =>
    db.prepare("SELECT plan_date, status, window_end FROM task WHERE id = ?").get(id) as {
      plan_date: string;
      status: string;
      window_end: string | null;
    };

  it("the advising task lands on tomorrow; the test keeps today", async () => {
    const advId = addTask({ title: "Go through Stanford academic advising", minutes: 120, windowEnd: SUN });
    const testId = addTask({ title: "Stanford math test", minutes: 120 });

    await generatePlan(db, doctrineDir, secrets, null, THU, calendar(roomForOne));

    expect(taskRow(advId).plan_date).toBe(FRI);
    expect(taskRow(advId).window_end).toBe(SUN); // the window itself is untouched
    expect(taskRow(advId).status).toBe("inbox"); // postponed, not "planned for today"
    expect(taskRow(testId).plan_date).toBe(THU);
    expect(taskRow(testId).status).toBe("planned");
  });

  it("tomorrow's plan picks it up with no further intervention", async () => {
    const advId = addTask({ title: "Go through Stanford academic advising", minutes: 120, windowEnd: SUN });
    addTask({ title: "Stanford math test", minutes: 120 });
    await generatePlan(db, doctrineDir, secrets, null, THU, calendar(roomForOne));

    const tomorrow = await generatePlan(db, doctrineDir, secrets, null, FRI, calendar([]));
    expect(tomorrow!.blocks.some((b) => b.task_id === advId)).toBe(true);
    expect(taskRow(advId).plan_date).toBe(FRI);
  });

  it("a task the owner PINNED for today is never moved, however much window it has", async () => {
    const advId = addTask({ title: "Go through Stanford academic advising", minutes: 120, windowEnd: SUN });
    addTask({ title: "Stanford math test", minutes: 120 });
    // His own pin: a locked block for this task on this date.
    db.prepare(
      `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_locked)
       VALUES (?, 'focused_work', 'Advising (pinned)', ?, ?, 1)`
    ).run(advId, `${THU}T13:00:00`, `${THU}T15:00:00`);

    await generatePlan(db, doctrineDir, secrets, null, THU, calendar(roomForOne));
    expect(taskRow(advId).plan_date).toBe(THU);
  });

  it("the plan records where the work went, not just that it left", async () => {
    addTask({ title: "Go through Stanford academic advising", minutes: 120, windowEnd: SUN });
    addTask({ title: "Stanford math test", minutes: 120 });
    const plan = await generatePlan(db, doctrineDir, secrets, null, THU, calendar(roomForOne));
    const deferred = plan!.unplaced.find((u: { reason: string }) => u.reason === "deferred_within_window");
    expect(deferred).toBeTruthy();
    expect(deferred.movedTo).toBe(FRI);
  });

  it("a task with NO window behaves exactly as before — it stays put and reports a failure", async () => {
    const id = addTask({ title: "Stanford math test", minutes: 120 });
    addTask({ title: "Another two-hour thing", minutes: 120 });
    const plan = await generatePlan(db, doctrineDir, secrets, null, THU, calendar(roomForOne));
    expect(taskRow(id).plan_date).toBe(THU);
    expect(
      plan!.unplaced.every((u: { reason: string }) => u.reason !== "deferred_within_window")
    ).toBe(true);
  });
});
