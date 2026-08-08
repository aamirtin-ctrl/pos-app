// Property-based fuzzing of the Google Tasks reconcile.
//
// Bidirectional sync is where data quietly disappears: two sides both believe they are
// authoritative, and a rule that looks right for one direction erases something in the
// other. This module already produced two real bugs in one day — a due-date echo that
// poisoned every pushed task with a midnight deadline, and a crash mid-push that let the
// pull re-import POS's own strays as new tasks ("Call family" three times).
//
// So the invariants here are about LOSS and DUPLICATION, over random combinations of local
// and remote state:
//   - a local task is never hard-deleted, whatever Google says;
//   - completion is never silently undone;
//   - the same Google id never yields two local rows;
//   - reconciling twice against unchanged remote state changes nothing the second time.
//
// Seeded LCG, injected Google surface, no network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { reconcileGoogleTasks, type GoogleTaskLite, type GoogleTasksDeps } from "../main/gtasks-sync.ts";
import type { SecretStore } from "../main/secrets.ts";

const connected = { get: (n: string) => (n === "GOOGLE_OAUTH_TOKENS" ? "{}" : null) } as unknown as SecretStore;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-gtasks-fuzz-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LIVE = ["inbox", "planned", "in_progress"];

/** Seed random local tasks; return the remote listing the fake Google will serve. */
function seedPair(seed: number): GoogleTaskLite[] {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  const insert = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                       status, plan_date, hard_deadline_at, gtasks_id)
     VALUES (?, 'admin', 2, 30, 30, ?, ?, ?, ?)`
  );

  const remote: GoogleTaskLite[] = [];
  const n = int(0, 6);
  for (let i = 0; i < n; i++) {
    const gid = `g${i}`;
    const linked = r() < 0.8;
    insert.run(
      `task-${i}`,
      pick(LIVE),
      r() < 0.5 ? "2026-08-12" : null,
      r() < 0.3 ? "2026-08-12T17:00:00" : null,
      linked ? gid : null
    );
    // Whether Google still knows about it, and in what state.
    const roll = r();
    if (!linked) continue;
    if (roll < 0.15) continue; // vanished from the listing entirely
    remote.push({
      id: gid,
      title: r() < 0.3 ? `renamed-${i}` : `task-${i}`,
      status: roll < 0.4 ? "completed" : "needsAction",
      deleted: roll > 0.9 ? true : undefined,
      due: r() < 0.4 ? "2026-08-12T00:00:00.000Z" : undefined,
      completed: roll < 0.4 ? "2026-08-11T09:00:00.000Z" : undefined,
      updated: "2030-01-01T00:00:00.000Z", // far future: remote always "newer", the harsher path
    });
  }
  // Rows Google has that POS has never seen.
  for (let i = 0; i < int(0, 2); i++) {
    remote.push({ id: `new${i}`, title: `phone-task-${i}`, status: "needsAction" });
  }
  return remote;
}

function deps(remote: GoogleTaskLite[]): Partial<GoogleTasksDeps> {
  return {
    isConnected: () => true,
    ensureTasklist: async () => "POS_LIST",
    listTasks: async ({ tasklist }) => ({ items: tasklist === "@default" ? [] : remote }),
    patchTask: async () => {},
    insertTask: async () => ({ id: "never" }),
    pushTasks: async () => ({ pushed: 0, completed: 0 }),
    now: () => new Date("2026-08-12T12:00:00Z"),
  };
}

const countTasks = () => (db.prepare("SELECT COUNT(*) n FROM task").get() as { n: number }).n;
const snapshot = () =>
  JSON.stringify(
    db.prepare("SELECT id, title, status, plan_date, hard_deadline_at, gtasks_id FROM task ORDER BY id").all()
  );

const SEEDS = 400;

describe("gtasks reconcile invariants over random states", () => {
  it("never hard-deletes a local task, whatever Google reports", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const remote = seedPair(seed);
      const before = countTasks();
      await reconcileGoogleTasks(db, connected, deps(remote));
      // Rows may be ADDED (Google-only tasks adopted) but never removed: POS keeps history,
      // and the planner and worklog read it.
      expect(countTasks(), `seed ${seed}`).toBeGreaterThanOrEqual(before);
      db.prepare("DELETE FROM task").run();
    }
  });

  it("never silently un-completes work", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const remote = seedPair(seed);
      db.prepare("UPDATE task SET status = 'done', completed_at = '2026-08-11 09:00:00' WHERE id % 2 = 0").run();
      const doneBefore = db.prepare("SELECT id FROM task WHERE status = 'done'").all() as { id: number }[];
      await reconcileGoogleTasks(db, connected, deps(remote));
      for (const d of doneBefore) {
        const after = db.prepare("SELECT status FROM task WHERE id = ?").get(d.id) as { status: string };
        expect(after.status, `seed ${seed}: task ${d.id} was done and became ${after.status}`).toBe("done");
      }
      db.prepare("DELETE FROM task").run();
    }
  });

  it("never maps two local rows to one Google id", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const remote = seedPair(seed);
      await reconcileGoogleTasks(db, connected, deps(remote));
      const dupes = db
        .prepare(
          "SELECT gtasks_id, COUNT(*) n FROM task WHERE gtasks_id IS NOT NULL GROUP BY gtasks_id HAVING n > 1"
        )
        .all() as { gtasks_id: string; n: number }[];
      expect(dupes, `seed ${seed}: duplicated ${JSON.stringify(dupes)}`).toEqual([]);
      db.prepare("DELETE FROM task").run();
    }
  });

  it("is idempotent — a second reconcile against unchanged remote state changes nothing", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const remote = seedPair(seed);
      await reconcileGoogleTasks(db, connected, deps(remote));
      const first = snapshot();
      await reconcileGoogleTasks(db, connected, deps(remote));
      expect(snapshot(), `seed ${seed}: the second pass moved something`).toBe(first);
      db.prepare("DELETE FROM task").run();
    }
  });

  it("never writes a midnight hard deadline from a date-only Google due", async () => {
    // The 2026-08-07 bug: Google's due is DATE-only, and storing it as <date>T00:00:00 gave
    // every pushed task a deadline already in the past, so the solver refused to place it.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const remote = seedPair(seed);
      await reconcileGoogleTasks(db, connected, deps(remote));
      const midnight = db
        .prepare("SELECT id, hard_deadline_at d FROM task WHERE hard_deadline_at LIKE '%T00:00:00'")
        .all() as { id: number; d: string }[];
      expect(midnight, `seed ${seed}: fabricated midnight deadlines ${JSON.stringify(midnight)}`).toEqual([]);
      db.prepare("DELETE FROM task").run();
    }
  });
});
