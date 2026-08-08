// Stage 2 (§5.5) — LLM (fast tier). Parses a free-text braindump into typed tasks.
// The prompt FORBIDS time assignment: the LLM decides WHAT a task is, never WHEN.
// Buffers are applied in code after parsing, not in the prompt.
// Degrades to a deterministic keyword parser when the LLM is unavailable.

import { todayISO } from "../dates.ts";
import { BLOCK_DEFAULTS, BLOCK_TYPES, bufferedMinutes, type BlockType, type Doctrine } from "./doctrine.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { parseWhen } from "../crm/when.ts";

export interface ParsedTask {
  title: string;
  blockType: BlockType;
  cognitiveLoad: number;
  rawEstimateMinutes: number;
  estimatedMinutes: number; // buffered, ceil-15
  isMit: boolean;
  hardDeadlineAt: string | null; // ISO, resolved by caller against plan date
  personHint: string | null;
  splittable: boolean;
  estimateSource: "stated" | "inferred";
  reasoning: string;
  /**
   * The LAST day this work may be scheduled on (ISO date), or null. Only ever set together
   * with `flexible` — see parseWindow. The caller persists it as task.window_end, which is
   * the engine's licence to move the task to a later day inside the window.
   */
  windowEnd: string | null;
  /** First day the window opens ("next week" → next Monday), or null = immediately. */
  windowStart: string | null;
  /** Part of the day he named ("tonight", "this morning"), or null. */
  dayPart: DayPart | null;
  /**
   * "This happens every day", not just today (owner ask 2026-08-06: "I need time to workout
   * and gym everyday… it should have realized this is a preference and add it into my
   * calendars"). 'daily' when the text says so; null for the overwhelming majority — a plain
   * one-off task, exactly as before.
   */
  recurrence: "daily" | null;
  /**
   * True when the user said the work can happen ACROSS a range ("this week", "by Friday",
   * "no rush") rather than on one named day. A specific day is `false` with `windowEnd`
   * still carrying that day, so the caller can tell "Thursday" from "any day up to Thursday"
   * and only writes window_end for the latter.
   */
  flexible: boolean;
}

// ── deadline windows (owner report 2026-08-06) ───────────────────────────────
//
// "maybe about two hours in total to go through my Stanford academic advising stuff — I could
// do this the rest of the week, it doesn't have to be today."
//
// That sentence carried a WINDOW, and every word of it used to be thrown away: the task was
// pinned to the day it was captured, so the next morning it competed with a math test that
// genuinely had to be that day. The window is now parsed — by the model when there is one,
// and by these rules when there is not.

const DAY_MS = 86_400_000;
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const utcMidnight = (dateISO: string) => new Date(`${dateISO}T00:00:00Z`);
/** Next occurrence of weekday `target` (0=Sun..6=Sat) ON OR AFTER `from`. */
const onOrAfterWeekday = (from: Date, target: number) =>
  addDays(from, (target - from.getUTCDay() + 7) % 7);

/** The Sunday that closes the current week — today, when today IS Sunday. */
export const endOfThisWeek = (refISO: string) => isoOf(onOrAfterWeekday(utcMidnight(refISO), 0));

/**
 * Part of the day the work belongs in, when the text names one.
 *
 * Owner report 2026-08-06: "the one that I said for tonight is in the afternoon and not in the
 * night." He said "tonight" and the solver placed it at 14:00, because nothing in a parsed
 * task could express a time of day at all — only a duration and a date. The energy curve then
 * picked whatever slot scored best, which is exactly right when no preference was stated and
 * exactly wrong when one was.
 */
export type DayPart = "morning" | "afternoon" | "evening";

// "30 mins A day" carries the same standing commitment as "every day" — the duration in
// front is what separates it from "spend a day in Como" (owner miss 2026-08-07: "can u
// dedicate 30 mins a day to learning agentic coding" was filed as a note).
const RECURRENCE_PATTERN =
  /\bevery\s*day\b|\beveryday\b|\bdaily\b|\beach day\b|(?:mins?|minutes?|h(?:ou)?rs?)\s+(?:a|per|each)\s+day\b/i;
export function parseRecurrence(text: string): "daily" | null {
  return RECURRENCE_PATTERN.test(text ?? "") ? "daily" : null;
}

// Order matters: evening checked first so "tomorrow night" wins over any stray match, and the
// patterns are deliberately BARE nouns with word boundaries — "Thursday evening", "late
// afternoon" and "tomorrow morning" must all hit, which anchored phrases like "this evening"
// missed (owner ask 2026-08-06: expand the keyword dataset the no-model path acts on).
const DAY_PART_PATTERNS: [RegExp, DayPart][] = [
  [/\btonight\b|\btonite\b|\bevenings?\b|\bnights?\b|\bafter dinner\b|\bbefore bed\b|\bafter work\b/i, "evening"],
  [/\bafternoons?\b|\bafter lunch\b|\bat noon\b|\baround noon\b|\bmid-?day\b/i, "afternoon"],
  // "(?<!good )" keeps "good morning" — the digest greeting and half his Alexa emails — from
  // marking everything he says at 7am as morning work.
  [/(?<!good )\bmornings?\b|\bfirst thing\b|\bbefore (?:noon|lunch)\b|\bwhen i wake\b/i, "morning"],
];

/** The part of the day the text names, or null when it names none. */
export function parseDayPart(text: string): DayPart | null {
  const t = text ?? "";
  for (const [re, part] of DAY_PART_PATTERNS) if (re.test(t)) return part;
  return null;
}

/** Minutes-since-midnight bounds for a day part. Soft in spirit, hard in the grid. */
export const DAY_PART_BOUNDS: Record<DayPart, { earliest: number; latest: number }> = {
  morning: { earliest: 0, latest: 12 * 60 },
  afternoon: { earliest: 12 * 60, latest: 17 * 60 },
  evening: { earliest: 17 * 60, latest: 24 * 60 },
};

