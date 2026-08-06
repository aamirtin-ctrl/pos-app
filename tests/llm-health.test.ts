// LLM availability (main/llm/meter.ts + main/llm/provider.ts llmHealth).
//
// Owner report 2026-08-05: the app started copying his raw sparkle-box text into event
// titles instead of writing headlines — the deterministic fallback's signature behavior —
// with nothing on screen saying the AI had stopped working. Gemini's free tier is ~250
// fast-tier requests a day, so this is a state he will hit again.
//
// These tests pin the two halves of the fix: a failure is CLASSIFIED (quota vs. anything
// else, across both providers' error shapes), and llmHealth turns that plus the key and the
// ceiling into the single answer the gear ring, the Spend card and the planner chip read.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import {
  classifyLlmError,
  recordFailure,
  clearFailure,
  lastFailure,
  failureIsCurrent,
  resetFailureCache,
  recordCall,
  setCeiling,
  getCeiling,
  FAILURE_WINDOW_MS,
  LLM_LAST_FAILURE_KEY,
} from "../main/llm/meter.ts";
import { llmHealth } from "../main/llm/provider.ts";
import type { SecretStore } from "../main/secrets.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-llm-health-"));
  db = openDb(path.join(dir, "pos.db"));
  resetFailureCache(); // the module cache is per-process, not per-test
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A secret store holding exactly the named keys. */
const keys = (present: Record<string, string> = {}): SecretStore =>
  ({ get: (n: string) => present[n] ?? null }) as unknown as SecretStore;

const gemini = keys({ GEMINI_API_KEY: "g" });
const anthropic = keys({ ANTHROPIC_API_KEY: "a" });
const noKeys = keys();

// ── representative failures, as the two SDKs actually throw them ─────────────

/** @google/genai surfaces the API's error envelope in the message. */
const GEMINI_429 = new Error(
  'got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota. Please migrate to Gemini 2.5 Flash…","status":"RESOURCE_EXHAUSTED"}}'
);

/** The same condition with the status word but no digits anywhere. */
const RESOURCE_EXHAUSTED = Object.assign(new Error("Resource has been exhausted"), {
  status: "RESOURCE_EXHAUSTED",
});

/** provider.ts callAnthropic throws this shape verbatim on a non-ok response. */
const ANTHROPIC_RATE_LIMIT = new Error(
  'anthropic 429: {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}'
);

/** Billing, not throughput — same user-visible consequence. */
const INSUFFICIENT_QUOTA = new Error('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}');

/** A structured 429 with a useless message, to prove the status field is read. */
const STATUS_ONLY_429 = Object.assign(new Error("request failed"), { status: 429 });

describe("classifyLlmError", () => {
  it("calls every quota/rate-limit shape 'quota'", () => {
    for (const e of [GEMINI_429, RESOURCE_EXHAUSTED, ANTHROPIC_RATE_LIMIT, INSUFFICIENT_QUOTA, STATUS_ONLY_429]) {
      expect(classifyLlmError(e)).toBe("quota");
    }
    // The bare strings each provider is known to emit.
    expect(classifyLlmError("Quota exceeded for quota metric 'Generate Content API requests'")).toBe("quota");
    expect(classifyLlmError("429 Too Many Requests")).toBe("quota");
  });

  it("calls everything else 'error', including failures that merely contain digits", () => {
    expect(classifyLlmError(new Error("anthropic 500: internal server error"))).toBe("error");
    expect(classifyLlmError(Object.assign(new Error("bad key"), { status: 401 }))).toBe("error");
    expect(classifyLlmError(new Error("getaddrinfo ENOTFOUND api.anthropic.com"))).toBe("error");
    expect(classifyLlmError(new Error("prompt was 4290 tokens, over the limit"))).toBe("error");
    expect(classifyLlmError(null)).toBe("error");
  });
});

