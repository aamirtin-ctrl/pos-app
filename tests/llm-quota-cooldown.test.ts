// One 429 must not cost ten more.
//
// His Gemini key hits the free tier's rate limit regularly: 47 of 132 msgplans runs over two
// days, every one HTTP 429, at a month-to-date spend of ten cents — so this is Google's
// per-window limit, not the app's cost ceiling, and it is the concrete reason he asked for
// work on "edge cases when the gemini credits are down".
//
// Each worker tick fires roughly a dozen LLM features within seconds of each other. The
// health API already knew the provider was refusing (llmHealth reports reason "quota"), but
// call() never consulted it, so every feature paid its own doomed round-trip to be told the
// same thing — slow, and needlessly hostile to a rate limit that is counting requests.
//
// The cooldown is deliberately short. FAILURE_WINDOW_MS is an hour because a red ring should
// persist; suppressing CALLS for an hour would keep the app deterministic long after the
// quota window reopened.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  inQuotaCooldown,
  recordFailure,
  clearFailure,
  lastFailure,
  QUOTA_COOLDOWN_MS,
  FAILURE_WINDOW_MS,
  resetFailureCache,
} from "../main/llm/meter.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-quota-"));
  db = openDb(path.join(dir, "pos.db"));
  // The failure state is cached in module scope so llmHealth and the hot call path do not
  // hit SQLite on every check. That cache outlives a test's database, so without this the
  // suite only passed in file order — a failure recorded elsewhere leaked in here (found by
  // running with --sequence.shuffle, 2026-08-08). The seam exists for exactly this.
  resetFailureCache();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The real shape Gemini returns when the free tier is exhausted. */
const quota429 = () =>
  new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details."}}'
  );

describe("inQuotaCooldown", () => {
  it("suppresses the calls that follow a fresh quota refusal", () => {
    const f = recordFailure(db, quota429());
    expect(f.code, "the 429 must classify as quota").toBe("quota");
    expect(inQuotaCooldown(lastFailure(db))).toBe(true);
  });

  it("lets the next tick probe again — the window is a minute, not an hour", () => {
    recordFailure(db, quota429());
    const f = lastFailure(db)!;
    const justAfter = new Date(Date.parse(f.at) + QUOTA_COOLDOWN_MS + 1);
    expect(inQuotaCooldown(f, justAfter)).toBe(false);
    // …and it is emphatically shorter than the UI's red-ring window
    expect(QUOTA_COOLDOWN_MS).toBeLessThan(FAILURE_WINDOW_MS);
    expect(inQuotaCooldown(f, new Date(Date.parse(f.at) + QUOTA_COOLDOWN_MS - 1))).toBe(true);
  });

  it("a one-off network blip does NOT gag the model", () => {
    // Only quota predicts the next call's outcome. A transient error does not.
    const f = recordFailure(db, new Error("socket hang up"));
    expect(f.code).not.toBe("quota");
    expect(inQuotaCooldown(lastFailure(db))).toBe(false);
  });

  it("a successful call clears it immediately — recovery is not made to wait", () => {
    recordFailure(db, quota429());
    expect(inQuotaCooldown(lastFailure(db))).toBe(true);
    clearFailure(db);
    expect(inQuotaCooldown(lastFailure(db))).toBe(false);
  });

  it("no recorded failure means no cooldown", () => {
    expect(inQuotaCooldown(null)).toBe(false);
    expect(inQuotaCooldown(lastFailure(db))).toBe(false);
  });

  it("an unparseable timestamp is treated as no cooldown, never as forever", () => {
    expect(inQuotaCooldown({ code: "quota", at: "not a date", message: "x" })).toBe(false);
  });
});
