// Screen Time (knowledgeC.db) tests.
//
// NOTHING here reads the real ~/Library/Application Support/Knowledge/knowledgeC.db.
// Every test builds a fixture SQLite file in a tmpdir with the same table/column shape
// as the real store (ZOBJECT + ZSOURCE) and points the reader at that.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../main/db/db.ts";
import { captureOutcomes, adherenceStats, AUTO_OUTCOME_NOTE_SUFFIX } from "../main/engine/learning.ts";
import {
  appleSecondsToDate,
  dateToAppleSeconds,
  usageForRange,
  aggregateUsage,
  categoryFor,
  blockUsage,
  autoCaptureOutcomes,
  focusProxy,
  screenTimeAvailable,
  CATEGORY_MAP,
  APP_USAGE_STREAM,
  BACKLIT_STREAM,
  type UsageSpan,
} from "../main/screentime.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-screentime-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixture ─────────────────────────────────────────────────────────────────────
interface FixtureRow {
  stream?: string;
  /** bundle id for /app/usage */
  value?: string | null;
  int?: number | null;
  /** local naive ISO, e.g. "2026-08-03T09:00:00" */
  start: string;
  end: string;
  /** null/undefined = this Mac; a string = another Apple device syncing in */
  device?: string | null;
}

let fixtureSeq = 0;

/** Build a knowledgeC-shaped SQLite file and return its path. */
function makeKnowledge(rows: FixtureRow[]): string {
  const p = path.join(dir, `knowledgeC-${fixtureSeq++}.db`);
  const k = new Database(p);
  k.exec(`
    CREATE TABLE ZSOURCE (Z_PK INTEGER PRIMARY KEY, ZDEVICEID TEXT, ZBUNDLEID TEXT);
    CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZSTREAMNAME TEXT,
      ZVALUESTRING TEXT,
      ZVALUEINTEGER INTEGER,
      ZSTARTDATE REAL,
      ZENDDATE REAL,
      ZSOURCE INTEGER
    );
    INSERT INTO ZSOURCE (Z_PK, ZDEVICEID) VALUES (1, NULL);
  `);
  const sourceIds = new Map<string, number>();
  const insSource = k.prepare("INSERT INTO ZSOURCE (ZDEVICEID) VALUES (?)");
  const insObj = k.prepare(
    `INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZVALUEINTEGER, ZSTARTDATE, ZENDDATE, ZSOURCE)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    let src = 1;
    if (r.device) {
      if (!sourceIds.has(r.device)) {
        sourceIds.set(r.device, Number(insSource.run(r.device).lastInsertRowid));
      }
      src = sourceIds.get(r.device)!;
    }
    insObj.run(
      r.stream ?? APP_USAGE_STREAM,
      r.value ?? null,
      r.int ?? null,
      dateToAppleSeconds(new Date(r.start)),
      dateToAppleSeconds(new Date(r.end)),
      src
    );
  }
  k.close();
  return p;
}

const XCODE = "com.apple.dt.Xcode";
const SLACK = "com.tinyspeck.slackmacgap";
const INSTAGRAM = "com.burbn.instagram";

/** A full day of display-on, i.e. "the Mac was awake" evidence. */
const backlitAllDay = (date: string): FixtureRow => ({
  stream: BACKLIT_STREAM,
  int: 1,
  start: `${date}T07:00:00`,
  end: `${date}T23:00:00`,
});

/** Seed an accepted plan for `date` and return an insertBlock helper. */
function seedPlan(date: string) {
  const planId = Number(
    db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, accepted_at)
         VALUES (?, 'test', '{}', datetime('now'))`
      )
      .run(date).lastInsertRowid
  );
  return (type: string, from: string, to: string, title = type) =>
    Number(
      db
        .prepare(
          `INSERT INTO block (block_type, title, starts_at, ends_at, is_anchor, plan_id)
           VALUES (?, ?, ?, ?, 0, ?)`
        )
        .run(type, title, `${date}T${from}:00`, `${date}T${to}:00`, planId).lastInsertRowid
    );
}

// ── Apple absolute time ─────────────────────────────────────────────────────────
describe("Apple absolute time", () => {
  it("treats ZSTARTDATE as SECONDS since 2001-01-01 (not the nanoseconds chat.db uses)", () => {
    expect(appleSecondsToDate(0).toISOString()).toBe("2001-01-01T00:00:00.000Z");
    expect(appleSecondsToDate(86_400).toISOString()).toBe("2001-01-02T00:00:00.000Z");
    // 2026-08-03T12:00:00Z
    const d = new Date("2026-08-03T12:00:00.000Z");
    expect(appleSecondsToDate(dateToAppleSeconds(d)).toISOString()).toBe(d.toISOString());
  });

  it("round-trips a local wall-clock time through the store's epoch", () => {
    const local = new Date("2026-08-03T09:30:00"); // local, no offset — like block.starts_at
    expect(appleSecondsToDate(dateToAppleSeconds(local)).getTime()).toBe(local.getTime());
  });
});