export interface ParsedWindow {
  /** Last day the work may happen (ISO date), or null when the text names no timeframe. */
  windowEnd: string | null;
  /**
   * FIRST day the work may happen, when the range does not start immediately: "next week"
   * opens next Monday, "this weekend" opens Saturday. Null = opens now (the old behavior,
   * and still the common case). Without this, "next week" work sat with window_start = today
   * and the reclaim pass could legally pull it into THIS week — the opposite of what he said.
   */
  windowStart?: string | null;
  /** True when the text named a RANGE; false when it named one specific day. */
  flexible: boolean;
}

const NO_WINDOW: ParsedWindow = { windowEnd: null, flexible: false };

const WEEKDAYS_FULL = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const WEEKDAYS_ABBR = "mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun";

/**
 * Deterministic window extraction — no LLM. Used as the fallback when the model omits the
 * field, and as the whole answer on the no-LLM path.
 *
 * The distinction that matters is RANGE vs DAY, not "is there a date":
 *   "this week" / "rest of the week"      → the coming Sunday, flexible
 *   "next week"                           → the Sunday after that, flexible
 *   "by Friday" / "before Thursday"       → that weekday, flexible
 *   "today" / "tomorrow"                  → that exact day, NOT flexible
 *
 * A non-flexible result is deliberately still returned with its date: the caller needs to be
 * able to tell "Thursday" from "any day up to Thursday", and only the second one earns a
 * window_end (see the migration-9 invariant).
 */
export function parseWindow(text: string, refISO: string): ParsedWindow {
  if (!text) return NO_WINDOW;
  const low = text.toLowerCase();
  const ref = utcMidnight(refISO);
  if (Number.isNaN(ref.getTime())) return NO_WINDOW;

  // "it doesn't have to be today" is the owner's own phrasing and it contains the word
  // "today" — read naively it pins the task to the one day he explicitly ruled out. The
  // negation is checked FIRST for that reason, and it is itself a flexibility signal.
  const negatesToday =
    /\b(?:does\s?n[o']?t|do\s?n[o']?t|need\s?n[o']?t|doesnt|dont)\b[^.]{0,20}\btoday\b/.test(low) ||
    /\bnot\s+(?:necessarily\s+)?today\b/.test(low);

  // ── one named day: a commitment, not a window ──
  // "day after tomorrow" contains "tomorrow" and must be read first.
  if (/\b(?:the\s+)?day after tomorrow\b/.test(low)) return { windowEnd: isoOf(addDays(ref, 2)), flexible: false };
  if (!negatesToday && /\btoday\b|\btonight\b|\btonite\b/.test(low)) return { windowEnd: refISO, flexible: false };
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(low)) return { windowEnd: isoOf(addDays(ref, 1)), flexible: false };

  // ── "by <weekday>" — a deadline, and everything before it is fair game ──
  // Checked before "next week" so "by next Friday" resolves to the Friday, not the Sunday.
  const wd = low.match(/\b(?:by|before|due|until|til|till)\s+((?:this|next)\s+)?(mon|tue|wed|thu|fri|sat|sun)(?:day|nesday|rsday|urday)?\b/);
  if (wd) {
    // crm/when.ts already owns weekday resolution (including the "next" offset) — reuse it
    // rather than keeping a second copy of the same arithmetic.
    const d = parseWhen(`${wd[1] ?? ""}${wd[2]}`, ref);
    if (d) return { windowEnd: isoOf(d), flexible: true };
  }

  // ── a named weekday: "next Thursday", "on Friday", bare "Wednesday" ──
  //
  // Owner ask 2026-08-06, after a day of these being dropped: "references to later weeks or
  // days of later weeks, like next Thursday, next Wednesday, etcetera." A weekday is a
  // commitment to a day, exactly like "tomorrow" — non-flexible, so braindump pins plan_date
  // to it and the engine may not shuffle it. crm/when.ts owns the arithmetic (including the
  // "next" offset); abbreviations require a preposition so "sat down" is never Saturday.
  const nextWd = low.match(new RegExp(`\\bnext\\s+(${WEEKDAYS_FULL}|${WEEKDAYS_ABBR})\\b`));
  if (nextWd) {
    const d = parseWhen(`next ${nextWd[1]}`, ref);
    if (d) return { windowEnd: isoOf(d), flexible: false };
  }
  const bareWd =
    low.match(new RegExp(`\\b(?:on|this|by)?\\s*(${WEEKDAYS_FULL})\\b`)) ??
    low.match(new RegExp(`\\b(?:on|this)\\s+(${WEEKDAYS_ABBR})\\b`));
  if (bareWd) {
    const d = parseWhen(bareWd[1], ref);
    if (d) return { windowEnd: isoOf(d), flexible: false };
  }

  // ── absolute dates: "August 10", "the 12th", "8/10" ──
  if (new RegExp(`\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b`).test(low)) {
    const d = parseWhen(low, ref);
    if (d) return { windowEnd: isoOf(d), flexible: false };
  }
  const ordinal = low.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal) {
    const dayN = parseInt(ordinal[1], 10);
    if (dayN >= 1 && dayN <= 31) {
      let cand = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), dayN));
      if (cand.getTime() < ref.getTime()) cand = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, dayN));
      // A 31st in a 30-day month rolls over silently — refuse rather than land on the 1st.
      if (cand.getUTCDate() === dayN) return { windowEnd: isoOf(cand), flexible: false };
    }
  }
  const slashDate = low.match(/\b(\d{1,2})\/(\d{1,2})\b(?!\s*(?:hour|hr|h\b))/);
  if (slashDate) {
    const m = parseInt(slashDate[1], 10), dayN = parseInt(slashDate[2], 10);
    if (m >= 1 && m <= 12 && dayN >= 1 && dayN <= 31) {
      let cand = new Date(Date.UTC(ref.getUTCFullYear(), m - 1, dayN));
      if (cand.getTime() < ref.getTime()) cand = new Date(Date.UTC(ref.getUTCFullYear() + 1, m - 1, dayN));
      if (cand.getUTCDate() === dayN) return { windowEnd: isoOf(cand), flexible: false };
    }
  }

  // ── "in N days / a week / two weeks": a point that far out ──
  const inDays = low.match(/\bin\s+(\d{1,2}|a couple(?: of)?|a few)\s+days?\b/);
  if (inDays && !/\bthe next\b/.test(low)) {
    const n = /^\d+$/.test(inDays[1]) ? Math.min(60, parseInt(inDays[1], 10)) : inDays[1].startsWith("a couple") ? 2 : 3;
    return { windowEnd: isoOf(addDays(ref, n)), flexible: false };
  }
  const inWeeks = low.match(/\bin\s+(a|one|two|three|four|\d{1,2})\s+weeks?\b/);
  if (inWeeks) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4 };
    const n = words[inWeeks[1]] ?? Math.min(8, parseInt(inWeeks[1], 10) || 1);
    return { windowEnd: isoOf(addDays(ref, 7 * n)), flexible: false };
  }

  // ── "this weekend": a RANGE that does not open until Saturday ──
  if (/\b(?:this|the|over the)\s+weekend\b/.test(low)) {
    const sat = onOrAfterWeekday(ref, 6);
    const sun = onOrAfterWeekday(sat, 0);
    return { windowStart: isoOf(sat), windowEnd: isoOf(sun), flexible: true };
  }

  // ── "end of the month": everything left in it ──
  if (/\bend of (?:the |this )?month\b/.test(low)) {
    const last = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
    return { windowEnd: isoOf(last), flexible: true };
  }

  if (/\bnext week\b/.test(low)) {
    // Opens next Monday — without windowStart the reclaim pass could pull it into THIS week.
    const nextMon = addDays(utcMidnight(endOfThisWeek(refISO)), 1);
    return { windowStart: isoOf(nextMon), windowEnd: isoOf(addDays(utcMidnight(endOfThisWeek(refISO)), 7)), flexible: true };
  }
  if (/\b(?:this|the) week\b|\b(?:rest|remainder|balance) of (?:this |the )?week\b|\ball week\b/.test(low)) {
    return { windowEnd: endOfThisWeek(refISO), flexible: true };
  }
  if (/\bbefore the weekend\b|\bby the weekend\b/.test(low)) {
    return { windowEnd: isoOf(onOrAfterWeekday(ref, 5)), flexible: true }; // Friday
  }
  const nextN = low.match(/\b(?:over|in|within) the next (\d{1,2}|few|couple(?: of)?) days?\b/);
  if (nextN) {
    const n = /^\d+$/.test(nextN[1]) ? Math.min(60, parseInt(nextN[1], 10)) : 3;
    return { windowEnd: isoOf(addDays(ref, n)), flexible: true };
  }
  // Slack with no stated edge. The week is the smallest honest bound we can put on it.
  if (/\bno rush\b|\bno hurry\b|\bwhenever\b|\bany ?time\b|\bsometime\b|\beventually\b|\bat some point\b|\bwhen i (?:get|have) (?:a )?chance\b|\bdoesn'?t have to be today\b|\bnot urgent\b/.test(low)) {
    return { windowEnd: endOfThisWeek(refISO), flexible: true };
  }
  return NO_WINDOW;
}

