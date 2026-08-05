// Persisted per-date day-cache helpers (setting table): pure key pruning plus
// the persist/read round-trip on a tmp DB. These back the serve-stale-while-
// refreshing paths in gcal/sync.readAnchors and icscal.eventsForDate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import {
  pruneDayCacheKeys,
  persistDayCache,
  readDayCache,
  cachedAnchors,
  ANCHORS_CACHE_PREFIX,
  DAY_CACHE_KEEP,
} from "../main/gcal/sync.ts";

const key = (d: string) => `${ANCHORS_CACHE_PREFIX}${d}`;
const dates = (n: number, from = "2026-08-01") =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T12:00:00`);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

describe("pruneDayCacheKeys", () => {
  it("keeps everything at or under the cap", () => {
    const keys = dates(DAY_CACHE_KEEP).map(key);
    expect(pruneDayCacheKeys(keys)).toEqual([]);
    expect(pruneDayCacheKeys(keys.slice(0, 3))).toEqual([]);
    expect(pruneDayCacheKeys([])).toEqual([]);
  });

  it("returns the OLDEST keys beyond the cap, regardless of input order", () => {
    const all = dates(DAY_CACHE_KEEP + 3).map(key);
    const shuffled = [...all].reverse();
    const doomed = pruneDayCacheKeys(shuffled);
    expect(doomed.sort()).toEqual(all.slice(0, 3)); // the 3 oldest dates go
  });

  it("respects an explicit keep count and never mutates its input", () => {
    const all = dates(5).map(key);
    const input = [...all];
    expect(pruneDayCacheKeys(input, 2).sort()).toEqual(all.slice(0, 3));
    expect(input).toEqual(all);
  });
});

describe("persistDayCache / readDayCache", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-daycache-"));
    db = openDb(path.join(dir, "pos.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips JSON per date and prefix", () => {
    const anchors = [{ startMin: 540, endMin: 600, title: "Standup", blockType: "meeting", gcalEventId: "g1", iCalUID: "u1" }];
    persistDayCache(db, ANCHORS_CACHE_PREFIX, "2026-08-05", JSON.stringify(anchors));
    expect(readDayCache(db, ANCHORS_CACHE_PREFIX, "2026-08-05")).toEqual(anchors);
    expect(cachedAnchors(db, "2026-08-05")).toEqual(anchors);
    // a different date / prefix reads as absent
    expect(readDayCache(db, ANCHORS_CACHE_PREFIX, "2026-08-06")).toBeNull();
    expect(readDayCache(db, "ics_cache:", "2026-08-05")).toBeNull();
  });

  it("returns null (not a throw) on unparseable persisted JSON", () => {
    db.prepare("INSERT INTO setting (key, value) VALUES (?, ?)").run(key("2026-08-05"), "{nope");
    expect(readDayCache(db, ANCHORS_CACHE_PREFIX, "2026-08-05")).toBeNull();
    expect(cachedAnchors(db, "2026-08-05")).toBeNull();
  });

  it("cachedAnchors rejects a persisted non-array", () => {
    persistDayCache(db, ANCHORS_CACHE_PREFIX, "2026-08-05", JSON.stringify({ not: "an array" }));
    expect(cachedAnchors(db, "2026-08-05")).toBeNull();
  });

  it("prunes to the newest DAY_CACHE_KEEP dates without touching other prefixes", () => {
    db.prepare("INSERT INTO setting (key, value) VALUES (?, ?)").run("ics_subscriptions", "[]");
    const all = dates(DAY_CACHE_KEEP + 2);
    for (const d of all) persistDayCache(db, ANCHORS_CACHE_PREFIX, d, "[]");
    const kept = (db.prepare("SELECT key FROM setting WHERE key LIKE ?").all(`${ANCHORS_CACHE_PREFIX}%`) as { key: string }[])
      .map((r) => r.key)
      .sort();
    expect(kept).toEqual(all.slice(2).map(key)); // the 2 oldest were deleted
    expect(getSetting(db, "ics_subscriptions")).toBe("[]"); // unrelated keys untouched
  });
});
