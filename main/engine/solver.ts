// Stage 3 (§5.6) — DETERMINISTIC. Not an LLM. A weighted assignment pass.
// The LLM decided WHAT each task is (Stage 2); this decides WHEN it goes.
// Same input twice → identical output: index-ordered iteration, explicit tiebreaks,
// no randomness. Never places into a slot the eligibility mask excluded, regardless
// of score. Never silently drops a task — everything unplaced carries a reason.

import { BLOCK_DEFAULTS, WORK_TYPES, hhmmToMin, type BlockType, type Doctrine } from "./doctrine.ts";
import { buildGrid, SLOT_MIN, type Anchor, type Slot } from "./grid.ts";

export interface PlannerTask {
  id: number;
  title: string;
  blockType: BlockType;
  cognitiveLoad: number;
  estimatedMinutes: number; // post-buffer
  isMit: boolean;
  deadlineMin: number | null; // minutes-since-midnight the task must END by (today), or null
  project: string | null;
  splittable: boolean;
}

export type UnplacedReason =
  | "exceeded_deep_work_cap"
  | "no_eligible_slot"
  | "deadline_conflict"
  | "insufficient_contiguous_time";

export interface PlacedBlock {
  blockType: BlockType;
  title: string;
  startMin: number;
  endMin: number;
  taskId?: number;
  capacityAtPlacement?: number;
  isAnchor: boolean;
  isLocked?: boolean;
}

export interface SolveResult {
  blocks: PlacedBlock[];
  unplaced: { task: PlannerTask; reason: UnplacedReason }[];
  notes: string[];
}

const slotsFor = (minutes: number) => Math.max(1, Math.ceil(minutes / SLOT_MIN));

