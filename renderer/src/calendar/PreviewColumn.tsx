import { COLORS, FALLBACK_COLOR, DAY_START_MIN, DAY_END_MIN, type Item } from "./shared.ts";

// One flanking day-preview in the carousel: a tiny muted "Thu 6" label over a
// thin vertical day-track (6:00-24:00) with tinted rounded blocks positioned
// and sized proportionally to that day's events. No text inside the track —
// it reads as a distant, out-of-focus day. Clicking navigates to the day.

const TRACK_SPAN = DAY_END_MIN - DAY_START_MIN;

export default function PreviewColumn({ iso, items, width, opacity, onSelect }: {
  iso: string;
  items: Item[];
  width: number;
  opacity: number;
  onSelect: (iso: string) => void;
}) {
  const d = new Date(`${iso}T12:00:00`);
  const label = `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(iso)}
      title={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      aria-label={`Go to ${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`}
      className="no-drag shrink-0 flex flex-col items-center gap-2 pt-1 cursor-pointer transition-[transform,opacity] duration-[140ms] hover:scale-[1.03] active:scale-[0.97]"
      style={{ width, opacity, maxHeight: "85vh" }}
    >
      <span
        className="shrink-0 max-w-full truncate text-[10px] font-medium uppercase tracking-wide tabular-nums"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </span>
      <span className="relative block flex-1 w-full min-h-0">
        {/* the soft day-line */}
        <span
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 rounded-full"
          style={{ background: "var(--line)" }}
        />
        {/* tinted blocks, height-proportional to the working day */}
        {items.map((it) => {
          const start = Math.max(it.startMin, DAY_START_MIN);
          const end = Math.min(it.endMin, DAY_END_MIN);
          if (end <= start) return null;
          const c = COLORS[it.type] ?? FALLBACK_COLOR;
          return (
            <span
              key={it.key}
              className="absolute left-1/2 -translate-x-1/2 rounded-full shadow-sm"
              style={{
                top: `${((start - DAY_START_MIN) / TRACK_SPAN) * 100}%`,
                height: `${((end - start) / TRACK_SPAN) * 100}%`,
                minHeight: 4,
                width: "58%",
                background: c.bg,
                border: it.external ? "1px dashed var(--accent-soft)" : "1px solid color-mix(in srgb, white 45%, transparent)",
              }}
            />
          );
        })}
      </span>
    </button>
  );
}
