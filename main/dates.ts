// Local calendar dates.
//
// `new Date().toISOString().slice(0, 10)` is the UTC date, not his. West of UTC the two
// disagree for the last hours of every evening: in America/Chicago (UTC−5 in summer)
// everything from 19:00 onward reports TOMORROW. The app was using it as "today" in the
// scheduling core, so between 7pm and midnight — which is when he actually sits down with
// it — a braindump was planned onto the wrong day, recurring work did not materialize for
// the current day (its `dateISO < today` guard read the real today as already past), and
// the stale-engine sweep skipped today entirely because its window started tomorrow.
//
// Audited 2026-08-08. Every place that means "the calendar day he is living in" uses these.
//
// NOT everything here should: a value that has to match what Google was sent, or one that
// only ever does date-string arithmetic, is correctly UTC and says so at its call site
// (gtasks-sync.pushedDueDateOf, planner.upcomingDates).

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function localDateISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today, as he would say it. */
export function todayISO(now: Date = new Date()): string {
  return localDateISO(now);
}

/**
 * `days` calendar days from `d`, local. Advancing the DATE rather than adding 24h of
 * milliseconds, because a calendar day is 23 or 25 hours twice a year.
 */
export function addDaysISO(d: Date, days: number): string {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return localDateISO(out);
}
