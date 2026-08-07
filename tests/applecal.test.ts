// Pure parsing/heuristic tests for the Apple Calendar bridge.
// Nothing here shells out to osascript or touches the network — the AppleScript
// itself is exercised by hand; these lock the TS side of the line protocol.

import { describe, it, expect } from "vitest";
import {
  FIELD_SEP,
  SCAN_ERROR_MARKER,
  parseAppleDate,
  parseAppleLine,
  parseAppleEvents,
  parseAppleScan,
  healPartialScan,
  isAllDay,
  appleBlockType,
  classifyOsaError,
  buildEventsScript,
  filterAppleEvents,
  isPosAuthoredCalendar,
  parseExcludedCalendars,
  parseCalendarNames,
  type AppleEvent,
} from "../main/applecal.ts";

const row = (...fields: string[]) => fields.join(FIELD_SEP);

describe("parseAppleDate", () => {
  it("parses the zero-padded ISO the AppleScript emits", () => {
    expect(parseAppleDate("2026-08-04T09:30:00")).toEqual({ y: 2026, mo: 8, d: 4, hh: 9, mm: 30, ss: 0 });
  });

  it("tolerates a missing seconds field and a space separator", () => {
    expect(parseAppleDate("2026-12-31 23:59")).toEqual({ y: 2026, mo: 12, d: 31, hh: 23, mm: 59, ss: 0 });
  });

  it("returns null for garbage rather than an Invalid Date", () => {
    expect(parseAppleDate("")).toBeNull();
    expect(parseAppleDate("not a date")).toBeNull();
    expect(parseAppleDate("2026-13-04T09:00:00")).toBeNull(); // month 13
    expect(parseAppleDate("2026-08-04T99:00:00")).toBeNull(); // hour 99
  });
});

describe("isAllDay", () => {
  const at = (hh: number, mm: number, ss = 0, d = 4) => ({ y: 2026, mo: 8, d, hh, mm, ss });

  it("detects Calendar.app's 00:00:00 → 23:59:59 same-day shape", () => {
    expect(isAllDay(at(0, 0, 0), at(23, 59, 59))).toBe(true);
  });

  it("detects the 00:00 → 00:00 next-day shape", () => {
    expect(isAllDay(at(0, 0, 0), at(0, 0, 0, 5))).toBe(true);
  });

  it("detects a multi-day all-day event", () => {
    expect(isAllDay(at(0, 0, 0), at(0, 0, 0, 7))).toBe(true);
  });

  it("is false for a midnight-starting but short event", () => {
    expect(isAllDay(at(0, 0, 0), at(1, 0, 0))).toBe(false);
  });

  it("is false for a normal timed event", () => {
    expect(isAllDay(at(9, 0, 0), at(10, 0, 0))).toBe(false);
  });
});

