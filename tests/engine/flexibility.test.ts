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
import {
  displacedByNewAnchors,
  freedByRemovedAnchors,
  upcomingDates,
  anchorFingerprint,
  type PlannedSpan,
} from "../../main/planner.ts";

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

  it("a solo social commitment is fixed — he promised another person (2026-08-06)", () => {
    // The miss: "hangout" 16:00-19:00, typed into Google after agreeing over text. No
    // attendees, no invitation, none of the appointment vocabulary — and the day still has
    // to bend around it, because someone else is expecting him.
    expect(inferFlexibility({ title: "hangout" })).toBe("fixed");
    for (const title of [
      "Hangout with Zayn",
      "hang out",
      "Dinner with Sara",
      "Lunch with the team",
      "Coffee with Priya",
      "Drinks",
      "Birthday party",
      "Amal's birthday",
      "Wedding",
      "Basketball game",
      "Concert",
      "Date night",
    ]) {
      expect(inferFlexibility({ title }), title).toBe("fixed");
    }
  });

  it("a neutral solo event the owner created himself is preferred", () => {
    // A PLAIN SOLO BLOCK commits him to nobody, so it stays movable-under-pressure.
    expect(inferFlexibility({ title: "Reading" })).toBe("preferred");
    expect(inferFlexibility({ title: "Errands" })).toBe("preferred");
    expect(inferFlexibility({ title: "Write the draft", attendees: [{ self: true }] })).toBe("preferred");
    // word-bounded, so these are NOT obligations
    expect(inferFlexibility({ title: "Classroom refresh" })).toBe("preferred");
    expect(inferFlexibility({ title: "Overdue invoices" })).toBe("preferred");
    // …and the social words do not swallow ordinary work titles either
    expect(inferFlexibility({ title: "Third-party integration" })).toBe("preferred");
    expect(inferFlexibility({ title: "Game plan for Q3" })).toBe("preferred");
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
    // Reading (preferred) and Doctor (fixed) partially overlap → Reading is released and
    // re-placed elsewhere (any overlap displaces a preferred anchor, see above). Nothing
    // in the final schedule may overlap anything else, anchor or placed work alike.
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
  const ACCEPTED = { accepted: true };
  const DRAFT = { accepted: false };

  it("a new fixed anchor over a placed block triggers the re-plan", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60 + 30, 15 * 60)], ACCEPTED)).toEqual(["MIT"]);
  });

  it("an anchor the plan already knows about changes nothing", () => {
    expect(displacedByNewAnchors(plan, [at(9 * 60, 9 * 60 + 30, { title: "Standup" })], ACCEPTED)).toEqual([]);
  });

  it("a new anchor that lands on free time changes nothing", () => {
    expect(displacedByNewAnchors(plan, [at(11 * 60, 12 * 60)], ACCEPTED)).toEqual([]);
  });

  it("an untiered anchor counts as fixed", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: undefined })], ACCEPTED)).toEqual([
      "MIT",
    ]);
  });

  it("a locked block is never reported — re-planning cannot move it, so it must not loop", () => {
    expect(displacedByNewAnchors(plan, [at(17 * 60, 17 * 60 + 30)], ACCEPTED)).toEqual([]);
  });

  it("a rescheduled obligation reads as new", () => {
    // same title, different minutes → the plan bent around the OLD time, not this one
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { title: "Standup" })], ACCEPTED)).toEqual(["MIT"]);
  });

  // ── acceptance sets the THRESHOLD, not eligibility (2026-08-06) ────────────

  it("an UN-accepted plan re-solves on ANY new overlapping event, of any tier", () => {
    // He has not read this plan. Re-solving it costs him nothing, so a ten-minute clip of a
    // preferred event is reason enough — better fixed before he reads it than after.
    expect(displacedByNewAnchors(plan, [at(14 * 60, 14 * 60 + 10, { flexibility: "preferred" })], DRAFT)).toEqual(
      ["MIT"]
    );
    expect(displacedByNewAnchors(plan, [at(14 * 60 + 30, 15 * 60)], DRAFT)).toEqual(["MIT"]);
  });

  it("an ACCEPTED plan re-solves for a long preferred overlap — a 3h event on a work block", () => {
    // The owner's case with a title we could not classify: whatever it is called, three hours
    // sitting on top of placed work is a real conflict.
    expect(
      displacedByNewAnchors(plan, [at(16 * 60, 19 * 60, { flexibility: "preferred", title: "Hangout" })], {
        accepted: true,
      })
    ).toEqual([]); // …but only when it actually overlaps something placed
    expect(
      displacedByNewAnchors(plan, [at(13 * 60, 16 * 60, { flexibility: "preferred", title: "Hangout" })], ACCEPTED)
    ).toEqual(["MIT"]);
  });

  it("an ACCEPTED plan ignores a SHORT preferred overlap — no thrashing a day he is reading", () => {
    expect(
      displacedByNewAnchors(plan, [at(15 * 60 + 20, 15 * 60 + 30, { flexibility: "preferred" })], ACCEPTED)
    ).toEqual([]);
    // exactly at the 30-minute line it counts
    expect(
      displacedByNewAnchors(plan, [at(15 * 60, 15 * 60 + 30, { flexibility: "preferred" })], ACCEPTED)
    ).toEqual(["MIT"]);
  });

  it("a flexible anchor never triggers — that is POS's own output coming back from Google", () => {
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: "flexible" })], ACCEPTED)).toEqual([]);
    expect(displacedByNewAnchors(plan, [at(14 * 60, 15 * 60, { flexibility: "flexible" })], DRAFT)).toEqual([]);
  });

  it("a preferred anchor the solver MOVED is matched by title, not span — the loop guard", () => {
    // The plan holds "Reading" at 16:00 because the solver displaced it from 14:00. Reading
    // the 14:00 event as brand new every pass is precisely how this would loop.
    const withReading: PlannedSpan[] = [
      ...plan,
      { title: "Reading", startMin: 16 * 60, endMin: 17 * 60, isAnchor: true, isLocked: false },
    ];
    const ev = at(14 * 60, 15 * 60, { flexibility: "preferred", title: "Reading" });
    expect(displacedByNewAnchors(withReading, [ev], DRAFT)).toEqual([]);
    expect(displacedByNewAnchors(withReading, [ev], ACCEPTED)).toEqual([]);
  });
});

