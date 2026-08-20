// Daily carry-over (main/rollover.ts): unfinished one-off tasks roll to today; a missed
// curriculum day shifts the Notion plan down the line and resets local instances so the
// enrichment sentinel re-fetches. Notion is faked — no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import type { SecretStore } from "../main/secrets.ts";
import { rolloverMissedTasks, daysBetweenISO } from "../main/rollover.ts";
import { AGENTIC_CURRICULUM_MARKER_PREFIX } from "../main/notion.ts";

const TODAY = "2026-08-16";
const YESTERDAY = "2026-08-15";
const TWO_AGO = "2026-08-14";

const withNotion = { get: (n: string) => (n === "NOTION_TOKEN" ? "tok" : null) } as unknown as SecretStore;
const noNotion = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-rollover-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertTask(over: Record<string, unknown> = {}): number {
  const t = {
    title: "Task",
    block_type: "deep_work",
    status: "planned",
    plan_date: YESTERDAY,
    notes: null,
    recurrence: null,
    recurrence_parent_id: null,
    window_end: null,
    ...over,
  };
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, status, plan_date, notes, recurrence, recurrence_parent_id, window_end)
       VALUES (@title, @block_type, @status, @plan_date, @notes, @recurrence, @recurrence_parent_id, @window_end)`
    )
    .run(t);
  return Number(r.lastInsertRowid);
}

const planDate = (id: number) => (db.prepare("SELECT plan_date FROM task WHERE id = ?").get(id) as { plan_date: string | null }).plan_date;
const statusOf = (id: number) => (db.prepare("SELECT status FROM task WHERE id = ?").get(id) as { status: string }).status;
const titleOf = (id: number) => (db.prepare("SELECT title FROM task WHERE id = ?").get(id) as { title: string }).title;

const noShift = { shiftCurriculum: async () => ({ shifted: 0 }) };

describe("ordinary task carry-over", () => {
  it("moves an unfinished past task to today", async () => {
    const id = insertTask();
    const r = await rolloverMissedTasks(db, noNotion, TODAY, noShift);
    expect(r.moved).toBe(1);
    expect(planDate(id)).toBe(TODAY);
  });

  it("leaves done/dropped, today's, undated, window and recurring-template tasks alone", async () => {
    const done = insertTask({ status: "done" });
    const today = insertTask({ plan_date: TODAY });
    const undated = insertTask({ plan_date: null });
    const windowed = insertTask({ window_end: "2026-08-20" });
    const r = await rolloverMissedTasks(db, noNotion, TODAY, noShift);
    expect(r.moved).toBe(0);
    expect(statusOf(done)).toBe("done");
    expect(planDate(today)).toBe(TODAY);
    expect(planDate(undated)).toBeNull();
    expect(planDate(windowed)).toBe(YESTERDAY);
  });

  it("a missed habit instance is dropped — tomorrow's own instance IS the roll-over", async () => {
    const template = insertTask({ recurrence: "daily", plan_date: null });
    const missedGym = insertTask({ recurrence_parent_id: template, title: "Gym / workout" });
    const todayGym = insertTask({ recurrence_parent_id: template, title: "Gym / workout", plan_date: TODAY });
    const r = await rolloverMissedTasks(db, noNotion, TODAY, noShift);
    expect(r.droppedHabits).toBe(1);
    expect(statusOf(missedGym)).toBe("dropped"); // its Google row is deleted by the push pass
    expect(statusOf(todayGym)).toBe("planned"); // today's stands — exactly one gym task exists
  });
});

describe("curriculum shift", () => {
  function curriculumSetup() {
    const template = insertTask({
      title: "Learn agentic coding",
      recurrence: "daily",
      plan_date: null,
      notes: `${AGENTIC_CURRICULUM_MARKER_PREFIX}db-123`,
    });
    const missed = insertTask({
      recurrence_parent_id: template,
      title: "Learn: How AI Code Generation Works",
      plan_date: YESTERDAY,
    });
    const todayInst = insertTask({
      recurrence_parent_id: template,
      title: "Apply: run the ReAct example",
      plan_date: TODAY,
    });
    return { template, missed, todayInst };
  }

  it("shifts Notion from the missed day, drops the stale instance, resets today's for re-enrichment", async () => {
    const { template, missed, todayInst } = curriculumSetup();
    const calls: unknown[] = [];
    const r = await rolloverMissedTasks(db, withNotion, TODAY, {
      shiftCurriculum: async (_s, dbId, fromISO, delta) => {
        calls.push([dbId, fromISO, delta]);
        return { shifted: 12 };
      },
    });
    expect(calls).toEqual([["db-123", YESTERDAY, 1]]);
    expect(r.curriculumShifted).toBe(12);
    expect(r.curriculumFrom).toBe(YESTERDAY);
    expect(statusOf(missed)).toBe("dropped");
    expect(titleOf(todayInst)).toBe("Learn agentic coding"); // sentinel reset → enrichment re-fetches
    expect(titleOf(template)).toBe("Learn agentic coding"); // template untouched
  });

  it("two missed days → delta 2 from the earliest", async () => {
    const { template } = curriculumSetup();
    insertTask({ recurrence_parent_id: template, title: "Learn: day one topic", plan_date: TWO_AGO });
    const calls: unknown[] = [];
    await rolloverMissedTasks(db, withNotion, TODAY, {
      shiftCurriculum: async (_s, dbId, fromISO, delta) => {
        calls.push([dbId, fromISO, delta]);
        return { shifted: 3 };
      },
    });
    expect(calls).toEqual([["db-123", TWO_AGO, 2]]);
  });

  it("no Notion token → curriculum untouched (no shift, nothing dropped)", async () => {
    const { missed } = curriculumSetup();
    const r = await rolloverMissedTasks(db, noNotion, TODAY, noShift);
    expect(r.curriculumShifted).toBe(0);
    expect(statusOf(missed)).toBe("planned");
  });

  it("Notion shift failure leaves local state untouched (retries next day)", async () => {
    const { missed, todayInst } = curriculumSetup();
    await expect(
      rolloverMissedTasks(db, withNotion, TODAY, {
        shiftCurriculum: async () => {
          throw new Error("notion 502");
        },
      })
    ).rejects.toThrow("notion 502");
    expect(statusOf(missed)).toBe("planned");
    expect(titleOf(todayInst)).toBe("Apply: run the ReAct example");
  });
});

describe("daysBetweenISO", () => {
  it("counts calendar days", () => {
    expect(daysBetweenISO(YESTERDAY, TODAY)).toBe(1);
    expect(daysBetweenISO(TWO_AGO, TODAY)).toBe(2);
    expect(daysBetweenISO(TODAY, TODAY)).toBe(0);
  });
});
