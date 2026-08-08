// "Today" means the calendar day he is living in.
//
// `new Date().toISOString().slice(0, 10)` is the UTC date. West of UTC the two disagree for
// the last hours of every evening — in America/Chicago (UTC−5 in summer) everything from
// 19:00 local onward reports TOMORROW — and the scheduling core was using it as "today".
//
// Between 7pm and midnight, which is when he actually sits down with the app:
//   • a braindump was planned onto the wrong day (assistant.today drives plan_day),
//   • recurring work did not materialize for the current day, because
//     materializeRecurringTasks' `dateISO < today` guard read the real today as past,
//   • the stale-engine sweep skipped today, because its window started tomorrow — so an
//     engine fix shipped in the evening never reached the day on screen.
//
// Audited 2026-08-08.

import { describe, it, expect } from "vitest";
import { localDateISO, todayISO, addDaysISO } from "../main/dates.ts";

/** The UTC-based expression these helpers replaced, kept here to assert the difference. */
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

describe("localDateISO", () => {
  it("is the local calendar date, not the UTC one", () => {
    for (const hour of [0, 9, 15, 19, 20, 23]) {
      const d = new Date(2026, 7, 7, hour, 30); // 2026-08-07, local, by construction
      expect(localDateISO(d), `at ${hour}:30 local`).toBe("2026-08-07");
    }
  });

  it("late evening is where the old expression diverged — west of UTC", () => {
    const evening = new Date(2026, 7, 7, 23, 30);
    expect(localDateISO(evening)).toBe("2026-08-07");
    // In a zone behind UTC the old code called this the 8th. Only assert the divergence
    // where it actually happens, so this passes in UTC and east of it too.
    if (evening.getTimezoneOffset() > 0) {
      expect(utcDate(evening)).not.toBe(localDateISO(evening));
    }
  });

  it("pads month and day", () => {
    expect(localDateISO(new Date(2026, 0, 3, 12, 0))).toBe("2026-01-03");
  });
});

describe("todayISO", () => {
  it("defaults to now and accepts an injected clock", () => {
    expect(todayISO(new Date(2026, 7, 7, 22, 0))).toBe("2026-08-07");
    expect(todayISO()).toBe(localDateISO(new Date()));
  });
});

describe("addDaysISO", () => {
  it("advances and rewinds calendar days", () => {
    const d = new Date(2026, 7, 7, 22, 0);
    expect(addDaysISO(d, 1)).toBe("2026-08-08");
    expect(addDaysISO(d, -1)).toBe("2026-08-06");
    expect(addDaysISO(d, 0)).toBe("2026-08-07");
  });

  it("crosses month and year boundaries", () => {
    expect(addDaysISO(new Date(2026, 7, 31, 12, 0), 1)).toBe("2026-09-01");
    expect(addDaysISO(new Date(2026, 11, 31, 12, 0), 1)).toBe("2027-01-01");
    expect(addDaysISO(new Date(2027, 0, 1, 12, 0), -1)).toBe("2026-12-31");
  });

  it("advances the DATE across a DST boundary, not 24 hours of milliseconds", () => {
    // Adding 86_400_000ms across a 23-hour day lands on the following day at 01:00, which
    // still formats correctly — but across the 25-hour day it lands at 23:00 of the SAME
    // date. Advancing the date is right in both.
    expect(addDaysISO(new Date(2027, 2, 13, 12, 0), 1)).toBe("2027-03-14"); // into spring forward
    expect(addDaysISO(new Date(2027, 10, 6, 12, 0), 1)).toBe("2027-11-07"); // into fall back
    expect(addDaysISO(new Date(2027, 10, 7, 12, 0), 1)).toBe("2027-11-08"); // out of it
  });
});
