// Three-tier event flexibility (owner ask 2026-08-05):
//   "Sometimes I add Google Calendar events after the fact — typically that means it's
//    something I have to go to, and my calendar should adjust around it. The app should
//    know which events can be moved, which shouldn't be, and which it should try not to."
//
// Two halves: what tier an external event gets (inferFlexibility), and what the solver
// does with each tier (fixed immovable, preferred displaceable-under-pressure, flexible
// re-placed freely) — including that displacement stays deterministic.

import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { solve, type PlannerTask } from "../../main/engine/solver.ts";
import { flexibilityOf, type Anchor } from "../../main/engine/grid.ts";
import { inferFlexibility, looksLikeObligation, POS_CALENDAR_NAME } from "../../main/gcal/sync.ts";
import { displacedByNewAnchors, type PlannedSpan } from "../../main/planner.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const W = 7 * 60 + 30; // wake 07:30
const SLEEP = 23 * 60;

let nextId = 1;
function mkTask(p: Partial<PlannerTask> & { blockType: PlannerTask["blockType"] }): PlannerTask {
  return {
    id: nextId++,
    title: p.title ?? `task-${nextId}`,
    blockType: p.blockType,
    cognitiveLoad: p.cognitiveLoad ?? 3,
    estimatedMinutes: p.estimatedMinutes ?? 60,
    isMit: p.isMit ?? false,
    deadlineMin: p.deadlineMin ?? null,
    project: p.project ?? null,
    splittable: p.splittable ?? false,
  };
}

const overlaps = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) =>
  a.startMin < b.endMin && a.endMin > b.startMin;

// ── 1. inference ─────────────────────────────────────────────────────────────

describe("inferFlexibility", () => {
  it("an event with other attendees is fixed", () => {
    expect(
      inferFlexibility({ title: "Design review", attendees: [{ self: true }, { self: false }] })
    ).toBe("fixed");
  });

  it("an accepted invitation is fixed", () => {
    expect(inferFlexibility({ title: "Coffee", responseStatus: "accepted" })).toBe("fixed");
    expect(
      inferFlexibility({ title: "Coffee", attendees: [{ self: true, responseStatus: "accepted" }] })
    ).toBe("fixed");
  });

  it("a solo event whose title reads like an obligation is fixed — the owner's own case", () => {
    // He types this into Google himself, after the fact. No attendees, no invitation.
    // It is still something he has to go to, so the day bends around it.
    expect(inferFlexibility({ title: "Dentist appointment" })).toBe("fixed");
    for (const title of [
      "CS229 lecture",
      "Physics class",
      "Midterm exam",
      "Interview with Acme",
      "Flight to SFO",
      "Doctor",
      "Meeting with Priya",
      "1:1",
      "Call with the bank",
      "Grant deadline",
      "Paper due",
    ]) {
      expect(inferFlexibility({ title }), title).toBe("fixed");
    }
  });

  it("a neutral solo event the owner created himself is preferred", () => {
    expect(inferFlexibility({ title: "Reading" })).toBe("preferred");
    expect(inferFlexibility({ title: "Write the draft", attendees: [{ self: true }] })).toBe("preferred");
    // word-bounded, so these are NOT obligations
    expect(inferFlexibility({ title: "Classroom refresh" })).toBe("preferred");
    expect(inferFlexibility({ title: "Overdue invoices" })).toBe("preferred");
    expect(looksLikeObligation("Reading")).toBe(false);
  });

  it("anything on a POS-authored calendar is flexible — the planner owns it", () => {
    expect(inferFlexibility({ title: "Deep work", calendarName: POS_CALENDAR_NAME })).toBe("flexible");
    expect(inferFlexibility({ title: "Dinner", calendarName: "POS — From Messages" })).toBe("flexible");
    // …and the POS calendar wins even over an obligation title, because we wrote it.
    expect(inferFlexibility({ title: "Dentist appointment", calendarName: POS_CALENDAR_NAME })).toBe(
      "flexible"
    );
  });

  it("a source that already called it a meeting is fixed (Apple/ICS have no attendee list)", () => {
    expect(inferFlexibility({ title: "Standup", blockType: "meeting" })).toBe("fixed");
    expect(inferFlexibility({ title: "Standup", blockType: "personal" })).toBe("preferred");
  });

  it("an untiered anchor defaults to fixed — the pre-flexibility behavior", () => {
    expect(flexibilityOf({})).toBe("fixed");
    expect(flexibilityOf({ flexibility: "preferred" })).toBe("preferred");
  });
});

