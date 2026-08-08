// Subscribed-calendar (webcal/ICS) tests. No network: feeds are fixture strings
// parsed with node-ical's sync parser, and subscription add/remove runs on a tmp
// DB with an injected validator.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ical from "node-ical";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import { mergeCalendarSources, type MergeableAppleEvent } from "../main/gcal/sync.ts";
import {
  floatingDriftDays,
  normalizeIcsUrl,
  eventsFromParsed,
  icsBlockType,
  listSubscriptions,
  addSubscription,
  removeSubscription,
  ICS_SUBSCRIPTIONS_KEY,
  SEED_SUBSCRIPTION_NAME,
  type IcsEvent,
} from "../main/icscal.ts";

// ── url normalization ────────────────────────────────────────────────────────

describe("normalizeIcsUrl", () => {
  it("rewrites webcal:// to https://", () => {
    expect(normalizeIcsUrl("webcal://example.com/cal.ics")).toBe("https://example.com/cal.ics");
  });

  it("rewrites webcals:// and is case-insensitive", () => {
    expect(normalizeIcsUrl("WEBCALS://example.com/a")).toBe("https://example.com/a");
    expect(normalizeIcsUrl("WebCal://example.com/a")).toBe("https://example.com/a");
  });

  it("normalizes the owner's published iCloud URL", () => {
    const u = normalizeIcsUrl(
      "webcal://p135-caldav.icloud.com/published/2/MTM1ODA5NDk4NTEzNTgwOR_8KyhdpBs8jKgU-D6Dq16Ro_7RQfvEzic2fjM53xPPTAatEXKYG2iJtwy4BNHV_bk0w88wJe7rsfato4EBxUY"
    );
    expect(u.startsWith("https://p135-caldav.icloud.com/published/2/")).toBe(true);
  });

  it("leaves http(s) URLs alone and trims whitespace", () => {
    expect(normalizeIcsUrl("  https://example.com/cal.ics  ")).toBe("https://example.com/cal.ics");
  });

  it("rejects non-URL garbage and non-http protocols", () => {
    expect(() => normalizeIcsUrl("not a url")).toThrow(/not a valid/);
    expect(() => normalizeIcsUrl("")).toThrow(/not a valid/);
    expect(() => normalizeIcsUrl("ftp://example.com/cal.ics")).toThrow(/unsupported protocol/);
  });
});

// ── fixture feed → eventsFromParsed ──────────────────────────────────────────
//
// One plain timed VEVENT (Wed 2026-08-05 09:30-10:15), one weekly RRULE
// (Wednesdays 14:00-15:00 since July), one all-day VEVENT, one running past
// midnight. Floating local times, exactly like a published class schedule.

const FIXTURE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//pos-tests//EN",
  "X-WR-CALNAME:Fixture feed",
  "BEGIN:VEVENT",
  "UID:plain-1@pos-tests",
  "DTSTAMP:20260801T000000Z",
  "DTSTART:20260805T093000",
  "DTEND:20260805T101500",
  "SUMMARY:Dentist appointment",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-1@pos-tests",
  "DTSTAMP:20260801T000000Z",
  "DTSTART:20260701T140000",
  "DTEND:20260701T150000",
  "RRULE:FREQ=WEEKLY;BYDAY=WE",
  "SUMMARY:CS lecture",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday-1@pos-tests",
  "DTSTAMP:20260801T000000Z",
  "DTSTART;VALUE=DATE:20260805",
  "DTEND;VALUE=DATE:20260806",
  "SUMMARY:Company holiday",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:overnight-1@pos-tests",
  "DTSTAMP:20260801T000000Z",
  "DTSTART:20260805T230000",
  "DTEND:20260806T010000",
  "SUMMARY:Red-eye flight",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const parseFixture = () => ical.sync.parseICS(FIXTURE);
const byUid = (events: IcsEvent[], uid: string) => events.filter((e) => e.uid === uid);

