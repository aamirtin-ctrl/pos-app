// Doctrine-adherence nudges (owner request 2026-08-05): "call me out when I'm on my
// phone/computer past the scheduled time — when I'm not winding down when I should be,
// or working when I should be."
//
// The shape of the thing: compare INTENT (what the accepted plan and the doctrine say
// should be happening right now) against REALITY (Screen Time for the last few minutes).
// When they disagree in one of five specific, nameable ways, say so once — with the real
// numbers — and then shut up.
//
// THE RISK IS NOT MISSING A NUDGE, IT IS SENDING TOO MANY. A nagging app gets turned off
// in a week and then it can never help again. So every gate below is deliberately
// conservative and stacked:
//   - `nudges_enabled` defaults to OFF. This is opt-in, always.
//   - at most ONE nudge per block, THREE per day, and never within 45 minutes of the last.
//   - nothing at all outside wake..sleep+1h — a nudge he sleeps through would otherwise
//     burn a third of the daily budget for nothing.
//   - a delivery FAILURE never consumes budget; only a delivered nudge is recorded.
//   - anything unknown (an app that isn't in CATEGORY_MAP, a missing idle signal, a
//     Screen Time database that won't open) resolves toward SILENCE, never toward a guess.
//
// Delivery is dual-channel on purpose: a macOS notification cannot reach him when the
// problem IS that he is on his phone. So the same sentence also goes to his own iMessage
// thread, prefixed "POS — " so capture.ts ignores it (digest.ts already owns that
// convention and both the prefix and the self-handle lookup are reused from there).
//
// NOT reusing messaging.sendIMessage, deliberately: it requires a person_id, writes an
// `interaction` row + markLatestDraftSent for that person, and carries the standing
// invariant "USER-INITIATED ONLY — must never be wired to any automatic path". A nudge is
// exactly an automatic path. digest.ts hit the same wall and solved it the same way: reuse
// messaging.iMessageScript (so the AppleScript escaping is never duplicated) and run it
// through a local osascript runner with the identical automation_denied mapping. Tests
// inject `runScript` and `notify` — no osascript, no Electron, no network.
//
// SCREEN TIME DEPENDENCY: main/screentime.ts is owned by another agent. It is imported for
// the production default (`defaultScreenTime()`), but everything this file needs from it is
// ALSO declared locally as `ScreenTimeApi` and injectable, for two reasons: the tests must
// never touch the real knowledgeC.db, and a shape change over there should cost one adapter
// function here rather than breaking the nudge engine. The adapter is where the two
// signatures are reconciled — screenTimeAvailable() returns a status object, not a boolean,
// and the awake signal arrives as backlit spans on readSnapshot().

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { DIGEST_PREFIX, firstSelfHandle } from "./digest.ts";
import { iMessageScript } from "./messaging.ts";
import {
  dayBounds,
  hhmmToMin,
  loadDoctrine,
  shutdownStartMin,
  WORK_TYPES,
  type BlockType,
  type Doctrine,
} from "./engine/doctrine.ts";
import { wakeTimeFor } from "./wake.ts";
import * as screentime from "./screentime.ts";

const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

// ── the screentime.ts surface this file needs ────────────────────────────────

export type UsageCategory = "focus" | "communication" | "distraction" | "neutral";

/** One app's foreground stretch — structurally screentime.UsageSpan. */
export interface UsageSample {
  bundleId: string;
  appName: string;
  /** Minutes from local midnight of the QUERIED RANGE's start day (screentime.ts's frame). */
  startMin: number;
  endMin: number;
  seconds: number;
}

/** The backlit ("display was on") evidence, as readSnapshot reports it. */
export interface AwakeSnapshot {
  awake: { startMin: number; endMin: number }[];
  /** False when the Knowledge store has no /display/isBacklit stream at all. */
  backlitAvailable: boolean;
}

/**
 * The narrow slice of main/screentime.ts the nudge engine consumes. Everything past
 * `usageForRange` is optional so a partial module still yields the cases it can support.
 */