// ── 2. solver semantics ──────────────────────────────────────────────────────

describe("solver — fixed anchors are immovable", () => {
  it("a fixed anchor keeps its exact minutes and nothing overlaps it", () => {
    const dentist: Anchor = {
      startMin: 13 * 60,
      endMin: 14 * 60,
      blockType: "personal",
      title: "Dentist appointment",
      flexibility: "fixed",
    };
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "focused_work", estimatedMinutes: 60, title: "focus" }),
      mkTask({ blockType: "admin", estimatedMinutes: 45, title: "admin" }),
    ];
    const r = solve(ts, doctrine, [dentist]);

    const placed = r.blocks.filter((b) => b.title === "Dentist appointment");
    expect(placed).toHaveLength(1);
    expect(placed[0].startMin).toBe(13 * 60);
    expect(placed[0].endMin).toBe(14 * 60);
    expect(placed[0].isAnchor).toBe(true);
    expect(placed[0].flexibility).toBe("fixed");
    for (const b of r.blocks) {
      if (b === placed[0]) continue;
      expect(overlaps(b, dentist), `"${b.title}" overlaps the fixed anchor`).toBe(false);
    }
    expect(r.notes.some((n) => /^Moved /.test(n))).toBe(false);
  });
});

describe("solver — preferred blocks", () => {
  const reading = (startMin: number, endMin: number): Anchor => ({
    startMin,
    endMin,
    blockType: "personal",
    title: "Reading",
    flexibility: "preferred",
  });

  it("is NOT displaced when nothing needs its slot", () => {
    const r = solve([mkTask({ blockType: "admin", estimatedMinutes: 30 })], doctrine, [
      reading(14 * 60, 15 * 60),
    ]);
    const b = r.blocks.find((x) => x.title === "Reading")!;
    expect(b).toBeTruthy();
    expect(b.startMin).toBe(14 * 60); // exactly where the owner put it
    expect(b.endMin).toBe(15 * 60);
    expect(b.isAnchor).toBe(true);
    expect(b.flexibility).toBe("preferred");
    expect(r.notes.some((n) => /Moved "Reading"/.test(n))).toBe(false);
    expect(r.unplaced).toHaveLength(0);
  });

  it("IS displaced to make room for a fixed anchor landing on it, with a note", () => {
    // The owner adds "Dentist appointment" to Google after the fact, on top of his
    // self-scheduled reading block. The obligation stays put; the reading block moves.
    const dentist: Anchor = {
      startMin: 14 * 60,
      endMin: 15 * 60,
      blockType: "personal",
      title: "Dentist appointment",
      flexibility: "fixed",
    };
    const r = solve([], doctrine, [reading(14 * 60, 15 * 60), dentist]);

    const d = r.blocks.find((b) => b.title === "Dentist appointment")!;
    expect(d.startMin).toBe(14 * 60);
    expect(d.endMin).toBe(15 * 60);

    const b = r.blocks.find((x) => x.title === "Reading")!;
    expect(b, "the displaced block is re-placed, not dropped").toBeTruthy();
    expect(b.startMin).not.toBe(14 * 60);
    expect(b.endMin - b.startMin).toBe(60); // same duration
    expect(overlaps(b, dentist)).toBe(false);
    expect(b.flexibility).toBe("preferred"); // still the owner's, still displaceable
    // nearest legal window to where it was — 15:00, right after the appointment
    expect(b.startMin).toBe(15 * 60);
    expect(
      r.notes.some((n) => /Moved "Reading" to 15:00 to make room for "Dentist appointment"/.test(n)),
      `notes were: ${JSON.stringify(r.notes)}`
    ).toBe(true);
  });

  it("IS released on the second pass when a task would otherwise be unplaced", () => {
    // Fixed walls everywhere except 10:00–14:00, and that window is a preferred block.
    // Pass 1 leaves the task with nowhere to go; pass 2 releases the block and seats it.
    const anchors: Anchor[] = [
      { startMin: W, endMin: 10 * 60, blockType: "personal", title: "out", flexibility: "fixed" },
      reading(10 * 60, 14 * 60),
      { startMin: 14 * 60, endMin: SLEEP, blockType: "personal", title: "out again", flexibility: "fixed" },
    ];
    const t = mkTask({ blockType: "focused_work", estimatedMinutes: 60, title: "ship the deck" });

    const before = solve(
      [t],
      doctrine,
      anchors.map((a) => (a.title === "Reading" ? { ...a, flexibility: "fixed" as const } : a))
    );
    expect(before.unplaced, "sanity: as a FIXED block it strands the task").toHaveLength(1);

    const r = solve([t], doctrine, anchors);
    const placed = r.blocks.find((b) => b.taskId === t.id);
    expect(placed, "the task the day had to seat").toBeTruthy();
    expect(placed!.startMin).toBeGreaterThanOrEqual(10 * 60);
    expect(placed!.endMin).toBeLessThanOrEqual(14 * 60);
    expect(r.unplaced).toHaveLength(0);
    // and the displacement is explained rather than silent
    expect(r.notes.some((n) => /Reading/.test(n)), `notes were: ${JSON.stringify(r.notes)}`).toBe(true);
  });

  it("a flexible anchor is re-placed freely — the planner owns those minutes", () => {
    const posBlock: Anchor = {
      startMin: 14 * 60,
      endMin: 15 * 60,
      blockType: "focused_work",
      title: "POS block",
      flexibility: "flexible",
    };
    const dentist: Anchor = {
      startMin: 14 * 60,
      endMin: 15 * 60,
      blockType: "personal",
      title: "Dentist appointment",
      flexibility: "fixed",
    };
    const r = solve([], doctrine, [posBlock, dentist]);
    const b = r.blocks.find((x) => x.title === "POS block")!;
    expect(b).toBeTruthy();
    expect(overlaps(b, dentist)).toBe(false);
    expect(b.flexibility).toBe("flexible");
    // planner output moving is not news — no note is emitted for it
    expect(r.notes.some((n) => /Moved "POS block"/.test(n))).toBe(false);
  });
});

