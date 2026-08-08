// Cost meter (§3.3): every API call logged to llm_call; month-to-date spend by feature;
// hard configurable monthly ceiling — when exceeded the app degrades to deterministic-only
// planning and warns in-app rather than failing.

import type { Db } from "../db/db.ts";
import { getSetting, setSetting } from "../db/db.ts";

// USD per **million** tokens (input, output). Update as prices move.
const PRICING: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-embedding-001": { in: 0.15, out: 0 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
};

export const DEFAULT_CEILING_USD = 10;

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { in: 3, out: 15 }; // unknown model: price conservatively
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

export function recordCall(
  db: Db,
  feature: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const cost = costUsd(model, inputTokens, outputTokens);
  db.prepare(
    "INSERT INTO llm_call (feature, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)"
  ).run(feature, model, inputTokens, outputTokens, cost);
  return cost;
}

/** Month-to-date spend, optionally per feature. */
export function monthSpend(db: Db): { total: number; byFeature: Record<string, number> } {
  const rows = db
    .prepare(
      `SELECT feature, SUM(cost_usd) AS c FROM llm_call
       WHERE called_at >= strftime('%Y-%m-01', 'now') GROUP BY feature`
    )
    .all() as { feature: string; c: number }[];
  const byFeature: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byFeature[r.feature] = r.c;
    total += r.c;
  }
  return { total, byFeature };
}

export function getCeiling(db: Db): number {
  const v = getSetting(db, "llm_monthly_ceiling_usd");
  return v ? Number(v) : DEFAULT_CEILING_USD;
}

export function setCeiling(db: Db, usd: number): void {
  setSetting(db, "llm_monthly_ceiling_usd", String(usd));
}

export function underCeiling(db: Db): boolean {
  return monthSpend(db).total < getCeiling(db);
}

// ── failure classification ───────────────────────────────────────────────────
//
// The app's never-throw contract (provider.call returns null) means a dead API key, an
// exhausted free tier and a transient 500 all look IDENTICAL from the outside: planning
// quietly falls back to the deterministic path and the owner sees his own braindump text
// copied into event titles with no explanation. Owner report 2026-08-05.
//
// So every failure is classified and remembered. "quota" is the one that matters — Gemini's
// free tier is ~250 fast-tier requests/day, and hitting it is a state that persists for
// hours, not a blip worth retrying. Everything else is "error".

export type LlmFailureCode = "quota" | "error";

export interface LlmFailure {
  code: LlmFailureCode;
  /** ISO timestamp of the failure. */
  at: string;
  /** Truncated provider message, for the Settings card. Never contains the API key. */
  message: string;
}

/** Setting key holding the last failure as JSON, so the state survives a restart. */
export const LLM_LAST_FAILURE_KEY = "llm_last_failure";

/** How long a recorded failure keeps describing the CURRENT state of the provider. */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long a QUOTA refusal suppresses further calls, so one 429 does not become ten.
 *
 * His Gemini key hits the free tier's rate limit regularly — 47 of 132 msgplans runs over two
 * days, all HTTP 429, at a month-to-date spend of ten cents, so this is Google's per-window
 * limit and not the app's cost ceiling. Each tick fires roughly a dozen features within a few
 * seconds of each other, and every one of them was making its own doomed round-trip: the
 * first refusal already told us the answer for the rest.
 *
 * Deliberately much shorter than FAILURE_WINDOW_MS, which exists to keep a red ring on screen
 * for an hour. Suppressing CALLS for an hour would keep the app deterministic long after the
 * quota window reopened. A minute collapses the burst — the common case — while re-probing on
 * the very next tick, so the worst cost of being wrong is sixty seconds of determinism.
 *
 * Quota only. A one-off network blip must not gag the model.
 */
export const QUOTA_COOLDOWN_MS = 60 * 1000;

/** True when a quota refusal is recent enough that the next call would certainly fail too. */
export function inQuotaCooldown(f: LlmFailure | null, now: Date = new Date()): boolean {
  if (!f || f.code !== "quota") return false;
  const at = Date.parse(f.at);
  return Number.isFinite(at) && now.getTime() - at < QUOTA_COOLDOWN_MS;
}