export interface ScreenTimeApi {
  /** boolean, or screentime.ts's `{ ok }` status object — both are accepted. */
  screenTimeAvailable(): boolean | { ok: boolean };
  usageForRange(startISO: string, endISO: string): UsageSample[];
  /** bundle id → category. Absent ⇒ every app reads as `neutral` ⇒ the category rules stay silent. */
  CATEGORY_MAP?: Record<string, UsageCategory>;
  /** Optional per-bundle classifier (prefix rules included), preferred over CATEGORY_MAP. */
  categoryFor?(bundleId: string): UsageCategory | undefined;
  /**
   * Preferred awake signal: the backlit spans for a range. Without it (or `displayAwake` /
   * `idleSeconds`) the `idle_in_work_block` case is SKIPPED ENTIRELY rather than nagging
   * someone who deliberately stepped away from the machine.
   */
  readSnapshot?(startISO: string, endISO: string): AwakeSnapshot;
  /** Alternate awake signal — "was the display on for this range?". */
  displayAwake?(startISO: string, endISO: string): boolean;
  /** Last-resort awake signal: seconds since the last input event. */
  idleSeconds?(): number;
}

/**
 * The production adapter over main/screentime.ts. Reconciles the two signatures in one
 * place: `screenTimeAvailable()` there returns `{ ok, error }`, and the awake evidence is
 * the `/display/isBacklit` spans that come back on a snapshot read.
 */
export function defaultScreenTime(): ScreenTimeApi {
  return {
    screenTimeAvailable: () => screentime.screenTimeAvailable(),
    usageForRange: (a, b) => screentime.usageForRange(a, b),
    categoryFor: (id) => screentime.categoryFor(id),
    CATEGORY_MAP: screentime.CATEGORY_MAP,
    readSnapshot: (a, b) => {
      const s = screentime.readSnapshot(a, b);
      return { awake: s.awake, backlitAvailable: s.backlitAvailable };
    },
  };
}

const isAvailable = (st: ScreenTimeApi): boolean => {
  const v = st.screenTimeAvailable();
  return typeof v === "boolean" ? v : !!v?.ok;
};

// ── tunables (exported so tests and Settings copy stay in sync) ──────────────

/** The "reality" window: how far back "right now" reaches. */
export const NUDGE_WINDOW_MIN = 10;
/** past_shutdown: minutes of focus/communication inside the window that count as working. */
export const PAST_SHUTDOWN_MIN_USAGE = 5;
/** winding_down_but_scrolling: minutes of distraction inside the window. */
export const SCROLLING_MIN_DISTRACTION = 7;
/** distracted_in_deep_work: share of the elapsed block spent on distraction. */
export const DEEP_WORK_DISTRACTION_PCT = 0.4;
/** …but not before the block has run long enough for the ratio to mean anything. */
export const DEEP_WORK_MIN_ELAPSED_MIN = 10;
/** idle_in_work_block: minutes elapsed before absence is worth mentioning. */
export const IDLE_MIN_ELAPSED_MIN = 15;
/** …and the share of those minutes showing ANY usage that still counts as "nothing". */
export const IDLE_MAX_ACTIVE_PCT = 0.2;
/** …and the share of the block the display must have been ON for, to prove he was there. */
export const IDLE_MIN_AWAKE_PCT = 0.5;
/** working_past_bedtime: how far ahead of sleep onset the case opens. */
export const BEDTIME_LEAD_MIN = 30;

/** Hard rate limits. */
export const MAX_NUDGES_PER_DAY = 3;
export const MIN_MINUTES_BETWEEN_NUDGES = 45;
/** Nudging stops this long after sleep onset; before wake it never starts. */
export const AWAKE_TAIL_MIN = 60;

/** Settings keys this module owns. */
export const NUDGES_ENABLED_KEY = "nudges_enabled";
export const NUDGE_CHANNEL_KEY = "nudge_channel";
export const NUDGE_LAST_AT_KEY = "nudge_last_at";
export const nudgeCountKey = (dateISO: string) => `nudge_count:${dateISO}`;
export const nudgeSentBlockKey = (blockId: number) => `nudge_sent_block:${blockId}`;

// ── time helpers (local time throughout — the doctrine is a local-time object) ──

