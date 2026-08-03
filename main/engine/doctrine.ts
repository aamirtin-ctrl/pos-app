// The doctrine file (§5.2): everything the engine believes about "an optimal day",
// in ONE editable config file — not code, not a prompt. Seeded on first run at
// ~/Library/Application Support/pos/doctrine.yaml, editable in Settings.
// hard_constraints are NEVER auto-modified by the learning loop.

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export const BLOCK_TYPES = [
  "deep_work", "focused_work", "admin", "comms", "meeting",
  "gym", "break", "meal", "transition", "shutdown", "personal",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** §5.1 defaults: duration + cognitive load per type. */
export const BLOCK_DEFAULTS: Record<BlockType, { minutes: number; load: number }> = {
  deep_work: { minutes: 90, load: 5 },
  focused_work: { minutes: 50, load: 3 },
  admin: { minutes: 30, load: 2 },
  comms: { minutes: 25, load: 2 },
  meeting: { minutes: 30, load: 3 },
  gym: { minutes: 75, load: 0 },
  break: { minutes: 20, load: 0 },
  meal: { minutes: 40, load: 0 },
  transition: { minutes: 10, load: 0 },
  shutdown: { minutes: 15, load: 1 },
  personal: { minutes: 30, load: 0 },
};

/** Block types the first-hour cognitive ban applies to. */
export const COGNITIVE_TYPES: ReadonlySet<BlockType> = new Set([
  "deep_work", "focused_work", "admin", "comms", "shutdown",
]);

const curvePoint = z.object({ hours_after_wake: z.number().min(0), capacity: z.number().min(0).max(100) });

const doctrineSchema = z.object({
  version: z.number(),
  chronotype: z.object({
    wake_time: z.string().regex(/^\d{2}:\d{2}$/),
    sleep_onset: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  energy_curve: z.array(curvePoint).min(2),
  physical_curve: z.object({
    peak_window: z.object({
      start_hours_after_wake: z.number(),
      end_hours_after_wake: z.number(),
    }),
  }),
  hard_constraints: z.object({
    no_cognitive_work_before_hours_after_wake: z.number(),
    max_deep_work_block_minutes: z.number(),
    min_deep_work_block_minutes: z.number(),
    max_deep_work_blocks_per_day: z.number(),
    max_deep_work_minutes_per_day: z.number(),
    min_recovery_after_deep_work_minutes: z.number(),
    min_gym_end_before_sleep_hours: z.number(),
    min_transition_around_meeting_cluster_minutes: z.number(),
    max_meeting_clusters_per_day: z.number(),
    min_gap_between_stacked_meetings_minutes: z.number(),
    no_deep_work_immediately_after_meeting: z.boolean(),
    latest_comms_window_before_sleep_hours: z.number(),
  }),
  soft_preferences: z.object({ weights: z.record(z.string(), z.number()) }),
  fixed_rituals: z.array(
    z.object({
      type: z.enum(BLOCK_TYPES),
      at_hours_after_wake: z.number().optional(),
      before_sleep_hours: z.number().optional(),
      duration: z.number(),
      label: z.string(),
    })
  ),
  estimation: z.object({
    default_buffer_pct: z.number(),
    max_buffer_pct: z.number(),
    category_multipliers: z.record(z.string(), z.number()),
  }),
  breaks: z.object({
    after_deep_work_minutes: z.number(),
    after_focused_work_minutes: z.number(),
    break_is_screen_free: z.boolean(),
  }),
});

export type Doctrine = z.infer<typeof doctrineSchema>;

// Shipped defaults. Owner decision 2026-08-03: wake 07:30; sleep/gym stay at doctrine
// defaults, explicitly editable. Rationale comments per §5.3 so the user can argue with
// the reasoning, not just the numbers.
export const DEFAULT_DOCTRINE_YAML = `version: 1

chronotype:
  wake_time: "07:30"
  sleep_onset: "23:00"
  # All windows below are computed as offsets from wake_time so the doctrine
  # survives a schedule change without hand-editing.

energy_curve:
  # Piecewise linear, keyed on hours-since-wake. Values are cognitive capacity 0-100.
  # Biphasic: morning peak, early-afternoon flat spot (post-lunch dip ~14:00,
  # accentuated by eating), smaller evening peak. Interpolate between points.
  - { hours_after_wake: 0.0,  capacity: 20 }   # sleep inertia: impaired immediately on waking
  - { hours_after_wake: 1.0,  capacity: 55 }   # inertia dissipates asymptotically over ~2-4h
  - { hours_after_wake: 2.0,  capacity: 88 }   # peak 1 begins
  - { hours_after_wake: 3.5,  capacity: 100 }
  - { hours_after_wake: 5.0,  capacity: 92 }
  - { hours_after_wake: 6.0,  capacity: 70 }   # postprandial + circasemidian dip
  - { hours_after_wake: 7.5,  capacity: 55 }   # trough
  - { hours_after_wake: 9.0,  capacity: 75 }   # peak 2 begins
  - { hours_after_wake: 10.5, capacity: 82 }   # peak 2 max (< peak 1)
  - { hours_after_wake: 12.0, capacity: 65 }
  - { hours_after_wake: 14.0, capacity: 40 }
  - { hours_after_wake: 16.0, capacity: 20 }   # wind-down

physical_curve:
  # Core body temperature proxy — drives gym placement, not cognitive work.
  # Strength/power/coordination peak late afternoon (typical 3-15% above morning).
  peak_window: { start_hours_after_wake: 7.0, end_hours_after_wake: 11.0 }

hard_constraints:
  # Violating any of these invalidates a plan. No exceptions, no scoring.
  # Implemented as slot-eligibility FILTERS, never negative weights.
  no_cognitive_work_before_hours_after_wake: 1.0   # sleep inertia: the block that starts at wake is the weakest of the morning
  max_deep_work_block_minutes: 120                 # BRAC runs ~90-120 min; alertness decays in the last ~20
  min_deep_work_block_minutes: 60
  max_deep_work_blocks_per_day: 3
  max_deep_work_minutes_per_day: 240               # elite performers rarely exceed ~4h/day of deliberate focus
  min_recovery_after_deep_work_minutes: 15
  min_gym_end_before_sleep_hours: 3.0              # bouts ending >=4h before sleep show no sleep disruption; 3h is the hard floor, 4h the scored preference
  min_transition_around_meeting_cluster_minutes: 10
  max_meeting_clusters_per_day: 2
  min_gap_between_stacked_meetings_minutes: 10     # ~35% of workers want gaps for action items, ~28% to recharge — cluster with seams
  no_deep_work_immediately_after_meeting: true     # attention residue: full refocus after an interruption averages ~23 min
  latest_comms_window_before_sleep_hours: 2.0

soft_preferences:
  # Scored, not enforced. Weights are tunable.
  weights:
    mit_in_highest_capacity_slot: 10
    deep_work_capacity_match: 8
    gym_in_physical_peak: 6
    gym_ends_4h_before_sleep: 5
    admin_in_dip: 5
    meeting_cluster_in_dip: 5
    similar_tasks_batched: 4
    minimize_context_switches: 4
    preserve_largest_contiguous_free_block: 3
    comms_windows_at_fixed_times: 3

fixed_rituals:
  - { type: comms,    at_hours_after_wake: 2.0,  duration: 25, label: "Comms window 1" }
  - { type: meal,     at_hours_after_wake: 5.5,  duration: 40, label: "Lunch" }
  - { type: comms,    at_hours_after_wake: 8.5,  duration: 25, label: "Comms window 2" }
  - { type: shutdown, before_sleep_hours: 4.0,   duration: 15, label: "Shutdown ritual" }

estimation:
  # Planning-fallacy correction: percentage buffers scale with task size; fixed additions don't.
  default_buffer_pct: 25
  max_buffer_pct: 50
  # Per-category multipliers, overwritten by the learning loop (§5.8) from YOUR actuals.
  category_multipliers:
    deep_work: 1.25
    focused_work: 1.25
    admin: 1.15
    meeting: 1.0

breaks:
  after_deep_work_minutes: 20        # micro-breaks (<=10 min) only help low-demand work; deep recovery needs more
  after_focused_work_minutes: 10
  break_is_screen_free: true         # surfaced as UI copy, not enforceable
`;

export function parseDoctrine(yamlText: string): Doctrine {
  const raw = yaml.load(yamlText);
  return doctrineSchema.parse(raw);
}

/** Seeds the default doctrine.yaml if missing, then loads+validates it. */
export function loadDoctrine(dir: string): Doctrine {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "doctrine.yaml");
  if (!fs.existsSync(file)) fs.writeFileSync(file, DEFAULT_DOCTRINE_YAML, "utf8");
  return parseDoctrine(fs.readFileSync(file, "utf8"));
}

export function saveDoctrine(dir: string, yamlText: string): Doctrine {
  const parsed = parseDoctrine(yamlText); // throws on invalid — caller surfaces the error
  fs.writeFileSync(path.join(dir, "doctrine.yaml"), yamlText, "utf8");
  return parsed;
}

// ── time helpers shared by grid/solver ──
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Linear interpolation over the energy curve. Clamps outside the control points. */
export function capacityAt(doctrine: Doctrine, hoursAfterWake: number): number {
  const pts = doctrine.energy_curve;
  if (hoursAfterWake <= pts[0].hours_after_wake) return pts[0].capacity;
  for (let i = 1; i < pts.length; i++) {
    if (hoursAfterWake <= pts[i].hours_after_wake) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (hoursAfterWake - a.hours_after_wake) / (b.hours_after_wake - a.hours_after_wake);
      return a.capacity + t * (b.capacity - a.capacity);
    }
  }
  return pts[pts.length - 1].capacity;
}

/** Planning-fallacy buffer: raw × category multiplier, capped, rounded up to 15. */
export function bufferedMinutes(doctrine: Doctrine, blockType: string, raw: number): number {
  const mult =
    doctrine.estimation.category_multipliers[blockType] ??
    1 + doctrine.estimation.default_buffer_pct / 100;
  const capped = Math.min(mult, 1 + doctrine.estimation.max_buffer_pct / 100);
  return Math.ceil((raw * capped) / 15) * 15;
}