describe("parseAppleLine", () => {
  it("parses a well-formed row into an AppleEvent", () => {
    const ev = parseAppleLine(
      row("UID-1", "Civil dialogue session", "2026-08-04T12:00:00", "2026-08-04T13:30:00", "Work")
    );
    expect(ev).toEqual<AppleEvent>({
      uid: "UID-1",
      title: "Civil dialogue session",
      startMin: 12 * 60,
      endMin: 13 * 60 + 30,
      calendar: "Work",
      allDay: false,
    });
  });

  it("computes minutes since midnight, not clock times", () => {
    const ev = parseAppleLine(row("U", "Gym", "2026-08-04T06:15:00", "2026-08-04T07:05:00", "Personal"))!;
    expect(ev.startMin).toBe(375);
    expect(ev.endMin).toBe(425);
    expect(ev.endMin - ev.startMin).toBe(50);
  });

  it("clamps an event running past midnight to the end of the day", () => {
    const ev = parseAppleLine(row("U", "Red-eye", "2026-08-04T22:00:00", "2026-08-05T02:00:00", "Travel"))!;
    expect(ev.startMin).toBe(1320);
    expect(ev.endMin).toBe(1440);
  });

  it("flags an all-day event and reports the full day", () => {
    const ev = parseAppleLine(row("U", "DFW startup week", "2026-08-04T00:00:00", "2026-08-04T23:59:59", "Work"))!;
    expect(ev.allDay).toBe(true);
    expect(ev.startMin).toBe(0);
    expect(ev.endMin).toBe(1440);
  });

  it("gives a zero-length event a 15-minute floor", () => {
    const ev = parseAppleLine(row("U", "Ping", "2026-08-04T09:00:00", "2026-08-04T09:00:00", "Work"))!;
    expect(ev.endMin - ev.startMin).toBe(15);
  });

  it("falls back to (busy) for an empty title", () => {
    expect(parseAppleLine(row("U", "", "2026-08-04T09:00:00", "2026-08-04T10:00:00", "Work"))!.title).toBe("(busy)");
  });

  it("skips malformed rows", () => {
    expect(parseAppleLine("")).toBeNull();
    expect(parseAppleLine("   ")).toBeNull();
    expect(parseAppleLine("no separators at all")).toBeNull();
    // too few fields
    expect(parseAppleLine(row("U", "Title", "2026-08-04T09:00:00", "2026-08-04T10:00:00"))).toBeNull();
    // missing uid
    expect(parseAppleLine(row("", "Title", "2026-08-04T09:00:00", "2026-08-04T10:00:00", "Work"))).toBeNull();
    // unparseable dates
    expect(parseAppleLine(row("U", "Title", "sometime", "later", "Work"))).toBeNull();
  });

  it("strips a trailing carriage return", () => {
    const ev = parseAppleLine(row("U", "T", "2026-08-04T09:00:00", "2026-08-04T10:00:00", "Work") + "\r");
    expect(ev?.calendar).toBe("Work");
  });
});

describe("parseAppleEvents", () => {
  it("keeps good rows and drops bad ones", () => {
    const stdout = [
      row("A", "Standup", "2026-08-04T09:00:00", "2026-08-04T09:15:00", "Work"),
      "garbage line",
      "",
      row("B", "Dentist", "2026-08-04T15:00:00", "2026-08-04T16:00:00", "HYT Fam"),
      row("C", "broken", "nope", "nope", "Work"),
    ].join("\n");
    const events = parseAppleEvents(stdout);
    expect(events.map((e) => e.uid)).toEqual(["A", "B"]);
  });

  it("returns an empty array for empty output (a day with no events)", () => {
    expect(parseAppleEvents("")).toEqual([]);
    expect(parseAppleEvents("\n\n")).toEqual([]);
  });
});

describe("appleBlockType", () => {
  it("calls meeting-ish titles a meeting", () => {
    expect(appleBlockType("Weekly sync", "Personal")).toBe("meeting");
    expect(appleBlockType("Calling Prakash", "HYT Fam")).toBe("meeting");
    expect(appleBlockType("1:1 with Sam", "Family")).toBe("meeting");
    expect(appleBlockType("Mummy's doc appt", "HYT Fam")).toBe("meeting");
    expect(appleBlockType("Zoom with the investor", "Family")).toBe("meeting");
  });

  it("treats a work-ish calendar as a meeting even with a bland title", () => {
    expect(appleBlockType("Blocked", "Work")).toBe("meeting");
    expect(appleBlockType("Offsite", "Company Calendar")).toBe("meeting");
  });

  it("falls back to personal", () => {
    expect(appleBlockType("Haircut", "Personal")).toBe("personal");
    expect(appleBlockType("Groceries", "HYT Fam")).toBe("personal");
    expect(appleBlockType("", "")).toBe("personal");
  });
});

describe("classifyOsaError", () => {
  it("recognises a TCC/automation denial by code", () => {
    const e = classifyOsaError("execution error: Not authorized to send Apple events to Calendar. (-1743)", "x");
    expect(e.code).toBe("permission");
    expect(e.message).toMatch(/Automation/);
  });

  it("recognises an unreachable Calendar.app", () => {
    expect(classifyOsaError("execution error: Can’t get application. (-1728)", "x").code).toBe("unavailable");
  });

  it("falls back to a script error", () => {
    expect(classifyOsaError("execution error: syntax error", "x").code).toBe("script");
  });
});

