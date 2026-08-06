// Observed wake time (owner request 2026-08-05).
//
// The doctrine's `chronotype.wake_time` is an INTENTION (07:30). The real wake time moves,
// and every window in the doctrine — the energy curve, the first-hour cognitive ban, every
// ritual offset — is expressed as hours-after-wake. Planning a 06:40 morning against a 07:30
// wake shifts the whole day by 50 minutes.
//
// So the owner tells POS when he actually got up: a text to his own number, or an Alexa
// routine that mails him. That message flows through the normal capture pipeline
// (main/capture.ts), which recognizes it here and records the timestamp instead of routing
// it to the assistant as a task.
//
// THE MESSAGE'S OWN TIMESTAMP IS THE WAKE TIME — never now(). Capture runs on a worker
// tick, so a 06:40 text can easily be read at 07:15; using now() would record the moment POS
// noticed rather than the moment he woke. Mail carries internalDate, iMessage carries
// message.date; both reach recordWake as an ISO string.
//
// Everything here is local-time: the day key and the HH:MM are derived from the timestamp in
// the machine's timezone, which is the timezone the owner wakes up in.

import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { Doctrine } from "./engine/doctrine.ts";

/** Settings-key prefix. One row per day: `wake_observed:2026-08-05` → "06:40". */
export const WAKE_SETTING_PREFIX = "wake_observed:";

/**
 * A wake ping is a MORNING message. Past this hour (local) an "awake"/"morning" message is
 * something else — a note about a morning meeting, a late reply — and is left for the
 * assistant. Exclusive bound: 12:00 is already afternoon.
 */
export const WAKE_LATEST_HOUR = 12;

/** Longest a message can be and still be a wake ping rather than a braindump mentioning one. */
const WAKE_MAX_WORDS = 5;

export const wakeSettingKey = (dateISO: string): string => `${WAKE_SETTING_PREFIX}${dateISO}`;

const pad = (n: number) => String(n).padStart(2, "0");
const localDateISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Parse an ISO timestamp; null when it is unusable (a connector handed us junk). */
function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface WakeRecord {
  /** Local calendar day the wake belongs to. */
  dateISO: string;
  /** The wake time now on record for that day, "HH:MM" local. */
  hhmm: string;
  /** false = an earlier wake was already recorded for that day and was kept. */
  stored: boolean;
}

/**
 * Record an observed wake from a message timestamp. Returns null if `iso` is unparseable.
 *
 * EARLIEST WINS. Waking is a single event, and the first ping of the morning is the one that
 * marks it; a later "good morning" reply at 10:30 must not drag the recorded wake forward and
 * shove the whole plan two hours later. A genuinely later wake on a new day is a different
 * day key, so it records normally.
 */
export function recordWake(db: Db, iso: string): WakeRecord | null {
  const d = parseIso(iso);
  if (!d) return null;
  const dateISO = localDateISO(d);
  const hhmm = localHhmm(d);
  const prior = observedWake(db, dateISO);
  if (prior !== null && prior <= hhmm) return { dateISO, hhmm: prior, stored: false };
  setSetting(db, wakeSettingKey(dateISO), hhmm);
  return { dateISO, hhmm, stored: true };
}

/** The observed wake for a day as "HH:MM", or null when none was reported. */
export function observedWake(db: Db, dateISO: string): string | null {
  const raw = getSetting(db, wakeSettingKey(dateISO));
  if (!raw) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null; // hand-edited garbage degrades to "not reported", never to a bad plan
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/**
 * The wake time to PLAN a given day against: what actually happened when we know it, the
 * doctrine's intention otherwise. This is the only wake-time source the planner should use.
 */
export function wakeTimeFor(db: Db, dateISO: string, doctrine: Doctrine): string {
  return observedWake(db, dateISO) ?? doctrine.chronotype.wake_time;
}

// ── recognizing a wake ping ──────────────────────────────────────────────────
//
// The cost of a false positive is high: a message classified as a wake ping is CONSUMED and
// never reaches the assistant, so a real task would be silently lost. Everything below is
// therefore anchored and short-message-gated. "morning meeting with Raj" is a task and must
// stay one; so must "just woke up, remind me to call the dentist" — when a wake ping carries
// extra content, the content wins and the ping is given up.

/** Lowercase, strip punctuation/emoji/extra whitespace. "Morning!! 😀" → "morning". */
function normalizeWakeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ") // punctuation + symbols (incl. emoji) → space
    .replace(/\s+/g, " ")
    .trim();
}

/** The whole message is one of these and nothing else. */
const WAKE_EXACT: RegExp[] = [
  /^(good\s+)?morning$/,
  /^(gm|g\s?morning|mornin)$/,
  /^awake$/,
  /^(i\s?m|i\s+am)\s+awake$/,
  /^wide\s+awake$/,
  /^up$/,
  /^(i\s?m|i\s+am)\s+up$/,
  /^up\s+now$/,
  /^(i\s?m|i\s+am)\s+up\s+now$/,
  /^woke\s+up$/,
  /^just\s+woke(\s+up)?$/,
  /^rise\s+and\s+shine$/,
  /^awake\s+now$/,
];

/** Unambiguous wake phrases, allowed only inside a SHORT message (see WAKE_MAX_WORDS). */
const WAKE_PHRASE: RegExp[] = [
  /\bjust\s+woke\s+up\b/,
  /\bjust\s+got\s+up\b/,
  /\b(i\s?m|i\s+am)\s+awake\b/,
  /\b(i\s?m|i\s+am)\s+up\s+now\b/,
  /\bawake\s+now\b/,
  /\bup\s+and\s+about\b/,
  // NOT "good morning" as a phrase: "good morning call with Sarah" is a task, and the
  // bare greeting is already covered exactly above.
];

/**
 * Does this message say "I am awake"? Content-only — the caller still has to check the
 * timestamp (see isWakeMessage).
 *
 * True for "just woke up", "awake", "morning!", "up now", "good morning".
 * False for "morning meeting with Raj" (a task that merely contains the word).
 */
export function detectWakeFromText(text: string | null | undefined): boolean {
  const norm = normalizeWakeText(text ?? "");
  if (!norm) return false;
  if (WAKE_EXACT.some((re) => re.test(norm))) return true;
  // A phrase match only counts in a message short enough to be nothing BUT the ping.
  if (norm.split(" ").length > WAKE_MAX_WORDS) return false;
  return WAKE_PHRASE.some((re) => re.test(norm));
}

/**
 * The predicate main/capture.ts uses to consume a self-message as a wake report: it says it,
 * AND it arrived in the morning. `iso` is the MESSAGE's timestamp, never now().
 *
 * An afternoon "awake" is not a wake report — it falls through to the assistant like any
 * other capture.
 */
export function isWakeMessage(text: string | null | undefined, iso: string | null | undefined): boolean {
  if (!detectWakeFromText(text)) return false;
  const d = parseIso(iso);
  if (!d) return false; // no trustworthy timestamp → not consumable as a wake
  return d.getHours() < WAKE_LATEST_HOUR;
}
