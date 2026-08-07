// Cross-calendar de-duplication. Pure: no network, no DB, no osascript.
//
// The same real-world event reaches POS from up to three directions — Google, a Google
// account subscribed inside Calendar.app, and POS's own pushed blocks syncing back
// down. It must block the day exactly once. The join key is the RFC 5545 UID, which is
// the one identifier that survives crossing between systems.

import { describe, it, expect } from "vitest";
import {
  mergeCalendarSources,
  isOwnWriteCalendar,
  type MergeableAppleEvent,
  type MergeableGoogleAnchor,
} from "../main/gcal/sync.ts";

const gcal = (over: Partial<MergeableGoogleAnchor> = {}): MergeableGoogleAnchor => ({
  startMin: 9 * 60,
  endMin: 10 * 60,
  title: "Standup",
  blockType: "meeting",
  iCalUID: "uid-standup@google.com",
  ...over,
});

const apple = (over: Partial<MergeableAppleEvent> = {}): MergeableAppleEvent => ({
  uid: "uid-standup@google.com",
  title: "Standup",
  startMin: 9 * 60,
  endMin: 10 * 60,
  blockType: "meeting",
  ...over,
});

describe("mergeCalendarSources", () => {
  it("skips an Apple event whose uid matches a Google anchor's iCalUID", () => {
    const { anchors, skipped } = mergeCalendarSources([gcal()], [apple()]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].source).toBe("google");
    expect(skipped).toEqual([{ uid: "uid-standup@google.com", reason: "same-uid" }]);
  });

  it("matches on uid even when the title and time no longer agree", () => {
    // the whole point of joining on the UID: renaming or moving the event in one system
    // must not make it look like a second, distinct event.
    const { anchors, skipped } = mergeCalendarSources(
      [gcal({ title: "Standup" })],
      [apple({ title: "Daily standup (renamed)", startMin: 10 * 60, endMin: 11 * 60 })]
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0].title).toBe("Standup");
    expect(skipped).toEqual([{ uid: "uid-standup@google.com", reason: "same-uid" }]);
  });

  it("falls back to time+title for an Apple event with a distinct uid", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal({ iCalUID: "uid-a@google.com" })],
      [apple({ uid: "uid-b@icloud.com" })]
    );
    expect(anchors).toHaveLength(1);
    expect(skipped).toEqual([{ uid: "uid-b@icloud.com", reason: "same-time-title" }]);
  });

  it("keeps a genuinely distinct Apple event", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal()],
      [apple({ uid: "uid-dentist@icloud.com", title: "Dentist", startMin: 15 * 60, endMin: 16 * 60, blockType: "personal" })]
    );
    expect(skipped).toEqual([]);
    expect(anchors).toHaveLength(2);
    expect(anchors[1]).toEqual({
      startMin: 15 * 60,
      endMin: 16 * 60,
      title: "Dentist",
      blockType: "personal",
      source: "apple",
      uid: "uid-dentist@icloud.com",
    });
  });

  it("keeps an Apple event that only overlaps partially", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal()],
      [apple({ uid: "uid-other@icloud.com", endMin: 11 * 60 })]
    );
    expect(skipped).toEqual([]);
    expect(anchors).toHaveLength(2);
  });

  it("falls back to time+title when neither side has a UID", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal({ iCalUID: undefined })],
      [apple({ uid: undefined })]
    );
    expect(anchors).toHaveLength(1);
    expect(skipped).toEqual([{ uid: "", reason: "same-time-title" }]);
  });

  it("falls back to time+title when only the Google side has a UID", () => {
    const { anchors, skipped } = mergeCalendarSources([gcal()], [apple({ uid: "" })]);
    expect(anchors).toHaveLength(1);
    expect(skipped).toEqual([{ uid: "", reason: "same-time-title" }]);
  });

  it("ignores surrounding whitespace when comparing titles and uids", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal({ iCalUID: " uid-standup@google.com " })],
      [apple({ uid: "uid-standup@google.com" })]
    );
    expect(anchors).toHaveLength(1);
    expect(skipped[0].reason).toBe("same-uid");
  });

  it("handles empty inputs", () => {
    expect(mergeCalendarSources([], [])).toEqual({ anchors: [], skipped: [] });
    expect(mergeCalendarSources([gcal()], [])).toEqual({
      anchors: [
        {
          startMin: 9 * 60,
          endMin: 10 * 60,
          title: "Standup",
          blockType: "meeting",
          source: "google",
          uid: "uid-standup@google.com",
        },
      ],
      skipped: [],
    });
    const appleOnly = mergeCalendarSources([], [apple()]);
    expect(appleOnly.skipped).toEqual([]);
    expect(appleOnly.anchors).toHaveLength(1);
    expect(appleOnly.anchors[0].source).toBe("apple");
  });

  it("defaults an Apple event with no blockType to personal", () => {
    const { anchors } = mergeCalendarSources([], [{ uid: "u", title: "Nap", startMin: 60, endMin: 120 }]);
    expect(anchors[0].blockType).toBe("personal");
  });

  it("de-dupes a POS block that synced down into Calendar.app (the feedback loop)", () => {
    // POS pushes into "POS — Planned"; Google gives that event an iCalUID; the calendar
    // syncs back into Calendar.app carrying the same UID. Without the UID join it would
    // re-enter the plan as an external anchor.
    const posBlock = gcal({ iCalUID: "pos-block-1@google.com", title: "Deep work", blockType: "personal" });
    const { anchors, skipped } = mergeCalendarSources(
      [posBlock],
      [apple({ uid: "pos-block-1@google.com", title: "Deep work" })]
    );
    expect(anchors).toHaveLength(1);
    expect(skipped).toEqual([{ uid: "pos-block-1@google.com", reason: "same-uid" }]);
  });

  it("does not let one Google anchor absorb two different Apple events", () => {
    const { anchors, skipped } = mergeCalendarSources(
      [gcal()],
      [
        apple(), // same uid → same-uid
        apple({ uid: "uid-gym@icloud.com", title: "Gym", startMin: 7 * 60, endMin: 8 * 60 }),
      ]
    );
    expect(skipped).toEqual([{ uid: "uid-standup@google.com", reason: "same-uid" }]);
    expect(anchors.map((a) => a.title)).toEqual(["Standup", "Gym"]);
  });
});

