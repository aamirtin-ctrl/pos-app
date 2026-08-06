// Stage 3 (§5.6) — DETERMINISTIC. Not an LLM. A weighted assignment pass.
// The LLM decided WHAT each task is (Stage 2); this decides WHEN it goes.
// Same input twice → identical output: index-ordered iteration, explicit tiebreaks,
// no randomness. Never places into a slot the eligibility mask excluded, regardless
// of score. Never silently drops a task — everything unplaced carries a reason.

import { BLOCK_DEFAULTS, WORK_TYPES, hhmmToMin, type BlockType, type Doctrine } from "./doctrine.ts";
import { buildGrid, flexibilityOf, SLOT_MIN, type Anchor, type Flexibility, type Slot } from "./grid.ts";

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
  /**
   * The LAST day (ISO date) this work may be scheduled on, or null for same-day-only work.
   * Set ONLY for work the owner said was flexible across a range — see migration 9. A task
   * carrying one may be handed back as `deferred_within_window` instead of being crammed in.
   *
   * Optional so every existing construction (and every existing test) is byte-identical to
   * before: no window means the old behavior, exactly.
   */
  windowEnd?: string | null;
  /** The day currently being solved for. With a `windowEnd`, this is a CHOICE, not a commitment. */
  planDate?: string;
}

export type UnplacedReason =
  | "exceeded_deep_work_cap"
  | "no_eligible_slot"
  | "deadline_conflict"
  | "insufficient_contiguous_time"
  /**
   * NOT a failure. The task has a deadline window with days left in it, today could not seat
   * it (or seating it would have stranded work that must happen today), so it moves. The
   * planner advances its plan_date to the next day inside the window; tomorrow picks it up.
   */
  | "deferred_within_window";

/** The one reason that means "not today" rather than "not at all". */
export const DEFERRED_REASON = "deferred_within_window" as const;

/**
 * Reasons that mean the day genuinely could not seat the work — the only conditions worth
 * deferring a windowed task to relieve.
 *
 * `exceeded_deep_work_cap` is deliberately NOT here. It is a budget, not a clock, and the
 * ranking below already spends that budget on same-day work first; adding it would make the
 * withholding pass re-solve the day for a task that a cap, not a competitor, turned away.
 */
const PRESSURE_REASONS: ReadonlySet<UnplacedReason> = new Set<UnplacedReason>([
  "no_eligible_slot",
  "insufficient_contiguous_time",
  "deadline_conflict",
]);

/**
 * May this task legitimately be moved to a LATER day? True only when it has a window and
 * today is not the last day of it — on `windowEnd` itself there is nowhere left to go, so a
 * failure there is a real failure.
 *
 * ISO dates compare correctly as strings, which is the whole reason they are stored that way.
 */
export function isDeferrable(t: PlannerTask): boolean {
  const end = t.windowEnd ?? null;
  const day = t.planDate ?? null;
  return end !== null && day !== null && day < end;
}

/**
 * The day a deferred task moves to: tomorrow, clamped to the window (which `isDeferrable`
 * already guarantees is reachable). Null when the task is not deferrable at all.
 *
 * Exported because THREE places must agree on it — the planner that writes the new plan_date,
 * the narration that tells the owner where it went, and the tests that pin both.
 */
