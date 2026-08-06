// Stage 2 (§5.5) — LLM (fast tier). Parses a free-text braindump into typed tasks.
// The prompt FORBIDS time assignment: the LLM decides WHAT a task is, never WHEN.
// Buffers are applied in code after parsing, not in the prompt.
// Degrades to a deterministic keyword parser when the LLM is unavailable.

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
  /** Part of the day he named ("tonight", "this morning"), or null. */
  dayPart: DayPart | null;
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

const DAY_PART_PATTERNS: [RegExp, DayPart][] = [
  [/\btonight\b|\bthis evening\b|\bin the evening\b|\bafter dinner\b|\bat night\b/i, "evening"],
  [/\bthis afternoon\b|\bin the afternoon\b|\bafter lunch\b/i, "afternoon"],
  [/\bthis morning\b|\bin the morning\b|\bfirst thing\b|\bbefore lunch\b/i, "morning"],
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
  /** True when the text named a RANGE; false when it named one specific day. */
  flexible: boolean;
}

const NO_WINDOW: ParsedWindow = { windowEnd: null, flexible: false };

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
  if (!negatesToday && /\btoday\b|\btonight\b/.test(low)) return { windowEnd: refISO, flexible: false };
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

  if (/\bnext week\b/.test(low)) return { windowEnd: isoOf(addDays(utcMidnight(endOfThisWeek(refISO)), 7)), flexible: true };
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
  if (/\bno rush\b|\bwhenever\b|\bany ?time\b|\bsometime\b|\bdoesn'?t have to be today\b|\bnot urgent\b/.test(low)) {
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
  refISO: string = new Date().toISOString().slice(0, 10)
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
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst),
      isMit,
      hardDeadlineAt: hhmm,
      personHint: typeof r.person_hint === "string" && r.person_hint.trim() ? r.person_hint.trim() : null,
      splittable: r.splittable === true,
      estimateSource: r.estimate_source === "stated" ? "stated" : "inferred",
      reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
      windowEnd: window.windowEnd,
      flexible: window.flexible,
      // Read from the owner's own words, not from the model: "tonight" is unambiguous and a
      // model that omits it should not cost him the constraint.
      dayPart: parseDayPart(sourceSegment(title, segments) ?? text),
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

/** "forty five" → 45, "twenty" → 20, "2" → 2. Null when `w` names no number. */
function wordValue(w: string): number | null {
  const t = w.trim().toLowerCase().replace(/-/g, " ");
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
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

  const hrs = low.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUM_PHRASE_RE})\\s*${HOUR_UNIT_RE}\\b`));
  if (hrs) {
    const n = wordValue(hrs[1]);
    if (n !== null) return Math.round(n * 60);
  }
  const mins = low.match(new RegExp(`\\b(\\d+|${NUM_PHRASE_RE})\\s*min(?:ute)?s?\\b`));
  if (mins) {
    const n = wordValue(mins[1]);
    if (n !== null) return Math.round(n);
  }
  return null;
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
  ...Object.keys(NUMBER_WORDS),
]);

/** Does this fragment name any actual work, or only when work should happen? */
function namesWork(fragment: string): boolean {
  const words = fragment.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  return words.some((w) => !SCHEDULING_WORDS.has(w));
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
export function workSegments(text: string): WorkSegment[] {
  const parts = (text ?? "")
    // Sentence boundaries split too. "Tonight I need to do research for Liatris. Tomorrow I
    // need to continue working on it." is two instructions with two different days, and
    // without this it is one task that takes the FIRST day it sees. The lookarounds keep
    // "2.5 hours" and "a.m." intact: only a period between a word and a capitalised word ends
    // a sentence here.
    .split(/\n|;|(?<!\d),(?!\d)| and (?=[a-z])|(?<=[a-z0-9])\.\s+(?=[A-Z])/i)
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
  return segs;
}

/** Filler that survives speech-to-text and has no business on a calendar card. */
const TITLE_STRIP = [
  /^(?:and|so|then|also|um+|uh+)\b\s*/i,
  /^(?:i\s+)?(?:need|want|have|gotta|got)\s+to\s+/i,
  /^(?:i\s+)?(?:should|must|will|can|could|would|might)\s+/i,
  /^(?:maybe|about|around|like|roughly|approximately|probably)\s+/i,
  /^(?:set|find|block|carve|reserve|schedule)\s+(?:aside\s+|out\s+)?(?:some\s+)?time\s+(?:to|for)\s+/i,
  /^(?:spend\s+)?(?:some\s+)?time\s+(?:to|for|on)\s+/i,
  /^in\s+total\s+/i,
  /^to\s+(?=[a-z])/i,
];

/** Turn a spoken fragment into something readable on a calendar card. */
export function titleFromFragment(fragment: string): string {
  let t = fragment.trim();
  // Durations are captured as a number; repeating them in the title is noise.
  t = t
    .replace(new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${NUM_PHRASE_RE})\\s*${HOUR_UNIT_RE}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:\\d+|${NUM_PHRASE_RE})\\s*min(?:ute)?s?\\b`, "gi"), " ")
    .replace(new RegExp(`\\bhalf an hour\\b|\\ba couple(?: of)? ${HOUR_UNIT_RE}\\b|\\ba few ${HOUR_UNIT_RE}\\b`, "gi"), " ")
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
  refISO: string = new Date().toISOString().slice(0, 10)
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
    // The duration is read from the merged segment: he states it in the scheduling clause at
    // least as often as in the work clause ("later this week, maybe two hours in total").
    const stated = statedMinutes(p);
    const rawEst = stated ?? BLOCK_DEFAULTS[blockType].minutes;
    const window = parseWindow(p, refISO);
    out.push({
      title: titleFromFragment(seg.work),
      blockType,
      cognitiveLoad: load,
      rawEstimateMinutes: rawEst,
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst),
      isMit: false,
      hardDeadlineAt: null,
      personHint: null,
      splittable: blockType === "deep_work" && rawEst > 120,
      estimateSource: stated ? "stated" : "inferred",
      reasoning: "deterministic fallback (no LLM)",
      windowEnd: window.windowEnd,
      flexible: window.flexible,
      dayPart: parseDayPart(p),
    });
  }
  return out;
}
