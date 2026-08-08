// Calendar geometry regression tests (owner report 2026-08-05: "a couple of the
// calendar events are overlapping — break is overlapping with something,
// transitions overlapping with something").
//
// Cause: cards were painted at `max(MIN_CARD_PX, duration * PX_PER_MIN)`. At
// 1.2 px/min a 15-minute break is 18px and a 10-minute transition 12px, so the
// readable minimum inflated them by 8-14px straight over the block starting
// immediately after. These tests pin the geometry helpers that fix it, plus the
// lane packing and the external/anchor dedupe that feed them.

import { describe, it, expect } from "vitest";
import {
  MIN_CARD_PX, PX_PER_MIN, buildItems, cardHeightPx, cardHeights, layoutLanes,
  todayISO, addDaysISO, localDateISO,
  type Block, type ExternalEvent, type Item, type LaidOutItem, type PlanView,
} from "../renderer/src/calendar/shared.ts";

const item = (p: Partial<Item> & { startMin: number; endMin: number }): Item => ({
  key: p.key ?? `k${p.startMin}-${p.endMin}`,
  startMin: p.startMin,
  endMin: p.endMin,
  title: p.title ?? "item",
  type: p.type ?? "admin",
  external: p.external ?? false,
  anchor: p.anchor ?? false,
  locked: p.locked ?? false,
});

const heightOf = (laid: LaidOutItem[], key: string) => cardHeights(laid).get(key)!;

/** Painted span of a card in minutes-of-day, i.e. what the eye actually sees. */
const painted = (it: LaidOutItem, h: number) => ({ from: it.startMin, to: it.startMin + h / PX_PER_MIN });

describe("cardHeightPx", () => {
  it("never exceeds its own span when the next block starts immediately after", () => {
    // 10-minute transition followed at once by a 60-minute block
    expect(cardHeightPx(10, 10)).toBe(10 * PX_PER_MIN);
    // 15-minute break followed at once by the next block
    expect(cardHeightPx(15, 15)).toBe(15 * PX_PER_MIN);
  });

  it("grants the readable minimum to an isolated short block", () => {
    expect(cardHeightPx(10, null)).toBe(MIN_CARD_PX);
    expect(cardHeightPx(15, null)).toBe(MIN_CARD_PX);
  });

  it("borrows only the empty grid that is actually there", () => {
    // MIN_CARD_PX needs 26/1.2 ≈ 21.7 minutes of room
    expect(cardHeightPx(10, 30)).toBe(MIN_CARD_PX);   // 36px of room → minimum fits
    expect(cardHeightPx(10, 15)).toBeCloseTo(15 * PX_PER_MIN, 6); // only 18px → take all 18
    expect(cardHeightPx(10, 12)).toBeCloseTo(12 * PX_PER_MIN, 6); // only 14.4px → take all of it
  });

  it("long blocks are unaffected — always their true duration", () => {
    expect(cardHeightPx(90, 90)).toBe(90 * PX_PER_MIN);
    expect(cardHeightPx(60, null)).toBe(60 * PX_PER_MIN);
  });
});

