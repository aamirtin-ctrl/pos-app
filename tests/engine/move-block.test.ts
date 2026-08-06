// Dragging a block, and letting the day rebuild around it.
//
// Owner ask 2026-08-06: "You should make it possible for me to move around different events in
// the app. And when I move around the events, the breaks and whatever else can change
// accordingly to the scheduling best practices."
//
// The contract is deliberately NOT "nudge the neighbours": a drag PINS one block
// (is_locked = 1) and the day is re-solved from scratch around it, so recovery breaks,
// meeting transitions and everything else are recomputed by doctrine rather than dragged
// along by hand. It is the same mechanism reconcileMovedEvents already used when he moved a
// POS event inside Google Calendar — this just drives it from inside the app.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { moveBlock, resizeBlock, moveBlockToDay, unpinBlock, MOVE_SNAP_MIN } from "../../main/planner.ts";
import { SecretStore } from "../../main/secrets.ts";

const DATE = "2026-08-06";
let dir: string;
let db: Db;
let secrets: SecretStore;

/** No network and no LLM: anchors are injected, so the solve is pure. */
const deps = { anchors: async () => [] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-move-"));
  db = openDb(path.join(dir, "pos.db"));
  secrets = new SecretStore(dir);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPlanWithBlock(opts: { startMin: number; endMin: number; isAnchor?: boolean; type?: string }): number {
  const planId = Number(
    db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
         VALUES (?, 'test', '{}', '', '[]')`
      )
      .run(DATE).lastInsertRowid
  );
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return Number(
    db
      .prepare(
        `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
         VALUES (NULL, ?, 'Deep work', ?, ?, ?, ?)`
      )
      .run(
        opts.type ?? "deep_work",
        `${DATE}T${hhmm(opts.startMin)}:00`,
        `${DATE}T${hhmm(opts.endMin)}:00`,
        opts.isAnchor ? 1 : 0,
        planId
      ).lastInsertRowid
  );
}

const minsOf = (iso: string) => {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
};
const pinnedSpans = () =>
  (db.prepare("SELECT starts_at, ends_at FROM block WHERE is_locked = 1").all() as any[]).map(
    (b) => [minsOf(b.starts_at), minsOf(b.ends_at)]
  );

describe("moveBlock", () => {
  it("pins the block at its new time and keeps its length", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    const res = await moveBlock(db, dir, secrets, null, id, 14 * 60, deps);
    expect(res.moved).toBe(true);
    // The block itself is re-created by the regeneration, so assert on the PIN, which is
    // what survives and what the next solve reads.
    expect(pinnedSpans()).toContainEqual([14 * 60, 15 * 60]);
  });

  it("snaps to the solver's own grid — an off-grid block could never be re-placed", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 14 * 60 + 7, deps);
    const [[start]] = pinnedSpans();
    expect(start % MOVE_SNAP_MIN).toBe(0);
  });

  // A block ending at exactly 24:00 would be written as hour 24, which Date reads as the NEXT
  // day at 00:00 — so the block would appear to have negative length. The last usable slot is
  // the last grid step that ends before midnight.
  it("never lets a block fall off the end of its day", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 23 * 60 + 45, deps);
    const [[start, end]] = pinnedSpans();
    expect(end).toBeLessThan(24 * 60);
    expect(end - start).toBe(60); // a drag moves work; it never resizes it
    expect(start % MOVE_SNAP_MIN).toBe(0);
  });

  it("clamps a negative drag to the start of the day", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, -600, deps);
    const [[start]] = pinnedSpans();
    expect(start).toBe(0);
  });

  // External events belong to the calendar they came from. Moving them here would leave the
  // two copies disagreeing with no way to tell which is right.
  it("refuses an external calendar event with a typed reason", async () => {
    const id = addPlanWithBlock({ startMin: 16 * 60, endMin: 19 * 60, isAnchor: true, type: "personal" });
    const res = await moveBlock(db, dir, secrets, null, id, 12 * 60, deps);
    expect(res).toMatchObject({ moved: false, error: "external_event" });
    expect(pinnedSpans()).toEqual([]); // nothing was written
  });

  it("reports a missing block instead of throwing", async () => {
    expect(await moveBlock(db, dir, secrets, null, 9999, 12 * 60, deps)).toMatchObject({
      moved: false,
      error: "not_found",
    });
  });

  // The bug this feature would have shipped with: is_locked was never written on the blocks a
  // regeneration inserts, so a pin survived exactly ONE re-plan and then silently expired.
  // The owner would drag something, watch it stay, and find it moved later.
  it("keeps the pin across a second re-solve", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 14 * 60, deps);
    const after1 = pinnedSpans();
    expect(after1).toContainEqual([14 * 60, 15 * 60]);

    // Re-solve again (as the sweep would). The pin must still be there.
    const { generatePlan } = await import("../../main/planner.ts");
    await generatePlan(db, dir, secrets, null, DATE, deps);
    expect(pinnedSpans()).toContainEqual([14 * 60, 15 * 60]);
  });

  // Owner report 2026-08-06: "i still cant click and drag the events on my calendar."
  //
  // `is_anchor` was the movability test, and by then most of his day was an anchor: past
  // blocks are carried forward as anchors and a pin is re-read as one. So the first drag
  // worked and then the block — and everything already behind him — became immovable. A block
  // he pinned himself has to stay draggable, or a drag is a one-way door.
  it("lets a pinned block be dragged again", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 14 * 60, deps);
    const pinned = db.prepare("SELECT id FROM block WHERE is_locked = 1").get() as { id: number };

    const again = await moveBlock(db, dir, secrets, null, pinned.id, 16 * 60, deps);
    expect(again.moved).toBe(true);
    expect(pinnedSpans()).toContainEqual([16 * 60, 17 * 60]);
  });

  it("still refuses an anchor he did NOT pin — that is the calendar's, not his", async () => {
    const id = addPlanWithBlock({ startMin: 16 * 60, endMin: 19 * 60, isAnchor: true, type: "personal" });
    expect(await moveBlock(db, dir, secrets, null, id, 12 * 60, deps)).toMatchObject({
      moved: false,
      error: "external_event",
    });
  });

  it("unpinBlock releases the placement so the planner may site it again", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 14 * 60, deps);
    const pinned = db.prepare("SELECT id FROM block WHERE is_locked = 1").get() as { id: number };
    expect(await unpinBlock(db, dir, secrets, null, pinned.id, deps)).toMatchObject({ moved: true });
    expect(pinnedSpans()).toEqual([]);
  });
});

// ── dragging an edge: extend or limit the time this takes ────────────────────
//
// Owner ask 2026-08-06: "make it so i can easily move the top/bottom of events to
// extend/limit time."
//
// The difference from moveBlock is what it MEANS. Moving says "do this later"; resizing says
// "this takes longer than you thought" — so the task's estimate is corrected too, or the
// correction lives in one day's pin and every future plan keeps budgeting the number he just
// told us was wrong.
describe("resizeBlock", () => {
  const taskBacked = (startMin: number, endMin: number) => {
    const taskId = Number(
      db.prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date)
         VALUES ('Deep work', 'deep_work', 4, ?, 0, 'planned', ?)`
      ).run(endMin - startMin, DATE).lastInsertRowid
    );
    const planId = Number(
      db.prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
         VALUES (?, 'test', '{}', '', '[]')`
      ).run(DATE).lastInsertRowid
    );
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const blockId = Number(
      db.prepare(
        `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
         VALUES (?, 'deep_work', 'Deep work', ?, ?, 0, ?)`
      ).run(taskId, `${DATE}T${hhmm(startMin)}:00`, `${DATE}T${hhmm(endMin)}:00`, planId).lastInsertRowid
    );
    return { taskId, blockId };
  };
  const estimateOf = (taskId: number) =>
    (db.prepare("SELECT estimated_minutes m FROM task WHERE id = ?").get(taskId) as { m: number }).m;

  it("extends the bottom edge, keeping the start where it was", async () => {
    const { blockId } = taskBacked(10 * 60, 11 * 60);
    await resizeBlock(db, dir, secrets, null, blockId, 10 * 60, 12 * 60, deps);
    expect(pinnedSpans()).toContainEqual([10 * 60, 12 * 60]);
  });

  it("moves the top edge, keeping the end where it was", async () => {
    const { blockId } = taskBacked(10 * 60, 11 * 60);
    await resizeBlock(db, dir, secrets, null, blockId, 9 * 60 + 30, 11 * 60, deps);
    expect(pinnedSpans()).toContainEqual([9 * 60 + 30, 11 * 60]);
  });

  // The point of resizing rather than moving: the correction has to outlive the day.
  it("teaches the task its new length", async () => {
    const { taskId, blockId } = taskBacked(10 * 60, 11 * 60);
    expect(estimateOf(taskId)).toBe(60);
    await resizeBlock(db, dir, secrets, null, blockId, 10 * 60, 12 * 60, deps);
    expect(estimateOf(taskId)).toBe(120);
  });

  it("never collapses a block below one slot", async () => {
    const { blockId } = taskBacked(10 * 60, 11 * 60);
    await resizeBlock(db, dir, secrets, null, blockId, 10 * 60, 10 * 60, deps);
    const [[start, end]] = pinnedSpans();
    expect(end - start).toBeGreaterThanOrEqual(MOVE_SNAP_MIN);
  });

  it("keeps both edges on the solver's grid", async () => {
    const { blockId } = taskBacked(10 * 60, 11 * 60);
    await resizeBlock(db, dir, secrets, null, blockId, 10 * 60 + 7, 11 * 60 + 8, deps);
    const [[start, end]] = pinnedSpans();
    expect(start % MOVE_SNAP_MIN).toBe(0);
    expect(end % MOVE_SNAP_MIN).toBe(0);
  });

  it("keeps the block inside its own day", async () => {
    const { blockId } = taskBacked(22 * 60, 23 * 60);
    await resizeBlock(db, dir, secrets, null, blockId, 22 * 60, 25 * 60, deps);
    const [[, end]] = pinnedSpans();
    expect(end).toBeLessThan(24 * 60);
  });

  it("refuses an external calendar event — its length belongs to that calendar", async () => {
    const id = addPlanWithBlock({ startMin: 16 * 60, endMin: 19 * 60, isAnchor: true, type: "personal" });
    expect(await resizeBlock(db, dir, secrets, null, id, 16 * 60, 20 * 60, deps)).toMatchObject({
      moved: false,
      error: "external_event",
    });
  });
});

// ── dragging work into another day ───────────────────────────────────────────
//
// Owner ask 2026-08-06: "I should be able to drag calendar events into other days."
//
// What moves is the TASK, not the block. Dropping work on Thursday means "do this Thursday",
// and Thursday's own solve — with its anchors, energy curve and shutdown — is a better judge
// of WHEN than the minute he happened to release the pointer over a 90px preview column.
describe("moveBlockToDay", () => {
  const TOMORROW = "2026-08-07";
  const withTask = (startMin: number, endMin: number) => {
    const taskId = Number(
      db.prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date)
         VALUES ('Research for Liatris', 'deep_work', 4, ?, 0, 'planned', ?)`
      ).run(endMin - startMin, DATE).lastInsertRowid
    );
    const planId = Number(
      db.prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
         VALUES (?, 'test', '{}', '', '[]')`
      ).run(DATE).lastInsertRowid
    );
    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const blockId = Number(
      db.prepare(
        `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
         VALUES (?, 'deep_work', 'Research for Liatris', ?, ?, 0, ?)`
      ).run(taskId, `${DATE}T${hhmm(startMin)}:00`, `${DATE}T${hhmm(endMin)}:00`, planId).lastInsertRowid
    );
    return { taskId, blockId };
  };
  const planDateOf = (taskId: number) =>
    (db.prepare("SELECT plan_date d FROM task WHERE id = ?").get(taskId) as { d: string }).d;
  const early = { anchors: async () => [], now: new Date(`${DATE}T06:00:00`) };

  it("moves the work to the day he dropped it on", async () => {
    const { taskId, blockId } = withTask(10 * 60, 11 * 60);
    const r = await moveBlockToDay(db, dir, secrets, null, blockId, TOMORROW, early);
    expect(r.moved).toBe(true);
    expect(planDateOf(taskId)).toBe(TOMORROW);
  });

  it("leaves the day it came from — the work is not on both", async () => {
    const { blockId } = withTask(10 * 60, 11 * 60);
    await moveBlockToDay(db, dir, secrets, null, blockId, TOMORROW, early);
    const stillHere = db
      .prepare(
        `SELECT COUNT(*) n FROM block b JOIN plan p ON p.id = b.plan_id
          WHERE p.plan_date = ? AND b.title = 'Research for Liatris'`
      )
      .get(DATE) as { n: number };
    expect(stillHere.n).toBe(0);
  });

  it("clears any window, because a drag is a decision about a day", async () => {
    const { taskId, blockId } = withTask(10 * 60, 11 * 60);
    db.prepare("UPDATE task SET window_start = ?, window_end = '2026-08-09' WHERE id = ?").run(DATE, taskId);
    await moveBlockToDay(db, dir, secrets, null, blockId, TOMORROW, early);
    const row = db.prepare("SELECT window_end w FROM task WHERE id = ?").get(taskId) as { w: string | null };
    expect(row.w).toBeNull(); // otherwise the engine could drift it straight back
  });

  it("refuses a block with no work behind it — scaffolding is per-day", async () => {
    const id = addPlanWithBlock({ startMin: 13 * 60, endMin: 13 * 60 + 45, type: "meal" });
    expect(await moveBlockToDay(db, dir, secrets, null, id, TOMORROW, early)).toMatchObject({
      moved: false,
      error: "no_task",
    });
  });

  it("refuses an external calendar event", async () => {
    const id = addPlanWithBlock({ startMin: 16 * 60, endMin: 19 * 60, isAnchor: true, type: "personal" });
    expect(await moveBlockToDay(db, dir, secrets, null, id, TOMORROW, early)).toMatchObject({
      moved: false,
      error: "external_event",
    });
  });

  it("refuses the past — a day that has been cannot be scheduled into", async () => {
    const { blockId } = withTask(10 * 60, 11 * 60);
    expect(await moveBlockToDay(db, dir, secrets, null, blockId, "2026-08-01", early)).toMatchObject({
      moved: false,
      error: "past_day",
    });
  });

  it("is a no-op on the day it is already on", async () => {
    const { blockId } = withTask(10 * 60, 11 * 60);
    expect(await moveBlockToDay(db, dir, secrets, null, blockId, DATE, early)).toMatchObject({
      moved: false,
      error: "same_day",
    });
  });
});