describe("freedByRemovedAnchors — the reverse trigger", () => {
  const plan: PlannedSpan[] = [
    { title: "Dentist appointment", startMin: 13 * 60, endMin: 15 * 60, isAnchor: true, isLocked: false, isExternal: true },
    { title: "Quick call", startMin: 16 * 60, endMin: 16 * 60 + 15, isAnchor: true, isLocked: false },
    { title: "MIT", startMin: 9 * 60, endMin: 10 * 60, isAnchor: false, isLocked: false },
    { title: "Pinned", startMin: 19 * 60, endMin: 20 * 60, isAnchor: true, isLocked: true },
  ];
  const anchor = (startMin: number, endMin: number, title: string): Anchor => ({
    startMin,
    endMin,
    blockType: "personal",
    title,
    flexibility: "fixed",
  });
  const live = [anchor(13 * 60, 15 * 60, "Dentist appointment"), anchor(16 * 60, 16 * 60 + 15, "Quick call")];

  it("reports nothing while every anchor is still on the calendar", () => {
    expect(freedByRemovedAnchors(plan, live, { accepted: true })).toEqual([]);
  });

  it("reports an anchor that has disappeared", () => {
    expect(freedByRemovedAnchors(plan, [live[1]], { accepted: true })).toEqual([
      { title: "Dentist appointment", startMin: 13 * 60, endMin: 15 * 60 },
    ]);
  });

  it("a short cancellation does not rewrite an ACCEPTED day, but does a draft", () => {
    expect(freedByRemovedAnchors(plan, [live[0]], { accepted: true })).toEqual([]); // 15 min < 45
    expect(freedByRemovedAnchors(plan, [live[0]], { accepted: false })).toEqual([
      { title: "Quick call", startMin: 16 * 60, endMin: 16 * 60 + 15 },
    ]);
  });

  it("a locked pin is never 'freed' — it is not the calendar's to cancel, and it would loop", () => {
    expect(freedByRemovedAnchors(plan, [], { accepted: true }).map((f) => f.title)).toEqual([
      "Dentist appointment",
    ]);
  });

  it("a renamed or moved event is not a cancellation — either match is enough", () => {
    // same span, new title
    expect(freedByRemovedAnchors(plan, [anchor(13 * 60, 15 * 60, "Dr. Osman"), live[1]], { accepted: true })).toEqual([]);
    // same title, new span (the solver may move a preferred anchor)
    expect(freedByRemovedAnchors(plan, [anchor(10 * 60, 12 * 60, "Dentist appointment"), live[1]], { accepted: true })).toEqual([]);
  });

  it("placed (non-anchor) work is never reported — only external anchors free time", () => {
    expect(freedByRemovedAnchors([plan[2]], [], { accepted: false })).toEqual([]);
  });
});