describe("buildEventsScript", () => {
  it("resets the day before setting the month so Jan 31 → Feb cannot overflow", () => {
    const s = buildEventsScript("2026-02-01");
    const resetDay = s.indexOf("set day of dayStart to 1");
    const setMonth = s.indexOf("set month of dayStart to 2");
    expect(resetDay).toBeGreaterThan(-1);
    expect(setMonth).toBeGreaterThan(resetDay);
  });

  it("rejects a non-ISO date instead of interpolating it", () => {
    expect(() => buildEventsScript("08/04/2026")).toThrow();
    expect(() => buildEventsScript('2026-08-04" & (do shell script "id")')).toThrow();
  });

  it("skips POS's own calendars inside the scan, before the expensive whose clause", () => {
    const s = buildEventsScript("2026-08-04");
    // em dash by code point: osascript's source encoding is not guaranteed to be UTF-8
    expect(s).toContain('set posPrefix to "POS " & (character id 8212) & " "');
    expect(s.indexOf("if cname starts with posPrefix")).toBeLessThan(s.indexOf("every event of c whose"));
  });

  it("embeds the excluded calendar names as an AppleScript list", () => {
    const s = buildEventsScript("2026-08-04", ["Holidays", "Siri Suggestions"]);
    expect(s).toContain('set skipNames to {"Holidays", "Siri Suggestions"}');
  });

  it("emits an empty list when nothing is excluded, and drops blank names", () => {
    expect(buildEventsScript("2026-08-04")).toContain("set skipNames to {}");
    expect(buildEventsScript("2026-08-04", ["  ", ""])).toContain("set skipNames to {}");
  });

  it("escapes quotes in a calendar name instead of breaking out of the string", () => {
    const s = buildEventsScript("2026-08-04", ['Bad" & (do shell script "id") & "']);
    expect(s).toContain('\\"');
    expect(s).not.toContain('do shell script "id"');
  });
});

describe("isPosAuthoredCalendar", () => {
  it("recognises the calendars POS writes itself", () => {
    expect(isPosAuthoredCalendar("POS — Planned")).toBe(true);
    expect(isPosAuthoredCalendar("POS — Apple")).toBe(true);
    expect(isPosAuthoredCalendar("  POS — Anything  ")).toBe(true);
  });

  it("does not claim unrelated calendars", () => {
    expect(isPosAuthoredCalendar("Work")).toBe(false);
    expect(isPosAuthoredCalendar("POSitive vibes")).toBe(false); // no em dash
    expect(isPosAuthoredCalendar("POS - Planned")).toBe(false); // hyphen, not em dash
    expect(isPosAuthoredCalendar("")).toBe(false);
  });
});

describe("parseExcludedCalendars", () => {
  it("splits the comma-separated setting and trims", () => {
    expect(parseExcludedCalendars("Holidays, Birthdays ,Siri Suggestions")).toEqual([
      "Holidays",
      "Birthdays",
      "Siri Suggestions",
    ]);
  });

  it("defaults to nothing excluded", () => {
    expect(parseExcludedCalendars(null)).toEqual([]);
    expect(parseExcludedCalendars(undefined)).toEqual([]);
    expect(parseExcludedCalendars("")).toEqual([]);
    expect(parseExcludedCalendars(" , , ")).toEqual([]);
  });
});

describe("filterAppleEvents", () => {
  const stdout = [
    row("A", "Standup", "2026-08-04T09:00:00", "2026-08-04T09:15:00", "Work"),
    row("B", "Deep work", "2026-08-04T10:00:00", "2026-08-04T12:00:00", "POS — Planned"),
    row("C", "Dentist", "2026-08-04T15:00:00", "2026-08-04T16:00:00", "POS — Apple"),
    row("D", "Eid", "2026-08-04T00:00:00", "2026-08-04T23:59:59", "Holidays"),
  ].join("\n");
  const events = parseAppleEvents(stdout);

  it("excludes POS's own mirror calendars, so our output never re-enters as input", () => {
    expect(filterAppleEvents(events).map((e) => e.uid)).toEqual(["A", "D"]);
  });

  it("also excludes the calendars named in the settings list", () => {
    expect(filterAppleEvents(events, ["Holidays"]).map((e) => e.uid)).toEqual(["A"]);
  });

  it("matches excluded names case-insensitively and ignores whitespace", () => {
    expect(filterAppleEvents(events, [" holidays "]).map((e) => e.uid)).toEqual(["A"]);
  });

  it("keeps everything when nothing is excluded and no POS calendar is present", () => {
    const clean = parseAppleEvents(row("A", "Standup", "2026-08-04T09:00:00", "2026-08-04T09:15:00", "Work"));
    expect(filterAppleEvents(clean, [])).toHaveLength(1);
    expect(filterAppleEvents([], ["Work"])).toEqual([]);
  });
});