const pad = (n: number) => String(n).padStart(2, "0");
const localDateISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minsSinceMidnight = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Minutes-since-midnight → "HH:MM", wrapping past-midnight values back into the clock. */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * `now` in the doctrine's day frame. When sleep onset is past midnight, dayBounds pushes
 * sleepMin past 1440; the small hours of the following morning belong to the SAME doctrine
 * day and must be pushed with it, or 00:30 would read as 14.5 hours before a 01:00 bedtime.
 */
export function dayMinutes(now: Date, doctrine: Doctrine): number {
  const { sleepMin } = dayBounds(doctrine);
  const m = minsSinceMidnight(now);
  if (sleepMin > 1440 && m < sleepMin - 1440 + AWAKE_TAIL_MIN) return m + 1440;
  return m;
}

/**
 * Local midnight the doctrine day's minute values are measured from. Normally `now`'s own
 * midnight; in the small hours of a past-midnight doctrine day it is YESTERDAY's, because
 * dayMinutes() has already pushed those minutes past 1440 to keep the day contiguous.
 */
function dayAnchor(now: Date, doctrine: Doctrine): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (dayMinutes(now, doctrine) >= 1440) d.setDate(d.getDate() - 1);
  return d;
}

/** Doctrine-day minute → a real Date (values ≥1440 roll into the next calendar day). */
function dateAtMinute(anchor: Date, min: number): Date {
  const d = new Date(anchor.getTime());
  d.setMinutes(d.getMinutes() + min);
  return d;
}

/**
 * Doctrine dir, mirroring capture.resolveDoctrineDir (preferences.ts mirrors it for the
 * same reason): importing capture.ts here would drag the whole assistant/LLM graph into a
 * module that only needs a wake time and a shutdown minute.
 */
function resolveDoctrineDirLocal(): string {
  try {
    const electron = req("electron") as { app?: { getPath(name: string): string } };
    const p = electron.app?.getPath("userData");
    if (p) return p;
  } catch {
    /* not running inside Electron */
  }
  return join(homedir(), "Library", "Application Support", "pos");
}

// ── the accepted plan's current block ────────────────────────────────────────

export interface PlanBlock {
  id: number;
  block_type: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  is_anchor: number;
  /** minutes since local midnight, derived from starts_at/ends_at */
  startMin: number;
  endMin: number;
}

/** planner.ts stores block times as naive local "YYYY-MM-DDTHH:MM:00". */
const blockMin = (iso: string): number => {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 0 : minsSinceMidnight(d);
};

/**
 * The block of TODAY'S accepted plan that contains `now`, or null.
 *
 * Non-anchor wins on a tie: an anchor is an external calendar event laid over the day, and
 * when the planner has put real work underneath one, the work is the intent worth judging
 * against. Ties beyond that go to the block that started most recently (the innermost one).
 * Only the most recently accepted plan for the day is considered — replanning a day leaves
 * the earlier accepted rows behind, and they are history, not intent.
 */
export function currentBlock(db: Db, now: Date = new Date()): PlanBlock | null {
  const dateISO = localDateISO(now);
  const plan = db
    .prepare(
      `SELECT id FROM plan
        WHERE plan_date = ? AND accepted_at IS NOT NULL
        ORDER BY datetime(accepted_at) DESC, id DESC LIMIT 1`
    )
    .get(dateISO) as { id: number } | undefined;
  if (!plan) return null;

  const rows = db
    .prepare(
      `SELECT id, block_type, title, starts_at, ends_at, is_anchor
         FROM block WHERE plan_id = ? ORDER BY starts_at`
    )
    .all(plan.id) as Omit<PlanBlock, "startMin" | "endMin">[];

  const nowMin = minsSinceMidnight(now);
  const containing = rows
    .map((r) => ({ ...r, startMin: blockMin(r.starts_at), endMin: blockMin(r.ends_at) }))
    .filter((b) => b.endMin > b.startMin && nowMin >= b.startMin && nowMin < b.endMin);
  if (containing.length === 0) return null;

  containing.sort((a, b) => a.is_anchor - b.is_anchor || b.startMin - a.startMin);
  return containing[0];
}

// ── usage accounting ─────────────────────────────────────────────────────────

