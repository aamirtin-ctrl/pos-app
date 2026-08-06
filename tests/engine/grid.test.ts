// Phase 3 gate: given a wake time and 3 anchors, the grid renders with correct
// capacity scores and eligibility masks.

import { describe, it, expect } from "vitest";
import {
  parseDoctrine, DEFAULT_DOCTRINE_YAML, capacityAt, bufferedMinutes, shutdownStartMin,
} from "../../main/engine/doctrine.ts";
import { buildGrid, type Anchor } from "../../main/engine/grid.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const W = 7 * 60 + 30; // wake 07:30 in minutes

describe("doctrine", () => {
  it("parses the shipped default with wake 07:30", () => {
    expect(doctrine.chronotype.wake_time).toBe("07:30");
    expect(doctrine.hard_constraints.max_deep_work_minutes_per_day).toBe(240);
  });

  it("interpolates capacity linearly and clamps at the edges", () => {
    expect(capacityAt(doctrine, 0)).toBe(20);
    expect(capacityAt(doctrine, 3.5)).toBe(100);
    // midpoint of (2.0, 88) → (3.5, 100): t=0.5 → 94
    expect(capacityAt(doctrine, 2.75)).toBeCloseTo(94, 5);
    expect(capacityAt(doctrine, 99)).toBe(20); // clamp beyond last point
  });

  it("applies planning-fallacy buffer, capped, rounded up to 15", () => {
    expect(bufferedMinutes(doctrine, "deep_work", 120)).toBe(150); // 120*1.25
    expect(bufferedMinutes(doctrine, "admin", 30)).toBe(45); // 30*1.15=34.5 → ceil15 = 45
    expect(bufferedMinutes(doctrine, "meeting", 30)).toBe(30); // ×1.0
    expect(bufferedMinutes(doctrine, "unknown_type", 60)).toBe(75); // default 25%
  });
});