describe("parseCalendarNames", () => {
  it("splits on linefeed so a name containing a comma survives", () => {
    expect(parseCalendarNames("Work\nHome, Family\nHolidays")).toEqual(["Work", "Home, Family", "Holidays"]);
  });

  it("hides POS's own calendars and de-dupes, dropping blank lines", () => {
    expect(parseCalendarNames("Work\r\nPOS — Apple\n\nWork\nPOS — Planned\n")).toEqual(["Work"]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseCalendarNames("")).toEqual([]);
  });
});


// ── partial-scan resilience ───────────────────────────────────────────────────
//
// Owner report 2026-08-07: a family dinner on a shared iCloud calendar ("HYT Fam") never
// became an anchor, and the planner scheduled the shutdown ritual inside it. The scan's
// per-calendar `on error` used to coerce a FAILED calendar into an EMPTY one — these lock
// the marker protocol and the snapshot healing that replaced that silence.
describe("parseAppleScan / healPartialScan", () => {
  const ev = (uid: string, cal: string, startH: number): string =>
    row(uid, `Event ${uid}`, `2026-08-07T${String(startH).padStart(2, "0")}:00:00`, `2026-08-07T${String(startH + 1).padStart(2, "0")}:00:00`, cal);

  it("separates event rows from error-marker rows", () => {
    const out = parseAppleScan([ev("a", "Work", 9), `${SCAN_ERROR_MARKER}${FIELD_SEP}HYT Fam`, ev("b", "Home", 12)].join("\n"));
    expect(out.events.map((e) => e.uid)).toEqual(["a", "b"]);
    expect(out.erroredCalendars).toEqual(["HYT Fam"]);
  });

  it("a clean scan reports no errored calendars (old outputs parse unchanged)", () => {
    const out = parseAppleScan([ev("a", "Work", 9)].join("\n"));
    expect(out.erroredCalendars).toEqual([]);
    expect(out.events).toHaveLength(1);
  });

  it("heals ONLY the errored calendar from the snapshot — his exact case", () => {
    const fresh = parseAppleScan(ev("standoff", "Work", 18)).events;
    const snapshot: AppleEvent[] = [
      { uid: "dinner", title: "Dinner at our home", startMin: 1140, endMin: 1320, calendar: "HYT Fam", allDay: false },
      { uid: "old-work", title: "Stale Work row", startMin: 540, endMin: 600, calendar: "Work", allDay: false },
    ];
    const healed = healPartialScan(fresh, ["HYT Fam"], snapshot);
    // The dinner is restored; the stale Work row is NOT — Work scanned fine, so its
    // fresh (empty-of-that-event) answer is the truth.
    expect(healed.map((e) => e.uid).sort()).toEqual(["dinner", "standoff"]);
  });

  it("no errors → snapshot untouched; no snapshot → fresh returned as-is", () => {
    const fresh: AppleEvent[] = [];
    expect(healPartialScan(fresh, [], [{ uid: "x", title: "t", startMin: 0, endMin: 60, calendar: "A", allDay: false }])).toBe(fresh);
    expect(healPartialScan(fresh, ["A"], null)).toBe(fresh);
  });

  it("calendar-name matching is case-folded, same rule as exclusions", () => {
    const healed = healPartialScan([], ["hyt fam"], [
      { uid: "dinner", title: "Dinner", startMin: 1140, endMin: 1320, calendar: "HYT Fam", allDay: false },
    ]);
    expect(healed).toHaveLength(1);
  });
});
