// Ported from PersonalCRM2 lib/when.test.ts (node:test → vitest).
import { describe, it, expect } from "vitest";
import { parseWhen } from "../../main/crm/when.ts";

// anchor = a Wednesday
const ANCHOR = new Date("2025-10-01T12:00:00Z"); // Wed Oct 1 2025
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

describe("parseWhen", () => {
  it("relative: tomorrow / today / day after", () => {
    expect(iso(parseWhen("let's meet tomorrow", ANCHOR))).toBe("2025-10-02");
    expect(iso(parseWhen("lunch today?", ANCHOR))).toBe("2025-10-01");
    expect(iso(parseWhen("call day after tomorrow", ANCHOR))).toBe("2025-10-03");
  });

  it("relative: next week / in N / next month", () => {
    expect(iso(parseWhen("grab coffee next week", ANCHOR))).toBe("2025-10-08");
    expect(iso(parseWhen("ping me in 2 weeks", ANCHOR))).toBe("2025-10-15");
    expect(iso(parseWhen("circle back in 3 days", ANCHOR))).toBe("2025-10-04");
    expect(iso(parseWhen("reconnect next month", ANCHOR))).toBe("2025-11-01");
  });

  it("weekdays anchored to message date", () => {
    // Wed Oct 1 → this Friday = Oct 3
    expect(iso(parseWhen("lunch this friday", ANCHOR))).toBe("2025-10-03");
    // next Friday = Oct 10
    expect(iso(parseWhen("dinner next friday", ANCHOR))).toBe("2025-10-10");
    // Monday (upcoming) = Oct 6
    expect(iso(parseWhen("see you monday", ANCHOR))).toBe("2025-10-06");
  });

  it("absolute month anchored: no year → next upcoming from anchor", () => {
    // anchor Oct 2025; "in September" → Sep 2026 (already passed in 2025)
    expect(iso(parseWhen("let's do lunch in September", ANCHOR))).toBe("2026-09-01");
    // "December" still ahead in 2025
    expect(iso(parseWhen("catch up in December", ANCHOR))).toBe("2025-12-01");
    expect(iso(parseWhen("dinner Oct 20", ANCHOR))).toBe("2025-10-20");
  });

  it("ISO date passes through; no temporal phrase → null", () => {
    expect(iso(parseWhen("meeting on 2025-11-15", ANCHOR))).toBe("2025-11-15");
    expect(iso(parseWhen("great chatting, take care", ANCHOR))).toBeNull();
  });
});

// ── hostile and abbreviated dates (audited 2026-08-08) ──────────────────────
//
// Found by handing parseWhen deliberately awkward input rather than the phrasings it was
// written for. A due date is acted on, so a confident wrong answer is worse here than an
// admission of ignorance — everything unreadable already returns null, and these now do too.
describe("parseWhen — abbreviations, retrospect, and impossible dates", () => {
  const BASE = new Date("2026-08-08T12:00:00Z"); // a Saturday
  const iso = (t: string) => {
    const d = parseWhen(t, BASE);
    return d ? d.toISOString().slice(0, 10) : null;
  };

  it("'tmw' is tomorrow — the abbreviation in his own messages", () => {
    // Commitment 113 in his live database: "Wanna come to library with me tmw am". "tmrw"
    // and "tmr" were both handled; the one he actually typed was not, so it got no date.
    expect(iso("wanna come to library with me tmw am")).toBe("2026-08-09");
    for (const t of ["tmw", "tmrw", "tmr", "tomorrow", "tmoro", "tmorow"]) {
      expect(iso(`let's do it ${t}`), t).toBe("2026-08-09");
    }
  });

  it("a retrospective reference is not a due date", () => {
    // The weekday rule would otherwise resolve "last friday" to the NEXT Friday: a future
    // deadline invented out of a sentence about the past.
    for (const t of ["last friday", "previous tuesday", "past monday", "last week"]) {
      expect(iso(`we discussed it ${t}`), t).toBeNull();
    }
    // …while the forward-looking forms are untouched
    expect(iso("next friday")).toBe("2026-08-21");
    expect(iso("this friday")).toBe("2026-08-14");
  });

  it("an impossible calendar date is null, not the day it rolls over to", () => {
    // Date.UTC silently rolls: "feb 30" became March 2 and "2026-13-45" became 14 Feb 2027.
    expect(iso("due feb 30")).toBeNull();
    expect(iso("due 2026-02-30")).toBeNull();
    expect(iso("due 2026-13-45")).toBeNull();
    expect(iso("the 31st of february")).toBeNull();
    // real dates still resolve
    expect(iso("due 2026-09-15")).toBe("2026-09-15");
    expect(iso("due feb 28")).toBe("2027-02-28");
  });

  it("the day may sit on either side of the month name", () => {
    // Only the trailing form was read, so "the 5th of September" silently became the 1st.
    for (const t of ["the 5th of september", "5 september", "sep 5", "september 5"]) {
      expect(iso(t), t).toBe("2026-09-05");
    }
    // a bare month still means the 1st, as before
    expect(iso("september")).toBe("2026-09-01");
  });
});