/** ISO date, or null. Defensive: the model is free to return anything. */
function coerceIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : s;
}

/** The date table the parse prompt carries, so the model never does calendar math itself. */
export function windowDateReference(refISO: string): string {
  const ref = utcMidnight(refISO);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = addDays(ref, i);
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    days.push(`${names[d.getUTCDay()]}=${isoOf(d)}${tag}`);
  }
  const thisWeek = endOfThisWeek(refISO);
  return (
    `${days.join(", ")} | end of THIS week (the coming Sunday) = ${thisWeek}` +
    ` | end of NEXT week = ${isoOf(addDays(utcMidnight(thisWeek), 7))}`
  );
}

const PARSE_PROMPT = (text: string, refISO: string) => `You classify tasks for a day planner. Parse the braindump below into a JSON array.

For each distinct task output exactly:
{
  "title": "<short imperative title>",
  "block_type": "<one of: deep_work | focused_work | admin | comms | meeting | gym | personal>",
  "cognitive_load": <1-5>,
  "raw_estimate_minutes": <integer>,
  "estimate_source": "stated" | "inferred",
  "is_mit": <true for the single most important task, at most one>,
  "hard_deadline_hhmm": "<HH:MM 24h today, ONLY if the text states a hard deadline, else null>",
  "window_end": "<YYYY-MM-DD, the LAST day this work may happen, else null>",
  "flexible": <true if the work may happen on ANY day up to window_end, false if it must be one named day>,
  "person_hint": "<a person's name if the task involves someone specific, else null>",
  "splittable": <true if the work can split across two sessions>,
  "reasoning": "<one line, for the audit trail>"
}

Classification guide: deep_work = creative/analytical, load 4-5, needs long focus (problem sets,
writing, coding, design). focused_work = load 3, under an hour of real focus. admin = load 1-2
chores (forms, email cleanup, booking). comms = replies/outreach. gym = exercise. personal = errands, social.

DEADLINE WINDOW — the difference between "on Thursday" and "any day up to Thursday":
- When the text says the work can happen across a RANGE — "this week", "the rest of the week",
  "by Friday", "over the next few days", "whenever", "no rush", "it doesn't have to be today" —
  set "window_end" to the LAST day of that range (from the DATE REFERENCE table) and "flexible": true.
- When the text names a SPECIFIC day — "today", "tomorrow", "Thursday", "at 3pm" — set "window_end"
  to that day and "flexible": false. The work happens that day; it is not movable.
- When the text says nothing about timing at all, "window_end" is null and "flexible" is false.
- Take every date from the DATE REFERENCE table exactly. Never do weekday math yourself.

WINDOW EXAMPLES:
- "maybe about two hours in total to go through my Stanford academic advising stuff — I could do this
  the rest of the week, it doesn't have to be today" → { "title": "Go through Stanford academic advising",
  "raw_estimate_minutes": 120, "estimate_source": "stated", "window_end": "<end of THIS week from the table>", "flexible": true }
- "two hours for a Stanford math test today" → { "title": "Stanford math test", "raw_estimate_minutes": 120,
  "estimate_source": "stated", "window_end": "<today from the table>", "flexible": false }
- "finish the grant draft by Friday" → { "window_end": "<that Friday from the table>", "flexible": true }
- "gym" → { "window_end": null, "flexible": false }

Rules:
- NEVER assign times of day, ordering, or schedule — that is not your job.
- If duration is unstated, estimate from the task type and set estimate_source "inferred".
- Long deep work is almost always splittable.
- Return STRICT JSON only: a bare array, no preamble, no markdown fences.

DATE REFERENCE (precomputed — use these exact dates):
${windowDateReference(refISO)}

BRAINDUMP:
"""${text.slice(0, 4000)}"""`;