describe("the sweep's date window and fingerprint", () => {
  it("covers today plus the next days-1 dates, in order, across a month boundary", () => {
    expect(upcomingDates("2026-08-06", 3)).toEqual(["2026-08-06", "2026-08-07", "2026-08-08"]);
    expect(upcomingDates("2026-08-30", 3)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(upcomingDates("2026-08-06", 1)).toEqual(["2026-08-06"]);
  });

  it("the anchor fingerprint ignores order and notices every real change", () => {
    const a = { startMin: 60, endMin: 120, blockType: "personal" as const, title: "A", flexibility: "fixed" as const };
    const b = { startMin: 180, endMin: 240, blockType: "personal" as const, title: "B", flexibility: "preferred" as const };
    expect(anchorFingerprint([a, b])).toEqual(anchorFingerprint([b, a]));
    expect(anchorFingerprint([a, b])).not.toEqual(anchorFingerprint([a]));
    expect(anchorFingerprint([a])).not.toEqual(anchorFingerprint([{ ...a, endMin: 150 }]));
    expect(anchorFingerprint([a])).not.toEqual(anchorFingerprint([{ ...a, flexibility: "preferred" as const }]));
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


// ── the family-dinner regression (owner report 2026-08-07) ──────────────────
//
// "Dinner at our home- Mahimwala and frisco tins" (19:00–22:00, shared iCloud calendar
// "HYT Fam") brushed a fixed school event for 30 minutes and was relocated to 11 AM.
// Three layers had to fail at once; each is pinned here.
describe("family dinner stays a dinner", () => {
  it("his exact title is an obligation, with or without 'with'", () => {
    expect(inferFlexibility({ title: "Dinner at our home- Mahimwala and frisco tins " })).toBe("fixed");
    expect(inferFlexibility({ title: "Dinner" })).toBe("fixed");
    expect(inferFlexibility({ title: "Brunch at the Khans' place" })).toBe("fixed");
  });

  it("anything on a family/household calendar is fixed, whatever the title", () => {
    expect(inferFlexibility({ title: "thing", calendarName: "HYT Fam" })).toBe("fixed");
    expect(inferFlexibility({ title: "reading", calendarName: "Family" })).toBe("fixed");
    expect(inferFlexibility({ title: "reading", calendarName: "Household stuff" })).toBe("fixed");
    // a plain personal calendar changes nothing
    expect(inferFlexibility({ title: "reading", calendarName: "Personal" })).toBe("preferred");
  });

  it("classification is what makes two real events sit still, not the solver — correctly tagged, the dinner never moves", () => {
    // Dinner correctly reads as `fixed` now (family calendar + dinner-shaped title). Two
    // FIXED anchors are never displaced by each other, however they overlap — this is the
    // actual fix for the family-dinner incident, not a solver carve-out.
    const dinner: Anchor = {
      startMin: 19 * 60, endMin: 22 * 60, blockType: "personal",
      title: "Dinner at our home", flexibility: "fixed",
    };
    const standoff: Anchor = {
      startMin: 18 * 60, endMin: 19 * 60 + 30, blockType: "meeting",
      title: "Graduate St. Mark's standoff", flexibility: "fixed",
    };
    const r = solve([], doctrine, [dinner, standoff]);
    const d = r.blocks.find((b) => b.title === "Dinner at our home")!;
    expect(d.startMin).toBe(19 * 60);
    expect(d.endMin).toBe(22 * 60);
  });

  it("a preferred block is displaced by ANY overlap with a fixed one, partial included", () => {
    // `preferred` is reserved for solo placeholders with no obligation signal — if
    // classification ever mistags a real event as `preferred` again, the solver must not
    // paper over it by leaving a partial double-booking on the schedule. A real fixed
    // appointment landing on any part of a placeholder moves the placeholder, full stop.
    const readingBlock: Anchor = {
      startMin: 14 * 60, endMin: 15 * 60, blockType: "personal", title: "Reading", flexibility: "preferred",
    };
    const clipped: Anchor = {
      // overlaps only the last 15 minutes of Reading — a brush, not a cover
      startMin: 14 * 60 + 45, endMin: 15 * 60 + 30, blockType: "personal", title: "Doctor", flexibility: "fixed",
    };
    const r = solve([], doctrine, [readingBlock, clipped]);
    const b = r.blocks.find((x) => x.title === "Reading")!;
    expect(overlaps(b, clipped)).toBe(false);
  });

  it("full coverage still releases too — the dentist-on-reading case", () => {
    const readingBlock: Anchor = {
      startMin: 14 * 60, endMin: 15 * 60, blockType: "personal", title: "Reading", flexibility: "preferred",
    };
    const dentist: Anchor = {
      startMin: 13 * 60 + 30, endMin: 15 * 60 + 30, blockType: "personal", title: "Dentist", flexibility: "fixed",
    };
    const r = solve([], doctrine, [readingBlock, dentist]);
    const b = r.blocks.find((x) => x.title === "Reading")!;
    expect(overlaps(b, dentist)).toBe(false);
  });
});