// ── the Apple-mirror feedback loop (owner-visible 2026-08-07) ───────────────
//
// mirrorAppleSweep writes Apple events into a Google calendar named "POS — Apple". That
// name starts with the same "POS — " prefix inferFlexibility uses to mean "planner-
// authored, therefore flexible". readAnchorsLive read the mirrored dinner back as a
// genuine Google anchor, tagged it flexible, and the merge (time+title fallback) preferred
// that copy over the correctly-tiered `fixed` Apple original — a flexible anchor has no
// task behind it, so the solver silently dropped the entire 3-hour dinner from the day.
//
// isOwnWriteCalendar is the fix: both calendars POS itself writes to are excluded from
// ever being read back as an anchor source, so this class of event never reaches the merge
// carrying the wrong tier in the first place.
describe("isOwnWriteCalendar", () => {
  it("excludes the planner calendar and the Apple mirror, nothing else", () => {
    const posId = "pos123";
    const mirrorId = "mirror456";
    expect(isOwnWriteCalendar(posId, posId, mirrorId)).toBe(true);
    expect(isOwnWriteCalendar(mirrorId, posId, mirrorId)).toBe(true);
    expect(isOwnWriteCalendar("some-other-calendar", posId, mirrorId)).toBe(false);
    expect(isOwnWriteCalendar(undefined, posId, mirrorId)).toBe(true); // no id → never a valid source
  });

  it("works before either calendar has been created (both ids null)", () => {
    expect(isOwnWriteCalendar("anything", null, null)).toBe(false);
    expect(isOwnWriteCalendar(null, null, null)).toBe(true);
  });
});
