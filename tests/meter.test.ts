import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  costUsd, recordCall, monthSpend, getCeiling, setCeiling, underCeiling, DEFAULT_CEILING_USD,
} from "../main/llm/meter.ts";
import { extractJson } from "../main/llm/provider.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-meter-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cost meter", () => {
  it("computes cost from the pricing table", () => {
    // 1M in + 1M out on flash = 0.30 + 2.50
    expect(costUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(2.8, 6);
  });

  it("records calls and aggregates month spend by feature", () => {
    recordCall(db, "plan_parse", "gemini-2.5-flash", 200_000, 50_000);
    recordCall(db, "plan_parse", "gemini-2.5-flash", 100_000, 25_000);
    recordCall(db, "narration", "gemini-2.5-pro", 10_000, 2_000);
    const s = monthSpend(db);
    expect(Object.keys(s.byFeature).sort()).toEqual(["narration", "plan_parse"]);
    expect(s.total).toBeCloseTo(s.byFeature.plan_parse + s.byFeature.narration, 9);
    expect(s.total).toBeGreaterThan(0);
  });

  it("ceiling defaults, is configurable, and flips underCeiling", () => {
    expect(getCeiling(db)).toBe(DEFAULT_CEILING_USD);
    expect(underCeiling(db)).toBe(true);
    setCeiling(db, 0.0001);
    recordCall(db, "x", "gemini-2.5-pro", 1_000_000, 1_000_000); // ≫ 0.0001
    expect(underCeiling(db)).toBe(false);
  });
});

describe("extractJson", () => {
  it("parses clean JSON, fenced JSON, and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: [{"a":1}] hope that helps')).toEqual([{ a: 1 }]);
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
