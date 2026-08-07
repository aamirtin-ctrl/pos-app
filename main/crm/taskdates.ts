// Giving undated work a real day, with judgement when the rules alone cannot.
//
// Owner ask 2026-08-06: "the google tasks populated by the app are not dated. everything needs
// to be on a certain day. this might require Gemini and that's fine."
//
// The deterministic vocabulary (parseWindow, weekdays, "next week", "the 10th"…) resolves the
// overwhelming majority of what people actually say. What is left after that pass is text with
// no date-shaped words in it at all — "spend another night in Como", "put the coolers on top
// of the garage cupboard" — where there is nothing left to parse, only something to JUDGE. That
// is exactly the kind of call the deterministic rules were built to stay out of and the model
// is good at.
//
// This does not relax "never default to today" (owner directive, 2026-08-05) — it replaces a
// BLIND default with a REASONED one. The prompt is explicit that today is the wrong answer
// unless the text itself says so, which the deterministic pass would already have caught if it
// did.

import type { Db } from "../db/db.ts";
import type { LlmClient } from "../llm/provider.ts";
import { extractJson } from "../llm/provider.ts";
import { contextBlock } from "../context.ts";
import { preferencesBlock, resolvePreferencesDir } from "../preferences.ts";

/** How many undated tasks one pass will date — bounded so a backlog costs one call, not N. */
export const TASK_DATE_BATCH = 20;

interface UndatedTask {
  id: number;
  title: string;
  notes: string | null;
  createdAt: string;
}

function buildPrompt(rows: UndatedTask[], about: string, prefs: string, todayISO: string): string {
  const lines = rows
    .map((r) => `${r.id}. "${r.title}"${r.notes ? ` — ${r.notes}` : ""} (added ${r.createdAt.slice(0, 10)})`)
    .join("\n");
  return `${about ? `${about}\n\n` : ""}${prefs ? `${prefs}\n\n` : ""}Today is ${todayISO}. Each numbered item below is real work with NO date attached — nothing in its own wording named one, so a person has to use judgement about when it makes sense.

For each item, pick the single day it should happen. Rules:
- NEVER pick today unless the item is plainly urgent (something breaking, a same-day deadline implied by the content). Defaulting to today out of laziness is the exact mistake to avoid.
- Prefer a day within the next 7 days when nothing in the content suggests otherwise — do not reach for next month on a whim.
- Personal/errand items ("put the coolers away", "spend another night somewhere") belong on a light day, not stacked onto a day that already sounds busy from its own wording — you cannot see his calendar, so just avoid Monday-morning-shaped days for pure errands when a weekend reads more naturally.
- If genuinely nothing distinguishes one day from another, say so with "confidence" below 0.5 rather than picking arbitrarily and sounding certain.

Return STRICT JSON only — a bare array, no prose, no markdown fences:
[{ "n": <the number above>, "date": "YYYY-MM-DD", "confidence": <0-1> }]

ITEMS:
${lines}`;
}

export interface TaskDateResult {
  dated: number;
  skipped?: "llm_unavailable" | "empty" | "bad_response";
}

/**
 * Date every undated, schedulable task the deterministic pass could not resolve. One batched
 * call for up to TASK_DATE_BATCH tasks — never one call per task (owner directive on AI-call
 * efficiency, 2026-08-06 earlier). Only ever fills a NULL plan_date; never overwrites a day the
 * owner or the deterministic parse already decided.
 */
export async function dateUndatedTasks(
  db: Db,
  llm: LlmClient | null,
  now: Date = new Date()
): Promise<TaskDateResult> {
  if (!llm) return { dated: 0, skipped: "llm_unavailable" };
  const rows = db
    .prepare(
      `SELECT id, title, notes, created_at AS createdAt FROM task
        WHERE plan_date IS NULL AND status IN ('inbox','planned','in_progress')
        ORDER BY id LIMIT ?`
    )
    .all(TASK_DATE_BATCH) as UndatedTask[];
  if (rows.length === 0) return { dated: 0, skipped: "empty" };

  const todayISO = now.toISOString().slice(0, 10);
  const about = contextBlock(db);
  let prefs = "";
  try {
    prefs = preferencesBlock(resolvePreferencesDir());
  } catch {
    /* no preferences file — proceed without it */
  }

  const res = await llm.call("task-dates", "fast", buildPrompt(rows, about, prefs, todayISO), { json: true });
  if (!res) return { dated: 0, skipped: "llm_unavailable" };

  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch {
    return { dated: 0, skipped: "bad_response" };
  }
  if (!Array.isArray(parsed)) return { dated: 0, skipped: "bad_response" };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const set = db.prepare("UPDATE task SET plan_date = ? WHERE id = ? AND plan_date IS NULL");
  let dated = 0;
  for (const item of parsed as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const n = Number(item.n);
    if (!byId.has(n)) continue;
    const date = typeof item.date === "string" ? item.date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // The one rule the model is not trusted to override: never land on the day already gone.
    if (date < todayISO) continue;
    set.run(date, n);
    dated++;
  }
  if (dated > 0) console.log(`taskdates: gave ${dated} undated task(s) a day`);
  return { dated };
}