export interface UsageSummary {
  /** length of the window in minutes */
  totalMinutes: number;
  /** minutes in which ANY app was in use */
  activeMinutes: number;
  /** minutes attributed to each category */
  byCategory: Record<UsageCategory, number>;
  /** minutes per app, for naming what he is actually on */
  byApp: { name: string; category: UsageCategory; minutes: number }[];
}

const EMPTY_SUMMARY = (totalMinutes: number): UsageSummary => ({
  totalMinutes,
  activeMinutes: 0,
  byCategory: { focus: 0, communication: 0, distraction: 0, neutral: 0 },
  byApp: [],
});

/**
 * Clip [a,b) to [winStart,winEnd), correcting for the day frame first.
 *
 * screentime.ts measures a span from local midnight of the QUERIED RANGE's start day, while
 * a past-midnight doctrine day counts past 1440 from the previous midnight. A window that
 * straddles midnight therefore gets spans back 1440 minutes off; shift whichever way lands
 * them in range. Returns null when nothing survives the clip.
 */
function clipSpan(a: number, b: number, winStart: number, winEnd: number): [number, number] | null {
  if (b <= winStart - 720) {
    a += 1440;
    b += 1440;
  } else if (a >= winEnd + 720) {
    a -= 1440;
    b -= 1440;
  }
  const from = Math.max(a, winStart);
  const to = Math.min(b, winEnd);
  return to > from ? [from, to] : null;
}

function categoryOf(api: ScreenTimeApi, bundleId: string): UsageCategory {
  const viaFn = api.categoryFor?.(bundleId);
  if (viaFn) return viaFn;
  // Unknown app ⇒ neutral ⇒ it can never TRIGGER a nudge, only ever count as "active".
  return api.CATEGORY_MAP?.[bundleId] ?? "neutral";
}

/**
 * Minute-level occupancy over [winStart, winEnd) in minutes-since-midnight.
 *
 * Counted per MINUTE, not per sample, so two apps logging the same minute cannot inflate
 * "7 of the last 10 minutes" past the window. A minute can still count toward two different
 * categories if genuinely overlapping samples disagree — rare in Screen Time data, and the
 * honest reading when it happens.
 *
 * A degenerate sample (endMin <= startMin) falls back to its `seconds`, rounded up.
 */
export function summarizeUsage(
  samples: UsageSample[],
  api: ScreenTimeApi,
  winStart: number,
  winEnd: number
): UsageSummary {
  const total = Math.max(0, winEnd - winStart);
  const out = EMPTY_SUMMARY(total);
  if (total === 0) return out;

  const active = new Set<number>();
  const catMinutes: Record<UsageCategory, Set<number>> = {
    focus: new Set(),
    communication: new Set(),
    distraction: new Set(),
    neutral: new Set(),
  };
  const apps = new Map<string, { name: string; category: UsageCategory; minutes: number }>();

  for (const s of samples) {
    const a = s.startMin;
    const b = s.endMin > s.startMin ? s.endMin : s.startMin + Math.max(1, Math.ceil((s.seconds ?? 0) / 60));
    const clipped = clipSpan(a, b, winStart, winEnd);
    if (!clipped) continue;
    const [from, to] = clipped;

    const cat = categoryOf(api, s.bundleId);
    for (let m = Math.floor(from); m < to; m++) {
      active.add(m);
      catMinutes[cat].add(m);
    }
    const name = s.appName?.trim() || s.bundleId;
    const key = `${cat} ${name}`;
    const prev = apps.get(key);
    if (prev) prev.minutes += to - from;
    else apps.set(key, { name, category: cat, minutes: to - from });
  }

  out.activeMinutes = active.size;
  for (const c of ["focus", "communication", "distraction", "neutral"] as const) {
    out.byCategory[c] = catMinutes[c].size;
  }
  out.byApp = [...apps.values()].sort((x, y) => y.minutes - x.minutes);
  return out;
}

/** The app with the most minutes among `cats`, or null when nothing matched. */
function topApp(u: UsageSummary, cats: UsageCategory[]): string | null {
  for (const a of u.byApp) if (cats.includes(a.category)) return a.name;
  return null;
}

const workMinutes = (u: UsageSummary) => u.byCategory.focus + u.byCategory.communication;

// ── evaluation ───────────────────────────────────────────────────────────────

