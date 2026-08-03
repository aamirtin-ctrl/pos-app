// Phase 4 gate tests (§9) — written BEFORE the solver, per spec. Non-negotiable list:
// >120min deep rejected; 6h deep → 4h placed + exceeded_deep_work_cap; no deep in first
// hour; gym 2h/3h/4h before sleep; 5 scattered meetings → ≤2 clusters + transitions;
// no deep right after a meeting cluster; zero free slots → no crash; determinism.

import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
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

  it("breaks are inserted after deep work blocks", () => {
    const t = mkTask({ blockType: "deep_work", estimatedMinutes: 90, cognitiveLoad: 5 });
    const r = solve([t], doctrine, []);
    const deep = r.blocks.find((b) => b.taskId === t.id)!;
    const brk = r.blocks.find((b) => b.blockType === "break" && b.startMin === deep.endMin);
    expect(brk).toBeTruthy();
  });
});
