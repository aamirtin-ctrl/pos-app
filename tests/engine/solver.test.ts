// Phase 4 gate tests (§9) — written BEFORE the solver, per spec. Non-negotiable list:
// >120min deep rejected; 6h deep → 4h placed + exceeded_deep_work_cap; no deep in first
// hour; gym 2h/3h/4h before sleep; 5 scattered meetings → ≤2 clusters + transitions;
// no deep right after a meeting cluster; zero free slots → no crash; determinism.

import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML, shutdownStartMin } from "../../main/engine/doctrine.ts";
import { solve, type PlannerTask } from "../../main/engine/solver.ts";
import type { Anchor } from "../../main/engine/grid.ts";

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

/** Group placed meeting blocks into clusters: gap ≤ 45 min → same cluster. */
function meetingClusters(blocks: { blockType: string; startMin: number; endMin: number }[]) {
  const meetings = blocks.filter((b) => b.blockType === "meeting").sort((a, b) => a.startMin - b.startMin);
  const clusters: { start: number; end: number }[] = [];
  for (const m of meetings) {
    const last = clusters[clusters.length - 1];
    if (last && m.startMin - last.end <= 45) last.end = Math.max(last.end, m.endMin);
    else clusters.push({ start: m.startMin, end: m.endMin });
  }
  return clusters;
}

