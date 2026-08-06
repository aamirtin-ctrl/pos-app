// The past is not schedulable, and a pinned task is not scheduled twice.
//
// Two owner reports from 2026-08-06, both from the same drag:
//
//   "it duplicated the stanford math test and then locked it"
//
//   "when I move stuff in my schedule around, it can't add or change events into times that
//    have already passed. I think it added unpack travel bag from nine AM to nine thirty. But
//    it's eleven forty right now, that already passed."
//
// The first: a pin becomes a fixed ANCHOR, and anchors carry no task_id — so the task behind
// it stayed in the pool and the solver scheduled it a second time. His day held the pinned
// "Take Stanford math test" at 13:45 AND a fresh one at 16:45.
//
// The second is older and much wider: nothing in the engine knew what time it was. Every
// re-solve treated the whole day as available, so the morning kept being handed out again
// hours after it was gone.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { generatePlan, getPlan, moveBlock, floorFor } from "../../main/planner.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { buildGrid } from "../../main/engine/grid.ts";
import { SecretStore } from "../../main/secrets.ts";

const DATE = "2026-08-06";
/** 11:40 on the day being planned — the moment he reported it. */
const AT_1140 = new Date("2026-08-06T11:40:00");

let dir: string;
let db: Db;
let secrets: SecretStore;
const deps = (now?: Date) => ({ anchors: async () => [], ...(now ? { now } : {}) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-past-"));
  db = openDb(path.join(dir, "pos.db"));
  secrets = new SecretStore(dir);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(title: string, minutes = 30, type = "personal"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date)
         VALUES (?, ?, 3, ?, 0, 'inbox', ?)`
      )
      .run(title, type, minutes, DATE).lastInsertRowid
  );
}

const blocks = () => (getPlan(db, DATE)?.blocks ?? []) as any[];
const minsOf = (iso: string) => {
  const [h, m] = String(iso).slice(11, 16).split(":").map(Number);
  return h * 60 + m;
};

describe("floorFor", () => {
  it("is the current minute on the day being solved", () => {
    expect(floorFor(DATE, AT_1140)).toBe(11 * 60 + 40);
  });

  it("is null for any other day — tomorrow has no past", () => {
    expect(floorFor("2026-08-07", AT_1140)).toBeNull();
    expect(floorFor("2026-08-05", AT_1140)).toBeNull();
  });
});

describe("the grid's now-floor", () => {
  const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

  it("makes every slot before now ineligible for everything", () => {
    const g = buildGrid(doctrine, [], { floorMin: 11 * 60 + 40 });
    for (const s of g.slots) {
      if (s.startMin >= 11 * 60 + 40) continue;
      expect(Object.values(s.eligible).every((v) => v === false)).toBe(true);
    }
  });

  it("leaves the rest of the day exactly as it was", () => {
    const withFloor = buildGrid(doctrine, [], { floorMin: 11 * 60 + 40 });
    const without = buildGrid(doctrine, []);
    for (const s of withFloor.slots) {
      if (s.startMin < 11 * 60 + 40) continue;
      const same = without.slots.find((x) => x.startMin === s.startMin)!;
      expect(s.eligible).toEqual(same.eligible);
    }
  });

  it("changes nothing at all when no floor is given (tomorrow, and every old caller)", () => {
    expect(buildGrid(doctrine, [], {}).slots.map((s) => s.eligible))
      .toEqual(buildGrid(doctrine, []).slots.map((s) => s.eligible));
  });
});

describe("re-solving today at 11:40", () => {
  it("never places new work in the morning that has already gone", async () => {
    addTask("Unpack travel bag", 30);
    await generatePlan(db, dir, secrets, null, DATE, deps(AT_1140));
    for (const b of blocks()) {
      expect(minsOf(b.starts_at)).toBeGreaterThanOrEqual(11 * 60 + 40);
    }
  });

  it("carries what already happened forward instead of erasing his morning", async () => {
    // A first plan built earlier in the day, with a block at 09:00.
    addTask("Unpack travel bag", 30);
    await generatePlan(db, dir, secrets, null, DATE, deps(new Date("2026-08-06T06:00:00")));
    const morning = blocks().filter((b) => minsOf(b.starts_at) < 11 * 60 + 40);
    expect(morning.length).toBeGreaterThan(0);
    const before = morning.map((b) => `${b.title}@${minsOf(b.starts_at)}`).sort();

    // Re-solve at 11:40 — the morning must survive, at exactly the same minutes.
    await generatePlan(db, dir, secrets, null, DATE, deps(AT_1140));
    const after = blocks()
      .filter((b) => minsOf(b.starts_at) < 11 * 60 + 40)
      .map((b) => `${b.title}@${minsOf(b.starts_at)}`)
      .sort();
    expect(after).toEqual(before);
  });

  it("does not re-place a task whose block has already begun", async () => {
    const id = addTask("Unpack travel bag", 30);
    await generatePlan(db, dir, secrets, null, DATE, deps(new Date("2026-08-06T06:00:00")));
    await generatePlan(db, dir, secrets, null, DATE, deps(AT_1140));
    const mine = blocks().filter((b) => b.title === "Unpack travel bag");
    expect(mine).toHaveLength(1); // carried forward once, never scheduled again
    expect(id).toBeGreaterThan(0);
  });

  it("plans tomorrow across the whole day — a floor belongs only to today", async () => {
    db.prepare("UPDATE task SET plan_date = '2026-08-07' WHERE 1=1").run();
    addTask("Morning thing", 30);
    db.prepare("UPDATE task SET plan_date = '2026-08-07' WHERE title = 'Morning thing'").run();
    await generatePlan(db, dir, secrets, null, "2026-08-07", deps(AT_1140));
    const early = (getPlan(db, "2026-08-07")?.blocks ?? []) as any[];
    expect(early.some((b) => minsOf(b.starts_at) < 11 * 60)).toBe(true);
  });
});

describe("a pinned task is placed once", () => {
  it("does not duplicate the task behind a dragged block", async () => {
    addTask("Take Stanford math test", 150, "deep_work");
    await generatePlan(db, dir, secrets, null, DATE, deps(new Date("2026-08-06T06:00:00")));
    const test = blocks().find((b) => b.title === "Take Stanford math test")!;
    expect(test).toBeTruthy();

    await moveBlock(db, dir, secrets, null, test.id, 13 * 60 + 45, {
      anchors: async () => [],
      now: new Date("2026-08-06T06:00:00"),
    });

    const copies = blocks().filter((b) => b.title === "Take Stanford math test");
    expect(copies).toHaveLength(1);
    expect(minsOf(copies[0].starts_at)).toBe(13 * 60 + 45);
  });

  it("keeps the task link on the pinned block, so it is still that task's placement", async () => {
    const taskId = addTask("Take Stanford math test", 150, "deep_work");
    await generatePlan(db, dir, secrets, null, DATE, deps(new Date("2026-08-06T06:00:00")));
    const test = blocks().find((b) => b.title === "Take Stanford math test")!;
    await moveBlock(db, dir, secrets, null, test.id, 13 * 60 + 45, {
      anchors: async () => [],
      now: new Date("2026-08-06T06:00:00"),
    });
    const pinned = blocks().find((b) => b.title === "Take Stanford math test")!;
    expect(pinned.task_id).toBe(taskId);
  });
});