describe("buildGrid (Phase 3 gate)", () => {
  const anchors: Anchor[] = [
    { startMin: 10 * 60, endMin: 11 * 60, blockType: "meeting", title: "Standup" },
    { startMin: 14 * 60, endMin: 15 * 60, blockType: "meeting", title: "1:1" },
    { startMin: 18 * 60, endMin: 19 * 60, blockType: "personal", title: "Dinner w/ folks" },
  ];
  const grid = buildGrid(doctrine, anchors);

  it("generates 15-min slots from wake to sleep", () => {
    expect(grid.wakeMin).toBe(W);
    expect(grid.sleepMin).toBe(23 * 60);
    expect(grid.slots.length).toBe((23 * 60 - W) / 15); // 62 slots
    expect(grid.slots[0].startMin).toBe(W);
  });

  it("marks anchor-occupied slots as not free and never eligible", () => {
    const inMeeting = grid.slots.find((s) => s.startMin === 10 * 60)!;
    expect(inMeeting.free).toBe(false);
    expect(Object.values(inMeeting.eligible).every((v) => v === false)).toBe(true);
  });

  it("scores capacity from the energy curve at each slot", () => {
    const s = grid.slots.find((x) => x.hoursAfterWake === 3.5)!; // 11:00
    expect(s.capacity).toBe(100);
  });

  it("first hour after wake is ineligible for cognitive work but fine for gym/meal", () => {
    const early = grid.slots[1]; // 07:45, hoursAfterWake 0.25
    expect(early.eligible.deep_work).toBe(false);
    expect(early.eligible.admin).toBe(false);
    expect(early.eligible.meal).toBe(true);
  });

  it("slot immediately after a meeting is ineligible for deep_work (attention residue)", () => {
    const after = grid.slots.find((s) => s.startMin === 11 * 60)!;
    expect(after.afterMeeting).toBe(true);
    expect(after.eligible.deep_work).toBe(false);
    expect(after.eligible.admin).toBe(true); // only deep work is banned there
  });

  it("gym ineligible when it would end < 3h before sleep; comms < 2h", () => {
    const late = grid.slots.find((s) => s.startMin === 21 * 60)!; // ends 21:15, 1.75h to sleep
    expect(late.eligible.gym).toBe(false);
    expect(late.eligible.comms).toBe(false);
    const eightPm = grid.slots.find((s) => s.startMin === 19 * 60 + 45)!; // ends 20:00, 3h
    expect(eightPm.eligible.gym).toBe(true);
  });

  // Owner report 2026-08-05: shutdown fired at ~19:30, then 2.5h of "free time", then a
  // task at 22:15–23:00. Shutdown means the work day is CLOSED.
  describe("shutdown closes the work day", () => {
    it("shipped default puts the boundary 2.5h before sleep (20:30)", () => {
      expect(shutdownStartMin(doctrine)).toBe(20 * 60 + 30);
      expect(grid.shutdownMin).toBe(20 * 60 + 30);
    });

    it("no work type is eligible at or after the boundary", () => {
      const after = grid.slots.filter((s) => s.startMin >= 20 * 60 + 30);
      expect(after.length).toBeGreaterThan(0);
      for (const s of after) {
        for (const t of ["deep_work", "focused_work", "admin", "comms", "meeting"] as const) {
          expect(s.eligible[t], `${t} at ${s.startMin}`).toBe(false);
        }
      }
    });

    it("the last slot BEFORE the boundary is still open for work", () => {
      const last = grid.slots.find((s) => s.startMin === 20 * 60 + 15)!;
      expect(last.eligible.focused_work).toBe(true);
      expect(last.eligible.admin).toBe(true);
      expect(last.eligible.meeting).toBe(true);
    });

    it("personal, meal and break stay legal after the boundary", () => {
      const evening = grid.slots.find((s) => s.startMin === 21 * 60)!;
      expect(evening.eligible.personal).toBe(true);
      expect(evening.eligible.meal).toBe(true);
      expect(evening.eligible.break).toBe(true);
      expect(evening.eligible.transition).toBe(true);
      // Gym is life, not work, so the boundary does not touch it — but its OWN rule
      // (end ≥3h before sleep) still applies, and at 21:00 that is what rejects it.
      expect(evening.eligible.gym).toBe(false);
    });

    it("gym remains eligible after an early boundary — the ban is on work, not on the evening", () => {
      // Shutdown 5h before sleep = 18:00, leaving post-boundary slots that clear the 3h gym floor.
      const early = parseDoctrine(
        DEFAULT_DOCTRINE_YAML.replace("before_sleep_hours: 2.5", "before_sleep_hours: 5.0")
      );
      const g = buildGrid(early, []);
      expect(g.shutdownMin).toBe(18 * 60);
      const s = g.slots.find((x) => x.startMin === 18 * 60 + 30)!; // after the boundary, 4.25h to sleep
      expect(s.eligible.gym).toBe(true);
      expect(s.eligible.personal).toBe(true);
      expect(s.eligible.deep_work).toBe(false);
      expect(s.eligible.admin).toBe(false);
    });

    it("a doctrine with no shutdown ritual bans nothing (boundary is null)", () => {
      const none = parseDoctrine(
        DEFAULT_DOCTRINE_YAML.replace(/^\s*- \{ type: shutdown.*$/m, "")
      );
      expect(shutdownStartMin(none)).toBeNull();
      const g = buildGrid(none, []);
      expect(g.shutdownMin).toBeNull();
      expect(g.slots.find((s) => s.startMin === 21 * 60)!.eligible.focused_work).toBe(true);
    });
  });

  it("computes contiguous free runs and physical peak", () => {
    const beforeMeeting = grid.slots.find((s) => s.startMin === 10 * 60 - 15)!;
    expect(beforeMeeting.contiguousFreeAfter).toBe(15);
    const peakSlot = grid.slots.find((s) => s.hoursAfterWake === 8)!; // 15:30
    expect(peakSlot.inPhysicalPeak).toBe(true);
  });
});
