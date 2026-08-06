// The scheduling vocabulary the NO-MODEL path must understand.
//
// Owner ask 2026-08-06, at the end of a day of Gemini outages: "You see how all of today we've
// run into a bunch of problems when the Gemini API is down in terms of not having a full
// dataset of keywords that map to different things — keywords for specific timings that day,
// or references to later weeks or days of later weeks, like next Thursday, next Wednesday,
// etcetera. I want you to make and expand on these cases and edge cases."
//
// The design rule these tests enforce: any word whose meaning is MECHANICAL — a weekday, a
// date, a part of the day, a relative offset — must resolve without a network call. The model
// is for judgement (what is the work, how long will it take), never for arithmetic that a
// quota outage can take away.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { braindump } from "../../main/planner.ts";
import { parseWindow, parseDayPart } from "../../main/engine/parse.ts";

// Thursday 2026-08-06 — the day all of this happened.
const THU = "2026-08-06";

describe("weekdays — days of this week and later weeks", () => {
  it('"next Thursday" / "next Wednesday" — the case he named verbatim', () => {
    // when.ts's shipped convention (already pinned by the "by next Friday" test): "next X" is
    // the coming X plus a week — said on a Thursday, "next Thursday" is not in two days.
    expect(parseWindow("send the deck next thursday", THU)).toEqual({ windowEnd: "2026-08-13", flexible: false });
    expect(parseWindow("call them next wednesday", THU)).toEqual({ windowEnd: "2026-08-19", flexible: false });
  });

  it("a bare full weekday is a commitment to that day", () => {
    expect(parseWindow("dentist on friday", THU)).toEqual({ windowEnd: "2026-08-07", flexible: false });
    expect(parseWindow("review the packet saturday", THU)).toEqual({ windowEnd: "2026-08-08", flexible: false });
    expect(parseWindow("monday standup prep", THU)).toEqual({ windowEnd: "2026-08-10", flexible: false });
  });

  it("abbreviations need a preposition, so prose never becomes a date", () => {
    expect(parseWindow("lunch on thu", THU)).toEqual({ windowEnd: "2026-08-06", flexible: false });
    // "sat" as a verb must never be Saturday.
    expect(parseWindow("we sat and talked for hours", THU)).toEqual({ windowEnd: null, flexible: false });
  });

  it('"by Friday" stays a flexible deadline — precedence over the bare-weekday read', () => {
    expect(parseWindow("finish the draft by friday", THU)).toEqual({ windowEnd: "2026-08-07", flexible: true });
  });
});

describe("absolute dates — the August 10/12 inputs that were lost", () => {
  it("month-name dates", () => {
    expect(parseWindow("sign up for the regional event august 10", THU)).toEqual({
      windowEnd: "2026-08-10", flexible: false,
    });
    expect(parseWindow("deliverable due aug 12", THU)).toEqual({ windowEnd: "2026-08-12", flexible: false });
  });

  it('"the 10th" — this month if still ahead, next month once past', () => {
    expect(parseWindow("book it for the 10th", THU)).toEqual({ windowEnd: "2026-08-10", flexible: false });
    expect(parseWindow("rent is due on the 1st", THU)).toEqual({ windowEnd: "2026-09-01", flexible: false });
  });

  it("refuses an ordinal the month cannot hold, rather than rolling into the wrong one", () => {
    // September has no 31st; landing on Oct 1 silently would be worse than not parsing.
    expect(parseWindow("on the 31st", "2026-09-05")).toEqual({ windowEnd: null, flexible: false });
  });

  it("slash dates, without eating fractions", () => {
    expect(parseWindow("flight on 8/10", THU)).toEqual({ windowEnd: "2026-08-10", flexible: false });
    expect(parseWindow("a 1/2 hour of stretching", THU)).toEqual({ windowEnd: null, flexible: false });
  });
});