/** minutes-since-midnight → "HH:MM" (wraps past-midnight values back into clock time). */
const fmtMin = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function solve(tasks: PlannerTask[], doctrine: Doctrine, anchors: Anchor[]): SolveResult {
  const hc = doctrine.hard_constraints;
  const w = doctrine.soft_preferences.weights;
  const fixed = anchors.filter((a) => !a.movable);
  const movableMeetings = anchors
    .filter((a) => a.movable && a.blockType === "meeting")
    .sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));

  const grid = buildGrid(doctrine, fixed);
  const { slots, wakeMin, sleepMin } = grid;
  const occ: (BlockType | null)[] = slots.map((s) => (s.free ? null : s.anchor!.blockType));

  const blocks: PlacedBlock[] = fixed.map((a) => ({
    blockType: a.blockType,
    title: a.title,
    startMin: a.startMin,
    endMin: a.endMin,
    isAnchor: true,
  }));
  const unplaced: SolveResult["unplaced"] = [];
  const notes: string[] = [];

  const idx = (min: number) => Math.round((min - wakeMin) / SLOT_MIN);
  const minOf = (i: number) => wakeMin + i * SLOT_MIN;

  function canPlace(type: BlockType, i0: number, len: number): boolean {
    if (i0 < 0 || i0 + len > slots.length) return false;
    for (let i = i0; i < i0 + len; i++) {
      if (occ[i] !== null) return false;
      if (!slots[i].eligible[type]) return false;
    }
    // dynamic residue check: deep work may not directly follow ANY meeting (incl. repacked)
    if (type === "deep_work" && hc.no_deep_work_immediately_after_meeting) {
      if (i0 > 0 && occ[i0 - 1] === "meeting") return false;
    }
    // deep-to-deep adjacency would violate min recovery
    if (type === "deep_work") {
      if (i0 > 0 && occ[i0 - 1] === "deep_work") return false;
      if (i0 + len < slots.length && occ[i0 + len] === "deep_work") return false;
    }
    return true;
  }

  function place(type: BlockType, i0: number, len: number, title: string, taskId?: number): PlacedBlock {
    for (let i = i0; i < i0 + len; i++) occ[i] = type;
    const avgCap = avgCapacity(i0, len);
    const b: PlacedBlock = {
      blockType: type,
      title,
      startMin: minOf(i0),
      endMin: minOf(i0 + len),
      taskId,
      capacityAtPlacement: Math.round(avgCap * 10) / 10,
      isAnchor: false,
    };
    blocks.push(b);
    return b;
  }

  function avgCapacity(i0: number, len: number): number {
    let s = 0;
    for (let i = i0; i < i0 + len; i++) s += slots[i].capacity;
    return s / len;
  }

  /** All legal start indices for a run of `len` slots of `type`. */
  function candidates(type: BlockType, len: number): number[] {
    const out: number[] = [];
    for (let i0 = 0; i0 + len <= slots.length; i0++) if (canPlace(type, i0, len)) out.push(i0);
    return out;
  }

  function bestBy(cands: number[], score: (i0: number) => number): number | null {
    let best: number | null = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      const s = score(c);
      if (s > bestScore + 1e-9) {
        bestScore = s;
        best = c;
      } // ties → earliest (first seen wins)
    }
    return best;
  }

  function unplacedReason(type: BlockType, len: number, deadlineMin: number | null): UnplacedReason {
    const anyEligible = slots.some((s, i) => occ[i] === null && s.eligible[type]);
    if (!anyEligible) return "no_eligible_slot";
    if (deadlineMin !== null && candidates(type, len).length > 0) return "deadline_conflict";
    return "insufficient_contiguous_time";
  }

  // ── 1. Fixed rituals — bend around anchors, don't disappear ──
  //
  // Rituals are placed before ANY work (gym, meetings, MIT, deep work, shallow batching all
  // follow), so the shutdown boundary is known and occupied before a single task is sited.
  // Within the loop, shutdown goes first: the boundary must claim its own minutes before a
  // comms window or a lunch that bent late can take them. The eligibility mask does the
  // actual enforcement (grid.ts bans work at/after `shutdownStartMin`); this ordering just
  // guarantees the ritual block itself lands where the mask says the wall is.
  const rituals = [...doctrine.fixed_rituals].sort(
    (a, b) => (a.type === "shutdown" ? 0 : 1) - (b.type === "shutdown" ? 0 : 1)
  );
  for (const r of rituals) {
    const target =
      r.at_hours_after_wake !== undefined
        ? wakeMin + r.at_hours_after_wake * 60
        : sleepMin - (r.before_sleep_hours ?? 0) * 60;
    const len = slotsFor(r.duration);
    const t0 = idx(target);
    // Rituals bend around anchors, but only so far — a comms window 10 hours off
    // its target is not that ritual anymore. Beyond ±2h it drops with a note.
    const MAX_BEND_SLOTS = Math.ceil(120 / SLOT_MIN);
    let placedAt: number | null = null;
    for (let d = 0; d <= MAX_BEND_SLOTS && placedAt === null; d++) {
      for (const cand of d === 0 ? [t0] : [t0 + d, t0 - d]) {
        if (canPlace(r.type, cand, len)) {
          placedAt = cand;
          break;
        }
      }
    }
    if (placedAt !== null) place(r.type, placedAt, len, r.label);
    else notes.push(`Ritual "${r.label}" could not be placed — day is fully blocked there.`);
  }

  // task ordering helpers
  const byId = (a: PlannerTask, b: PlannerTask) => a.id - b.id;
  const remaining = new Set(tasks.map((t) => t.id));
  const take = (t: PlannerTask) => remaining.delete(t.id);

  // ── 2. Gym — best slot in the physical peak, respecting the sleep floor ──
  for (const t of tasks.filter((x) => x.blockType === "gym").sort(byId)) {
    take(t);
    const len = slotsFor(t.estimatedMinutes);
    const cands = candidates("gym", len);
    if (cands.length === 0) {
      unplaced.push({ task: t, reason: unplacedReason("gym", len, null) });
      continue;
    }
    const fourH = sleepMin - (hc.min_gym_end_before_sleep_hours + 1) * 60; // 4h scored pref
    const best = bestBy(cands, (i0) => {
      let inPeak = 0;
      for (let i = i0; i < i0 + len; i++) if (slots[i].inPhysicalPeak) inPeak++;
      const endsClean = minOf(i0 + len) <= fourH ? 1 : 0;
      return (w.gym_in_physical_peak ?? 6) * (inPeak / len) + (w.gym_ends_4h_before_sleep ?? 5) * endsClean;
    })!;
    const b = place("gym", best, len, t.title || "Gym", t.id);
    if (b.endMin > fourH) notes.push(`Gym ends <4h before sleep (hard floor is 3h) — degraded placement.`);
  }

  // ── 3. Cluster meetings — ≤2 clusters, seams, transitions ──
  interface Cluster {
    startIdx: number;
    endIdx: number; // exclusive
  }
  const clusters: Cluster[] = [];
  // seed clusters from immovable meeting anchors
  const fixedMeetingSlots = slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.anchor?.blockType === "meeting")
    .map(({ i }) => i);
  for (const i of fixedMeetingSlots) {
    const last = clusters[clusters.length - 1];
    if (last && (i - last.endIdx) * SLOT_MIN <= 45) last.endIdx = i + 1;
    else clusters.push({ startIdx: i, endIdx: i + 1 });
  }
  const gapSlots = Math.max(1, Math.ceil(hc.min_gap_between_stacked_meetings_minutes / SLOT_MIN));
  let repacked = 0;
  for (const m of movableMeetings) {
    const len = slotsFor(m.endMin - m.startMin);
    const options: { i0: number; dist: number }[] = [];
    for (const c of clusters) {
      const after = c.endIdx + gapSlots;
      if (canPlace("meeting", after, len)) options.push({ i0: after, dist: Math.abs(minOf(after) - m.startMin) });
      const before = c.startIdx - gapSlots - len;
      if (canPlace("meeting", before, len)) options.push({ i0: before, dist: Math.abs(minOf(before) - m.startMin) });
    }
    let chosen: number | null = null;
    if (options.length > 0) {
      options.sort((a, b) => a.dist - b.dist || a.i0 - b.i0);
      chosen = options[0].i0;
    } else if (clusters.length < hc.max_meeting_clusters_per_day) {
      // new cluster at the nearest legal run to its original time
      const cands = candidates("meeting", len);
      if (cands.length > 0) {
        chosen = bestBy(cands, (i0) => -Math.abs(minOf(i0) - m.startMin));
      }
    }
    if (chosen === null) {
      // fall back: anywhere legal, even if it means a 3rd cluster — flag it
      const cands = candidates("meeting", len);
      if (cands.length > 0) {
        chosen = bestBy(cands, (i0) => -Math.abs(minOf(i0) - m.startMin));
        notes.push(`Could not keep "${m.title}" within ${hc.max_meeting_clusters_per_day} meeting clusters.`);
      }
    }
    if (chosen === null) {
      notes.push(`Meeting "${m.title}" could not be placed at all.`);
      continue;
    }
    if (chosen !== idx(m.startMin)) repacked++;
    place("meeting", chosen, len, m.title);
    // merge into cluster bookkeeping
    const merged: Cluster = { startIdx: chosen, endIdx: chosen + len };
    clusters.push(merged);
    clusters.sort((a, b) => a.startIdx - b.startIdx);
    for (let i = clusters.length - 2; i >= 0; i--) {
      if ((clusters[i + 1].startIdx - clusters[i].endIdx) * SLOT_MIN <= 45) {
        clusters[i].endIdx = Math.max(clusters[i].endIdx, clusters[i + 1].endIdx);
        clusters.splice(i + 1, 1);
      }
    }
  }
  if (repacked > 0) notes.push(`Consolidated ${repacked} movable meeting(s) into ${clusters.length} cluster(s).`);
  // transitions flanking every cluster (explicit closure beats an empty gap)
  const transLen = slotsFor(hc.min_transition_around_meeting_cluster_minutes);
  for (const c of clusters) {
    if (canPlace("transition", c.startIdx - transLen, transLen))
      place("transition", c.startIdx - transLen, transLen, "Transition");
    if (canPlace("transition", c.endIdx, transLen)) place("transition", c.endIdx, transLen, "Transition");
  }

  // ── deep-work bookkeeping for hard caps ──
  let deepMinutes = 0;
  let deepBlocks = 0;

  function deepChunks(t: PlannerTask): number[] | null {
    const est = t.estimatedMinutes;
    const max = hc.max_deep_work_block_minutes;
    const min = hc.min_deep_work_block_minutes;
    if (est <= max) return [Math.max(est, min)];
    if (!t.splittable) return null;
    // split into 2 (default max) — long deep work almost always splits
    const half = Math.ceil(est / 2 / SLOT_MIN) * SLOT_MIN;
    const c1 = Math.min(max, half);
    const c2 = est - c1;
    if (c2 > max || c2 < min) return null;
    return [c1, c2];
  }

  function insertBreak(afterIdx: number, minutes: number) {
    const want = slotsFor(minutes);
    for (const len of [want, 1]) {
      if (len >= 1 && canPlace("break", afterIdx, len)) {
        place("break", afterIdx, len, "Break");
        return;
      }
    }
    notes.push("No room for a recovery break after a focus block.");
  }

  function placeDeepOrFocused(t: PlannerTask, mit: boolean): boolean {
    const isDeep = t.blockType === "deep_work";
    if (isDeep) {
      const chunks = deepChunks(t);
      if (chunks === null || deepMinutes + t.estimatedMinutes > hc.max_deep_work_minutes_per_day ||
          deepBlocks + (chunks?.length ?? 0) > hc.max_deep_work_blocks_per_day) {
        unplaced.push({ task: t, reason: "exceeded_deep_work_cap" });
        return false;
      }
      let prevEnd: number | null = null;
      const placedIdx: number[] = [];
      for (const chunk of chunks) {
        const len = slotsFor(chunk);
        let cands = candidates("deep_work", len).filter((i0) => prevEnd === null || i0 >= prevEnd);
        if (t.deadlineMin !== null) {
          const all = cands;
          cands = cands.filter((i0) => minOf(i0 + len) <= t.deadlineMin!);
          if (all.length > 0 && cands.length === 0) {
            unplaced.push({ task: t, reason: "deadline_conflict" });
            return false;
          }
        }
        if (cands.length === 0) {
          unplaced.push({ task: t, reason: unplacedReason("deep_work", len, t.deadlineMin) });
          return false;
        }
        const best = bestBy(cands, (i0) => {
          const cap = avgCapacity(i0, len) / 100;
          return (mit ? (w.mit_in_highest_capacity_slot ?? 10) : 0) + (w.deep_work_capacity_match ?? 8) * cap * (t.cognitiveLoad / 5);
        })!;
        place("deep_work", best, len, t.title, t.id);
        insertBreak(best + len, doctrine.breaks.after_deep_work_minutes);
        prevEnd = best + len + slotsFor(doctrine.breaks.after_deep_work_minutes);
        placedIdx.push(best);
        deepMinutes += chunk;
        deepBlocks += 1;
      }
      return true;
    }
    // focused/admin/comms/other single block
    const len = slotsFor(t.estimatedMinutes);
    let cands = candidates(t.blockType, len);
    if (t.deadlineMin !== null) {
      const all = cands;
      cands = cands.filter((i0) => minOf(i0 + len) <= t.deadlineMin!);
      if (all.length > 0 && cands.length === 0) {
        unplaced.push({ task: t, reason: "deadline_conflict" });
        return false;
      }
    }
    if (cands.length === 0) {
      unplaced.push({ task: t, reason: unplacedReason(t.blockType, len, t.deadlineMin) });
      return false;
    }
    const dipScore = (i0: number) => (100 - avgCapacity(i0, len)) / 100;
    const adjacency = (i0: number) => {
      const before = blocks.find((b) => b.taskId !== undefined && b.endMin === minOf(i0));
      const after = blocks.find((b) => b.taskId !== undefined && b.startMin === minOf(i0 + len));
      const sameProject = (b?: PlacedBlock) => {
        if (!b) return 0;
        const other = tasks.find((x) => x.id === b.taskId);
        return other && other.project && other.project === t.project ? 1 : 0;
      };
      return sameProject(before) + sameProject(after);
    };
    const best = bestBy(cands, (i0) => {
      let s = 0;
      if (mit) s += (w.mit_in_highest_capacity_slot ?? 10) * (avgCapacity(i0, len) / 100);
      if (t.blockType === "admin" || t.blockType === "comms") s += (w.admin_in_dip ?? 5) * dipScore(i0);
      if (t.blockType === "focused_work") s += (w.deep_work_capacity_match ?? 8) * (avgCapacity(i0, len) / 100) * (t.cognitiveLoad / 5);
      s += ((w.similar_tasks_batched ?? 4) + (w.minimize_context_switches ?? 4)) * 0.5 * adjacency(i0);
      // prefer not shattering the biggest free block
      s -= (w.preserve_largest_contiguous_free_block ?? 3) * 0.01 * (slots[i0].contiguousFreeAfter / (16 * 60));
      return s;
    })!;
    place(t.blockType, best, len, t.title, t.id);
    if (t.blockType === "focused_work") insertBreak(best + len, doctrine.breaks.after_focused_work_minutes);
    return true;
  }

  // ── 4. MIT first — into the highest-capacity eligible slot ──
  const mits = tasks
    .filter((t) => remaining.has(t.id) && t.isMit)
    .sort((a, b) => b.cognitiveLoad - a.cognitiveLoad || a.id - b.id);
  for (const t of mits) {
    take(t);
    placeDeepOrFocused(t, true);
  }

  // ── 5. Remaining deep work, descending by load ──
  const deeps = tasks
    .filter((t) => remaining.has(t.id) && t.blockType === "deep_work")
    .sort((a, b) => b.cognitiveLoad - a.cognitiveLoad || b.estimatedMinutes - a.estimatedMinutes || a.id - b.id);
  for (const t of deeps) {
    take(t);
    placeDeepOrFocused(t, false);
  }

  // ── 6. breaks were inserted inline after each deep/focused block ──

  // ── 7. Batch shallow work into the dip, same project adjacent ──
  const shallow = tasks
    .filter((t) => remaining.has(t.id))
    .sort(
      (a, b) =>
        (a.project ?? "~").localeCompare(b.project ?? "~") ||
        a.title.localeCompare(b.title) ||
        a.id - b.id
    );
  for (const t of shallow) {
    take(t);
    placeDeepOrFocused(t, false);
  }

  // ── 7b. explain the wall, don't just enforce it ──
  // "no_eligible_slot" is opaque when the day visibly has free evening hours. If work was
  // cut while time remains AFTER the shutdown boundary, say so — that free time is a
  // deliberate choice, not an oversight the owner should try to fill.
  if (grid.shutdownMin !== null) {
    const cut = unplaced.filter((u) => u.reason === "no_eligible_slot" && WORK_TYPES.has(u.task.blockType));
    const eveningFree = slots.some((s, i) => s.startMin >= grid.shutdownMin! && occ[i] === null);
    if (cut.length > 0 && eveningFree) {
      notes.push(
        `The work day closes at ${fmtMin(grid.shutdownMin)} (shutdown ritual); ${cut.length} task(s) had no room before it. ` +
          `The evening is free on purpose — it is not schedulable work time.`
      );
    }
  }

  // ── 8. stable output ordering ──
  blocks.sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title));
  unplaced.sort((a, b) => a.task.id - b.task.id);
  return { blocks, unplaced, notes };
}

/** Engine version stamped onto plans — bump when solver behavior changes. */
export const ENGINE_VERSION = "1.0.0";

export { hhmmToMin };
