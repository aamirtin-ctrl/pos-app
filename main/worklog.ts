// Worklog memory — a terse, durable record of what the user actually did.
//
// Three writers:
//   - distillWeek: weekly LLM distillation (bio-mining style: 0-3 NOTABLE entries,
//     never invented) over completed tasks, accepted plan narrations, and the week's
//     braindumped tasks. Idempotent per ISO week via setting `worklog_distilled:<key>`.
//   - addManual: the sparkle box "log: …" intent (source 'manual').
//   - (nothing else — syncs never write here.)
//
// One reader beyond the UI: catchUpParagraph builds a "since we last talked" update
// for a contact, in the user's own channel voice, with a deterministic bullet-list
// fallback when no LLM is available.

import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { LlmClient } from "./llm/provider.ts";
import { extractJson } from "./llm/provider.ts";
import { CHANNEL_CATEGORY, getVoices } from "./crm/drafts.ts";

export interface WorklogEntry {
  id: number;
  happened_at: string;
  title: string;
  detail: string | null;
  source: string;
  created_at: string;
}

// ── idempotency key ──────────────────────────────────────────────────────────

/**
 * Setting key for one ISO-8601 week, e.g. "worklog_distilled:2026-W32".
 * ISO weeks run Mon-Sun; the year is the ISO week-year (Jan 1 can belong to the
 * previous year's last week and vice versa).
 */
export function distillWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // nearest Thursday decides the week-year
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `worklog_distilled:${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── writers ──────────────────────────────────────────────────────────────────

/** Sparkle-box "log: …" → one manual entry, happened now. Returns the row id. */
export function addManual(db: Db, title: string): { id: number } {
  const t = title.trim();
  if (!t) throw new Error("empty worklog entry");
  const r = db
    .prepare("INSERT INTO worklog (happened_at, title, source) VALUES (datetime('now'), ?, 'manual')")
    .run(t.slice(0, 200));
  return { id: Number(r.lastInsertRowid) };
}

export interface DistillResult {
  inserted: number;
  /** Non-error reason nothing happened: 'already-distilled' | 'no-llm' | 'no-activity' | 'llm-failed'. */
  skipped: string | null;
}

/**
 * Distill the last 7 days into 0-3 NOTABLE worklog entries (source 'auto').
 * Idempotent per ISO week: the setting `worklog_distilled:<year-week>` is written
 * once distillation succeeds (including a legitimate empty result), so re-runs
 * within the same week are no-ops. Without an LLM it skips WITHOUT marking the
 * week, so a later run with a key configured still catches up.
 */
export async function distillWeek(db: Db, llm: LlmClient | null): Promise<DistillResult> {
  const key = distillWeekKey();
  if (getSetting(db, key)) return { inserted: 0, skipped: "already-distilled" };
  if (!llm) return { inserted: 0, skipped: "no-llm" };

  const done = db
    .prepare(
      `SELECT title, block_type, completed_at FROM task
       WHERE status = 'done' AND completed_at IS NOT NULL
         AND datetime(completed_at) >= datetime('now', '-7 days')
       ORDER BY completed_at DESC LIMIT 60`
    )
    .all() as { title: string; block_type: string; completed_at: string }[];
  const narrations = db
    .prepare(
      `SELECT plan_date, narration FROM plan
       WHERE accepted_at IS NOT NULL AND narration IS NOT NULL
         AND datetime(accepted_at) >= datetime('now', '-7 days')
       ORDER BY plan_date DESC LIMIT 7`
    )
    .all() as { plan_date: string; narration: string }[];
  const braindumped = db
    .prepare(
      `SELECT title FROM task
       WHERE datetime(created_at) >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 60`
    )
    .all() as { title: string }[];

  if (done.length === 0 && narrations.length === 0 && braindumped.length === 0) {
    setSetting(db, key, new Date().toISOString());
    return { inserted: 0, skipped: "no-activity" };
  }

  const prompt = `You distill one week of a person's work activity into their durable worklog — terse, factual memory in the bio-mining style.
Extract 0-3 NOTABLE entries only: shipped things, decisions made, milestones hit, meaningful progress. Skip routine chores, vague intentions, and anything not clearly evidenced below. NEVER invent facts, names, numbers, or outcomes. Titles are terse (max 10 words); detail is one optional short line of context.
Return STRICT JSON ONLY — an array, possibly empty:
[{"title":"<terse durable fact>","detail":"<optional one-line context>"}]

COMPLETED TASKS (last 7 days):
${done.map((t) => `- [${t.block_type}] ${t.title} (${t.completed_at.slice(0, 10)})`).join("\n") || "(none)"}