export async function parseBraindump(
  text: string,
  doctrine: Doctrine,
  llm: LlmClient | null,
  /** The day being planned — the anchor every relative window phrase resolves against. */
  refISO: string = todayISO()
): Promise<{ tasks: ParsedTask[]; usedLlm: boolean }> {
  if (llm) {
    const res = await llm.call("plan_parse", "fast", PARSE_PROMPT(text, refISO), { json: true });
    if (res) {
      try {
        const raw = extractJson(res.text);
        const tasks = coerce(raw, doctrine, text, refISO);
        if (tasks.length > 0) return { tasks, usedLlm: true };
      } catch (e) {
        console.warn(`parseBraindump: bad LLM output (${(e as Error).message}); falling back`);
      }
    }
  }
  return { tasks: deterministicParse(text, doctrine, refISO), usedLlm: false };
}

/**
 * The braindump split into the fragments a single task can come from — the same split the
 * deterministic parser uses, so both paths agree on what "the sentence this task came from"
 * means.
 */
function segmentsOf(text: string): string[] {
  return text
    .split(/\n|;|(?<!\d),(?!\d)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

const STOPWORDS = new Set([
  "about", "after", "again", "have", "into", "over", "some", "than", "that", "them", "then",
  "this", "very", "week", "with", "your", "from", "just", "need", "work", "time", "today",
  "stuff", "thing", "things", "make", "take", "todo", "task", "tasks", "through", "going",
]);

/**
 * Which fragment of the braindump did this task come from? The model rewrites titles, so the
 * only durable join is shared distinctive words. Requires at least one, and prefers the
 * fragment sharing the most — a task the match cannot be made for simply gets no fallback
 * window, which is exactly the old behavior.
 */
function sourceSegment(title: string, segments: string[]): string | null {
  const words = new Set(
    title.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? []
  );
  if (words.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const s of segments) {
    const low = s.toLowerCase();
    let score = 0;
    for (const w of words) if (low.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    } // ties → the earlier fragment
  }
  return best;
}

function coerce(raw: unknown, doctrine: Doctrine, text: string, refISO: string): ParsedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedTask[] = [];
  const segments = segmentsOf(text);
  let mitSeen = false;
  for (const r of raw as Record<string, unknown>[]) {
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue;
    const btRaw = typeof r.block_type === "string" ? r.block_type : "focused_work";
    const blockType = (BLOCK_TYPES as readonly string[]).includes(btRaw) ? (btRaw as BlockType) : "focused_work";
    const load = clampInt(r.cognitive_load, 1, 5, BLOCK_DEFAULTS[blockType].load || 3);
    const rawEst = clampInt(r.raw_estimate_minutes, 5, 12 * 60, BLOCK_DEFAULTS[blockType].minutes);
    const isMit = r.is_mit === true && !mitSeen;
    if (isMit) mitSeen = true;
    const hhmm = typeof r.hard_deadline_hhmm === "string" && /^\d{2}:\d{2}$/.test(r.hard_deadline_hhmm)
      ? r.hard_deadline_hhmm
      : null;
    // The model's window if it gave one; otherwise re-read the fragment this task came from
    // with the deterministic rules. A model that simply omits the field must not cost the
    // owner the behavior — "the rest of the week" is legible without an LLM.
    const modelEnd = coerceIsoDate(r.window_end);
    const window: ParsedWindow = modelEnd
      ? { windowEnd: modelEnd, flexible: r.flexible === true }
      : parseWindow(sourceSegment(title, segments) ?? "", refISO);
    out.push({
      title,
      blockType,
      cognitiveLoad: load,
      rawEstimateMinutes: rawEst,
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst, r.estimate_source === "stated" ? "stated" : "inferred"),
      isMit,
      hardDeadlineAt: hhmm,
      personHint: typeof r.person_hint === "string" && r.person_hint.trim() ? r.person_hint.trim() : null,
      splittable: r.splittable === true,
      estimateSource: r.estimate_source === "stated" ? "stated" : "inferred",
      reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
      windowEnd: window.windowEnd,
      windowStart: window.windowStart ?? null,
      flexible: window.flexible,
      // Read from the owner's own words, not from the model: "tonight" is unambiguous and a
      // model that omits it should not cost him the constraint.
      dayPart: parseDayPart(sourceSegment(title, segments) ?? text),
      recurrence: parseRecurrence(sourceSegment(title, segments) ?? text),
    });
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ── spoken durations ─────────────────────────────────────────────────────────
//
// Owner report 2026-08-06: he said "maybe about like two hours in total to go through my
// Stanford academic advising stuff" and the planner budgeted 50 minutes. The estimate regex
// only ever matched DIGITS, and nobody speaking out loud says "2 hours" — they say two.

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fourty: 40, fifty: 50, sixty: 60, ninety: 90,
};
// Wrapped in a non-capturing group at the point of use is not enough — an alternation this
// long must carry its OWN grouping, or a suffix written after it binds to the last branch
// alone ("forty|five(?: …)?" reads "forty" OR "five with a suffix", so "forty five minutes"
// matched just "five" and produced 5).
const NUM_WORD_RE = `(?:${Object.keys(NUMBER_WORDS).join("|")})`;
/** Tens+units as spoken: "forty five", "twenty two". */
const NUM_PHRASE_RE = `${NUM_WORD_RE}(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?`;
/** Every way an hour is written or said: "2h", "2 hr", "2hrs", "two hours". */
const HOUR_UNIT_RE = `(?:hours?|hrs?|h)`;

/**
 * A written number, INCLUDING the leading-dot form. "\\b\\d+(?:\\.\\d+)?" cannot match ".5",
 * so ".5 hours" matched only the 5 and became FIVE HOURS — a ten-fold error on a duration
 * people really do type (audited 2026-08-08). The lookbehind stops "1.5" being re-read as
 * ".5" and stops a version-like "1.5.5" contributing a second number.
 */
const DECIMAL_RE = `(?<![\\d.])(?:\\d+(?:\\.\\d+)?|\\.\\d+)`;

/** "forty five" → 45, "twenty" → 20, "2" → 2. Null when `w` names no number. */
function wordValue(w: string): number | null {
  const t = w.trim().toLowerCase().replace(/-/g, " ");
  // ".5" as well as "0.5" — the leading-dot form is what the duration regex now captures, and
  // rejecting it here would silently drop the whole duration (2026-08-08).
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) return parseFloat(t);
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  // "forty five" / "twenty two": tens + units, the way it is spoken.
  const m = t.match(/^(twenty|thirty|forty|fourty|fifty)\s+(one|two|three|four|five|six|seven|eight|nine)$/);
  if (m) return NUMBER_WORDS[m[1]] + NUMBER_WORDS[m[2]];
  return null;
}

