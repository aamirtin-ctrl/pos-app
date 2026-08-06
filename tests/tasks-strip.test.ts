// The Google Tasks strip.
//
// Owner ask 2026-08-06: "maybe you should add little tasks that are, like, on the calendar
// that are shown with the drop down list, like Google Tasks, and you can always place it at,
// like, a four AM time slot. It's not actually a calendar event, but it's just a place for me
// to see the Google tasks."
//
// The gap: a task only becomes visible once the solver gives it a BLOCK. Everything undated —
// most of what arrives from Google Tasks, and everything the "only explicit dates schedule
// things" rule deliberately leaves alone — existed in the database and appeared nowhere he
// looks. He asked whether his inputs had populated and could not tell, which is the problem
// itself, not a UI nicety.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { tasksForStrip } from "../main/planner.ts";

const DATE = "2026-08-06";
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-strip-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(p: { title: string; planDate?: string | null; status?: string; gtasks?: string | null }): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date, gtasks_id)
         VALUES (?, 'admin', 3, 30, 0, ?, ?, ?)`
      )
      .run(p.title, p.status ?? "inbox", p.planDate === undefined ? DATE : p.planDate, p.gtasks ?? null)
      .lastInsertRowid
  );
}

function scheduleIt(taskId: number) {
  const planId = Number(
    db.prepare(
      `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
       VALUES (?, 'test', '{}', '', '[]')`
    ).run(DATE).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
     VALUES (?, 'admin', 'x', ?, ?, 0, ?)`
  ).run(taskId, `${DATE}T10:00:00`, `${DATE}T10:30:00`, planId);
}

const titles = () => tasksForStrip(db, DATE).map((t) => t.title);

describe("tasksForStrip", () => {
  it("shows the UNDATED work that has nowhere else to appear", () => {
    addTask({ title: "Spend another night in Como", planDate: null });
    addTask({ title: "Put the coolers on the garage cupboard", planDate: null });
    const rows = tasksForStrip(db, DATE);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Put the coolers on the garage cupboard",
      "Spend another night in Como",
    ]);
    expect(rows.every((r) => r.planDate === null)).toBe(true);
  });

  it("shows the day's own work too, and says which already has a block", () => {
    const scheduled = addTask({ title: "Take Stanford math test" });
    addTask({ title: "Unscheduled thing" });
    scheduleIt(scheduled);
    const rows = tasksForStrip(db, DATE);
    expect(rows.find((r) => r.title === "Take Stanford math test")!.scheduled).toBe(true);
    expect(rows.find((r) => r.title === "Unscheduled thing")!.scheduled).toBe(false);
  });

  it("marks what came from Google, so he can tell his task list apart", () => {
    addTask({ title: "From the phone", planDate: null, gtasks: "abc123" });
    addTask({ title: "From a text", planDate: null });
    const rows = tasksForStrip(db, DATE);
    expect(rows.find((r) => r.title === "From the phone")!.fromGoogle).toBe(true);
    expect(rows.find((r) => r.title === "From a text")!.fromGoogle).toBe(false);
  });

  it("is outstanding work, not an archive", () => {
    addTask({ title: "Finished", status: "done" });
    addTask({ title: "Shelved", status: "deferred" });
    addTask({ title: "Live" });
    expect(titles()).toEqual(["Live"]);
  });

  it("does not show another day's dated work", () => {
    addTask({ title: "Tomorrow's", planDate: "2026-08-07" });
    addTask({ title: "Today's" });
    expect(titles()).toEqual(["Today's"]);
  });

  it("puts the day's own work before the undated pile", () => {
    addTask({ title: "Undated", planDate: null });
    addTask({ title: "Dated" });
    expect(titles()).toEqual(["Dated", "Undated"]);
  });

  it("is empty when there is nothing outstanding", () => {
    expect(tasksForStrip(db, DATE)).toEqual([]);
  });
});