describe("solver — §9 gate", () => {
  it("rejects an unsplittable deep work block > 120 min", () => {
    const t = mkTask({ blockType: "deep_work", estimatedMinutes: 150, splittable: false, cognitiveLoad: 5 });
    const r = solve([t], doctrine, []);
    expect(r.blocks.filter((b) => b.taskId === t.id)).toHaveLength(0);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].reason).toBe("exceeded_deep_work_cap");
  });

  it("splits a splittable 3h deep task into 90+90 with a break between", () => {
    const t = mkTask({ blockType: "deep_work", estimatedMinutes: 180, splittable: true, cognitiveLoad: 5 });
    const r = solve([t], doctrine, []);
    const chunks = r.blocks.filter((b) => b.taskId === t.id);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.endMin - c.startMin).toBeLessThanOrEqual(120);
    expect(chunks.reduce((s, c) => s + (c.endMin - c.startMin), 0)).toBe(180);
    // a break (or larger gap) separates the two chunks — never back-to-back
    const [a, b] = chunks.sort((x, y) => x.startMin - y.startMin);
    expect(b.startMin - a.endMin).toBeGreaterThanOrEqual(15);
  });

  it("4 deep tasks totaling 480min → exactly 240 placed, remainder exceeded_deep_work_cap", () => {
    const ts = [1, 2, 3, 4].map(() =>
      mkTask({ blockType: "deep_work", estimatedMinutes: 120, cognitiveLoad: 5, splittable: false })
    );
    const r = solve(ts, doctrine, []);
    const deepMinutes = r.blocks
      .filter((b) => b.blockType === "deep_work")
      .reduce((s, b) => s + (b.endMin - b.startMin), 0);
    expect(deepMinutes).toBe(240);
    const capped = r.unplaced.filter((u) => u.reason === "exceeded_deep_work_cap");
    expect(capped).toHaveLength(2);
  });

  it("never places deep work in the first hour after wake", () => {
    const ts = [1, 2, 3].map((i) =>
      mkTask({ blockType: "deep_work", estimatedMinutes: 60, cognitiveLoad: 5, isMit: i === 1 })
    );
    const r = solve(ts, doctrine, []);
    for (const b of r.blocks.filter((x) => x.blockType === "deep_work")) {
      expect(b.startMin).toBeGreaterThanOrEqual(W + 60);
    }
  });

  describe("gym end-before-sleep rule", () => {
    // Free only [freeStart, freeEnd); everything else anchored.
    const wall = (freeStart: number, freeEnd: number): Anchor[] => [
      { startMin: W, endMin: freeStart, blockType: "personal", title: "busy" },
      { startMin: freeEnd, endMin: SLEEP, blockType: "personal", title: "busy" },
    ];
    const gym = () => mkTask({ blockType: "gym", estimatedMinutes: 45 });

    it("2h before sleep → rejected", () => {
      const r = solve([gym()], doctrine, wall(20 * 60, 21 * 60)); // ends ≤21:00 → <3h
      expect(r.blocks.filter((b) => b.blockType === "gym")).toHaveLength(0);
      expect(r.unplaced[0]?.reason).toBe("no_eligible_slot");
    });

    it("3h before sleep → allowed with penalty note", () => {
      const r = solve([gym()], doctrine, wall(19 * 60, 20 * 60));
      const g = r.blocks.find((b) => b.blockType === "gym");
      expect(g).toBeTruthy();
      expect(g!.endMin).toBeLessThanOrEqual(20 * 60);
      expect(r.notes.some((n) => /gym/i.test(n) && /4h/.test(n))).toBe(true);
    });

    it("4h before sleep → allowed clean", () => {
      const r = solve([gym()], doctrine, wall(17 * 60, 19 * 60 + 15));
      const g = r.blocks.find((b) => b.blockType === "gym");
      expect(g).toBeTruthy();
      expect(g!.endMin).toBeLessThanOrEqual(19 * 60);
      expect(r.notes.some((n) => /gym/i.test(n) && /4h/.test(n))).toBe(false);
    });
  });

  it("5 scattered movable meetings → ≤2 clusters with transitions inserted", () => {
    const anchors: Anchor[] = [9, 11, 13.5, 15, 17].map((h, i) => ({
      startMin: Math.round(h * 60),
      endMin: Math.round(h * 60) + 30,
      blockType: "meeting",
      title: `mtg-${i}`,
      movable: true,
    }));
    const r = solve([], doctrine, anchors);
    const placedMeetings = r.blocks.filter((b) => b.blockType === "meeting");
    expect(placedMeetings).toHaveLength(5);
    const clusters = meetingClusters(r.blocks);
    expect(clusters.length).toBeLessThanOrEqual(2);
    // transitions flank each cluster
    const transitions = r.blocks.filter((b) => b.blockType === "transition");
    expect(transitions.length).toBeGreaterThanOrEqual(clusters.length);
  });

  it("no deep work in the slot immediately after a meeting", () => {
    const anchors: Anchor[] = [
      { startMin: 10 * 60, endMin: 11 * 60, blockType: "meeting", title: "board" },
    ];
    const ts = [1, 2, 3, 4].map(() =>
      mkTask({ blockType: "deep_work", estimatedMinutes: 60, cognitiveLoad: 5 })
    );
    const r = solve(ts, doctrine, anchors);
    for (const b of r.blocks.filter((x) => x.blockType === "deep_work")) {
      expect(b.startMin).not.toBe(11 * 60);
    }
  });

  it("zero free slots → all tasks unplaced with reasons, plan produced, no crash", () => {
    const anchors: Anchor[] = [{ startMin: W, endMin: SLEEP, blockType: "personal", title: "slammed" }];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90 }),
      mkTask({ blockType: "admin", estimatedMinutes: 30 }),
    ];
    const r = solve(ts, doctrine, anchors);
    expect(r.unplaced).toHaveLength(2);
    for (const u of r.unplaced) expect(u.reason).toBe("no_eligible_slot");
    expect(r.notes.length).toBeGreaterThan(0); // rituals couldn't place either
  });

  it("hard deadline that cannot be met → deadline_conflict", () => {
    // Cognitive work can't start before 08:30; a 60-min task due 08:15 can never finish in time.
    const t = mkTask({ blockType: "focused_work", estimatedMinutes: 60, deadlineMin: W + 45 });
    const r = solve([t], doctrine, []);
    expect(r.unplaced[0]?.reason).toBe("deadline_conflict");
  });

  it("same input twice → identical output (deterministic)", () => {
    const anchors: Anchor[] = [
      { startMin: 10 * 60, endMin: 10 * 60 + 30, blockType: "meeting", title: "standup" },
      { startMin: 15 * 60, endMin: 15 * 60 + 30, blockType: "meeting", title: "1:1", movable: true },
    ];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, splittable: true }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 60, cognitiveLoad: 4 }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, project: "ops" }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, project: "ops" }),
      mkTask({ blockType: "gym", estimatedMinutes: 75 }),
      mkTask({ blockType: "comms", estimatedMinutes: 25 }),
    ];
    const r1 = solve(ts, doctrine, anchors);
    const r2 = solve(ts, doctrine, anchors);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("MIT lands in the highest-capacity eligible window", () => {
    const mit = mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5 });
    const r = solve([mit], doctrine, []);
    const b = r.blocks.find((x) => x.taskId === mit.id)!;
    expect(b).toBeTruthy();
    // Peak capacity is 3.5h after wake (11:00); a 90-min MIT should overlap the 10:00–12:00 core.
    expect(b.startMin).toBeGreaterThanOrEqual(9 * 60 + 30);
    expect(b.startMin).toBeLessThanOrEqual(12 * 60);
  });

  it("a full day of blocks never double-books a single minute", () => {
    // A rich day: MIT + 2 deep work + gym + 3 admin + 2 meeting anchors, on top of
    // the doctrine's own fixed rituals, breaks and cluster transitions. Whatever the
    // solver returns has to be a partition of the day — the calendar paints these
    // blocks by clock time, so any overlap here is an overlap the owner sees.
    const anchors: Anchor[] = [
      { startMin: 10 * 60, endMin: 10 * 60 + 30, blockType: "meeting", title: "standup" },
      { startMin: 15 * 60, endMin: 16 * 60, blockType: "meeting", title: "partner sync", movable: true },
    ];
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 60, cognitiveLoad: 4, title: "deep A" }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 60, cognitiveLoad: 3, title: "deep B" }),
      mkTask({ blockType: "gym", estimatedMinutes: 60, title: "Gym" }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, project: "ops", title: "admin 1" }),
      mkTask({ blockType: "admin", estimatedMinutes: 30, project: "ops", title: "admin 2" }),
      mkTask({ blockType: "admin", estimatedMinutes: 15, title: "admin 3" }),
    ];
    const r = solve(ts, doctrine, anchors);
    // sanity: this really is a full day, not an empty result trivially passing
    expect(r.blocks.length).toBeGreaterThanOrEqual(10);
    expect(r.blocks.some((b) => b.blockType === "break")).toBe(true);
    expect(r.blocks.some((b) => b.blockType === "transition")).toBe(true);

    const sorted = [...r.blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    for (const b of sorted) expect(b.endMin).toBeGreaterThan(b.startMin); // no zero-length cards
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      expect(
        cur.startMin,
        `"${cur.title}" (${cur.startMin}-${cur.endMin}) overlaps "${prev.title}" (${prev.startMin}-${prev.endMin})`
      ).toBeGreaterThanOrEqual(prev.endMin);
    }
  });

  // Flexibility (2026-08-05) added a third state to a binary model. An anchor that names
  // no tier is still an anchor in the old sense — this pins that, so the three-tier work
  // cannot quietly change what every existing call site already does.
  it("an anchor with no flexibility behaves exactly as an explicitly fixed one", () => {
    const bare: Anchor[] = [
      { startMin: 10 * 60, endMin: 10 * 60 + 30, blockType: "meeting", title: "standup" },
      { startMin: 13 * 60, endMin: 14 * 60, blockType: "personal", title: "Dentist appointment" },
      { startMin: 15 * 60, endMin: 15 * 60 + 30, blockType: "meeting", title: "1:1", movable: true },
    ];
    const tagged: Anchor[] = bare.map((a) => ({ ...a, flexibility: "fixed" as const }));
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 90, isMit: true, cognitiveLoad: 5, title: "MIT" }),
      mkTask({ blockType: "focused_work", estimatedMinutes: 60, title: "focus" }),
      mkTask({ blockType: "admin", estimatedMinutes: 45, project: "ops", title: "admin" }),
      mkTask({ blockType: "gym", estimatedMinutes: 60, title: "Gym" }),
    ];
    const untagged = solve(ts, doctrine, bare);
    expect(JSON.stringify(untagged)).toBe(JSON.stringify(solve(ts, doctrine, tagged)));

    // and the untiered anchors are immovable, occupying exactly their own minutes
    const dentist = untagged.blocks.find((b) => b.title === "Dentist appointment")!;
    expect(dentist.startMin).toBe(13 * 60);
    expect(dentist.endMin).toBe(14 * 60);
    expect(dentist.isAnchor).toBe(true);
    for (const b of untagged.blocks) {
      if (b === dentist) continue;
      expect(b.startMin < dentist.endMin && b.endMin > dentist.startMin, `"${b.title}" overlaps`).toBe(false);
    }
    // nothing was displaced — there is nothing displaceable in a fixed-only day
    expect(untagged.notes.some((n) => /^Moved /.test(n))).toBe(false);
  });

  it("breaks are inserted after deep work blocks", () => {
    const t = mkTask({ blockType: "deep_work", estimatedMinutes: 90, cognitiveLoad: 5 });
    const r = solve([t], doctrine, []);
    const deep = r.blocks.find((b) => b.taskId === t.id)!;
    const brk = r.blocks.find((b) => b.blockType === "break" && b.startMin === deep.endMin);
    expect(brk).toBeTruthy();
  });
});