export const NUDGE_KINDS = [
  "past_shutdown",
  "winding_down_but_scrolling",
  "distracted_in_deep_work",
  "idle_in_work_block",
  "working_past_bedtime",
] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

export interface Nudge {
  kind: NudgeKind;
  message: string;
  /** the block this nudge is about, for the one-per-block guard. null = a day-level nudge. */
  blockId: number | null;
}

export interface NudgeDeps {
  screenTime: ScreenTimeApi;
  doctrine: Doctrine;
  /** Pre-resolved current block; omit to have evaluateNudge look it up. */
  block?: PlanBlock | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How to name a block in a sentence: its own title if it has one, else its type. */
function blockLabel(b: PlanBlock): string {
  const t = (b.title ?? "").trim();
  if (t) return `"${t}"`;
  return `the ${b.block_type.replace(/_/g, " ")} block`;
}

/**
 * Was the Mac awake across [fromMin,toMin)? `undefined` means THE MODULE HAS NO SIGNAL, and
 * that is not the same as `false` — it is the reason idle_in_work_block skips rather than
 * guesses. A store with no /display/isBacklit stream reports backlitAvailable: false, which
 * is also "no signal".
 */
function displayWasAwake(
  api: ScreenTimeApi,
  anchor: Date,
  fromMin: number,
  toMin: number
): boolean | undefined {
  const startISO = dateAtMinute(anchor, fromMin).toISOString();
  const endISO = dateAtMinute(anchor, toMin).toISOString();
  try {
    if (typeof api.readSnapshot === "function") {
      const snap = api.readSnapshot(startISO, endISO);
      if (!snap?.backlitAvailable) return undefined;
      let lit = 0;
      for (const s of snap.awake ?? []) {
        const c = clipSpan(s.startMin, s.endMin, fromMin, toMin);
        if (c) lit += c[1] - c[0];
      }
      return lit >= (toMin - fromMin) * IDLE_MIN_AWAKE_PCT;
    }
    if (typeof api.displayAwake === "function") return api.displayAwake(startISO, endISO);
    if (typeof api.idleSeconds === "function") {
      // "Awake now" is the weaker claim, but it still separates "sitting here doing nothing"
      // from "walked away" — the only distinction this case needs.
      return api.idleSeconds() < IDLE_MIN_ELAPSED_MIN * 60;
    }
  } catch {
    return undefined; // a throwing signal is no signal
  }
  return undefined;
}

/**
 * INTENT vs REALITY. Returns the single highest-priority discrepancy, or null.
 *
 * Priority is the order in NUDGE_KINDS — the boundary cases (shutdown, then wind-down)
 * outrank the in-block ones because a boundary he is already past is the more expensive
 * miss. `working_past_bedtime` sits last only because `past_shutdown` subsumes it whenever
 * the usage is heavy; it survives as the case that fires on ONE minute of Slack at 22:45.
 *
 * No writes, no sends, no clock reads of its own — everything comes from `now` and `deps`.
 */
export function evaluateNudge(db: Db, now: Date, deps: NudgeDeps): Nudge | null {
  const { screenTime: st, doctrine } = deps;
  const nowMin = dayMinutes(now, doctrine);
  const { sleepMin } = dayBounds(doctrine);
  const shutMin = shutdownStartMin(doctrine);

  const anchor = dayAnchor(now, doctrine);
  const usageBetween = (fromMin: number, toMin: number): UsageSummary => {
    if (toMin <= fromMin) return EMPTY_SUMMARY(0);
    const samples = st.usageForRange(
      dateAtMinute(anchor, fromMin).toISOString(),
      dateAtMinute(anchor, toMin).toISOString()
    );
    return summarizeUsage(samples ?? [], st, fromMin, toMin);
  };

  const recent = usageBetween(nowMin - NUDGE_WINDOW_MIN, nowMin);

  // 1. past_shutdown — the work day closed and work is still happening.
  if (shutMin !== null && nowMin >= shutMin && workMinutes(recent) >= PAST_SHUTDOWN_MIN_USAGE) {
    const since = usageBetween(shutMin, nowMin);
    const mins = workMinutes(since) || workMinutes(recent);
    const app = topApp(since, ["focus", "communication"]) ?? topApp(recent, ["focus", "communication"]) ?? "work apps";
    return {
      kind: "past_shutdown",
      blockId: deps.block !== undefined ? (deps.block?.id ?? null) : (currentBlock(db, now)?.id ?? null),
      message:
        `It's ${hhmm(nowMin)} and you shut down at ${hhmm(shutMin)} — that's ${plural(mins, "minute")} in ${app} since. ` +
        `The evening was the point.`,
    };
  }

  // 2. winding_down_but_scrolling — past shutdown, not working, but not winding down either.
  if (shutMin !== null && nowMin >= shutMin && recent.byCategory.distraction >= SCROLLING_MIN_DISTRACTION) {
    const app = topApp(recent, ["distraction"]) ?? "the feed";
    return {
      kind: "winding_down_but_scrolling",
      blockId: null,
      message:
        `Past shutdown and ${recent.byCategory.distraction} of the last ${NUDGE_WINDOW_MIN} minutes were ${app}. ` +
        `Wind-down works better without the feed.`,
    };
  }

  const block = deps.block !== undefined ? deps.block : currentBlock(db, now);

  if (block) {
    const elapsed = nowMin - block.startMin;

    // 3. distracted_in_deep_work — the most expensive block on the board, spent elsewhere.
    if (
      (block.block_type === "deep_work" || block.block_type === "focused_work") &&
      elapsed >= DEEP_WORK_MIN_ELAPSED_MIN
    ) {
      const inBlock = usageBetween(block.startMin, nowMin);
      if (inBlock.byCategory.distraction >= elapsed * DEEP_WORK_DISTRACTION_PCT) {
        const app = topApp(inBlock, ["distraction"]) ?? "something else";
        return {
          kind: "distracted_in_deep_work",
          blockId: block.id,
          message:
            `You're ${plural(elapsed, "minute")} into ${blockLabel(block)} and ${inBlock.byCategory.distraction} of them were ${app}. ` +
            `Deep work only pays if the block stays whole.`,
        };
      }
    }

    // 4. idle_in_work_block — the block is running and nothing is happening on the machine.
    // Gated on a real awake signal: without one this is indistinguishable from "he took the
    // meeting in another room", and nagging that is how the whole feature gets turned off.
    if (WORK_TYPES.has(block.block_type as BlockType) && elapsed >= IDLE_MIN_ELAPSED_MIN) {
      const awake = displayWasAwake(st, anchor, block.startMin, nowMin);
      if (awake === true) {
        const inBlock = usageBetween(block.startMin, nowMin);
        if (inBlock.activeMinutes < elapsed * IDLE_MAX_ACTIVE_PCT) {
          return {
            kind: "idle_in_work_block",
            blockId: block.id,
            message:
              `You're ${plural(elapsed, "minute")} into ${blockLabel(block)} with ${plural(inBlock.activeMinutes, "minute")} of activity on an awake machine. ` +
              `It ends at ${hhmm(block.endMin)} either way.`,
          };
        }
      }
    }
  }

  // 5. working_past_bedtime — any work at all, this close to sleep onset.
  if (nowMin >= sleepMin - BEDTIME_LEAD_MIN && workMinutes(recent) > 0) {
    const app = topApp(recent, ["focus", "communication"]) ?? "work apps";
    return {
      kind: "working_past_bedtime",
      blockId: null,
      message:
        `It's ${hhmm(nowMin)} and you're still in ${app} — sleep onset is ${hhmm(sleepMin)}. ` +
        `Tomorrow's first block is built on tonight's sleep.`,
    };
  }

  return null;
}

// ── delivery ─────────────────────────────────────────────────────────────────

export type NudgeChannel = "notify" | "imessage";

/** `nudge_channel`, defaulting to both — see the dual-channel rationale at the top. */
export function nudgeChannels(db: Db): NudgeChannel[] {
  const raw = (getSetting(db, NUDGE_CHANNEL_KEY) ?? "both").trim().toLowerCase();
  if (raw === "notify") return ["notify"];
  if (raw === "imessage") return ["imessage"];
  return ["notify", "imessage"];
}

export interface NudgeSendDeps {
  /** Test hook — replaces the osascript runner. */
  runScript?: (script: string) => Promise<void>;
  /** Test hook — replaces the Electron notification. Return false when it can't show. */
  notify?: (title: string, body: string) => boolean;
}

export type NudgeSendResult =
  | { sent: true; channels: NudgeChannel[] }
  | {
      sent: false;
      reason: "no_channel" | "no_self_handle" | "automation_denied" | "send_failed" | "notify_failed";
      detail?: string;
    };

/**
 * Same osascript execution + error mapping as messaging.ts's private runner and digest.ts's
 * copy of it (-1743 / "not allowed" → the typed 'automation_denied').
 */
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 15_000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const detail = `${err.message} ${stderr ?? ""}`;
      if (detail.includes("-1743") || /not (allowed|authori[sz]ed)/i.test(detail)) {
        return reject(new Error("automation_denied"));
      }
      reject(new Error(`imessage_failed: ${(stderr || err.message).trim().slice(0, 200)}`));
    });
  });
}