describe("solver — determinism with preferred blocks present", () => {
  it("same input twice → identical output", () => {
    const anchors: Anchor[] = [
      { startMin: 9 * 60, endMin: 10 * 60, blockType: "meeting", title: "Standup", flexibility: "fixed" },
      { startMin: 11 * 60, endMin: 12 * 60, blockType: "personal", title: "Reading", flexibility: "preferred" },
      { startMin: 14 * 60, endMin: 15 * 60, blockType: "personal", title: "Guitar", flexibility: "preferred" },
      { startMin: 16 * 60, endMin: 17 * 60, blockType: "personal", title: "Dentist appointment", flexibility: "fixed" },
      { startMin: 16 * 60 + 30, endMin: 17 * 60 + 30, blockType: "personal", title: "Errand", flexibility: "preferred" },
    ];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 120, cognitiveLoad: 4, title: "deep A" }),
      mkTask({ blockType: "focused_work", estimatedMinutes: 90, title: "focus A" }),
      mkTask({ blockType: "focused_work", estimatedMinutes: 90, title: "focus B" }),
      mkTask({ blockType: "admin", estimatedMinutes: 45, project: "ops", title: "admin 1" }),
      mkTask({ blockType: "comms", estimatedMinutes: 25, title: "comms 1" }),
    ];
    const r1 = solve(ts, doctrine, anchors);
    const r2 = solve(ts, doctrine, anchors);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));

    // …and re-ordering the anchor list does not change the day either: the tiers are
    // partitioned and sorted before anything is placed.
    const r3 = solve(ts, doctrine, [...anchors].reverse());
    expect(JSON.stringify(r3)).toBe(JSON.stringify(r1));
  });

  it("the day is still a partition — displacement never double-books a minute", () => {
    const anchors: Anchor[] = [
      { startMin: 13 * 60, endMin: 14 * 60, blockType: "personal", title: "Reading", flexibility: "preferred" },
      { startMin: 13 * 60 + 30, endMin: 14 * 60 + 30, blockType: "personal", title: "Doctor", flexibility: "fixed" },
    ];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, title: "admin" }),
      mkTask({ blockType: "gym", estimatedMinutes: 60, title: "Gym" }),
    ];
    const r = solve(ts, doctrine, anchors);
    const sorted = [...r.blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      expect(
        cur.startMin,
        `"${cur.title}" (${cur.startMin}-${cur.endMin}) overlaps "${prev.title}" (${prev.startMin}-${prev.endMin})`
      ).toBeGreaterThanOrEqual(prev.endMin);
    }
  });

  it("every block carries a tier, and planner-placed blocks are flexible", () => {
    const r = solve([mkTask({ blockType: "admin", estimatedMinutes: 30, title: "admin" })], doctrine, [
      { startMin: 13 * 60, endMin: 14 * 60, blockType: "personal", title: "Doctor", flexibility: "fixed" },
    ]);
    for (const b of r.blocks) {
      expect(b.flexibility, b.title).toBeTruthy();
      if (!b.isAnchor) expect(b.flexibility, b.title).toBe("flexible");
    }
  });
});