describe("cardHeights over a laid-out day", () => {
  it("a break and a transition wedged between blocks never paint over their neighbour", () => {
    const laid = layoutLanes([
      item({ key: "deep", startMin: 600, endMin: 690, type: "deep_work" }),   // 10:00-11:30
      item({ key: "break", startMin: 690, endMin: 705, type: "break" }),      // 11:30-11:45
      item({ key: "trans", startMin: 705, endMin: 715, type: "transition" }), // 11:45-11:55
      item({ key: "mtg", startMin: 715, endMin: 775, type: "meeting" }),      // 11:55-12:55
    ]);
    const h = cardHeights(laid);
    for (const it of laid) {
      const next = laid.find((o) => o.startMin > it.startMin);
      if (!next) continue;
      expect(painted(it, h.get(it.key)!).to).toBeLessThanOrEqual(next.startMin);
    }
    // and they are still drawn at their true size, not collapsed
    expect(h.get("break")).toBe(15 * PX_PER_MIN);
    expect(h.get("trans")).toBe(10 * PX_PER_MIN);
  });

  it("a short block with free grid after it keeps the readable minimum", () => {
    const laid = layoutLanes([
      item({ key: "trans", startMin: 540, endMin: 550, type: "transition" }), // 9:00-9:10
      item({ key: "later", startMin: 660, endMin: 720, type: "admin" }),      // 11:00-12:00
    ]);
    expect(heightOf(laid, "trans")).toBe(MIN_CARD_PX);
  });

  it("only cards sharing a column constrain each other", () => {
    // two side-by-side lanes: the 10-min card in lane 0 is not clipped by the
    // long card beside it, only by what comes next in its own column
    const laid = layoutLanes([
      item({ key: "long", startMin: 540, endMin: 660, type: "meeting" }), // 9:00-11:00
      item({ key: "tiny", startMin: 545, endMin: 555, type: "break" }),   // 9:05-9:15, overlaps
    ]);
    expect(laid.find((l) => l.key === "long")!.lanes).toBe(2);
    expect(heightOf(laid, "tiny")).toBe(MIN_CARD_PX);
  });

  it("the last card of the day is unconstrained", () => {
    const laid = layoutLanes([item({ key: "solo", startMin: 1260, endMin: 1270, type: "transition" })]);
    expect(heightOf(laid, "solo")).toBe(MIN_CARD_PX);
  });
});

describe("layoutLanes with plan blocks and externals mixed", () => {
  const blk = (id: number, startMin: number, endMin: number, over: Partial<Block> = {}): Block => ({
    id,
    block_type: over.block_type ?? "deep_work",
    title: over.title ?? `block ${id}`,
    starts_at: `2026-08-05T${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}:00`,
    ends_at: `2026-08-05T${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`,
    is_anchor: over.is_anchor ?? 0,
    is_locked: over.is_locked ?? 0,
  });
  const plan = (blocks: Block[]): PlanView => ({ plan: { id: 1 }, blocks, unplaced: [] });

  it("externals go through lane assignment together with plan blocks", () => {
    const p = plan([blk(1, 600, 720)]); // 10:00-12:00 deep work
    const ext: ExternalEvent[] = [{ startMin: 660, endMin: 700, title: "Surprise call", blockType: "meeting" }];
    const laid = layoutLanes(buildItems(p, ext));
    expect(laid).toHaveLength(2);
    // the overlap is resolved horizontally: two lanes, distinct lane indices
    expect(new Set(laid.map((l) => l.lanes))).toEqual(new Set([2]));
    expect(new Set(laid.map((l) => l.lane))).toEqual(new Set([0, 1]));
    // no two cards share a column at an overlapping minute
    for (const a of laid) {
      for (const b of laid) {
        if (a.key === b.key) continue;
        const timeOverlap = a.startMin < b.endMin && b.startMin < a.endMin;
        const colOverlap = a.lane < b.lane + b.span && b.lane < a.lane + a.span;
        expect(timeOverlap && colOverlap).toBe(false);
      }
    }
  });

  it("non-overlapping externals still take the full width", () => {
    const p = plan([blk(1, 600, 660)]);
    const ext: ExternalEvent[] = [{ startMin: 720, endMin: 780, title: "Lunch w/ Sam", blockType: "meeting" }];
    const laid = layoutLanes(buildItems(p, ext));
    expect(laid.every((l) => l.lanes === 1 && l.span === 1)).toBe(true);
  });
});