/**
 * The duration the text actually STATES, in minutes, or null.
 *
 * Deliberately refuses clock times: "be back here at 5:30 latest" states a deadline, and
 * reading it as five and a half hours of work is exactly the class of junk task the owner
 * reported on 2026-08-05. A bare "5:30" is therefore never a duration.
 */
export function statedMinutes(text: string): number | null {
  if (!text) return null;
  const low = text.toLowerCase();

  // "an hour and a half", "two and a half hours" — checked first: the plain-hours rule below
  // would otherwise match the leading number and silently drop the half.
  const andHalf = low.match(
    new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUM_PHRASE_RE})\\s+(?:${HOUR_UNIT_RE}\\s+and\\s+a\\s+half|and\\s+a\\s+half\\s+${HOUR_UNIT_RE})\\b`)
  );
  if (andHalf) {
    const n = wordValue(andHalf[1]);
    if (n !== null) return Math.round(n * 60 + 30);
  }
  if (/\bhalf an hour\b|\bhalf hour\b|\bhalf-hour\b/.test(low)) return 30;
  if (new RegExp(`\\ba couple(?: of)? ${HOUR_UNIT_RE}\\b`).test(low)) return 120;
  if (new RegExp(`\\ba few ${HOUR_UNIT_RE}\\b`).test(low)) return 180;
  if (/\ba couple(?: of)? min(?:ute)?s?\b/.test(low)) return 10;

  // Hours and minutes are read TOGETHER and the EARLIEST one in the text wins.
  //
  // Checking hours first and returning on the first hit made unit precedence override word
  // order, which is not how anyone writes. "30 mins to edit insta and 1.25 hrs to gym" gave
  // the insta clause 75 minutes — the gym's duration — because the hours rule ran first and
  // never looked at where in the sentence each number actually sat. Segmentation should keep
  // two durations out of one segment, but when it cannot, the duration the sentence states
  // FIRST is the one attached to the work it is next to. (Owner-visible as the film/edit task
  // scheduled at the gym's length, 2026-08-07.)
  const hrs = low.match(new RegExp(`(${DECIMAL_RE}|\\b${NUM_PHRASE_RE})\\s*${HOUR_UNIT_RE}\\b`));
  const mins = low.match(new RegExp(`(${DECIMAL_RE}|\\b${NUM_PHRASE_RE})\\s*min(?:ute)?s?\\b`));
  const hrsVal = hrs ? wordValue(hrs[1]) : null;
  const minsVal = mins ? wordValue(mins[1]) : null;
  const hrsAt = hrs && hrsVal !== null ? hrs.index ?? Infinity : Infinity;
  const minsAt = mins && minsVal !== null ? mins.index ?? Infinity : Infinity;
  if (hrsAt === Infinity && minsAt === Infinity) return null;
  const stated = hrsAt <= minsAt ? Math.round((hrsVal as number) * 60) : Math.round(minsVal as number);
  return usableStatedMinutes(stated);
}

/**
 * A stated duration only counts when it describes a block a day could hold.
 *
 * "0 mins" is not a request for a zero-length block — it is a slip or a stray number, and
 * treating it as stated wrote raw 0 / estimated 0 onto the task while the solver quietly
 * gave it a 15-minute floor anyway, so the card and the calendar disagreed. Returning null
 * hands it to the block-type default instead, which is what "he did not really say" means
 * everywhere else in this parser.
 *
 * The ceiling is a day. Anything past that cannot be scheduled on a 1440-minute grid however
 * the solver is asked, so a typo ("9999 hours" → 599,940 minutes) would otherwise sit in the
 * database and the UI as a number nobody can act on. Clamping keeps it honest AND schedulable
 * -adjacent: it still reports unplaced, but for a legible reason.
 */
export function usableStatedMinutes(minutes: number | null): number | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(minutes, 1440);
}

// ── one sentence is one task ─────────────────────────────────────────────────
//
// Owner report 2026-08-06, verbatim: "that time later this week and maybe about, like, two
// hours in total — both those events should be the same event, they stem from the same task
// that I'm trying to do."
//
// He had said ONE sentence: "Set time later this week, maybe about like two hours in total to
// go through my Stanford academic advising stuff." Splitting on every comma turned the leading
// clause into a task of its own — and that clause describes no work at all, only WHEN some
// other work should happen. So his planner showed "Set time later this week" and "maybe about
// like two hours…" as two independent 75-minute commitments, and his actual math test, which
// did have to be that day, lost the contest for those hours.
//
// The rule: a fragment that names no work is not a task, it is a modifier. It merges into the
// fragment it modifies — forward by default (the clause introduces what follows), backward
// when it trails. A sentence that is PURELY scheduling produces nothing at all.

/** Words that describe scheduling rather than work; invisible when deciding "is this a task?". */
const SCHEDULING_WORDS = new Set([
  "set", "find", "block", "carve", "make", "reserve", "schedule", "put", "aside", "out",
  "time", "later", "this", "that", "next", "week", "weekend", "today", "tomorrow", "tonight",
  "morning", "afternoon", "evening", "night", "day", "days", "hour", "hours", "hrs", "min",
  "mins", "minute", "minutes", "sometime", "anytime", "whenever", "rush", "urgent", "total",
  "about", "around", "maybe", "like", "some", "the", "and", "for", "need", "want", "have",
  "gonna", "going", "will", "can", "could", "should", "would", "just", "really", "half",
  "couple", "few", "rest", "remainder", "balance", "all", "any", "more", "bit",
  // Temporal nouns: a fragment made only of these ("next Thursday", "tomorrow evening") is a
  // modifier for the work beside it, never a task of its own. Weekdays were missing, which is
  // how "next Thursday" could have become its own 75-minute to-do.
  "tomorrow", "tonight", "tonite", "yesterday", "noon", "midday", "evening", "afternoon",
  "night", "weekend", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  "sunday", "early", "late", "sometime", "eventually",
  // Recurrence language is scheduling, not work. "…and 1.25 hrs to gym everyday" left a bare
  // "everyday" behind once the gym was lifted out, and it became its own 75-minute task
  // (2026-08-07). parseRecurrence still reads these off the segment; they just cannot BE one.
  "everyday", "every", "daily", "each", "weekly", "always", "usually", "regularly",
  ...Object.keys(NUMBER_WORDS),
]);

/** Does this fragment name any actual work, or only when work should happen? */
/**
 * Grammar with no content: pronouns, copulas, articles, bare prepositions. A fragment built
 * only from these plus scheduling words names nothing to do.
 *
 * SCHEDULING_WORDS alone was too thin a filter — it made "work" mean "any word I have not
 * listed", so "this can be whenever" became a 75-minute focused_work task purely because
 * "be" was missing from the list (owner-visible 2026-08-07: a trailing clause of his own
 * sentence turned into a phantom block, the same shape as the "Just woke up" phantom).
 * Listing every function word is whack-a-mole; the fix is to require a word that carries
 * MEANING, not merely one that is unlisted.
 */
const FUNCTION_WORDS = new Set([
  "be", "is", "am", "are", "was", "were", "been", "being", "do", "does", "did", "done",
  "it", "its", "he", "she", "they", "them", "we", "us", "you", "your", "his", "her", "their",
  "our", "my", "me", "mine", "myself", "who", "what", "which", "when", "where", "why", "how",
  "an", "of", "to", "on", "in", "at", "by", "with", "from", "into", "over", "up", "down",
  "if", "then", "than", "but", "or", "nor", "yet", "so", "as", "too", "also", "not", "no",
  "there", "here", "these", "those", "such", "very", "much", "many", "own", "same", "other",
  "get", "got", "getting", "let", "lets", "please", "ok", "okay", "yeah", "yes", "well",
  // Evaluative filler — the whole predicate of a throwaway clause ("it should be fine",
  // "that's cool"). A fragment whose only content-looking word is one of these describes a
  // feeling about the plan, not a thing to do. Safe because a real task needs just ONE other
  // substantive word: "fine tune the model" still keeps "tune" and "model".
  "fine", "good", "great", "cool", "alright", "ready", "easy", "hard", "quick", "soon",
  "sure", "right", "wrong", "bad", "better", "best", "nice",
]);

/**
 * Does this fragment name actual work? True only when it contains at least one word that is
 * neither scheduling language nor bare grammar — i.e. something a calendar card could be
 * about. A fragment that fails is a modifier for the work beside it, never a task.
 */
function namesWork(fragment: string): boolean {
  const words = fragment.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  return words.some((w) => !SCHEDULING_WORDS.has(w) && !FUNCTION_WORDS.has(w));
}

export interface WorkSegment {
  /** The clause naming the work — what the title is built from. */
  work: string;
  /** Work clause plus any scheduling clauses merged into it — what windows are read from. */
  full: string;
}

/**
 * Split a braindump into the fragments that are really tasks, each carrying the scheduling
 * language that belongs to it. Returns [] when nothing in the text names work.
 */
/**
 * Pull "gym"/"workout" out as its OWN segment when it is conjoined onto something else —
 * "post the video and 1.25 hrs for the gym" — before the general segmenter runs.
 *
 * Owner report 2026-08-06: his one sentence about filming AND the gym became three garbled
 * fragments, and the gym half was swallowed into "post insta video and for the gym" — never
 * scheduled at all. General "and"-list segmentation ("I need to film, edit, and post…") is
 * genuinely an LLM-shaped problem no regex will solve reliably, and the durable capture queue
 * now exists precisely to retry text like this once the model is back. But the gym specifically
 * is common enough, and important enough — it is its own doctrine block type with its own
 * sleep-floor rule — to earn one targeted rule regardless of what the model is doing.
 */
function extractGymFragment(text: string): { rest: string; gym: string | null } {
  // The connector between the duration and the word "gym" is whatever he happened to type:
  // "1.25 hrs TO gym", "45 min OF gym", "an hour AT the gym". Accepting only "for"/"the" left
  // the duration ungrabbed for the most common phrasing he actually uses, so the gym fragment
  // carried no duration of its own and inherited a neighbouring clause's instead — his gym
  // came out at the insta task's 30 minutes (2026-08-07).
  const m = text.match(
    /,?\s*(?:and\s+)?((?:\d+(?:\.\d+)?|an?|half an?|a\s+couple(?:\s+of)?)\s*(?:h(?:ou)?rs?|min(?:ute)?s?)\s*)?(?:(?:for|to|of|at|in)\s+)?(?:the\s+)?\b(?:gym|work\s*out|workout)\b/i
  );
  if (!m) return { rest: text, gym: null };
  const duration = (m[1] ?? "").trim();
  return { rest: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim(), gym: `${duration} gym`.trim() };
}

export function workSegments(text: string): WorkSegment[] {
  const { rest: preGym, gym } = extractGymFragment(text ?? "");
  const parts = (preGym ?? "")
    // Sentence boundaries split too. "Tonight I need to do research for Liatris. Tomorrow I
    // need to continue working on it." is two instructions with two different days, and
    // without this it is one task that takes the FIRST day it sees. The lookarounds keep
    // "2.5 hours" and "a.m." intact: only a period between a word and a capitalised word ends
    // a sentence here.
    // The " and " rule splits a conjoined instruction into its two halves. Two corrections,
    // both from real input (2026-08-07):
    //
    //   (?=[a-z0-9]) — it required a LETTER after "and", so "…30 mins to edit insta and
    //   1.25 hrs to gym" never split: the two clauses stayed fused, and the insta half was
    //   scheduled at the gym's duration. A digit starts a conjoined clause just as often.
    //
    //   (?!a\s+(?:half|quarter)\b) — "an hour and a half" was being split into "an hour" and
    //   "a half on the deck", turning one 90-minute intent into a 60-minute task PLUS a
    //   90-minute task, and "two and a half hours" into a severed "a half hours…" that lost
    //   its number entirely and fell back to a 50-minute default. "and a half" is part of the
    //   duration, never a conjunction.
    .split(
      /\n|;|(?<!\d),(?!\d)| and (?!a\s+(?:half|quarter)\b)(?=[a-z0-9])|(?<=[a-z0-9])\.\s+(?=[A-Z])/i
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  const segs: WorkSegment[] = [];
  let pending: string[] = []; // scheduling-only clauses waiting for the work they modify
  for (const p of parts) {
    if (!namesWork(p)) {
      pending.push(p);
      continue;
    }
    segs.push({ work: p, full: [...pending, p].join(", ") });
    pending = [];
  }
  // Trailing modifiers ("Draft the proposal, sometime this week") attach to the last task.
  if (pending.length > 0 && segs.length > 0) {
    const last = segs[segs.length - 1];
    last.full = [last.full, ...pending].join(", ");
  }
  // Gym goes back on as its own segment, carrying whatever scheduling language surrounded the
  // WHOLE sentence (so "everyday… gym" still reads as recurring, not just the film half).
  if (gym) segs.push({ work: gym, full: `${gym}, ${text}` });
  return segs;
}

/** Filler that survives speech-to-text and has no business on a calendar card. */
const TITLE_STRIP = [
  /^(?:and|so|then|also|um+|uh+)\b\s*/i,
  /^(?:i\s+)?(?:need|want|have|gotta|got)\s+to\s+/i,
  /^(?:i\s+)?(?:should|must|will|can|could|would|might)\s+/i,
  /^(?:maybe|about|around|like|roughly|approximately|probably)\s+/i,
  /^(?:set|find|block|carve|reserve|schedule)\s+(?:aside\s+|out\s+)?(?:some\s+)?time\s+(?:to|for)\s+/i,
  // Same scheduling verbs WITHOUT the word "time" — "slot 30 mins to edit insta" strips its
  // duration and was left titled "Slot to edit/film insta content".
  /^(?:slot|set|block|carve|reserve|schedule|spend|dedicate|allocate)\s+(?:aside\s+|out\s+)?(?:some\s+)?(?:to|for|on)\s+/i,
  /^(?:slot|carve|reserve|dedicate|allocate)\s+/i,
  // "spend 45 minutes DOING errands" loses its duration and is left as "Spend doing errands".
  /^(?:spend\s+)?(?:some\s+)?(?:time\s+)?doing\s+/i,
  /^spend\s+(?=\w)/i,
  /^(?:spend\s+)?(?:some\s+)?time\s+(?:to|for|on)\s+/i,
  /^in\s+total\s+/i,
  // Addressed-to-the-assistant phrasing: "can u dedicate 30 mins a day to learning agentic
  // coding" left a title of "U dedicate a day to learning agentic coding".
  /^(?:can\s+|could\s+|pls\s+|please\s+)?(?:u|you)\s+/i,
  // The recurrence remnant after "30 mins a day" loses its duration to the strip above.
  /^a\s+day\s+(?:to|for|on)\s+/i,
  /^to\s+(?=[a-z])/i,
  // A leading preposition is what is left when the duration in front of it is removed
  // ("45 minutes ON email" → "On email", "two and a half hours OF deep work" → "Of deep
  // work"). Last in the list so the more specific rules above get first refusal.
  /^(?:on|of|in|at|with|for)\s+(?=[a-z])/i,
];

/** Turn a spoken fragment into something readable on a calendar card. */
export function titleFromFragment(fragment: string): string {
  let t = fragment.trim();
  // Durations are captured as a number; repeating them in the title is noise.
  t = t
    // Compound forms FIRST, as a unit. Stripping "an hour" out of "an hour and a half" left
    // the orphan behind — "spend an hour and a half on the deck" titled a block "Spend and a
    // half on the deck" (2026-08-07).
    .replace(
      new RegExp(
        `\\b(?:\\d+(?:\\.\\d+)?|${NUM_PHRASE_RE})\\s+(?:${HOUR_UNIT_RE}\\s+and\\s+a\\s+half|and\\s+a\\s+half\\s+${HOUR_UNIT_RE})\\b`,
        "gi"
      ),
      " "
    )
    .replace(new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${NUM_PHRASE_RE})\\s*${HOUR_UNIT_RE}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:\\d+|${NUM_PHRASE_RE})\\s*min(?:ute)?s?\\b`, "gi"), " ")
    .replace(new RegExp(`\\bhalf an hour\\b|\\ba couple(?: of)? ${HOUR_UNIT_RE}\\b|\\ba few ${HOUR_UNIT_RE}\\b`, "gi"), " ")
    // Any "and a half" the compound rule could not reach (the number sat in a clause that was
    // split away), plus recurrence adverbs — parseRecurrence already captured those, and a
    // block called "… everyday" reads wrong on a calendar that shows one day.
    .replace(/\band\s+a\s+(?:half|quarter)\b/gi, " ")
    .replace(/\b(?:every\s*day|everyday|daily|each\s+day)\b/gi, " ")
    // A trailing "tomorrow"/"tonight"/"this week" is WHEN, and parseWindow/parseDayPart have
    // already taken it. Leaving it on the card is noise at best and wrong at worst — a block
    // sitting on Saturday titled "… tomorrow" reads as though it belongs on Sunday.
    .replace(
      /[\s,]+(?:today|tomorrow|tmrw|tonight|tonite|this\s+(?:week|weekend|morning|afternoon|evening)|next\s+week)\s*$/i,
      " "
    )
    .replace(/\s{2,}/g, " ")
    .trim();
  // Strip repeatedly: speech stacks these ("maybe about like to go through…").
  for (let i = 0; i < 6; i++) {
    const before = t;
    for (const re of TITLE_STRIP) t = t.replace(re, "").trim();
    if (t === before) break;
  }
  t = t.replace(/^[,\s.]+|[,\s.]+$/g, "");
  if (!t) return fragment.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── deterministic fallback (no LLM): segment + keyword classification ────────
