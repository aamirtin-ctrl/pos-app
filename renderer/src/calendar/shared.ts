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

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const addDaysISO = (iso: string, n: number) =>
  new Date(new Date(`${iso}T12:00:00`).getTime() + n * 86400000).toISOString().slice(0, 10);
export const minOf = (iso: string) => parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);
export const fmtMin = (m: number) => {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
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
