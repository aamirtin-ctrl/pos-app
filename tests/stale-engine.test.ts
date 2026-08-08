// An engine fix has to reach the day that already has a plan.
//
// Owner report 2026-08-06, AFTER the shutdown-boundary and deep-work-cap fixes had shipped and
// he had relaunched: "I talked about the bug in today's schedule where it scheduled unpacking
// my travel bag almost two hours after my shutdown ritual and it not taking into account the
// Stanford math test. Why didn't it do that?"
//
// Because a plan is solved once and stored. Fixing the solver changes what the NEXT solve
// produces and does nothing to a row that already exists. His plan had been generated at
// 12:01 and nothing re-solved it: replanIfConflicted only fires when the EXTERNAL calendar
// moves (the anchor fingerprint), and his calendar had not moved — the engine had.
//
// So a fix could pass every test, ship, relaunch, and leave the reported bug on his screen.
// `plan.engine_version` was written on every row for exactly this purpose and nothing read it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { plansOnStaleEngine, STALE_ENGINE_WINDOW_DAYS } from "../main/workers.ts";
import { ENGINE_VERSION } from "../main/engine/solver.ts";
import { addDaysISO } from "../main/dates.ts";

const NOW = new Date("2026-08-06T12:00:00Z");
// LOCAL dates, matching what plansOnStaleEngine now computes and what the owner would call
// "today". Deriving them from toISOString() made the suite pass only in zones where the UTC
// and local dates of NOW happen to agree — it failed outright at UTC+14 (found by running
// the whole suite under Pacific/Kiritimati, 2026-08-08). The code was right; the helper was
// still thinking in UTC.
const iso = (offsetDays: number) => addDaysISO(NOW, offsetDays);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-stale-engine-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPlan(opts: { date: string; engine?: string; accepted?: boolean; generatedAt?: string }): number {
  return Number(
    db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks,
                           accepted_at, generated_at)
         VALUES (?, ?, '{}', '', '[]', ?, ?)`
      )
      .run(
        opts.date,
        opts.engine ?? "1.0.0",
        opts.accepted ? "2026-08-06 09:00:00" : null,
        opts.generatedAt ?? `${opts.date} 12:01:52`
      ).lastInsertRowid
  );
}

const dates = (rows: { planDate: string }[]) => rows.map((r) => r.planDate);

describe("plansOnStaleEngine", () => {
  it("flags TODAY — the day being lived is when a scheduling bug still matters", () => {
    addPlan({ date: iso(0), engine: "1.0.0" });
    expect(dates(plansOnStaleEngine(db, NOW))).toEqual([iso(0)]);
  });

  it("ignores a plan already solved by the current engine", () => {
    addPlan({ date: iso(0), engine: ENGINE_VERSION });
    expect(plansOnStaleEngine(db, NOW)).toEqual([]);
  });

  it("flags upcoming days too, in date order", () => {
    addPlan({ date: iso(2), engine: "1.0.0" });
    addPlan({ date: iso(0), engine: "1.1.0" });
    addPlan({ date: iso(1), engine: ENGINE_VERSION }); // current — not flagged
    expect(dates(plansOnStaleEngine(db, NOW))).toEqual([iso(0), iso(2)]);
  });

  it("never re-solves the past — yesterday is history", () => {
    addPlan({ date: iso(-1), engine: "1.0.0" });
    addPlan({ date: iso(-30), engine: "1.0.0" });
    expect(plansOnStaleEngine(db, NOW)).toEqual([]);
  });

  it("stops at the window edge", () => {
    addPlan({ date: iso(STALE_ENGINE_WINDOW_DAYS + 3), engine: "1.0.0" });
    expect(plansOnStaleEngine(db, NOW)).toEqual([]);
  });

  // Acceptance means he read that day and locked it. Silently re-solving it would be a worse
  // bug than the one being fixed, so it is reported and left alone.
  it("reports a locked day rather than rewriting it", () => {
    addPlan({ date: iso(0), engine: "1.0.0", accepted: true });
    const [row] = plansOnStaleEngine(db, NOW);
    expect(row.accepted).toBe(true);
    expect(row.engineVersion).toBe("1.0.0");
  });

  it("judges a day by its NEWEST plan only", () => {
    // Re-planning an accepted day leaves the superseded row behind; the old row's version
    // must not keep a day flagged forever after it has been re-solved.
    addPlan({ date: iso(0), engine: "1.0.0", generatedAt: `${iso(0)} 08:00:00`, accepted: true });
    addPlan({ date: iso(0), engine: ENGINE_VERSION, generatedAt: `${iso(0)} 16:00:00` });
    expect(plansOnStaleEngine(db, NOW)).toEqual([]);
  });

  it("carries the version it found, so the log can say what changed", () => {
    addPlan({ date: iso(0), engine: "1.1.0" });
    expect(plansOnStaleEngine(db, NOW)[0]).toMatchObject({
      planDate: iso(0),
      engineVersion: "1.1.0",
      accepted: false,
    });
  });
});

// The bump itself is the trigger, so a version that never moves is a silent no-op. This is a
// tripwire, not a style rule: 1.1.0 shipped the deadline windows, and the shutdown/deep-work
// fixes had to be 1.2.0 or his day would never have been re-solved.
describe("ENGINE_VERSION", () => {
  it("is a semver string past the version that first needed re-solving", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const [maj, min] = ENGINE_VERSION.split(".").map(Number);
    expect(maj > 1 || (maj === 1 && min >= 2)).toBe(true);
  });
});

// ── the evening hole (owner-facing, audited 2026-08-08) ─────────────────────
//
// The sweep window started at `now.toISOString().slice(0, 10)` — the UTC date. West of UTC
// that becomes TOMORROW for the last hours of every evening (America/Chicago: from 19:00),
// so `plan_date >= today` excluded the day actually on screen. An engine fix shipped in the
// evening therefore never reached today's plan, which is precisely when it would be shipped
// after a day of use. Verified against the real case: the 1.2.3 bump at 23:55 re-solved the
// following day and left the current one stale.
describe("plansOnStaleEngine — late in the evening", () => {
  it("still flags TODAY at 22:00 local, when UTC has already rolled over", () => {
    addPlan({ date: "2026-08-07", engine: "1.0.0" });
    const evening = new Date(2026, 7, 7, 22, 0); // 22:00 local, by construction
    expect(dates(plansOnStaleEngine(db, evening))).toContain("2026-08-07");
  });

  it("and at 23:59, the far edge", () => {
    addPlan({ date: "2026-08-07", engine: "1.0.0" });
    expect(dates(plansOnStaleEngine(db, new Date(2026, 7, 7, 23, 59)))).toContain("2026-08-07");
  });

  it("yesterday is still excluded — the window starts at today, not before it", () => {
    addPlan({ date: "2026-08-06", engine: "1.0.0" });
    expect(dates(plansOnStaleEngine(db, new Date(2026, 7, 7, 22, 0)))).not.toContain("2026-08-06");
  });

  it("the far end of the window is a calendar day out, not 24h of milliseconds", () => {
    // Across a DST boundary a fixed-ms window lands on the wrong date at the edge.
    addPlan({ date: "2027-03-14", engine: "1.0.0" }); // the 23-hour day
    expect(dates(plansOnStaleEngine(db, new Date(2027, 2, 13, 22, 0), 1))).toContain("2027-03-14");
  });
});
