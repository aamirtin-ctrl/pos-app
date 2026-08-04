// Pure parsing/heuristic tests for the Apple Calendar bridge.
// Nothing here shells out to osascript or touches the network — the AppleScript
// itself is exercised by hand; these lock the TS side of the line protocol.

import { describe, it, expect } from "vitest";
import {
  FIELD_SEP,
  parseAppleDate,
  parseAppleLine,
  parseAppleEvents,
  isAllDay,
  appleBlockType,
  classifyOsaError,
  buildEventsScript,
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
});
