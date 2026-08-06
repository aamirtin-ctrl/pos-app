// Stage 1 (§5.4) — DETERMINISTIC. Build the 15-minute slot grid, apply anchors,
// score capacity, and apply hard constraints as per-type ELIGIBILITY MASKS.
// A slot that cannot legally host a block type is removed from that type's candidate
// set before scoring ever happens. Hard constraints are filters, not penalties.

import {
  ASSIGNABLE_TYPES, BLOCK_TYPES, COGNITIVE_TYPES, capacityAt, dayBounds,
  shutdownStartMin, type BlockType, type Doctrine,
} from "./doctrine.ts";

export const SLOT_MIN = 15;

/**
 * How hard a block's placement is (owner ask 2026-08-05: "the app should know which events
 * can be moved, which shouldn't be, and which it should try not to").
 *
 *   fixed     — external obligation. Its slots are occupied, nothing may overlap it, and the
 *               planner never moves it. This is what an anchor has always been.
 *   preferred — real, but the owner's own. Occupies its slots by default; may be displaced
 *               and re-placed when a `fixed` anchor or a hard-deadline task has nowhere else
 *               to go (see solver.ts).
 *   flexible  — POS-generated. The planner owns the minutes outright and re-places freely.
 *
 * The default is `fixed` EVERYWHERE it is absent, so every anchor written before this
 * existed keeps behaving exactly as it did.
 */
export type Flexibility = "fixed" | "preferred" | "flexible";

/** The tier an anchor gets when it does not declare one — backward compatibility. */
export const DEFAULT_FLEXIBILITY: Flexibility = "fixed";

/** Read an anchor's tier, applying the backward-compatible default. */
export function flexibilityOf(a: { flexibility?: Flexibility }): Flexibility {
  return a.flexibility ?? DEFAULT_FLEXIBILITY;
}

export interface Anchor {
  startMin: number; // minutes since midnight
  endMin: number;
  blockType: BlockType;
  title: string;
  /** true = external/gcal/user-locked; the planner may never move it */
  movable?: boolean;
  /** How hard this placement is. Absent = "fixed" (the pre-flexibility behavior). */
  flexibility?: Flexibility;
}

export interface Slot {
  index: number;
  startMin: number;
  endMin: number;
  hoursAfterWake: number; // at slot start
  capacity: number;       // 0-100, energy-curve interpolated
  free: boolean;
  anchor?: Anchor;        // set when occupied
  contiguousFreeBefore: number; // minutes of free time ending at this slot's start
  contiguousFreeAfter: number;  // minutes of free time starting at this slot's start (inclusive)
  adjacentToMeeting: boolean;   // slot directly before or after a meeting-occupied slot
  afterMeeting: boolean;        // slot directly AFTER a meeting-occupied slot
  inPhysicalPeak: boolean;
  hoursToSleep: number;   // from slot END to sleep_onset
  eligible: Record<BlockType, boolean>;
}

export interface Grid {
  wakeMin: number;
  sleepMin: number;
  /** Start of the shutdown ritual = the minute the WORK day closes. null = no such ritual. */
  shutdownMin: number | null;
  slots: Slot[];
}

export function buildGrid(doctrine: Doctrine, anchors: Anchor[]): Grid {
  const { wakeMin, sleepMin } = dayBounds(doctrine);
  const shutdownMin = shutdownStartMin(doctrine);

  const hc = doctrine.hard_constraints;
  const peak = doctrine.physical_curve.peak_window;
  const n = Math.floor((sleepMin - wakeMin) / SLOT_MIN);

  // 1-2. slots + anchor occupation
  const slots: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const startMin = wakeMin + i * SLOT_MIN;
    const endMin = startMin + SLOT_MIN;
    const anchor = anchors.find((a) => a.startMin < endMin && a.endMin > startMin);
    const hoursAfterWake = (startMin - wakeMin) / 60;
    slots.push({
      index: i,
      startMin,
      endMin,
      hoursAfterWake,
      capacity: capacityAt(doctrine, hoursAfterWake), // 3. capacity score
      free: !anchor,
      anchor,
      contiguousFreeBefore: 0,
      contiguousFreeAfter: 0,
      adjacentToMeeting: false,
      afterMeeting: false,
      inPhysicalPeak: hoursAfterWake >= peak.start_hours_after_wake && hoursAfterWake < peak.end_hours_after_wake,
      hoursToSleep: (sleepMin - endMin) / 60,
      eligible: Object.fromEntries(BLOCK_TYPES.map((t) => [t, false])) as Record<BlockType, boolean>,
    });
  }

  // 4. derived fields
  let run = 0;
  for (const s of slots) {
    s.contiguousFreeBefore = run;
    run = s.free ? run + SLOT_MIN : 0;
  }
  run = 0;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    run = s.free ? run + SLOT_MIN : 0;
    s.contiguousFreeAfter = run;
  }
  for (let i = 0; i < slots.length; i++) {
    const prevMeeting = i > 0 && slots[i - 1].anchor?.blockType === "meeting";
    const nextMeeting = i < slots.length - 1 && slots[i + 1].anchor?.blockType === "meeting";
    slots[i].afterMeeting = prevMeeting;
    slots[i].adjacentToMeeting = prevMeeting || nextMeeting;
  }

  // 5. eligibility masks (hard constraints as filters)
  for (const s of slots) {
    if (!s.free) continue; // occupied slots are eligible for nothing
    for (const t of BLOCK_TYPES) {
      let ok = true;
      // No cognitive work in the first hour after wake.
      if (COGNITIVE_TYPES.has(t) && s.hoursAfterWake < hc.no_cognitive_work_before_hours_after_wake) ok = false;
      // No deep work immediately after a meeting (attention residue).
      if (t === "deep_work" && hc.no_deep_work_immediately_after_meeting && s.afterMeeting) ok = false;
      // Gym minutes must end >= min_gym_end_before_sleep_hours before sleep.
      if (t === "gym" && s.hoursToSleep < hc.min_gym_end_before_sleep_hours) ok = false;
      // Comms must end >= latest_comms_window_before_sleep_hours before sleep.
      if (t === "comms" && s.hoursToSleep < hc.latest_comms_window_before_sleep_hours) ok = false;
      // The shutdown ritual CLOSES THE DAY — for anything the owner put on a to-do list.
      //
      // It used to close the day only for WORK_TYPES, on the theory that the evening is his
      // and a personal errand is not work. Owner report 2026-08-06: "Again, added the task of
      // unpacking my travel bag two hours after my shutdown ritual. Shouldn't be doing this."
      // He is right, and the earlier reading was too clever. Unpacking a bag at 22:30 is not
      // leisure — it is a chore the engine assigned him, and being labelled `personal` does
      // not make it restful. A shutdown ritual that other assignments run past isn't a
      // boundary at all.
      //
      // What stays legal after shutdown is what the DOCTRINE places (the ritual itself, and
      // the recovery/meal blocks the solver inserts around real work), never a task. Because
      // the solver requires every slot of a run to be eligible, this also stops a block that
      // starts before the boundary from running through it — assignments must be FINISHED by
      // shutdown, not merely begun.
      if (shutdownMin !== null && ASSIGNABLE_TYPES.has(t) && s.startMin >= shutdownMin) ok = false;
      s.eligible[t] = ok;
    }
  }

  return { wakeMin, sleepMin, shutdownMin, slots };
}

/** Largest run of consecutive free slots (minutes) — soft-pref signal. */
export function largestContiguousFree(slots: Slot[]): number {
  let best = 0;
  for (const s of slots) best = Math.max(best, s.contiguousFreeAfter);
  return best;
}
