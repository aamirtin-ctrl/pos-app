// anchorsDiffer (main/gcal/sync.ts): decides whether a background anchors refresh found
// something different from the snapshot the renderer was served — the trigger for the
// pos:day-changed ping. Owner report 2026-08-13: deleting an event in Apple/Google Calendar
// didn't reflect in the day view; the refresh corrected the cache but nothing re-rendered.

import { describe, it, expect } from "vitest";
import { anchorsDiffer, type ExternalAnchor } from "../main/gcal/sync.ts";

function anchor(over: Partial<ExternalAnchor> = {}): ExternalAnchor {
  return {
    startMin: 600,
    endMin: 660,
    title: "Standup",
    blockType: "meeting",
    gcalEventId: "ev-1",
    iCalUID: "uid-1",
    calendarId: "cal-a",
    flexibility: "fixed",
    ...over,
  } as ExternalAnchor;
}

describe("anchorsDiffer", () => {
  it("same anchors → no ping", () => {
    const a = [anchor(), anchor({ gcalEventId: "ev-2", title: "Lunch" })];
    const b = [anchor({ gcalEventId: "ev-2", title: "Lunch" }), anchor()]; // order-insensitive
    expect(anchorsDiffer(a, b)).toBe(false);
  });

  it("deletion on another device → ping (the reported bug)", () => {
    const served = [anchor(), anchor({ gcalEventId: "ev-2", title: "Dentist" })];
    const fresh = [anchor()];
    expect(anchorsDiffer(served, fresh)).toBe(true);
  });

  it("addition → ping", () => {
    expect(anchorsDiffer([anchor()], [anchor(), anchor({ gcalEventId: "ev-2" })])).toBe(true);
  });

  it("moved event (same id, new time) → ping", () => {
    expect(anchorsDiffer([anchor()], [anchor({ startMin: 720, endMin: 780 })])).toBe(true);
  });

  it("retitled event → ping", () => {
    expect(anchorsDiffer([anchor()], [anchor({ title: "Standup (moved)" })])).toBe(true);
  });

  it("both empty → no ping", () => {
    expect(anchorsDiffer([], [])).toBe(false);
  });

  it("swap keeping count (one deleted, one added) → ping", () => {
    expect(anchorsDiffer([anchor()], [anchor({ gcalEventId: "ev-9" })])).toBe(true);
  });
});
