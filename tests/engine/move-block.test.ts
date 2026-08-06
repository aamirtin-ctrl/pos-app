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
import { moveBlock, unpinBlock, MOVE_SNAP_MIN } from "../../main/planner.ts";
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

  it("unpinBlock releases the placement so the planner may site it again", async () => {
    const id = addPlanWithBlock({ startMin: 10 * 60, endMin: 11 * 60 });
    await moveBlock(db, dir, secrets, null, id, 14 * 60, deps);
    const pinned = db.prepare("SELECT id FROM block WHERE is_locked = 1").get() as { id: number };
    expect(await unpinBlock(db, dir, secrets, null, pinned.id, deps)).toMatchObject({ moved: true });
    expect(pinnedSpans()).toEqual([]);
  });
});