describe("eventsFromParsed", () => {
  it("returns the plain event with local minutes math", () => {
    const events = eventsFromParsed(parseFixture(), "2026-08-05");
    const [plain] = byUid(events, "plain-1@pos-tests");
    expect(plain).toBeDefined();
    expect(plain.title).toBe("Dentist appointment");
    expect(plain.startMin).toBe(9 * 60 + 30);
    expect(plain.endMin).toBe(10 * 60 + 15);
    expect(plain.allDay).toBe(false);
  });

  it("expands the weekly RRULE onto a matching Wednesday", () => {
    // 2026-08-05 is a Wednesday, five weeks after DTSTART
    const events = eventsFromParsed(parseFixture(), "2026-08-05");
    const [lecture] = byUid(events, "weekly-1@pos-tests");
    expect(lecture).toBeDefined();
    expect(lecture.title).toBe("CS lecture");
    expect(lecture.startMin).toBe(14 * 60);
    expect(lecture.endMin).toBe(15 * 60);
  });

  it("windows the expansion to the target day only", () => {
    // Thursday: no weekly occurrence, no plain event
    const thursday = eventsFromParsed(parseFixture(), "2026-08-06");
    expect(byUid(thursday, "weekly-1@pos-tests")).toHaveLength(0);
    expect(byUid(thursday, "plain-1@pos-tests")).toHaveLength(0);
    // the following Wednesday: only the recurring event
    const nextWed = eventsFromParsed(parseFixture(), "2026-08-12");
    expect(byUid(nextWed, "weekly-1@pos-tests")).toHaveLength(1);
    expect(byUid(nextWed, "plain-1@pos-tests")).toHaveLength(0);
  });

  it("skips all-day events entirely", () => {
    const events = eventsFromParsed(parseFixture(), "2026-08-05");
    expect(byUid(events, "allday-1@pos-tests")).toHaveLength(0);
  });

  it("clamps an event running past midnight to 1440", () => {
    const [flight] = byUid(eventsFromParsed(parseFixture(), "2026-08-05"), "overnight-1@pos-tests");
    expect(flight).toBeDefined();
    expect(flight.startMin).toBe(23 * 60);
    expect(flight.endMin).toBe(1440);
  });

  it("sorts the day chronologically", () => {
    const events = eventsFromParsed(parseFixture(), "2026-08-05");
    const starts = events.map((e) => e.startMin);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("rejects malformed dates", () => {
    expect(() => eventsFromParsed(parseFixture(), "08/05/2026")).toThrow(/bad date/);
  });
});

// ── uid passthrough into the calendar merge ──────────────────────────────────

describe("uid passthrough for mergeCalendarSources", () => {
  it("an ICS event with a Google-known uid is deduped, an unknown one anchors", () => {
    const events = eventsFromParsed(parseFixture(), "2026-08-05");
    const mergeable: MergeableAppleEvent[] = events.map((e) => ({
      uid: e.uid,
      title: e.title,
      startMin: e.startMin,
      endMin: e.endMin,
      blockType: icsBlockType(e.title),
    }));
    // Google already has the lecture (same feed subscribed in Google Calendar)
    const { anchors, skipped } = mergeCalendarSources(
      [{ startMin: 14 * 60, endMin: 15 * 60, title: "CS lecture", blockType: "meeting", iCalUID: "weekly-1@pos-tests" }],
      mergeable
    );
    expect(skipped).toEqual([{ uid: "weekly-1@pos-tests", reason: "same-uid" }]);
    const icsAnchors = anchors.filter((a) => a.source === "apple");
    expect(icsAnchors.map((a) => a.uid).sort()).toEqual(["overnight-1@pos-tests", "plain-1@pos-tests"]);
  });
});

// ── block type heuristic ─────────────────────────────────────────────────────

describe("icsBlockType", () => {
  it("meeting-ish titles become meetings, the rest personal", () => {
    expect(icsBlockType("Weekly sync with design")).toBe("meeting");
    expect(icsBlockType("Interview: staff engineer")).toBe("meeting");
    expect(icsBlockType("Pick up dry cleaning")).toBe("personal");
  });
});

// ── subscriptions on a tmp DB ────────────────────────────────────────────────

describe("subscriptions", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-ics-"));
    db = openDb(path.join(dir, "pos.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const noNetwork = { validate: async () => undefined };

  it("seeds the owner's published iCloud feed on first read", () => {
    expect(getSetting(db, ICS_SUBSCRIPTIONS_KEY)).toBeNull();
    const subs = listSubscriptions(db);
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe(SEED_SUBSCRIPTION_NAME);
    // stored normalized: webcal:// became https://
    expect(subs[0].url.startsWith("https://p135-caldav.icloud.com/")).toBe(true);
    expect(subs[0].id).toBeTruthy();
    // seeding persisted — a second read returns the same list, no re-seed
    expect(listSubscriptions(db)).toEqual(subs);
  });

  it("add normalizes webcal://, persists, and round-trips through remove", async () => {
    const seeded = listSubscriptions(db);
    const added = await addSubscription(db, "webcal://example.com/team.ics", "Team", noNetwork);
    expect(added.url).toBe("https://example.com/team.ics");
    expect(added.name).toBe("Team");

    let subs = listSubscriptions(db);
    expect(subs).toHaveLength(seeded.length + 1);
    expect(subs.find((s) => s.id === added.id)).toEqual(added);

    expect(removeSubscription(db, added.id)).toEqual({ removed: true });
    subs = listSubscriptions(db);
    expect(subs).toHaveLength(seeded.length);
    expect(subs.find((s) => s.id === added.id)).toBeUndefined();
    // removing again is a no-op
    expect(removeSubscription(db, added.id)).toEqual({ removed: false });
  });

  it("adding the same feed twice returns the existing subscription", async () => {
    const a = await addSubscription(db, "webcal://example.com/x.ics", "X", noNetwork);
    const b = await addSubscription(db, "https://example.com/x.ics", "Y", noNetwork);
    expect(b.id).toBe(a.id);
    expect(listSubscriptions(db).filter((s) => s.url === "https://example.com/x.ics")).toHaveLength(1);
  });

  it("falls back to the feed name, then the hostname, when no name is given", async () => {
    const named = await addSubscription(db, "https://example.com/a.ics", undefined, {
      validate: async () => "Published name",
    });
    expect(named.name).toBe("Published name");
    const bare = await addSubscription(db, "https://feeds.example.org/b.ics", undefined, noNetwork);
    expect(bare.name).toBe("feeds.example.org");
  });

  it("a failing validation rejects and stores nothing", async () => {
    const before = listSubscriptions(db);
    await expect(
      addSubscription(db, "https://example.com/dead.ics", "Dead", {
        validate: async () => { throw new Error("HTTP 404"); },
      })
    ).rejects.toThrow(/404/);
    expect(listSubscriptions(db)).toEqual(before);
  });

  it("an invalid URL rejects before any fetch", async () => {
    await expect(addSubscription(db, "not a url", undefined, noNetwork)).rejects.toThrow(/not a valid/);
  });
});

// ── DST: the grid is a wall clock, not an elapsed-time line ─────────────────
//
// endMin was derived as startMin + (end − start) in real milliseconds. That equals the wall
// clock only on a 24-hour day: across a DST boundary a 01:00→04:00 event has two elapsed
// hours and three wall hours, so the calendar ended it at 03:00. The Apple reader has always
// avoided this (applecal.wallEpoch is UTC-based on purpose so its durations are wall minutes);
// Google was fixed the same day. This was the last source still doing it the wrong way.
const DST_FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//pos-tests//EN",
  "BEGIN:VEVENT",
  "UID:spring-1@pos-tests",
  "DTSTAMP:20270301T000000Z",
  "DTSTART:20270314T010000",
  "DTEND:20270314T040000",
  "SUMMARY:Across the spring-forward gap",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:fall-1@pos-tests",
  "DTSTAMP:20271101T000000Z",
  "DTSTART:20271107T010000",
  "DTEND:20271107T040000",
  "SUMMARY:Across the fall-back repeat",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:fall-late@pos-tests",
  "DTSTAMP:20271101T000000Z",
  "DTSTART:20271107T230000",
  "DTEND:20271108T000000",
  "SUMMARY:Late on the 25-hour day",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("eventsFromParsed across DST", () => {
  const parsed = () => ical.sync.parseICS(DST_FEED);

  it("keeps wall-clock end on the 23-hour (spring forward) day", () => {
    const e = eventsFromParsed(parsed(), "2027-03-14").find((x) => x.uid === "spring-1@pos-tests");
    expect(e, "the event should be on the day").toBeTruthy();
    expect(e!.startMin).toBe(60);
    expect(e!.endMin, "04:00 must be minute 240, not 180").toBe(240);
  });

  it("keeps wall-clock end on the 25-hour (fall back) day", () => {
    const e = eventsFromParsed(parsed(), "2027-11-07").find((x) => x.uid === "fall-1@pos-tests");
    expect(e!.startMin).toBe(60);
    expect(e!.endMin, "04:00 must be minute 240, not 300").toBe(240);
  });

  it("a late event on the 25-hour day still ends at midnight, not past it", () => {
    const e = eventsFromParsed(parsed(), "2027-11-07").find((x) => x.uid === "fall-late@pos-tests");
    expect(e!.startMin).toBe(23 * 60);
    expect(e!.endMin).toBe(1440);
  });
});

// ── floating recurrences must keep their local wall clock ───────────────────
//
// A floating DTSTART ("DTSTART:20260701T200000" — no zone, no Z) is a WALL CLOCK: every
// occurrence is at 20:00 wherever the reader is. node-ical resolves DTSTART to the right
// instant and then advances the RULE in UTC days, so once the local time is late enough that
// its UTC instant lands on the next UTC date, every occurrence comes out a day early locally.
//
// Measured in HIS timezone on 2026-08-08: a weekly BYDAY=WE event at 20:00 America/Chicago
// (01:00Z the next day) expanded to local TUESDAY, so asking for the Wednesday returned
// nothing at all. It hid because afternoon events in Chicago are still the same UTC date —
// only evening recurrences bite, and further west they bite earlier in the day. His Stanford
// class schedule (September, recurring) is exactly the shape this breaks.
const weeklyWed = (hhmm: string) =>
  [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pos-tests//EN", "BEGIN:VEVENT",
    "UID:weekly-drift@pos-tests", "DTSTAMP:20260801T000000Z",
    `DTSTART:20260701T${hhmm}00`, `DTEND:20260701T${hhmm}00`,
    "RRULE:FREQ=WEEKLY;BYDAY=WE", "SUMMARY:CS lecture", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");

describe("weekly recurrence lands on the right LOCAL day", () => {
  const WED = "2026-08-05";
  const TUE = "2026-08-04";
  const occurrencesOn = (hhmm: string, dateISO: string) =>
    eventsFromParsed(ical.sync.parseICS(weeklyWed(hhmm)), dateISO).filter(
      (e) => e.uid === "weekly-drift@pos-tests"
    );

  it("an EVENING weekly event is on Wednesday, not Tuesday — his timezone's failing case", () => {
    const wed = occurrencesOn("2000", WED);
    expect(wed, "20:00 weekly Wednesday must appear on the Wednesday").toHaveLength(1);
    expect(wed[0].startMin).toBe(20 * 60);
    expect(occurrencesOn("2000", TUE), "and must NOT appear on the Tuesday").toHaveLength(0);
  });

  it("holds at every hour of the day, including the edges", () => {
    for (const [hhmm, min] of [["0000", 0], ["0900", 540], ["1400", 840], ["2300", 1380]] as const) {
      const wed = occurrencesOn(hhmm, WED);
      expect(wed, `DTSTART ${hhmm} on the Wednesday`).toHaveLength(1);
      expect(wed[0].startMin, `DTSTART ${hhmm} keeps its local wall clock`).toBe(min);
      expect(occurrencesOn(hhmm, TUE), `DTSTART ${hhmm} must not leak onto the Tuesday`).toHaveLength(0);
    }
  });

  it("floatingDriftDays is zero when the local and UTC dates agree, ±1 when they do not", () => {
    // A pure function so the correction is inspectable rather than magic.
    const noon = new Date(2026, 6, 1, 12, 0); // local midday — same UTC date in every US zone
    expect(Math.abs(floatingDriftDays(noon))).toBeLessThanOrEqual(1);
    // Constructed so local and UTC dates provably differ: local 23:00 west of UTC.
    const late = new Date(2026, 6, 1, 23, 0);
    const expected = Math.round(
      (Date.UTC(late.getUTCFullYear(), late.getUTCMonth(), late.getUTCDate()) -
        Date.UTC(late.getFullYear(), late.getMonth(), late.getDate())) / 86_400_000
    );
    expect(floatingDriftDays(late)).toBe(expected);
  });
});