// ── 3. re-solving an accepted day when a new obligation lands on it ──────────

describe("displacedByNewAnchors — the re-plan trigger", () => {
  const plan: PlannedSpan[] = [
    { title: "Standup", startMin: 9 * 60, endMin: 9 * 60 + 30, isAnchor: true, isLocked: false },
    { title: "MIT", startMin: 14 * 60, endMin: 15 * 60 + 30, isAnchor: false, isLocked: false },
    { title: "Pinned call", startMin: 17 * 60, endMin: 18 * 60, isAnchor: false, isLocked: true },
  ];
  const at = (startMin: number, endMin: number, over: Partial<Anchor> = {}): Anchor => ({
    startMin,
    endMin,
    blockType: "personal",
    title: "Dentist appointment",
    flexibility: "fixed",
    ...over,
  });

  it("a new fixed anchor over a placed block triggers the re-plan", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60 + 30, 15 * 60)])).toEqual(["MIT"]);
  });

  it("an anchor the plan already knows about changes nothing", () => {
    expect(displacedByNewAnchors(plan, [at(9 * 60, 9 * 60 + 30, { title: "Standup" })])).toEqual([]);
  });

  it("a new anchor that lands on free time changes nothing", () => {
    expect(displacedByNewAnchors(plan, [at(11 * 60, 12 * 60)])).toEqual([]);
  });

  it("a preferred event does not disturb an accepted day — the solver can bend around it", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: "preferred" })])).toEqual([]);
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: "flexible" })])).toEqual([]);
  });

  it("an untiered anchor counts as fixed", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: undefined })])).toEqual(["MIT"]);
  });

  it("a locked block is never reported — re-planning cannot move it, so it must not loop", () => {
    expect(displacedByNewAnchors(plan, [at(17 * 60, 17 * 60 + 30)])).toEqual([]);
  });

  it("a rescheduled obligation reads as new", () => {
    // same title, different minutes → the plan bent around the OLD time, not this one
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { title: "Standup" })])).toEqual(["MIT"]);
  });
});

describe("solver — tiers on every block (regression guard)", () => {
  it("every block carries a tier, and planner-placed blocks are flexible", () => {
    const r = solve([mkTask({ blockType: "admin", estimatedMinutes: 30, title: "admin" })], doctrine, [
      { startMin: 13 * 60, endMin: 14 * 60, blockType: "personal", title: "Doctor", flexibility: "fixed" },
    ]);
    for (const b of r.blocks) {
      expect(b.flexibility, b.title).toBeTruthy();
      if (!b.isAnchor) expect(b.flexibility, b.title).toBe("flexible");
    }
  });
});