/** Electron's Notification, required lazily so tests (and any non-Electron run) never load it. */
function macNotify(title: string, body: string): boolean {
  try {
    const electron = req("electron") as {
      Notification?: { isSupported?(): boolean; new (o: { title: string; body: string }): { show(): void } };
    };
    const N = electron?.Notification;
    if (!N || (typeof N.isSupported === "function" && !N.isSupported())) return false;
    new N({ title, body }).show();
    return true;
  } catch {
    return false; // no Electron, no notification centre — the iMessage leg still stands
  }
}

/**
 * Deliver one nudge on the configured channels. `sent` is true when AT LEAST ONE channel
 * got through: a notification he saw is a delivered nudge even if Messages is locked down.
 * Records nothing — runNudgeCheck owns the budget, and only on success.
 */
export async function sendNudge(
  db: Db,
  _secrets: SecretStore | undefined,
  nudge: Nudge,
  deps: NudgeSendDeps = {}
): Promise<NudgeSendResult> {
  const channels = nudgeChannels(db);
  const delivered: NudgeChannel[] = [];
  let lastFailure: NudgeSendResult | null = null;

  if (channels.includes("notify")) {
    const ok = (deps.notify ?? macNotify)("POS", nudge.message);
    if (ok) delivered.push("notify");
    else lastFailure = { sent: false, reason: "notify_failed" };
  }

  if (channels.includes("imessage")) {
    const handle = firstSelfHandle(db);
    if (!handle) {
      lastFailure = { sent: false, reason: "no_self_handle" };
    } else {
      try {
        // The "POS — " prefix is load-bearing: capture.ts uses it to know this is the app
        // talking and must never re-ingest it as a braindump.
        await (deps.runScript ?? runOsascript)(iMessageScript(handle, `${DIGEST_PREFIX}${nudge.message}`));
        delivered.push("imessage");
      } catch (e) {
        const msg = (e as Error).message;
        lastFailure =
          msg === "automation_denied"
            ? { sent: false, reason: "automation_denied" }
            : { sent: false, reason: "send_failed", detail: msg };
      }
    }
  }

  if (delivered.length > 0) return { sent: true, channels: delivered };
  return lastFailure ?? { sent: false, reason: "no_channel" };
}