ACCEPTED PLAN NARRATIONS:
${narrations.map((n) => `- ${n.plan_date}: ${n.narration.slice(0, 200)}`).join("\n") || "(none)"}

TASKS BRAINDUMPED THIS WEEK (any status):
${braindumped.map((t) => `- ${t.title}`).join("\n") || "(none)"}`;

  const res = await llm.call("worklog_distill", "fast", prompt, { json: true });
  if (!res) return { inserted: 0, skipped: "llm-failed" }; // key not set — retry next run

  let inserted = 0;
  try {
    const parsed = extractJson(res.text);
    if (Array.isArray(parsed)) {
      const ins = db.prepare(
        "INSERT INTO worklog (happened_at, title, detail, source) VALUES (datetime('now'), ?, ?, 'auto')"
      );
      for (const item of parsed.slice(0, 3)) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const title = typeof o.title === "string" ? o.title.trim() : "";
        if (!title) continue;
        const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim().slice(0, 300) : null;
        ins.run(title.slice(0, 200), detail);
        inserted++;
      }
    }
  } catch (e) {
    console.warn(`worklog: bad distill JSON (${(e as Error).message})`);
    return { inserted: 0, skipped: "llm-failed" };
  }
  setSetting(db, key, new Date().toISOString());
  return { inserted, skipped: null };
}

// ── readers ──────────────────────────────────────────────────────────────────

/**
 * Entries at or after `sinceISO`, newest first. datetime() on both sides so the
 * "YYYY-MM-DD HH:MM:SS" rows compare correctly against ISO "T" timestamps.
 */
export function entriesSince(db: Db, sinceISO: string): WorklogEntry[] {
  return db
    .prepare(
      `SELECT * FROM worklog WHERE datetime(happened_at) >= datetime(?)
       ORDER BY datetime(happened_at) DESC, id DESC`
    )
    .all(sinceISO) as WorklogEntry[];
}

export interface CatchUpResult {
  paragraph: string;
  entries: WorklogEntry[];
  usedLlm: boolean;
  /** Voice category the paragraph was written in (email | text | linkedin | slack). */
  channel: string;
}

/**
 * "Since we last talked" update for one contact: worklog entries since their
 * last_contact_at (fallback: 90 days), written first-person in the user's voice
 * for the channel they most recently used with this person. No greeting, no
 * signoff, no invented facts. Deterministic fallback = bullet list of entries.
 */
export async function catchUpParagraph(
  db: Db,
  llm: LlmClient | null,
  personId: number
): Promise<CatchUpResult> {
  const p = db
    .prepare("SELECT id, display_name, last_contact_at FROM person WHERE id = ?")
    .get(personId) as { id: number; display_name: string; last_contact_at: string | null } | undefined;
  if (!p) throw new Error("person not found");

  const since =
    p.last_contact_at ?? new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString().slice(0, 19);
  const entries = entriesSince(db, since);

  const lastChannel = (
    db
      .prepare(
        "SELECT channel FROM interaction WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 1"
      )
      .get(personId) as { channel: string } | undefined
  )?.channel;
  const category = CHANNEL_CATEGORY[lastChannel ?? ""] ?? "email";
  const voice = getVoices(db)[category];

  const fallback =
    entries.length === 0
      ? "Nothing notable in the worklog since you last talked."
      : entries.map((e) => `- ${e.title}${e.detail ? ` — ${e.detail}` : ""}`).join("\n");

  if (!llm || entries.length === 0) {
    return { paragraph: fallback, entries, usedLlm: false, channel: category };
  }

  const res = await llm.call(
    "worklog_catchup",
    "smart",
    `Write a 60-120 word "since we last talked" update FROM the user TO ${p.display_name}, first person, in the user's ${category} voice.
VOICE: tone "${voice?.tone ?? "warm, direct"}"; quirks: ${voice?.notes?.join("; ") || "none"}.
Rules: no greeting, no signoff, no invented facts — only what the worklog below says. Natural prose, not a list. Plain text only.
WORKLOG SINCE ${since.slice(0, 10)}:
${entries.map((e) => `- ${e.happened_at.slice(0, 10)}: ${e.title}${e.detail ? ` — ${e.detail}` : ""}`).join("\n")}`,
    { maxTokens: 300 }
  );
  if (res?.text.trim()) return { paragraph: res.text.trim(), entries, usedLlm: true, channel: category };
  return { paragraph: fallback, entries, usedLlm: false, channel: category };
}