describe("relative offsets", () => {
  it('"day after tomorrow" is read before "tomorrow" can claim it', () => {
    expect(parseWindow("pick it up the day after tomorrow", THU)).toEqual({ windowEnd: "2026-08-08", flexible: false });
  });

  it('"in N days" is a point; "over the next N days" stays a range', () => {
    expect(parseWindow("follow up in 3 days", THU)).toEqual({ windowEnd: "2026-08-09", flexible: false });
    expect(parseWindow("in a couple days", THU)).toEqual({ windowEnd: "2026-08-08", flexible: false });
    expect(parseWindow("spread it over the next 3 days", THU)).toEqual({ windowEnd: "2026-08-09", flexible: true });
  });

  it('"in a week" / "in two weeks"', () => {
    expect(parseWindow("check back in a week", THU)).toEqual({ windowEnd: "2026-08-13", flexible: false });
    expect(parseWindow("revisit in two weeks", THU)).toEqual({ windowEnd: "2026-08-20", flexible: false });
  });
});

describe("ranges that do not open immediately", () => {
  it('"this weekend" opens Saturday and closes Sunday', () => {
    expect(parseWindow("clean the garage this weekend", THU)).toEqual({
      windowStart: "2026-08-08", windowEnd: "2026-08-09", flexible: true,
    });
  });

  it('"next week" opens next Monday — the reclaim pass may not pull it into this week', () => {
    const w = parseWindow("draft the essay next week", THU);
    expect(w.windowStart).toBe("2026-08-10");
    expect(w.windowEnd).toBe("2026-08-16");
    expect(w.flexible).toBe(true);
  });

  it('"end of the month" is everything left in it', () => {
    expect(parseWindow("expense report by end of the month", THU)).toEqual({
      windowEnd: "2026-08-31", flexible: true,
    });
  });
});

describe("slack phrases — real work with no stated edge", () => {
  it("all of them become a this-week window rather than nothing", () => {
    for (const phrase of ["no rush", "no hurry", "eventually", "at some point", "when i get a chance"]) {
      const w = parseWindow(`organize the photos, ${phrase}`, THU);
      expect(w.flexible, phrase).toBe(true);
      expect(w.windowEnd, phrase).toBe("2026-08-09");
    }
  });
});

describe("parts of the day — the vocabulary as spoken", () => {
  it("evening words", () => {
    for (const t of ["tonight", "tomorrow night", "thursday evening", "after dinner", "before bed", "after work"]) {
      expect(parseDayPart(t), t).toBe("evening");
    }
  });

  it("afternoon words, including noon", () => {
    for (const t of ["this afternoon", "late afternoon", "after lunch", "at noon", "around noon", "midday"]) {
      expect(parseDayPart(t), t).toBe("afternoon");
    }
  });

  it("morning words", () => {
    for (const t of ["tomorrow morning", "first thing", "before noon", "when i wake up"]) {
      expect(parseDayPart(t), t).toBe("morning");
    }
  });

  it('"good morning" is a greeting, not a schedule', () => {
    expect(parseDayPart("good morning! plan my day")).toBeNull();
  });
});

describe("end to end through braindump — no model anywhere", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-vocab-"));
    db = openDb(path.join(dir, "pos.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const tasks = () =>
    db.prepare("SELECT title, plan_date, day_part, window_start, window_end FROM task ORDER BY id").all() as any[];

  it("the inputs he lost: events on the 10th and the 12th land on those dates", async () => {
    await braindump(db, dir, null,
      "Sign up for the regional event on the 10th. Prep the deck for august 12.", THU);
    const [a, b] = tasks();
    expect(a.plan_date).toBe("2026-08-10");
    expect(b.plan_date).toBe("2026-08-12");
  });

  it('"next Thursday evening" carries BOTH the day and the part of the day', async () => {
    await braindump(db, dir, null, "Review the Liatris research next thursday evening", THU);
    const [t] = tasks();
    expect(t.plan_date).toBe("2026-08-13");
    expect(t.day_part).toBe("evening");
  });

  it('"this weekend" parks the work on Saturday with Sunday as its window', async () => {
    await braindump(db, dir, null, "Clean out the garage this weekend", THU);
    const [t] = tasks();
    expect(t.plan_date).toBe("2026-08-08");
    expect(t.window_start).toBe("2026-08-08");
    expect(t.window_end).toBe("2026-08-09");
  });

  it('"next Thursday" as its own fragment merges into the work, never a task of its own', async () => {
    await braindump(db, dir, null, "Send the sponsorship deck, next thursday", THU);
    const rows = tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_date).toBe("2026-08-13");
  });
});