describe("the recorded failure", () => {
  it("persists to a setting and survives a cold module cache", () => {
    const f = recordFailure(db, GEMINI_429);
    expect(f.code).toBe("quota");
    expect(f.message).toMatch(/quota/i);
    expect(getSetting(db, LLM_LAST_FAILURE_KEY)).toContain("quota");

    resetFailureCache(); // as if the app had just restarted
    expect(lastFailure(db)?.code).toBe("quota");
  });

  it("is cleared by a call that lands, and clearing is a no-op when nothing is wrong", () => {
    recordFailure(db, GEMINI_429);
    clearFailure(db);
    expect(lastFailure(db)).toBeNull();
    clearFailure(db); // must not throw or re-write
    resetFailureCache();
    expect(lastFailure(db)).toBeNull();
  });

  it("stops describing the present once it is over an hour old", () => {
    const now = new Date("2026-08-05T12:00:00Z");
    const fresh = recordFailure(db, GEMINI_429, new Date(now.getTime() - 5 * 60_000));
    expect(failureIsCurrent(fresh, now)).toBe(true);

    const stale = recordFailure(db, GEMINI_429, new Date(now.getTime() - FAILURE_WINDOW_MS - 1000));
    expect(failureIsCurrent(stale, now)).toBe(false);
    expect(failureIsCurrent(null, now)).toBe(false);
  });
});

describe("llmHealth", () => {
  const now = new Date("2026-08-05T12:00:00Z");

  it("is ok when a key is set, spend is under the ceiling, and nothing recently failed", () => {
    const h = llmHealth(db, gemini, now);
    expect(h.ok).toBe(true);
    expect(h.reason).toBeUndefined();
    expect(h.provider).toBe("gemini");
    expect(h.configured).toBe(true);
    expect(h.monthSpend).toBe(0);
    expect(h.ceiling).toBe(getCeiling(db));
  });

  it("stays ok when the only failure is older than the window", () => {
    recordFailure(db, GEMINI_429, new Date(now.getTime() - FAILURE_WINDOW_MS - 60_000));
    expect(llmHealth(db, gemini, now).ok).toBe(true);
  });

  it("reports 'no_key' when no provider is configured", () => {
    const h = llmHealth(db, noKeys, now);
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("no_key");
    expect(h.configured).toBe(false);
    expect(h.provider).toBeNull();
  });

  it("reports 'ceiling' when month-to-date spend has passed the ceiling", () => {
    setCeiling(db, 0.0001);
    recordCall(db, "plan_parse", "gemini-2.5-pro", 1_000_000, 1_000_000); // ≫ 0.0001
    const h = llmHealth(db, gemini, now);
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("ceiling");
    expect(h.monthSpend).toBeGreaterThan(h.ceiling);
  });

  it("reports 'quota' for a recent quota failure, on either provider", () => {
    recordFailure(db, GEMINI_429, new Date(now.getTime() - 60_000));
    const g = llmHealth(db, gemini, now);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe("quota");
    expect(g.provider).toBe("gemini");
    expect(g.lastFailureAt).toBe(new Date(now.getTime() - 60_000).toISOString());

    recordFailure(db, ANTHROPIC_RATE_LIMIT, new Date(now.getTime() - 60_000));
    expect(llmHealth(db, anthropic, now).reason).toBe("quota");
  });

  it("reports 'error' for a recent non-quota failure", () => {
    recordFailure(db, new Error("anthropic 500: internal server error"), new Date(now.getTime() - 60_000));
    const h = llmHealth(db, anthropic, now);
    expect(h.ok).toBe(false);
    expect(h.reason).toBe("error");
  });

  it("ranks a missing key and the ceiling above a provider failure — fix those first", () => {
    recordFailure(db, GEMINI_429, new Date(now.getTime() - 60_000));
    expect(llmHealth(db, noKeys, now).reason).toBe("no_key");

    setCeiling(db, 0.0001);
    recordCall(db, "plan_parse", "gemini-2.5-pro", 1_000_000, 1_000_000);
    expect(llmHealth(db, gemini, now).reason).toBe("ceiling");
  });
});
