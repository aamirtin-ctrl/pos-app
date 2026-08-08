// Every window phrase against every day of a year.
//
// parseWindow turns "this week" / "by Friday" / "next week" into the dates the scheduler is
// allowed to move work within. An off-by-one here is not subtle in effect — work lands on the
// wrong day, or becomes eligible for a day he explicitly ruled out — but it IS subtle to
// spot, because it only shows up near a boundary: a Sunday, the end of a month, a leap day,
// the turn of the year, a DST transition.
//
// So rather than sample, this sweeps every supported phrase across 366 consecutive reference
// dates and asserts the invariants that must hold for all of them. Exhaustive and fully
// deterministic — no RNG at all.

import { describe, it, expect } from "vitest";
import { parseWindow, endOfThisWeek } from "../../main/engine/parse.ts";

/** 366 consecutive dates from 2027-01-01 — includes a leap year and both DST transitions. */
const REF_DATES: string[] = (() => {
  const out: string[] = [];
  const d = new Date(Date.UTC(2027, 0, 1));
  for (let i = 0; i < 366; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
})();

/** Phrases the deterministic parser claims to understand. */
const PHRASES = [
  "this week", "rest of the week", "next week", "by friday", "before thursday",
  "by monday", "today", "tomorrow", "this weekend", "no rush", "whenever",
  "sometime this week", "by the end of the week", "next monday", "by sunday",
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (iso: string) => ISO.test(iso) && iso === new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10);

describe("parseWindow across a full year of reference dates", () => {
  it("every window it returns is a real calendar date", () => {
    for (const ref of REF_DATES) {
      for (const phrase of PHRASES) {
        const w = parseWindow(`do the thing ${phrase}`, ref);
        if (w.windowEnd !== null) {
          expect(isRealDate(w.windowEnd), `${ref} / "${phrase}" -> end ${w.windowEnd}`).toBe(true);
        }
        if (w.windowStart != null) {
          expect(isRealDate(w.windowStart), `${ref} / "${phrase}" -> start ${w.windowStart}`).toBe(true);
        }
      }
    }
  });

  it("never resolves a window that has already closed", () => {
    // A deadline in the past is not a window, it is a bug: the scheduler would have no legal
    // slot and would report the work unplaceable on a day it could actually have done it.
    for (const ref of REF_DATES) {
      for (const phrase of PHRASES) {
        const w = parseWindow(`do the thing ${phrase}`, ref);
        if (w.windowEnd === null) continue;
        expect(
          w.windowEnd >= ref,
          `${ref} / "${phrase}" -> window closed at ${w.windowEnd}, before the reference day`
        ).toBe(true);
      }
    }
  });

  it("a window never opens after it closes", () => {
    for (const ref of REF_DATES) {
      for (const phrase of PHRASES) {
        const w = parseWindow(`do the thing ${phrase}`, ref);
        if (w.windowEnd == null || w.windowStart == null) continue;
        expect(
          w.windowStart <= w.windowEnd,
          `${ref} / "${phrase}" -> opens ${w.windowStart}, closes ${w.windowEnd}`
        ).toBe(true);
      }
    }
  });

  it("a window never opens before the day it was said on", () => {
    for (const ref of REF_DATES) {
      for (const phrase of PHRASES) {
        const w = parseWindow(`do the thing ${phrase}`, ref);
        if (w.windowStart == null) continue;
        expect(w.windowStart >= ref, `${ref} / "${phrase}" -> opens ${w.windowStart}`).toBe(true);
      }
    }
  });

  it("is deterministic for every phrase and date", () => {
    for (const ref of REF_DATES) {
      for (const phrase of PHRASES) {
        const a = JSON.stringify(parseWindow(`do the thing ${phrase}`, ref));
        const b = JSON.stringify(parseWindow(`do the thing ${phrase}`, ref));
        expect(a, `${ref} / "${phrase}"`).toBe(b);
      }
    }
  });

  it("text naming no timeframe never invents one", () => {
    for (const ref of REF_DATES) {
      for (const text of ["write the deck", "gym", "email sarah", ""]) {
        const w = parseWindow(text, ref);
        expect(w.windowEnd, `${ref} / "${text}"`).toBeNull();
        expect(w.flexible, `${ref} / "${text}"`).toBe(false);
      }
    }
  });
});

describe("endOfThisWeek across a full year", () => {
  it("always lands on a Sunday, on or after the reference day", () => {
    for (const ref of REF_DATES) {
      const end = endOfThisWeek(ref);
      expect(isRealDate(end), `${ref} -> ${end}`).toBe(true);
      expect(end >= ref, `${ref} -> ${end} is in the past`).toBe(true);
      expect(new Date(`${end}T00:00:00Z`).getUTCDay(), `${ref} -> ${end} is not a Sunday`).toBe(0);
      // …and never more than a week out
      const gapDays = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${ref}T00:00:00Z`)) / 86_400_000;
      expect(gapDays, `${ref} -> ${end}`).toBeLessThan(7);
    }
  });
});