export function nextDayInWindow(t: PlannerTask): string | null {
  if (!isDeferrable(t)) return null;
  const next = new Date(Date.parse(`${t.planDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return next <= t.windowEnd! ? next : null;
}

export interface PlacedBlock {
  blockType: BlockType;
  title: string;
  startMin: number;
  endMin: number;
  taskId?: number;
  capacityAtPlacement?: number;
  isAnchor: boolean;
  isLocked?: boolean;
  /**
   * How hard this placement is. Anchors carry their own tier; everything the solver sited
   * itself is `flexible` — the planner chose those minutes and may choose again tomorrow.
   * Always set by the solver; optional only so older constructions still typecheck.
   */
  flexibility?: Flexibility;
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

/** A duration in the words a person uses: 150 → "2h30", 90 → "1h30", 45 → "45 min". */
const fmtDur = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
};

// ── a slower start on a lighter day ──────────────────────────────────────────
//
// Owner ask 2026-08-06: "when possible, it should let me have a slower start to the morning
// versus when I'm more to do that day. And it should be able to determine which is best. like
// a smart assistant."
//
// The morning routine was a flat 30 minutes because that is what he asked for on 2026-08-05
// ("half an hour to shower and read"). But he asked for that as a FLOOR — the least he needs
// to start the day like a person — and a fixed floor spends a wide-open Saturday exactly like
// a day with a test in it. Nothing else in the doctrine reads the shape of the day either:
// every ritual is a constant.
//
// So the stated duration stays the floor and becomes the answer only when the day is full.
// The room left over is what buys the difference.

/** The longest a wake-anchored ritual may stretch to when the day is genuinely empty. */
export const MORNING_SLOW_START_MAX = 75;

/**
 * How much room the day has left, 0 (packed or over-committed) → 1 (nothing on it).
 *
 * Demand is what the owner actually asked for — the buffered estimate of every task. Capacity
 * is the eligible working minutes the grid offers before the shutdown boundary, which already
 * has external anchors subtracted from it: a day with a four-hour hangout on it is not a light
 * day, and this sees that without being told.
 */
export function dayRoomFactor(tasks: PlannerTask[], grid: { slots: Slot[]; shutdownMin: number | null }): number {
  const end = grid.shutdownMin;
  const capacity = grid.slots.filter(
    (s) => s.free && (end === null || s.startMin < end) && WORK_TYPES_ARR.some((t) => s.eligible[t])
  ).length * SLOT_MIN;
  if (capacity <= 0) return 0;
  const demand = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  return Math.max(0, Math.min(1, 1 - demand / capacity));
}

const WORK_TYPES_ARR = [...WORK_TYPES];

/**
 * A ritual's length for THIS day. Unchanged for every ritual that declares no ceiling, which
 * is all of them except the morning routine — a comms window has no reason to grow.
 *
 * The wake-anchored personal ritual gets MORNING_SLOW_START_MAX by default rather than
 * requiring a doctrine edit, because the owner's file was written before this existed and
 * reconcileRituals only ever ADDS rituals; it does not rewrite the ones he already has.
 */
export function ritualDuration(
  r: { type: BlockType; duration: number; at_hours_after_wake?: number; expand_to?: number },
  roomFactor: number
): number {
  const isMorning = r.at_hours_after_wake === 0 && r.type === "personal";
  const ceiling = r.expand_to ?? (isMorning ? MORNING_SLOW_START_MAX : r.duration);
  if (ceiling <= r.duration) return r.duration;
  // Round to the grid so the extra minutes are actually placeable rather than rounded away.
  const raw = r.duration + roomFactor * (ceiling - r.duration);
  return Math.round(raw / SLOT_MIN) * SLOT_MIN;
}

/**
 * One anchor the pass must NOT occupy up front, and must re-place after everything else.
 * `displacedBy` names whatever took its minutes, for the note; null means nobody did (a
 * `flexible` block is planner output — moving it is not news worth a note).
 */
interface ReleasedAnchor {
  anchor: Anchor;
  displacedBy: string | null;
}

interface PassOptions {
  /** Anchors whose minutes are occupied from the start of the pass. */
  occupying: Anchor[];
  /** Anchors re-placed by the scoring pass at the end, after every task has had its turn. */
  released: ReleasedAnchor[];
}

/**
 * The three-tier entry point (owner ask 2026-08-05).
 *
 *   fixed     — occupies its minutes; nothing overlaps it; never moved. Unchanged behavior,
 *               and the default for any anchor that declares no tier, so every existing
 *               call site is byte-identical to before.
 *   preferred — occupies its minutes by default. Displaced only when it has to be: either a
 *               `fixed` anchor literally overlaps it, or the day could not seat something
 *               that must be seated. Then it is re-placed and the move is explained.
 *   flexible  — never occupies. Planner output; re-placed freely by the scoring pass.
 *
 * Displacement is a SECOND PASS, not a backtrack: pass 1 solves with `preferred` occupied;
 * if that leaves work stranded, pass 2 solves the identical input with every `preferred`
 * block released and re-placed last, and the better of the two is returned. Two full
 * deterministic passes and an explicit comparison — same input twice, same output.
 */
export function solve(tasks: PlannerTask[], doctrine: Doctrine, anchors: Anchor[]): SolveResult {
  const deferrable = new Set(tasks.filter(isDeferrable).map((t) => t.id));

  // No windows in play → the old function, unchanged, not one branch different.
  if (deferrable.size === 0) return solveTiered(tasks, doctrine, anchors);

  /** Work that MUST happen today and the day could not seat. The only thing worth deferring for. */
  const stranded = (r: SolveResult) =>
    r.unplaced.filter((u) => !deferrable.has(u.task.id) && PRESSURE_REASONS.has(u.reason)).length;

  let active = tasks;
  let result = solveTiered(active, doctrine, anchors);
  const withheld: PlannerTask[] = [];

  // ── withhold windowed work that is costing same-day work its place ──
  //
  // Ranking (below, in solvePass) already puts same-day tasks first within each placement
  // phase, which settles the owner's case on its own. This loop is the cross-phase backstop:
  // a windowed MIT is placed before a same-day deep-work task, and if that inversion strands
  // the task that genuinely has to be today, the windowed one gives way — it has all week.
  //
  // Deterministic and bounded: at most one windowed task leaves per iteration, chosen by an
  // explicit total order (most slack first, then longest — the one whose removal both costs
  // least and frees most), and an iteration that does not actually rescue anything is undone.
  for (;;) {
    if (stranded(result) === 0) break;
    const placed = new Set(result.blocks.map((b) => b.taskId).filter((id): id is number => id !== undefined));
    const victims = active
      .filter((t) => deferrable.has(t.id) && placed.has(t.id))
      .sort(
        (a, b) =>
          (b.windowEnd ?? "").localeCompare(a.windowEnd ?? "") ||
          b.estimatedMinutes - a.estimatedMinutes ||
          a.id - b.id
      );
    if (victims.length === 0) break;
    const victim = victims[0];
    const next = solveTiered(active.filter((t) => t.id !== victim.id), doctrine, anchors);
    if (stranded(next) >= stranded(result)) break; // the sacrifice bought nothing — keep the day as is
    active = active.filter((t) => t.id !== victim.id);
    withheld.push(victim);
    result = next;
  }

  // ── relabel: a windowed task that missed today has not failed, it has moved ──
  const unplaced = [
    ...result.unplaced.map((u) =>
      deferrable.has(u.task.id) ? { task: u.task, reason: DEFERRED_REASON as UnplacedReason } : u
    ),
    ...withheld.map((task) => ({ task, reason: DEFERRED_REASON as UnplacedReason })),
  ].sort((a, b) => a.task.id - b.task.id);

  return { ...result, unplaced };
}

/** The three-tier anchor logic. `solve` above wraps it with deadline-window deferral. */
function solveTiered(tasks: PlannerTask[], doctrine: Doctrine, anchors: Anchor[]): SolveResult {
  const byStart = (a: Anchor, b: Anchor) => a.startMin - b.startMin || a.title.localeCompare(b.title);
  const immovable = anchors.filter((a) => !a.movable);
  const fixedAnchors = immovable.filter((a) => flexibilityOf(a) === "fixed");
  const preferredAnchors = immovable.filter((a) => flexibilityOf(a) === "preferred").sort(byStart);
  const flexibleAnchors = immovable.filter((a) => flexibilityOf(a) === "flexible").sort(byStart);

  // `flexible` anchors are the planner's own blocks handed back to it. They never hold a
  // slot hostage; they are simply re-placed.
  const released: ReleasedAnchor[] = flexibleAnchors.map((a) => ({ anchor: a, displacedBy: null }));

  // A `preferred` block whose minutes a `fixed` anchor claims cannot stay where it is —
  // the two would paint on top of each other. It loses, unconditionally, in pass 1. This is
  // the owner's literal case: the dentist appointment lands on top of the reading block.
  const keptPreferred: Anchor[] = [];
  for (const p of preferredAnchors) {
    const clash = fixedAnchors.find((f) => f.startMin < p.endMin && f.endMin > p.startMin);
    if (clash) released.push({ anchor: p, displacedBy: clash.title });
    else keptPreferred.push(p);
  }

  const first = solvePass(tasks, doctrine, anchors, {
    occupying: [...fixedAnchors, ...keptPreferred],
    released,
  });
  if (keptPreferred.length === 0) return first;

  // Nothing stranded → nothing to buy with a displacement. `deadline_conflict` joins the
  // two reasons the owner named because it is the same failure wearing a different label:
  // the day has room, just not before the deadline, and a preferred block may be sitting in
  // exactly the window that would work.
  // Windowed work is excluded on purpose: displacing the owner's own `preferred` block to
  // seat something that has until Sunday is a bad trade. It defers instead (see `solve`).
  const pressured = first.unplaced.filter(
    (u) =>
      !isDeferrable(u.task) &&
      (u.reason === "no_eligible_slot" ||
        u.reason === "insufficient_contiguous_time" ||
        u.reason === "deadline_conflict")
  );
  if (pressured.length === 0) return first;

  const second = solvePass(tasks, doctrine, anchors, {
    occupying: fixedAnchors,
    released: [
      ...released,
      ...keptPreferred.map((a) => ({ anchor: a, displacedBy: pressured[0].task.title })),
    ],
  });
  // Only worth the churn if it actually seated something. Ties keep pass 1 — the calmer day.
  return second.unplaced.length < first.unplaced.length ? second : first;
}

function solvePass(
  tasks: PlannerTask[],
  doctrine: Doctrine,
  anchors: Anchor[],
  opts: PassOptions
): SolveResult {
  const hc = doctrine.hard_constraints;
  const w = doctrine.soft_preferences.weights;
  const fixed = opts.occupying;
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
    flexibility: flexibilityOf(a),
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

  function place(
    type: BlockType,
    i0: number,
    len: number,
    title: string,
    taskId?: number,
    as?: { isAnchor?: boolean; flexibility?: Flexibility }
  ): PlacedBlock {
    for (let i = i0; i < i0 + len; i++) occ[i] = type;
    const avgCap = avgCapacity(i0, len);
    const b: PlacedBlock = {
      blockType: type,
      title,
      startMin: minOf(i0),
      endMin: minOf(i0 + len),
      taskId,
      capacityAtPlacement: Math.round(avgCap * 10) / 10,
      isAnchor: as?.isAnchor ?? false,
      // Everything the solver sites itself is the planner's to move again tomorrow.
      flexibility: as?.flexibility ?? "flexible",
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
  const room = dayRoomFactor(tasks, grid);
  for (const r of rituals) {
    const target =
      r.at_hours_after_wake !== undefined
        ? wakeMin + r.at_hours_after_wake * 60
        : sleepMin - (r.before_sleep_hours ?? 0) * 60;
    const len = slotsFor(ritualDuration(r, room));
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
  //
  // `windowRank` is the LEADING key of every placement order below: work that must happen
  // today is offered the day before work that merely may. Without it the math test and the
  // advising block compete as equals for the same two hours, and the tiebreak that decides
  // which of them the owner loses is cognitive load — which is not the question he asked.
  // With no windowed tasks present it is 0 for everything, so ordering is bit-for-bit as before.
  const windowRank = (t: PlannerTask) => (isDeferrable(t) ? 1 : 0);
  const byId = (a: PlannerTask, b: PlannerTask) => windowRank(a) - windowRank(b) || a.id - b.id;
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

  /**
   * How to cut this deep-work task into blocks.
   *
   * Owner report 2026-08-06: "I don't get why that exceeded the deep work cap for today
   * because I didn't do any deep work today." He was right, and the narration agreed with
   * him in the same breath — "No deep work is scheduled today. 1 task did not fit: Take
   * Stanford math test (exceeded deep work cap)."
   *
   * Nothing about his DAY was full. His math test was 2h stated, buffered to 2h30, and
   * marked not splittable (correctly — you do not take half a test). That is 30 minutes over
   * `max_deep_work_block_minutes`, so this function returned null and the test was dropped.
   *
   * That cap is doctrine about how POS should CHUNK work — BRAC cycles run 90-120 minutes
   * and alertness decays after — not a claim that longer sessions are impossible. Applying it
   * to indivisible work inverted its purpose: a sound recommendation about pacing silently
   * deleted a real obligation. Work the owner says cannot be split is placed whole, and the
   * overrun is NARRATED instead. The daily budget still binds, because that one really is a
   * ceiling on how much focus a day holds.
   */
  function deepChunks(t: PlannerTask): number[] | null {
    const est = t.estimatedMinutes;
    const max = hc.max_deep_work_block_minutes;
    const min = hc.min_deep_work_block_minutes;
    if (est <= max) return [Math.max(est, min)];
    if (!t.splittable) {
      notes.push(
        `"${t.title}" runs ${fmtDur(est)} in one sitting, past the ${fmtDur(max)} focus cap, and can't be split — ` +
          `plan a stretch at the ${fmtDur(max - 30)} mark.`
      );
      return [est];
    }
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
    .sort((a, b) => windowRank(a) - windowRank(b) || b.cognitiveLoad - a.cognitiveLoad || a.id - b.id);
  for (const t of mits) {
    take(t);
    placeDeepOrFocused(t, true);
  }

  // ── 5. Remaining deep work, descending by load ──
  const deeps = tasks
    .filter((t) => remaining.has(t.id) && t.blockType === "deep_work")
    .sort(
      (a, b) =>
        windowRank(a) - windowRank(b) ||
        b.cognitiveLoad - a.cognitiveLoad ||
        b.estimatedMinutes - a.estimatedMinutes ||
        a.id - b.id
    );
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
        windowRank(a) - windowRank(b) ||
        (a.project ?? "~").localeCompare(b.project ?? "~") ||
        a.title.localeCompare(b.title) ||
        a.id - b.id
    );
  for (const t of shallow) {
    take(t);
    placeDeepOrFocused(t, false);
  }

  // ── 7a. re-place the released blocks — LAST, into what the day has left ──
  //
  // A displaced `preferred` block does not get its old minutes back and does not get to
  // outrank the work it made room for; it competes for whatever remains. The score is
  // "closest to where it was", the same rule the movable-meeting fallback above uses:
  // the owner put "Reading" at 14:00 for a reason, so 16:00 beats 08:00.
  const releasedInOrder = [...opts.released].sort(
    (x, y) =>
      x.anchor.startMin - y.anchor.startMin || x.anchor.title.localeCompare(y.anchor.title)
  );
  for (const r of releasedInOrder) {
    const a = r.anchor;
    const len = slotsFor(a.endMin - a.startMin);
    const cands = candidates(a.blockType, len);
    if (cands.length === 0) {
      notes.push(
        r.displacedBy
          ? `"${a.title}" had to give way to "${r.displacedBy}" and the day has no other room for it.`
          : `"${a.title}" could not be re-placed — the day has no room left for it.`
      );
      continue;
    }
    const best = bestBy(cands, (i0) => -Math.abs(minOf(i0) - a.startMin))!;
    const b = place(a.blockType, best, len, a.title, undefined, {
      isAnchor: true,
      flexibility: flexibilityOf(a),
    });
    if (r.displacedBy && b.startMin !== a.startMin) {
      notes.push(`Moved "${a.title}" to ${fmtMin(b.startMin)} to make room for "${r.displacedBy}".`);
    }
  }

  // ── 7b. explain the wall, don't just enforce it ──
  // "no_eligible_slot" is opaque when the day visibly has free evening hours. If work was
  // cut while time remains AFTER the shutdown boundary, say so — that free time is a
  // deliberate choice, not an oversight the owner should try to fill.
  if (grid.shutdownMin !== null) {
    // Windowed work excluded: it did not hit the wall, it moved to another day, and the
    // narration says so. Counting it here would contradict that in the same breath.
    const cut = unplaced.filter(
      (u) => u.reason === "no_eligible_slot" && WORK_TYPES.has(u.task.blockType) && !isDeferrable(u.task)
    );
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
export const ENGINE_VERSION = "1.1.0"; // 1.1.0: deadline windows (deferred_within_window)

export { hhmmToMin };