const KEYWORDS: [RegExp, BlockType, number][] = [
  [/\bgym\b|work ?out|lift|run\b|exercise/i, "gym", 0],
  [/\bemail|reply|respond|follow ?up|message|text|call\b|reach out/i, "comms", 2],
  [/\bform|book|schedule|expense|invoice|renew|pay |errand|order\b/i, "admin", 2],
  [/\bpset|problem set|essay|write|paper|design|build|code|study|research|deck\b/i, "deep_work", 5],
  [/\bmeet|meeting|1:1|sync\b/i, "meeting", 3],
];

export function deterministicParse(
  text: string,
  doctrine: Doctrine,
  refISO: string = todayISO()
): ParsedTask[] {
  const out: ParsedTask[] = [];
  for (const seg of workSegments(text)) {
    // Classify from the WHOLE segment — "gym" can easily land in the clause that was merged in
    // — but title from the work clause alone, so scheduling language stays off the card.
    const p = seg.full;
    let blockType: BlockType = "focused_work";
    let load = 3;
    for (const [re, bt, l] of KEYWORDS) {
      if (re.test(p)) {
        blockType = bt;
        load = l || BLOCK_DEFAULTS[bt].load || 3;
        break;
      }
    }
    // The work clause's OWN duration wins; the merged scheduling context is only a fallback,
    // for when he states it there instead ("later this week, maybe two hours in total").
    //
    // Reading `full` first was wrong for any segment whose merged context is the whole
    // sentence — the gym fragment, which extractGymFragment lifts out with its own duration
    // attached ("1.25 hrs gym") but carries the entire text as context so surrounding
    // "everyday" still reaches it. With earliest-duration-wins that handed the gym the insta
    // clause's 30 minutes. A duration sitting inside the work clause is the least ambiguous
    // signal available and must outrank one borrowed from a neighbour.
    const stated = statedMinutes(seg.work) ?? statedMinutes(p);
    const rawEst = stated ?? BLOCK_DEFAULTS[blockType].minutes;
    const window = parseWindow(p, refISO);
    out.push({
      title: titleFromFragment(seg.work),
      blockType,
      cognitiveLoad: load,
      rawEstimateMinutes: rawEst,
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst, stated ? "stated" : "inferred"),
      isMit: false,
      hardDeadlineAt: null,
      personHint: null,
      splittable: blockType === "deep_work" && rawEst > 120,
      estimateSource: stated ? "stated" : "inferred",
      reasoning: "deterministic fallback (no LLM)",
      windowEnd: window.windowEnd,
      windowStart: window.windowStart ?? null,
      flexible: window.flexible,
      dayPart: parseDayPart(p),
      recurrence: parseRecurrence(p),
    });
  }
  return out;
}
