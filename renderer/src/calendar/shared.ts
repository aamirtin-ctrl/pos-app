// Shared calendar types, watercolor palette and pure helpers used by both the
// detailed day timeline (DayPlanner) and the flanking multi-day preview
// columns (PreviewColumn). No React in here — keep it pure and testable.

export type Block = {
  id: number; block_type: string; title: string; starts_at: string; ends_at: string;
  is_anchor: number; is_locked: number;
};
export type PlanView = { plan: any; blocks: Block[]; unplaced: { title: string; reason: string }[] };
export type ExternalEvent = { startMin: number; endMin: number; title: string; blockType: string };

export type Item = {
  key: string; startMin: number; endMin: number; title: string; type: string;
  external: boolean; anchor: boolean; locked: boolean;
};

/** Everything one day's view needs — cached per date so flips render instantly. */
export type DayData = { plan: PlanView | null; external: ExternalEvent[]; outcomes: any[] };

// Watercolor washes: translucent pinks + ink grays, like the artwork.
export const COLORS: Record<string, { bg: string; fg: string }> = {
  deep_work: { bg: "rgba(231,127,168,0.85)", fg: "white" },
  focused_work: { bg: "rgba(242,169,196,0.8)", fg: "#5b4636" },
  admin: { bg: "rgba(85,82,90,0.28)", fg: "#55525a" },
  comms: { bg: "rgba(214,138,164,0.45)", fg: "#5b4636" },
  meeting: { bg: "rgba(85,82,90,0.55)", fg: "white" },
  gym: { bg: "rgba(163,177,138,0.6)", fg: "#3f4a33" },
  break: { bg: "rgba(253,243,246,0.9)", fg: "#9c8672" },
  meal: { bg: "rgba(230,204,178,0.6)", fg: "#5b4636" },
  transition: { bg: "rgba(245,239,227,0.8)", fg: "#9c8672" },
  shutdown: { bg: "rgba(107,85,68,0.6)", fg: "white" },
  personal: { bg: "rgba(200,182,166,0.55)", fg: "#5b4636" },
};
export const FALLBACK_COLOR = { bg: "rgba(200,182,166,0.55)", fg: "#5b4636" };

// Working day the preview tracks visualize (6:00 → 24:00).
export const DAY_START_MIN = 6 * 60;
export const DAY_END_MIN = 24 * 60;

/* ── time-proportional day grid geometry ──
   The center day is a real time grid: the full 24h is rendered and the
   container scrolls, but 07:00–22:00 is the window scrolled into view. At
   1.2 px/min those 15 hours are 1080px tall — a comfortable viewport — and the
   whole 24h day is 1728px. Everything (cards, gridlines, now-line, free gaps)
   derives its top/height from these two constants alone. */
export const PX_PER_MIN = 1.2;
export const GRID_START_MIN = 0;
export const GRID_END_MIN = 24 * 60;
/** Default visible window scrolled into view on mount / date change. */
export const WINDOW_START_MIN = 7 * 60;
export const WINDOW_END_MIN = 22 * 60;
/** Left gutter holding the hour labels, in px. */
export const GUTTER_PX = 54;
/**
 * Shortest card we would LIKE to draw, so a 10/15-minute block stays readable.
 * It is a wish, not a floor: `cardHeightPx` only grants it when the grid space
 * below the card is genuinely empty (see there — a short card must never paint
 * over the block that starts right after it).
 */
export const MIN_CARD_PX = 26;

/** Absolute offset (px from 00:00) of a minute-of-day on the grid. */
export const yOf = (min: number) => (min - GRID_START_MIN) * PX_PER_MIN;

/** Doctrine fallback when the engine produced no narration for the day. */
export const DOCTRINE_NARRATION =
  "Deep work sits in your 10am–noon peak; admin and comms cluster in the afternoon dip.";

/** First `n` sentences of a narration, trimmed — keeps the footer to two lines. */
export function firstSentences(text: string | null | undefined, n = 2): string {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const parts = s.match(/[^.!?]+[.!?]*/g);
  if (!parts) return s;
  return parts.slice(0, n).join(" ").replace(/\s+/g, " ").trim() || s;
}

/** An item placed into a horizontal lane so overlapping events sit side by side. */
export type LaidOutItem = Item & { lane: number; span: number; lanes: number };

// zero/negative-length items would break both overlap tests and the sweep below
const endOf = (i: Item) => Math.max(i.endMin, i.startMin + 1);
const overlaps = (a: Item, b: Item) => a.startMin < endOf(b) && b.startMin < endOf(a);

/**
 * Standard calendar lane packing. Items are swept in start order and grouped
 * into clusters of transitively-overlapping events; inside a cluster each item
 * takes the first lane whose previous occupant has already ended, then widens
 * across any adjacent lanes that stay free for its whole span. Non-overlapping
 * events end up in a one-lane cluster and keep the full width.
 */
export function layoutLanes(items: Item[]): LaidOutItem[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || endOf(b) - endOf(a));
  const out: LaidOutItem[] = [];
  let cluster: { item: Item; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const lanes = laneEnds.length;
    for (const c of cluster) {
      let span = 1;
      // widen right while the next lane holds nothing overlapping this item
      while (
        c.lane + span < lanes &&
        !cluster.some((o) => o !== c && o.lane === c.lane + span && overlaps(o.item, c.item))
      ) span++;
      out.push({ ...c.item, lane: c.lane, span, lanes });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };

  for (const it of sorted) {
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush(); // disjoint from the cluster so far
    let lane = laneEnds.findIndex((e) => e <= it.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(endOf(it)); }
    else laneEnds[lane] = endOf(it);
    cluster.push({ item: it, lane });
    clusterEnd = Math.max(clusterEnd, endOf(it));
  }
  flush();
  return out.sort((a, b) => a.startMin - b.startMin || a.lane - b.lane);
}