describe("buildItems external/anchor dedupe", () => {
  const anchor = (startMin: number, endMin: number, title: string): Block => ({
    id: 7, block_type: "meeting", title,
    starts_at: `2026-08-05T${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}:00`,
    ends_at: `2026-08-05T${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`,
    is_anchor: 1, is_locked: 0,
  });
  const p = (b: Block): PlanView => ({ plan: { id: 1 }, blocks: [b], unplaced: [] });

  it("hides an external whose span exactly matches an anchor", () => {
    const items = buildItems(p(anchor(600, 630, "Board call")), [
      { startMin: 600, endMin: 630, title: "Board call", blockType: "meeting" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].external).toBe(false);
  });

  it("hides an external that drifted by a minute (the stacked-duplicate bug)", () => {
    const items = buildItems(p(anchor(600, 630, "Board call")), [
      { startMin: 601, endMin: 631, title: "Board call", blockType: "meeting" },
    ]);
    expect(items).toHaveLength(1);
  });

  it("hides a same-title external that was rescheduled inside the anchor's span", () => {
    const items = buildItems(p(anchor(600, 660, "Board call")), [
      { startMin: 615, endMin: 700, title: "  board   CALL ", blockType: "meeting" },
    ]);
    expect(items).toHaveLength(1);
  });

  it("keeps a genuinely different external that merely overlaps", () => {
    const items = buildItems(p(anchor(600, 660, "Board call")), [
      { startMin: 615, endMin: 700, title: "Dentist", blockType: "personal" },
    ]);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.external)).toBe(true);
  });

  it("keeps a same-title external at a completely different hour", () => {
    const items = buildItems(p(anchor(600, 630, "Board call")), [
      { startMin: 900, endMin: 930, title: "Board call", blockType: "meeting" },
    ]);
    expect(items).toHaveLength(2);
  });

  it("with no plan, every external is shown", () => {
    const items = buildItems(null, [
      { startMin: 600, endMin: 630, title: "Board call", blockType: "meeting" },
      { startMin: 700, endMin: 730, title: "Board call", blockType: "meeting" },
    ]);
    expect(items).toHaveLength(2);
  });
});

// ── the calendar must open on the day he is actually living in ──────────────
//
// shared.todayISO seeds DayPlanner's initial date, decides `isToday` and `isPastDay`, and is
// where the "Today" button jumps. It was `new Date().toISOString().slice(0, 10)` — the UTC
// date — so west of UTC, for the last hours of every evening (America/Chicago from 19:00),
// the app OPENED ON TOMORROW and rendered the actual today as a past day, greyed and behind
// him. The same fault was fixed across the main process earlier on 2026-08-08; the renderer
// is a separate bundle and had been missed.
describe("renderer date helpers are local, not UTC", () => {
  it("localDateISO reads the local calendar date at every hour", () => {
    for (const hour of [0, 9, 12, 19, 20, 23]) {
      // Constructed from local components, so this IS 2026-08-07 wherever the test runs.
      expect(localDateISO(new Date(2026, 7, 7, hour, 30)), `${hour}:30 local`).toBe("2026-08-07");
    }
  });

  it("todayISO agrees with the local clock, not with UTC", () => {
    const now = new Date();
    expect(todayISO()).toBe(localDateISO(now));
    // Where the two genuinely differ (west of UTC late in the day), prove they differ — this
    // is the bug, and it must not be reintroduced.
    const evening = new Date(2026, 7, 7, 23, 30);
    if (evening.getTimezoneOffset() > 0) {
      expect(evening.toISOString().slice(0, 10)).not.toBe(localDateISO(evening));
    }
  });

  it("addDaysISO steps CALENDAR days, across months, years and DST", () => {
    expect(addDaysISO("2026-08-07", 1)).toBe("2026-08-08");
    expect(addDaysISO("2026-08-07", -1)).toBe("2026-08-06");
    expect(addDaysISO("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysISO("2027-01-01", -1)).toBe("2026-12-31");
    // both US DST transitions
    expect(addDaysISO("2027-03-13", 1)).toBe("2027-03-14");
    expect(addDaysISO("2027-03-14", 1)).toBe("2027-03-15");
    expect(addDaysISO("2027-11-06", 1)).toBe("2027-11-07");
    expect(addDaysISO("2027-11-07", 1)).toBe("2027-11-08");
  });

  it("a week of addDaysISO round-trips", () => {
    let d = "2026-08-07";
    for (let i = 0; i < 7; i++) d = addDaysISO(d, 1);
    expect(d).toBe("2026-08-14");
    for (let i = 0; i < 7; i++) d = addDaysISO(d, -1);
    expect(d).toBe("2026-08-07");
  });
});