// ── range clamping + merging ────────────────────────────────────────────────────
describe("usageForRange", () => {
  const D = "2026-08-03";

  it("clamps rows that straddle the range boundaries", () => {
    const p = makeKnowledge([
      { value: XCODE, start: `${D}T08:30:00`, end: `${D}T09:10:00` }, // starts before
      { value: SLACK, start: `${D}T09:50:00`, end: `${D}T10:30:00` }, // ends after
    ]);
    const spans = usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: p });
    expect(spans).toHaveLength(2);
    const xcode = spans.find((s) => s.bundleId === XCODE)!;
    expect(xcode.startMin).toBe(9 * 60); // clamped up to 09:00
    expect(xcode.endMin).toBe(9 * 60 + 10);
    expect(xcode.seconds).toBe(600);
    const slack = spans.find((s) => s.bundleId === SLACK)!;
    expect(slack.startMin).toBe(9 * 60 + 50);
    expect(slack.endMin).toBe(10 * 60); // clamped down to 10:00
    expect(slack.seconds).toBe(600);
  });

  it("merges adjacent same-app rows (<=60s apart) and overlapping duplicates", () => {
    const p = makeKnowledge([
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:20:00` },
      { value: XCODE, start: `${D}T09:20:30`, end: `${D}T09:40:00` }, // 30s gap → same sitting
      { value: XCODE, start: `${D}T09:35:00`, end: `${D}T09:45:00` }, // overlaps → union
    ]);
    const spans = usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: p });
    expect(spans).toHaveLength(1);
    expect(spans[0].startMin).toBe(9 * 60);
    expect(spans[0].endMin).toBe(9 * 60 + 45);
    expect(spans[0].seconds).toBe(45 * 60);
  });

  it("does not merge across a real break, and never merges different apps", () => {
    const p = makeKnowledge([
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:20:00` },
      { value: XCODE, start: `${D}T09:25:00`, end: `${D}T09:40:00` }, // 5-minute gap
      { value: SLACK, start: `${D}T09:20:00`, end: `${D}T09:25:00` },
    ]);
    const spans = usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: p });
    expect(spans).toHaveLength(3);
    expect(spans.filter((s) => s.bundleId === XCODE)).toHaveLength(2);
  });

  it("drops rows synced in from another Apple device unless asked for them", () => {
    const p = makeKnowledge([
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:30:00` },
      { value: INSTAGRAM, start: `${D}T09:00:00`, end: `${D}T09:30:00`, device: "iphone-uuid" },
    ]);
    const mac = usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: p });
    expect(mac.map((s) => s.bundleId)).toEqual([XCODE]);
    const all = usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: p, includeRemoteDevices: true });
    expect(all.map((s) => s.bundleId).sort()).toEqual([INSTAGRAM, XCODE].sort());
  });

  it("reports full_disk_access when the store cannot be opened", () => {
    const missing = path.join(dir, "nope.db");
    expect(screenTimeAvailable(missing)).toEqual(
      expect.objectContaining({ ok: false, error: "unavailable" })
    );
    expect(() => usageForRange(`${D}T09:00:00`, `${D}T10:00:00`, { dbPath: missing })).toThrow(
      /not found/
    );
  });
});

// ── category aggregation ────────────────────────────────────────────────────────
describe("category aggregation", () => {
  const span = (bundleId: string, seconds: number): UsageSpan => ({
    bundleId, appName: bundleId, startMin: 0, endMin: seconds / 60, seconds,
  });

  it("maps editors to focus, chat to communication, social to distraction, Finder to neutral", () => {
    expect(categoryFor(XCODE)).toBe("focus");
    expect(categoryFor(SLACK)).toBe("communication");
    expect(categoryFor(INSTAGRAM)).toBe("distraction");
    expect(categoryFor("com.apple.finder")).toBe("neutral");
  });

  it("defaults unknown bundle ids to neutral rather than guessing", () => {
    expect(categoryFor("com.some.unheard.of.App")).toBe("neutral");
    expect(CATEGORY_MAP["com.some.unheard.of.App"]).toBeUndefined();
  });

  it("computes per-category percentages of recorded usage and the top 3 apps", () => {
    const agg = aggregateUsage([
      span(XCODE, 3000),      // focus
      span(SLACK, 1200),      // communication
      span(INSTAGRAM, 600),   // distraction
      span("com.apple.finder", 200), // neutral
    ]);
    expect(agg.totalSeconds).toBe(5000);
    const pct = Object.fromEntries(agg.categories.map((c) => [c.category, c.pct]));
    expect(pct.focus).toBe(60);
    expect(pct.communication).toBe(24);
    expect(pct.distraction).toBe(12);
    expect(pct.neutral).toBe(4);
    expect(agg.dominant).toBe("focus");
    expect(agg.topApps).toHaveLength(3);
    expect(agg.topApps[0].bundleId).toBe(XCODE);
    expect(agg.topApps[0].appName).toBe("Xcode");
  });

  it("has no dominant category and zero percentages when nothing was used", () => {
    const agg = aggregateUsage([]);
    expect(agg.totalSeconds).toBe(0);
    expect(agg.dominant).toBeNull();
    expect(agg.categories.every((c) => c.pct === 0)).toBe(true);
  });

  it("maps the focus share to a 1-5 perceived-focus proxy", () => {
    expect(focusProxy(95)).toBe(5);
    expect(focusProxy(80)).toBe(5);
    expect(focusProxy(62)).toBe(4);
    expect(focusProxy(41)).toBe(3);
    expect(focusProxy(20)).toBe(2);
    expect(focusProxy(3)).toBe(1);
  });
});

// ── per-block report ────────────────────────────────────────────────────────────
describe("blockUsage", () => {
  const D = "2026-08-03";

  it("aggregates only the usage overlapping the block window", () => {
    const p = makeKnowledge([
      { value: XCODE, start: `${D}T08:00:00`, end: `${D}T08:45:00` }, // before the block
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:40:00` },
      { value: SLACK, start: `${D}T09:40:00`, end: `${D}T09:52:00` },
    ]);
    const block = seedPlan(D)("deep_work", "09:00", "10:00");
    const r = blockUsage(db, block, { dbPath: p });
    expect(r.blockMinutes).toBe(60);
    expect(r.totalSeconds).toBe(40 * 60 + 12 * 60);
    expect(r.dominant).toBe("focus");
    expect(r.coveragePct).toBeCloseTo(86.7, 1);
    expect(r.topApps.map((a) => a.bundleId)).toEqual([XCODE, SLACK]);
  });
});

