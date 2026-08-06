// Freed-up time pulls windowed work BACK.
//
// Owner ask 2026-08-06: "I want the system to be completely adaptable to a bunch of calendar
// changes and still fit stuff in free spaces as they pop up or move stuff around. Like, for
// example, right now for today, I initially had, like, a three hour hangout block that I
// deleted. So now there's a bunch of free space where I can do stuff."
//
// Deferral was a one-way door. His advising task moved to the next day while today was tight;
// he then deleted a three-hour hangout, today reopened with nearly six hours free, and the
// task could not come back — the solve only ever looked at `plan_date = today`, so the engine
// was re-solving a day it could no longer see the work for. From the calendar that is
// indistinguishable from the work having been thrown away, which is exactly how he read it.
//
// A window means "any day in here". It has to mean that in BOTH directions.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { listTasks } from "../../main/planner.ts";

const TODAY = "2026-08-06";
const TOMORROW = "2026-08-07";
const SUNDAY = "2026-08-09";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-reclaim-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(p: {
  title: string;
  planDate: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  status?: string;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit,
                           status, plan_date, window_start, window_end)
         VALUES (?, 'focused_work', 3, 150, 0, ?, ?, ?, ?)`
      )
      .run(p.title, p.status ?? "inbox", p.planDate, p.windowStart ?? null, p.windowEnd ?? null)
      .lastInsertRowid
  );
}

const titles = (dateISO: string) => listTasks(db, dateISO).map((r: any) => r.title).sort();

describe("listTasks reclaim pool", () => {
  it("offers today the windowed work parked on a later day", () => {
    addTask({ title: "Advising", planDate: TOMORROW, windowStart: TODAY, windowEnd: SUNDAY });
    expect(titles(TODAY)).toEqual(["Advising"]);
  });

  it("still returns the day's own work, and both together", () => {
    addTask({ title: "Math test", planDate: TODAY });
    addTask({ title: "Advising", planDate: TOMORROW, windowStart: TODAY, windowEnd: SUNDAY });
    expect(titles(TODAY)).toEqual(["Advising", "Math test"]);
  });

  it("never reaches past the end of the window", () => {
    // Parked Monday with a window that closed Sunday — not this day's business.
    addTask({ title: "Advising", planDate: "2026-08-10", windowStart: TODAY, windowEnd: SUNDAY });
    expect(titles("2026-08-11")).toEqual([]);
  });

  it("never reaches before the window opens", () => {
    addTask({ title: "Advising", planDate: SUNDAY, windowStart: TOMORROW, windowEnd: SUNDAY });
    expect(titles(TODAY)).toEqual([]); // the window has not opened yet
    expect(titles(TOMORROW)).toEqual(["Advising"]);
  });

  it("never pulls work BACKWARDS from a day that has already been and gone", () => {
    // A task parked on an EARLIER day is not a candidate: the past is not reschedulable.
    addTask({ title: "Yesterday's", planDate: "2026-08-05", windowStart: "2026-08-04", windowEnd: SUNDAY });
    expect(titles(TODAY)).toEqual([]);
  });

  it("leaves un-windowed work exactly where it was put", () => {
    // No window means the owner named a day. Reclaiming it would override him.
    addTask({ title: "Tomorrow only", planDate: TOMORROW });
    expect(titles(TODAY)).toEqual([]);
  });

  it("ignores work that is finished or retired", () => {
    for (const status of ["done", "deferred"]) {
      addTask({ title: `x-${status}`, planDate: TOMORROW, windowStart: TODAY, windowEnd: SUNDAY, status });
    }
    expect(titles(TODAY)).toEqual([]);
  });

  it("does not double-count a task already sitting on this day", () => {
    addTask({ title: "Advising", planDate: TODAY, windowStart: TODAY, windowEnd: SUNDAY });
    expect(listTasks(db, TODAY)).toHaveLength(1);
  });

  it("offers the same task to every day inside its window", () => {
    addTask({ title: "Advising", planDate: SUNDAY, windowStart: TODAY, windowEnd: SUNDAY });
    for (const d of [TODAY, TOMORROW, "2026-08-08"]) expect(titles(d)).toEqual(["Advising"]);
    // On its parked day it is simply the day's own work.
    expect(titles(SUNDAY)).toEqual(["Advising"]);
  });
});
