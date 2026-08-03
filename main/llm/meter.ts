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
