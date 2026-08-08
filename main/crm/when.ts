// Resolve a "when" phrase to an absolute date, ANCHORED to a reference date (e.g. the date a
// message was sent). This is what lets us read "lunch next Friday" in a text from 8 months ago
// and place it on the correct (past) calendar day — so we can then decide it's stale. No LLM.

const DAY = 86_400_000;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function midnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/**
 * A UTC date only if that date really exists. Date.UTC silently rolls an impossible day into
 * the next month — "feb 30" became March 2, and the garbage "2026-13-45" became 14 Feb 2027 —
 * so a typo produced a confident wrong DUE DATE rather than an admission of ignorance
 * (2026-08-08). Everything here already returns null for "I could not read that"; an
 * impossible date is exactly that.
 */
function exactUTC(year: number, monthIdx: number, day: number): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || !Number.isFinite(day)) return null;
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, monthIdx, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIdx && d.getUTCDate() === day ? d : null;
}
const addMonths = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));

/** Next occurrence of weekday `target` (0=Sun..6=Sat) on or after `from`. */
function onOrAfterWeekday(from: Date, target: number): Date {
  return addDays(from, (target - from.getUTCDay() + 7) % 7);
}

/**
 * Parse a date/time phrase out of `text`, resolved relative to `anchor`. Returns a UTC-midnight
 * Date or null. Handles relative ("tomorrow", "next week", "in 2 weeks", "this/next Friday",
 * "this weekend") and absolute ("September", "Sep 12", "2026-06-13") forms.
 */
export function parseWhen(text: string, anchor: Date): Date | null {
  if (!text) return null;
  const low = text.toLowerCase();
  const A = midnight(anchor);

  // Absolute ISO date wins.
  const iso = low.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return exactUTC(+iso[1], +iso[2] - 1, +iso[3]);

  // Relative keywords.
  if (/\bday after tomorrow\b/.test(low)) return addDays(A, 2);
  // "tmw" was missing while "tmrw" and "tmr" were present, and "tmw" is the one that turned
  // up in his real data — commitment 113, "Wanna come to library with me tmw am", parsed with
  // no date at all (2026-08-08).
  if (/\btomorrow\b|\btmrw\b|\btmr\b|\btmw\b|\btmoro?w?\b/.test(low)) return addDays(A, 1);
  if (/\btoday\b|\btonight\b/.test(low)) return A;
  if (/\bnext week\b/.test(low)) return addDays(A, 7);
  if (/\bnext month\b/.test(low)) return addMonths(A, 1);

  const inN = low.match(/\bin (\d{1,2}) (day|days|week|weeks|month|months)\b/);
  if (inN) {
    const n = +inN[1];
    return inN[2].startsWith("day") ? addDays(A, n) : inN[2].startsWith("week") ? addDays(A, n * 7) : addMonths(A, n);
  }

  if (/\b(this )?weekend\b/.test(low)) return onOrAfterWeekday(A, 6); // Saturday

  // A RETROSPECTIVE reference names a day that has already gone. It is not a plan, and the
  // weekday rule below would otherwise resolve "last friday" to the NEXT Friday — a future
  // due date invented out of a sentence about the past (2026-08-08).
  if (/\b(?:last|previous|past)\s+(?:mon|tue|wed|thu|fri|sat|sun|week|month)/.test(low)) return null;

  // Weekdays, optionally "this"/"next".
  const wd = low.match(/\b(this |next )?(mon|tue|wed|thu|fri|sat|sun)(?:day|s|nesday|rsday|urday)?\b/);
  if (wd) {
    let d = onOrAfterWeekday(A, WEEKDAY[wd[2]]);
    if ((wd[1] ?? "").trim() === "next") d = addDays(d, 7);
    return d;
  }

  // Absolute month name (+ optional day / year). Strip 4-digit years first so the day capture
  // doesn't eat them; anchor the year to the message when omitted.
  const cleaned = low.replace(/\b\d{4}\b/g, " ");
  // Whole-word months only — so "markaz"/"december"-style words don't match a prefix.
  const mm = cleaned.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/
  );
  if (mm) {
    const monthIdx = MONTHS[mm[1].slice(0, 3)];
    // The day can sit on either side of the month: "sep 5" and "the 5th of September" are the
    // same date. Only the trailing form was read, so the leading one silently became the 1st
    // of the month — a wrong due date rather than a missing one (2026-08-08). After wins when
    // both are present, since that is the form he actually writes.
    const after = cleaned.slice(mm.index! + mm[0].length);
    const before = cleaned.slice(0, mm.index!);
    const afterM = after.match(/\b([0-3]?\d)\b/);
    const beforeM = before.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\s+(?:of\s+)?$/);
    const dayM = afterM ?? beforeM;
    const day = dayM && +dayM[1] >= 1 && +dayM[1] <= 31 ? +dayM[1] : 1;
    // Only accept a PLAUSIBLE 4-digit year (19xx/20xx) — a phone/number fragment isn't a year.
    const yearM = low.match(/\b(19|20)\d{2}\b/);
    let year = yearM ? +yearM[0] : anchor.getUTCFullYear();
    if (!yearM && monthIdx < anchor.getUTCMonth()) year += 1; // next upcoming, relative to anchor
    return exactUTC(year, monthIdx, day);
  }

  return null;
}