/* ── card height: readable, but never spilling onto the next block ──
   Cards are painted at `duration * PX_PER_MIN`, which at 1.2 px/min makes a
   15-minute break 18px and a 10-minute transition 12px — too short to read. The
   old rule was `max(MIN_CARD_PX, duration * PX_PER_MIN)`, which inflated those
   cards by 8-14px and painted them straight over the block starting immediately
   after (exactly the break/transition overlaps the owner reported). The minimum
   is now capped by the real distance to the next card sharing the column, so a
   short block borrows only empty grid and never a neighbor's space. */

/** Do two laid-out items occupy any of the same lanes (i.e. the same column)? */
export const sharesColumn = (a: LaidOutItem, b: LaidOutItem) =>
  a.lane < b.lane + b.span && b.lane < a.lane + a.span;

/**
 * Painted height in px for a card of `durationMin`, given the minutes from its
 * own start to the start of the next card in its column (null = nothing after
 * it, so the grid below is free).
 *
 * Never shorter than the card's real time span, never longer than the space
 * actually available before the next card begins.
 */
export function cardHeightPx(durationMin: number, minutesToNextStart: number | null): number {
  const natural = Math.max(0, durationMin) * PX_PER_MIN;
  const available =
    minutesToNextStart === null ? Infinity : Math.max(0, minutesToNextStart) * PX_PER_MIN;
  return Math.max(natural, Math.min(MIN_CARD_PX, available));
}

/** Painted height per item key for a whole laid-out day (see `cardHeightPx`). */
export function cardHeights(laid: LaidOutItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of laid) {
    let nextStart = Infinity;
    for (const o of laid) {
      if (o.key === it.key || !sharesColumn(it, o)) continue;
      if (o.startMin > it.startMin && o.startMin < nextStart) nextStart = o.startMin;
    }
    out.set(
      it.key,
      cardHeightPx(it.endMin - it.startMin, nextStart === Infinity ? null : nextStart - it.startMin)
    );
  }
  return out;
}

/**
 * Empty stretches between busy time, from a merged sweep of the day's items
 * (so overlapping events don't fake a gap). Only used to paint a faint dashed
 * affordance in otherwise-empty grid space — never a row in a list.
 */
export function freeGaps(items: Item[], minMinutes = 25): { startMin: number; endMin: number }[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
  const gaps: { startMin: number; endMin: number }[] = [];
  let cursor: number | null = null;
  for (const it of sorted) {
    if (cursor !== null && it.startMin - cursor >= minMinutes) gaps.push({ startMin: cursor, endMin: it.startMin });
    cursor = cursor === null ? endOf(it) : Math.max(cursor, endOf(it));
  }
  return gaps;
}

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const addDaysISO = (iso: string, n: number) =>
  new Date(new Date(`${iso}T12:00:00`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const minOf = (iso: string) => parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);
export const fmtMin = (m: number) => {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
/** Compact hour-gutter label: 0 → "12 AM", 780 → "1 PM". */
export const fmtHour = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  return `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
};
export const fmtDur = (m: number) =>
  m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`;

/** Titles compare case- and whitespace-insensitively when deduping calendars. */
const titleKey = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** How far two copies of the same meeting may drift and still be one meeting. */
const DEDUPE_SLOP_MIN = 2;

/**
 * Is this external event already on the grid as a plan block?
 *
 * The old test was an exact `start-end` string match, so a meeting the plan
 * anchored at 10:00–10:30 and Google now reports as 10:00–10:31 rendered TWICE,
 * as two near-identical stacked cards. Two looser tests replace it: the same
 * span within ±2 minutes on both ends, or an identical title with any overlap
 * at all (which also catches a meeting that has since been moved or extended).
 */
function alreadyOnPlan(blocks: Block[], e: ExternalEvent): boolean {
  const eTitle = titleKey(e.title);
  return blocks.some((b) => {
    const bs = minOf(b.starts_at), be = minOf(b.ends_at);
    if (Math.abs(bs - e.startMin) <= DEDUPE_SLOP_MIN && Math.abs(be - e.endMin) <= DEDUPE_SLOP_MIN) return true;
    const bTitle = titleKey(b.title);
    return !!bTitle && bTitle === eTitle && bs < e.endMin && e.startMin < be;
  });
}

/**
 * One chronological stream for a day: plan blocks + external Google events,
 * hiding externals a plan already shows as anchors (see `alreadyOnPlan`).
 * Used identically by the center timeline and the preview columns so both
 * always agree on what a day contains.
 */
export function buildItems(plan: PlanView | null, external: ExternalEvent[]): Item[] {
  const planBlocks = plan?.blocks ?? [];
  const externalsToShow = plan ? external.filter((e) => !alreadyOnPlan(planBlocks, e)) : external;
  const fromPlan: Item[] = (plan?.blocks ?? []).map((b) => ({
    key: `b${b.id}`, startMin: minOf(b.starts_at), endMin: minOf(b.ends_at),
    title: b.title || b.block_type.replace(/_/g, " "), type: b.block_type,
    external: false, anchor: !!b.is_anchor, locked: !!b.is_locked,
  }));
  const fromGcal: Item[] = externalsToShow.map((e, i) => ({
    key: `x${i}`, startMin: e.startMin, endMin: e.endMin, title: e.title,
    type: e.blockType || "event", external: true, anchor: false, locked: false,
  }));
  return [...fromPlan, ...fromGcal].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
}
