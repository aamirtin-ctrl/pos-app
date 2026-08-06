// "Tonight" and "tomorrow" are the two least ambiguous scheduling words there are.
//
// Owner report 2026-08-06: "I said tonight I need to do research for my job, Liatris. And then
// I said tomorrow I need to continue working on it for two and a half hours… the one I said
// for tonight is in the afternoon and not in the night, and the one I said for tomorrow is
// today. It should have recognized off those keywords. The Gemini API should be able to catch
// this."
//
// Gemini was down at that exact minute (429 at 18:18, tasks written 18:18:02), which is why
// the titles are raw transcript. But the deeper point is that this never needed a model:
//
//   TOMORROW was parsed correctly and then DISCARDED. parseWindow returns that date with
//   flexible=false, and braindump only persisted a date when the range was flexible — so
//   plan_date stayed the day of capture and work for tomorrow landed on today.
//
//   TONIGHT had nowhere to be stored at all. A parsed task could carry a duration and a date
//   but never a time of day, so the energy curve placed it where it scored best: 14:00.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { braindump } from "../../main/planner.ts";
import { parseDayPart, deterministicParse } from "../../main/engine/parse.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { solve, withinDayPart, type PlannerTask } from "../../main/engine/solver.ts";

const TODAY = "2026-08-06";
const TOMORROW = "2026-08-07";
const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-named-day-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseDayPart", () => {
  it("hears the part of the day he named", () => {
    expect(parseDayPart("Tonight I need to do research for Liatris")).toBe("evening");
    expect(parseDayPart("this evening")).toBe("evening");
    expect(parseDayPart("after dinner")).toBe("evening");
    expect(parseDayPart("first thing")).toBe("morning");
    expect(parseDayPart("in the morning")).toBe("morning");
    expect(parseDayPart("this afternoon")).toBe("afternoon");
  });

  it("is null when he named none — which is most of the time", () => {
    expect(parseDayPart("two hours on the pset")).toBeNull();
    expect(parseDayPart("")).toBeNull();
  });
});

describe("his actual sparkle input", () => {
  const SAID =
    "Tonight I need to do research for my job Liatris. " +
    "Tomorrow I need to continue working on it for 2.5 hours.";

  it("puts tomorrow's work on TOMORROW, not today", async () => {
    await braindump(db, dir, null, SAID, TODAY);
    const rows = db.prepare("SELECT title, plan_date, day_part FROM task ORDER BY id").all() as any[];
    const tomorrow = rows.find((r) => /continue/i.test(r.title));
    expect(tomorrow, "the 'tomorrow' task exists").toBeTruthy();
    expect(tomorrow.plan_date).toBe(TOMORROW);
  });

  it("keeps tonight's work on today, marked for the evening", async () => {
    await braindump(db, dir, null, SAID, TODAY);
    const rows = db.prepare("SELECT title, plan_date, day_part FROM task ORDER BY id").all() as any[];
    const tonight = rows.find((r) => /research/i.test(r.title));
    expect(tonight.plan_date).toBe(TODAY);
    expect(tonight.day_part).toBe("evening");
  });

  it("does not put both on the same day — the bug he reported", async () => {
    await braindump(db, dir, null, SAID, TODAY);
    const dates = (db.prepare("SELECT DISTINCT plan_date FROM task").all() as any[]).map((r) => r.plan_date);
    expect(new Set(dates).size).toBeGreaterThan(1);
  });

  it("needs no model to do any of this", () => {
    // deterministicParse is the no-LLM path — the one that actually ran during the outage.
    const tasks = deterministicParse(SAID, doctrine, TODAY);
    const tonight = tasks.find((t) => /research/i.test(t.title))!;
    const tomorrow = tasks.find((t) => /continue/i.test(t.title))!;
    expect(tonight.dayPart).toBe("evening");
    expect(tomorrow.windowEnd).toBe(TOMORROW);
    expect(tomorrow.flexible).toBe(false); // a named day, not a range
  });
});

describe("withinDayPart", () => {
  const t = (dayPart: PlannerTask["dayPart"]): PlannerTask => ({
    id: 1, title: "x", blockType: "deep_work", cognitiveLoad: 4, estimatedMinutes: 60,
    isMit: false, deadlineMin: null, project: null, splittable: false, dayPart,
  });

  it("rejects the afternoon for work he said was for tonight", () => {
    expect(withinDayPart(t("evening"), 14 * 60, 15 * 60)).toBe(false);
    expect(withinDayPart(t("evening"), 19 * 60, 20 * 60)).toBe(true);
  });

  it("keeps morning work out of the evening, and vice versa", () => {
    expect(withinDayPart(t("morning"), 9 * 60, 10 * 60)).toBe(true);
    expect(withinDayPart(t("morning"), 15 * 60, 16 * 60)).toBe(false);
    expect(withinDayPart(t("afternoon"), 13 * 60, 14 * 60)).toBe(true);
    expect(withinDayPart(t("afternoon"), 19 * 60, 20 * 60)).toBe(false);
  });

  it("constrains nothing when he named no part of the day", () => {
    for (const [a, b] of [[0, 60], [12 * 60, 13 * 60], [23 * 60, 24 * 60]]) {
      expect(withinDayPart(t(null), a, b)).toBe(true);
    }
  });
});

describe("the solver honours it", () => {
  const task = (over: Partial<PlannerTask>): PlannerTask => ({
    id: 1, title: "Research for Liatris", blockType: "deep_work", cognitiveLoad: 4,
    estimatedMinutes: 60, isMit: false, deadlineMin: null, project: null, splittable: false,
    ...over,
  });

  it("places evening work in the evening, not wherever scores best", () => {
    const r = solve([task({ dayPart: "evening" })], doctrine, []);
    const b = r.blocks.find((x) => x.taskId === 1);
    expect(b, "it is placed").toBeTruthy();
    expect(b!.startMin).toBeGreaterThanOrEqual(17 * 60);
  });

  it("without a stated part of day, nothing changes", () => {
    const r = solve([task({ dayPart: null })], doctrine, []);
    expect(r.blocks.find((x) => x.taskId === 1)).toBeTruthy();
  });

  it("reports rather than silently relocating when the named part is full", () => {
    // The whole evening is taken, so evening-only work cannot be seated.
    const anchors = [
      { startMin: 17 * 60, endMin: 23 * 60, blockType: "personal" as const, title: "busy" },
    ];
    const r = solve([task({ dayPart: "evening" })], doctrine, anchors);
    expect(r.blocks.find((x) => x.taskId === 1)).toBeUndefined();
    expect(r.unplaced.map((u) => u.task.id)).toContain(1);
  });
});