// ── auto-capture ────────────────────────────────────────────────────────────────
describe("autoCaptureOutcomes", () => {
  const D = "2026-08-03";
  const outcomeFor = (blockId: number) =>
    db.prepare("SELECT * FROM block_outcome WHERE block_id = ?").all(blockId) as {
      completed: number; perceived_focus: number | null; note: string | null;
    }[];

  it("marks a focus-heavy deep_work block completed with a focus proxy and the evidence", () => {
    const p = makeKnowledge([
      backlitAllDay(D),
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:40:00` },
      { value: SLACK, start: `${D}T09:40:00`, end: `${D}T09:52:00` },
    ]);
    const block = seedPlan(D)("deep_work", "09:00", "10:00");

    const res = autoCaptureOutcomes(db, D, { dbPath: p });
    expect(res.captured).toBe(1);

    const rows = outcomeFor(block);
    expect(rows).toHaveLength(1);
    expect(rows[0].completed).toBe(1);
    expect(rows[0].perceived_focus).toBe(4); // 2400/3120 = 77% focus
    expect(rows[0].note).toContain("Xcode");
    expect(rows[0].note).toContain("Slack");
    expect(rows[0].note!.endsWith(AUTO_OUTCOME_NOTE_SUFFIX)).toBe(true);
  });

  it("marks a block with no usage on a backlit (awake) Mac as not completed", () => {
    const p = makeKnowledge([backlitAllDay(D)]);
    const block = seedPlan(D)("focused_work", "14:00", "15:00");

    const res = autoCaptureOutcomes(db, D, { dbPath: p });
    expect(res.captured).toBe(1);

    const rows = outcomeFor(block);
    expect(rows[0].completed).toBe(0);
    expect(rows[0].perceived_focus).toBe(1);
    expect(rows[0].note).toContain("no app usage recorded");
  });

  it("stays silent when the Mac was asleep — absence of evidence is not evidence of absence", () => {
    const p = makeKnowledge([]); // no usage AND no backlit rows
    const block = seedPlan(D)("focused_work", "14:00", "15:00");

    const res = autoCaptureOutcomes(db, D, { dbPath: p });
    expect(res.captured).toBe(0);
    expect(res.skipped).toEqual([{ blockId: block, blockType: "focused_work", reason: "no_evidence" }]);
    expect(outcomeFor(block)).toHaveLength(0);
  });

  it("does not mark a deep_work block completed when the time went to Instagram", () => {
    const p = makeKnowledge([
      backlitAllDay(D),
      { value: INSTAGRAM, start: `${D}T09:00:00`, end: `${D}T09:45:00` },
      { value: XCODE, start: `${D}T09:45:00`, end: `${D}T09:50:00` },
    ]);
    const block = seedPlan(D)("deep_work", "09:00", "10:00");
    autoCaptureOutcomes(db, D, { dbPath: p });
    const rows = outcomeFor(block);
    expect(rows[0].completed).toBe(0);
    expect(rows[0].perceived_focus).toBe(1);
  });

  it("never auto-captures block types the Mac knows nothing about (gym)", () => {
    const p = makeKnowledge([backlitAllDay(D)]);
    const block = seedPlan(D)("gym", "17:00", "18:00");
    const res = autoCaptureOutcomes(db, D, { dbPath: p });
    expect(res.captured).toBe(0);
    expect(res.skipped[0]).toEqual({ blockId: block, blockType: "gym", reason: "unsupported_type" });
    expect(outcomeFor(block)).toHaveLength(0);
  });

  it("CRITICAL: never overwrites or duplicates an outcome the owner recorded by hand", () => {
    const p = makeKnowledge([
      backlitAllDay(D),
      // Screen Time would say this comms block was all Instagram → not completed.
      { value: INSTAGRAM, start: `${D}T11:00:00`, end: `${D}T11:55:00` },
    ]);
    const block = seedPlan(D)("comms", "11:00", "12:00");
    captureOutcomes(db, [
      { blockId: block, completed: true, perceivedFocus: 5, note: "cleared the inbox" },
    ]);

    const res = autoCaptureOutcomes(db, D, { dbPath: p });
    expect(res.captured).toBe(0);
    expect(res.rows).toEqual([]);

    const rows = outcomeFor(block);
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0].completed).toBe(1); // his answer wins
    expect(rows[0].perceived_focus).toBe(5);
    expect(rows[0].note).toBe("cleared the inbox");
  });

  it("ignores blocks of a plan that was never accepted", () => {
    const p = makeKnowledge([backlitAllDay(D)]);
    const planId = Number(
      db
        .prepare("INSERT INTO plan (plan_date, engine_version, doctrine_snapshot) VALUES (?, 'test', '{}')")
        .run(D).lastInsertRowid
    );
    const block = Number(
      db
        .prepare(
          "INSERT INTO block (block_type, title, starts_at, ends_at, is_anchor, plan_id) VALUES ('deep_work','x',?,?,0,?)"
        )
        .run(`${D}T09:00:00`, `${D}T10:00:00`, planId).lastInsertRowid
    );
    expect(autoCaptureOutcomes(db, D, { dbPath: p }).captured).toBe(0);
    expect(outcomeFor(block)).toHaveLength(0);
  });
});

// ── provenance in the learning loop ─────────────────────────────────────────────
describe("adherenceStats provenance", () => {
  const D = "2026-08-03";

  it("counts auto (Screen Time) outcomes separately from the owner's own reporting", () => {
    const p = makeKnowledge([
      backlitAllDay(D),
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:55:00` },
    ]);
    const add = seedPlan(D);
    const auto = add("deep_work", "09:00", "10:00");
    const manual = add("deep_work", "13:00", "14:00");
    captureOutcomes(db, [{ blockId: manual, completed: true, perceivedFocus: 4, note: "good session" }]);
    autoCaptureOutcomes(db, D, { dbPath: p });

    const row = adherenceStats(db).find((r) => r.blockType === "deep_work")!;
    expect(row.planned).toBe(2);
    expect(row.completed).toBe(2);
    expect(row.completedManual).toBe(1);
    expect(row.completedAuto).toBe(1);
    expect(row.outcomesManual).toBe(1);
    expect(row.outcomesAuto).toBe(1);
    expect(row.autoShare).toBe(0.5);
    expect(auto).toBeGreaterThan(0);
  });

  it("a run of auto-captures cannot masquerade as self-reported adherence", () => {
    const p = makeKnowledge([
      backlitAllDay(D),
      { value: XCODE, start: `${D}T09:00:00`, end: `${D}T09:55:00` },
    ]);
    seedPlan(D)("deep_work", "09:00", "10:00");
    autoCaptureOutcomes(db, D, { dbPath: p });

    const row = adherenceStats(db).find((r) => r.blockType === "deep_work")!;
    expect(row.rate).toBe(1);
    expect(row.completedManual).toBe(0);
    expect(row.autoShare).toBe(1); // 100% machine-derived — the caller can see it
  });
});