// Owner report 2026-08-05: "shutdown at ~19:30, then 2.5h of free time, then another task
// at 22:15–23:00." Shutdown is a BOUNDARY — after it the work day is closed.
describe("solver — shutdown is a hard end-of-work boundary", () => {
  const SHUTDOWN = shutdownStartMin(doctrine)!; // 20:30 with the shipped default
  const WORK = ["deep_work", "focused_work", "admin", "comms", "meeting"];

  it("the shutdown ritual itself lands on the boundary", () => {
    const r = solve([], doctrine, []);
    const sd = r.blocks.find((b) => b.blockType === "shutdown");
    expect(sd).toBeTruthy();
    expect(sd!.startMin).toBe(SHUTDOWN);
  });

  it("a heavy day never starts a work block at or after shutdown", () => {
    // Far more work than the day can hold, of every work type, so the solver is under
    // maximum pressure to spill into the evening.
    const ts = [
      mkTask({ blockType: "deep_work", estimatedMinutes: 120, cognitiveLoad: 5, isMit: true }),
      mkTask({ blockType: "deep_work", estimatedMinutes: 120, cognitiveLoad: 4 }),
      ...[1, 2, 3, 4].map((i) => mkTask({ blockType: "focused_work", estimatedMinutes: 90, title: `focus ${i}` })),
      ...[1, 2, 3, 4].map((i) => mkTask({ blockType: "admin", estimatedMinutes: 45, title: `admin ${i}` })),
      ...[1, 2].map((i) => mkTask({ blockType: "comms", estimatedMinutes: 25, title: `comms ${i}` })),
    ];
    const r = solve(ts, doctrine, []);
    const work = r.blocks.filter((b) => WORK.includes(b.blockType));
    expect(work.length).toBeGreaterThan(3); // the day really did fill up
    for (const b of work) {
      expect(b.startMin, `"${b.title}" starts at ${b.startMin}, boundary is ${SHUTDOWN}`).toBeLessThan(SHUTDOWN);
      // and it may not run THROUGH the boundary either — work ends by shutdown
      expect(b.endMin, `"${b.title}" runs past the boundary`).toBeLessThanOrEqual(SHUTDOWN);
    }
    // Something had to give, and it went to unplaced rather than into the evening.
    expect(r.unplaced.length).toBeGreaterThan(0);
  });

  it("a task that only fits in the evening becomes unplaced with no_eligible_slot", () => {
    // Every minute from wake to 21:00 is anchored; only 21:00–23:00 is free.
    const anchors: Anchor[] = [
      { startMin: W, endMin: 21 * 60, blockType: "personal", title: "all day out" },
    ];
    const t = mkTask({ blockType: "focused_work", estimatedMinutes: 60, title: "evening orphan" });
    const r = solve([t], doctrine, anchors);
    expect(r.blocks.filter((b) => b.taskId === t.id)).toHaveLength(0);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].reason).toBe("no_eligible_slot");
    // and the solver explains the wall rather than leaving "no eligible slot" to be read as a bug
    expect(r.notes.some((n) => /work day closes at 20:30/i.test(n))).toBe(true);
  });

  it("gym and personal blocks may still be placed after shutdown", () => {
    // Boundary at 18:00 so the evening has room that clears the 3h gym-before-sleep floor.
    const early = parseDoctrine(DEFAULT_DOCTRINE_YAML.replace("before_sleep_hours: 2.5", "before_sleep_hours: 5.0"));
    // Everything before 18:00 is occupied, so the ONLY place gym can go is after shutdown.
    const anchors: Anchor[] = [
      { startMin: W, endMin: 18 * 60, blockType: "personal", title: "packed" },
    ];
    const gym = mkTask({ blockType: "gym", estimatedMinutes: 60, title: "Gym" });
    const personal = mkTask({ blockType: "personal", estimatedMinutes: 30, title: "Call Mum" });
    const r = solve([gym, personal], early, anchors);

    const g = r.blocks.find((b) => b.taskId === gym.id);
    expect(g).toBeTruthy();
    expect(g!.startMin).toBeGreaterThanOrEqual(18 * 60); // genuinely after the boundary
    const p = r.blocks.find((b) => b.taskId === personal.id);
    expect(p).toBeTruthy();
    expect(p!.startMin).toBeGreaterThanOrEqual(18 * 60);
  });

  it("an editable boundary actually moves — 4.0h closes the day at 19:00", () => {
    const late = parseDoctrine(DEFAULT_DOCTRINE_YAML.replace("before_sleep_hours: 2.5", "before_sleep_hours: 4.0"));
    expect(shutdownStartMin(late)).toBe(19 * 60);
    const ts = [1, 2, 3, 4, 5].map((i) =>
      mkTask({ blockType: "focused_work", estimatedMinutes: 90, title: `focus ${i}` })
    );
    const r = solve(ts, late, []);
    for (const b of r.blocks.filter((x) => WORK.includes(x.blockType))) {
      expect(b.endMin).toBeLessThanOrEqual(19 * 60);
    }
  });
});