/**
 * Quota/rate-limit shapes across both providers:
 *   Google  → HTTP 429, `"status": "RESOURCE_EXHAUSTED"`, "Quota exceeded for quota metric…"
 *   Anthropic → HTTP 429, `{"type":"rate_limit_error"}`, "insufficient_quota"
 */
const QUOTA_SHAPES = [
  /RESOURCE_EXHAUSTED/i,
  /\bquota\b/i,
  /insufficient_quota/i,
  /rate[_\s-]?limit/i,
  /too many requests/i,
];

/** Everything we can read off a thrown value, flattened to one searchable string. */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as Record<string, unknown> & { message?: string };
  const parts = [e.message ?? "", String((e as { toString?: () => string }).toString?.() ?? "")];
  try {
    // Errors carry their interesting fields (status, error.status, response body) as own
    // enumerable props; `message` is not enumerable, hence the explicit push above.
    parts.push(JSON.stringify(e));
  } catch {
    /* circular or otherwise unserializable — the message alone will have to do */
  }
  return parts.filter(Boolean).join(" ");
}

/** The numeric HTTP status, wherever the SDK hid it. Null when there isn't one. */
function statusOf(err: unknown): number | null {
  const e = err as Record<string, any> | null;
  if (!e || typeof e !== "object") return null;
  for (const v of [e.status, e.statusCode, e.code, e.error?.code, e.error?.status, e.response?.status]) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

/** "quota" for anything rate-limit/credit shaped, "error" for everything else. */
export function classifyLlmError(err: unknown): LlmFailureCode {
  if (statusOf(err) === 429) return "quota";
  const text = errorText(err);
  // A bare "429" in the message is how both providers' plain-fetch paths surface the status
  // ("anthropic 429: …"); the digit boundaries keep it from matching a token count.
  if (/(?:^|[^\d])429(?:[^\d]|$)/.test(text)) return "quota";
  return QUOTA_SHAPES.some((re) => re.test(text)) ? "quota" : "error";
}

// Module state mirrors the persisted setting so llmHealth() and the hot call path don't hit
// SQLite on every check. `undefined` means "not loaded from the DB yet" — distinct from
// `null`, which means "loaded, and there is no outstanding failure".
let failureState: LlmFailure | null | undefined = undefined;

/** Test seam: forget what this process learned, so the next read comes from the DB. */
export function resetFailureCache(): void {
  failureState = undefined;
}

function parseFailure(raw: string | null): LlmFailure | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<LlmFailure>;
    if (!p || (p.code !== "quota" && p.code !== "error") || typeof p.at !== "string") return null;
    return { code: p.code, at: p.at, message: typeof p.message === "string" ? p.message : "" };
  } catch {
    return null;
  }
}

/** The last recorded failure, or null when the provider's last word was a success. */
export function lastFailure(db: Db): LlmFailure | null {
  if (failureState !== undefined) return failureState;
  failureState = parseFailure(getSetting(db, LLM_LAST_FAILURE_KEY));
  return failureState;
}

/** Classify and remember a failed call. Returns what was recorded. */
export function recordFailure(db: Db, err: unknown, now: Date = new Date()): LlmFailure {
  const failure: LlmFailure = {
    code: classifyLlmError(err),
    at: now.toISOString(),
    message: String((err as Error)?.message ?? err ?? "").slice(0, 300),
  };
  failureState = failure;
  setSetting(db, LLM_LAST_FAILURE_KEY, JSON.stringify(failure));
  return failure;
}

/** A successful call means the provider is healthy again. No-op when nothing was wrong. */
export function clearFailure(db: Db): void {
  if (lastFailure(db) === null) return;
  failureState = null;
  setSetting(db, LLM_LAST_FAILURE_KEY, "");
}

/** True when the failure is recent enough to still describe the provider's current state. */
export function failureIsCurrent(f: LlmFailure | null, now: Date = new Date()): boolean {
  if (!f) return false;
  const at = Date.parse(f.at);
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age < FAILURE_WINDOW_MS;
}