// ── rate limiting + the entry point ──────────────────────────────────────────

export type NudgeSkipReason =
  | "disabled"
  | "asleep"
  | "daily_cap"
  | "too_soon"
  | "screentime_unavailable"
  | "nothing_to_say"
  | "block_already_nudged"
  | "no_channel"
  | "no_self_handle"
  | "automation_denied"
  | "send_failed"
  | "notify_failed"
  | "error";

export interface NudgeCheckResult {
  sent: boolean;
  kind?: NudgeKind;
  reason?: NudgeSkipReason;
  detail?: string;
  channels?: NudgeChannel[];
}

export interface RunNudgeOpts extends NudgeSendDeps {
  /** Defaults to the real main/screentime.ts; tests inject a fake so knowledgeC.db is never read. */
  screenTime?: ScreenTimeApi;
  /** Injected by tests; otherwise loaded from doctrine.yaml. */
  doctrine?: Doctrine;
  doctrineDir?: string;
  /** Injected by tests to avoid a DB round-trip; `null` means "no block right now". */
  block?: PlanBlock | null;
}

/** True while `now` is inside wake..sleep+1h — the only hours a nudge can be seen. */
export function withinAwakeWindow(db: Db, now: Date, doctrine: Doctrine): boolean {
  const { sleepMin } = dayBounds(doctrine);
  // Observed wake beats the doctrine's intention when it was reported; the evening bound
  // stays doctrine-derived, since every other offset in the file is.
  const wakeMin = hhmmToMin(wakeTimeFor(db, localDateISO(now), doctrine));
  const nowMin = dayMinutes(now, doctrine);
  return nowMin >= wakeMin && nowMin <= sleepMin + AWAKE_TAIL_MIN;
}

