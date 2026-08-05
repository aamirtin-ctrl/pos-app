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
/** Shortest card we will draw, so a 10-minute block stays readable. */
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

/**
 * One chronological stream for a day: plan blocks + external Google events,
 * hiding externals a plan already shows as anchors (same start/end span).
 * Used identically by the center timeline and the preview columns so both
 * always agree on what a day contains.
 */
export function buildItems(plan: PlanView | null, external: ExternalEvent[]): Item[] {
  const spans = plan ? new Set(plan.blocks.map((b) => `${minOf(b.starts_at)}-${minOf(b.ends_at)}`)) : null;
  const externalsToShow = spans ? external.filter((e) => !spans.has(`${e.startMin}-${e.endMin}`)) : external;
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