/** Nudges delivered on `dateISO` so far. */
export function nudgeCountToday(db: Db, dateISO: string): number {
  const n = Number.parseInt(getSetting(db, nudgeCountKey(dateISO)) ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Minutes since the last delivered nudge, or null when there has never been one. */
export function minutesSinceLastNudge(db: Db, now: Date): number | null {
  const raw = getSetting(db, NUDGE_LAST_AT_KEY);
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return null; // hand-edited garbage degrades to "no record", not to spam
  return (now.getTime() - t) / 60_000;
}

/**
 * THE entry point. Gate → evaluate → rate-limit → send → record.
 *
 * Never throws: this runs on a cron tick inside a try-less caller and a nudge engine that
 * can take the worker down is worse than no nudge engine. Every failure comes back as a
 * typed `reason`.
 *
 * Ordering matters. The cheap, silent gates (enabled, awake hours, budget) run BEFORE any
 * Screen Time read, and the budget is debited only after a channel actually delivered — a
 * denied Automation permission must not silently eat the day's three nudges.
 */
export async function runNudgeCheck(
  db: Db,
  secrets?: SecretStore,
  now: Date = new Date(),
  opts: RunNudgeOpts = {}
): Promise<NudgeCheckResult> {
  try {
    if (getSetting(db, NUDGES_ENABLED_KEY) !== "1") return { sent: false, reason: "disabled" };

    const doctrine = opts.doctrine ?? loadDoctrine(opts.doctrineDir ?? resolveDoctrineDirLocal());
    if (!withinAwakeWindow(db, now, doctrine)) return { sent: false, reason: "asleep" };

    const dateISO = localDateISO(now);
    if (nudgeCountToday(db, dateISO) >= MAX_NUDGES_PER_DAY) return { sent: false, reason: "daily_cap" };

    const since = minutesSinceLastNudge(db, now);
    if (since !== null && since < MIN_MINUTES_BETWEEN_NUDGES) return { sent: false, reason: "too_soon" };

    const st = opts.screenTime ?? defaultScreenTime();
    if (!isAvailable(st)) return { sent: false, reason: "screentime_unavailable" };

    // A Screen Time read that fails (Full Disk Access revoked, schema drift, the store
    // locked mid-read) is an UNAVAILABLE source, not a bug — it must not read as "error"
    // on every tick for the rest of the day.
    let nudge: Nudge | null;
    try {
      nudge = evaluateNudge(db, now, { screenTime: st, doctrine, block: opts.block });
    } catch (e) {
      return { sent: false, reason: "screentime_unavailable", detail: (e as Error).message };
    }
    if (!nudge) return { sent: false, reason: "nothing_to_say" };

    if (nudge.blockId !== null && getSetting(db, nudgeSentBlockKey(nudge.blockId))) {
      return { sent: false, reason: "block_already_nudged", kind: nudge.kind };
    }

    const res = await sendNudge(db, secrets, nudge, opts);
    if (!res.sent) return { sent: false, kind: nudge.kind, reason: res.reason, detail: res.detail };

    setSetting(db, NUDGE_LAST_AT_KEY, now.toISOString());
    setSetting(db, nudgeCountKey(dateISO), String(nudgeCountToday(db, dateISO) + 1));
    if (nudge.blockId !== null) setSetting(db, nudgeSentBlockKey(nudge.blockId), now.toISOString());

    return { sent: true, kind: nudge.kind, channels: res.channels };
  } catch (e) {
    return { sent: false, reason: "error", detail: (e as Error).message };
  }
}
