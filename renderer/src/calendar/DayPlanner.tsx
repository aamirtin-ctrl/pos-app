import React, { useCallback, useEffect, useMemo, useState } from "react";
import PreviewColumn from "./PreviewColumn.tsx";
import {
  COLORS, FALLBACK_COLOR, addDaysISO, buildItems, fmtDur, fmtMin, todayISO,
  type DayData, type ExternalEvent, type Item, type PlanView,
} from "./shared.ts";

// Structured-style day view on the cream/pink/brown watercolor theme:
// a single centered vertical timeline with tinted icon circles, rounded event
// cards, free-time gaps and a pulsing now indicator. External Google events
// populate the timeline even before a plan exists; a generated plan overlays
// them as anchors. All plan/gcal/outcomes behavior is unchanged.
//
// Around the center column, a multi-day carousel: adjacent days render as
// narrow no-text preview columns that taper in width and opacity toward the
// edges (a soft perspective effect). Previews draw from the same per-date
// cache, prefetched in the background after the center day loads.

/* ── small inline SVG icons per block type (no emoji) ── */
const ICON_PATHS: Record<string, React.ReactNode> = {
  deep_work: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />,
  focused_work: <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  admin: (<>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M9 12h6M9 16h6" />
  </>),
  comms: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  meeting: (<>
    <circle cx="9" cy="7" r="4" />
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75M23 21v-2a4 4 0 0 0-3-3.87" />
  </>),
  gym: <path d="M6 7v10M10 4v16M14 4v16M18 7v10M2 12h4M18 12h4M10 12h4" />,
  break: (<>
    <path d="M17 8h1a4 4 0 0 1 0 8h-1" />
    <path d="M3 8h14v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z" />
  </>),
  meal: (<>
    <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
    <path d="M7 2v20" />
    <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7" />
  </>),
  transition: <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />,
  shutdown: <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />,
  personal: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />,
  event: (<>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </>),
};
function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[type] ?? ICON_PATHS.event}
    </svg>
  );
}
const LockGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const FLIP_FETCH_DEBOUNCE_MS = 250; // settle time before external-events IPC after day flips
const PREFETCH_TTL_MS = 60_000; // a neighbor prefetched this recently is not refetched

// Carousel geometry: |offset| → column width / opacity, tapering to the edges.
const PREVIEW_WIDTH: Record<number, number> = { 1: 90, 2: 56, 3: 36 };
const PREVIEW_OPACITY: Record<number, number> = { 1: 0.85, 2: 0.6, 3: 0.4 };

export default function DayPlanner() {
  const [date, setDate] = useState(todayISO());
  // slide direction for the timeline enter animation (1 = forward/next day)
  const slideDir = React.useRef(1);
  const setDateAnimated = (next: string) => {
    setDate((d) => {
      slideDir.current = next >= d ? 1 : -1;
      return next;
    });
  };
  // trackpad horizontal scroll pages between days (accumulated so one swipe = one day)
  const dayWheel = React.useRef(0);
  const shiftDay = (n: number) => {
    slideDir.current = n > 0 ? 1 : -1;
    setDate((d: string) => new Date(new Date(`${d}T12:00:00`).getTime() + n * 86400000).toISOString().slice(0, 10));
  };
  const onDayWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    dayWheel.current += e.deltaX;
    if (dayWheel.current > 140) { shiftDay(1); dayWheel.current = 0; }
    else if (dayWheel.current < -140) { shiftDay(-1); dayWheel.current = 0; }
  };
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [external, setExternal] = useState<ExternalEvent[]>([]);
  const [outcomes, setOutcomes] = useState<any[]>([]);
  const [now, setNow] = useState(new Date());

  // Per-date client cache: flipping to a seen day renders instantly from here while
  // the (debounced) fetch revalidates in the background.
  const dayCache = React.useRef(new Map<string, DayData>());
  const dateRef = React.useRef(date);
  dateRef.current = date;
  // bumped whenever a background prefetch lands so cached previews repaint silently
  const [cacheTick, setCacheTick] = useState(0);

  const applyDay = (d: DayData) => {
    setPlan(d.plan);
    setExternal(d.external);
    setOutcomes(d.outcomes);
  };

  // Warm the carousel: fetch plan + gcal for ±3 days around the center, fully in
  // the background (fire-and-forget, after the center day has loaded). Outcomes
  // are center-only; keep whatever a full refresh cached for that date.
  // A neighbor prefetched in the last PREFETCH_TTL_MS is skipped — main keeps its
  // own short TTLs, so re-forcing all 6 on every settled flip was pure waste.
  const prefetchedAt = React.useRef(new Map<string, number>());
  const prefetchNeighbors = useCallback((centerIso: string) => {
    for (const off of [-1, 1, -2, 2, -3, 3]) {
      const iso = addDaysISO(centerIso, off);
      const last = prefetchedAt.current.get(iso);
      if (last && Date.now() - last < PREFETCH_TTL_MS) continue;
      prefetchedAt.current.set(iso, Date.now()); // set before the fetch — no duplicate in-flight
      void (async () => {
        try {
          const [r, g] = await Promise.all([window.pos.plan.get(iso), window.pos.gcal.events(iso)]);
          const prev = dayCache.current.get(iso);
          dayCache.current.set(iso, {
            plan: r.ok ? (r.data as PlanView | null) : null,
            external: g.ok && Array.isArray(g.data) ? (g.data as ExternalEvent[]) : [],
            outcomes: prev?.outcomes ?? [],
          });
          setCacheTick((t) => t + 1);
        } catch {
          prefetchedAt.current.delete(iso); // failed — allow the next flip to retry
        }
      })();
    }
  }, []);

  // Fast path: plan + outcomes are DB-only IPC and answer in milliseconds. They
  // paint the timeline immediately; externals from a previous fetch are kept so
  // the day never blanks while Google/ICS revalidate.
  const refreshLocal = useCallback(async (forDate: string) => {
    const yday = addDaysISO(forDate, -1);
    const [r, o] = await Promise.all([window.pos.plan.get(forDate), window.pos.outcomes.needed(yday)]);
    const data: DayData = {
      plan: r.ok ? (r.data as PlanView | null) : null,
      external: dayCache.current.get(forDate)?.external ?? [], // read at completion — merge-safe
      outcomes: o.ok ? (o.data as any[]) : [],
    };
    dayCache.current.set(forDate, data);
    if (dateRef.current === forDate) applyDay(data); // ignore stale responses after more flips
  }, []);

  // Slow path: external events (Google network + ICS feeds). NEVER blocks the
  // timeline — results merge into the cached day whenever they arrive.
  const refreshExternal = useCallback(async (forDate: string) => {
    const g = await window.pos.gcal.events(forDate);
    if (!g.ok || !Array.isArray(g.data)) return;
    const prev = dayCache.current.get(forDate);
    const data: DayData = {
      plan: prev?.plan ?? null,
      external: g.data as ExternalEvent[],
      outcomes: prev?.outcomes ?? [],
    };
    dayCache.current.set(forDate, data);
    if (dateRef.current === forDate) applyDay(data); // stale-response guard
    else setCacheTick((t) => t + 1); // no longer centered — still repaint its preview
  }, []);

  const refresh = useCallback(async () => {
    const forDate = date;
    await refreshLocal(forDate);
    void refreshExternal(forDate); // never awaited — merges in when it lands
    prefetchNeighbors(forDate); // never awaited — previews fill in silently
  }, [date, refreshLocal, refreshExternal, prefetchNeighbors]);

  useEffect(() => {
    // Optimistic flip: paint the cached day immediately (or clear to a blank day),
    // then refresh the cheap DB-only data right away — first paint never waits on
    // Google/ICS. The external fetch + neighbor prefetch still debounce so rapid
    // flips don't fan out network IPC.
    const cached = dayCache.current.get(date);
    if (cached) applyDay(cached);
    else { setPlan(null); setExternal([]); setOutcomes([]); }
    void refreshLocal(date);
    const t = setTimeout(() => {
      void refreshExternal(date);
      prefetchNeighbors(date);
    }, FLIP_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [date, refreshLocal, refreshExternal, prefetchNeighbors]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = date === todayISO();
  const isPastDay = date < todayISO();

  // one chronological stream: plan blocks + remaining external events
  // (externals that a plan already shows as anchors are hidden inside buildItems)
  const items = useMemo<Item[]>(() => buildItems(plan, external), [plan, external]);

  // responsive carousel depth: ±3 needs ≥1200px, ±2 needs ≥1000px, else ±1
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const maxOffset = winW >= 1200 ? 3 : winW >= 1000 ? 2 : 1;

  // flanking preview columns, rendered straight from the per-date cache
  // (cacheTick invalidates this memo when a background prefetch lands)
  const previews = useMemo(() => {
    void cacheTick;
    const offsets: number[] = [];
    for (let o = -maxOffset; o <= maxOffset; o++) if (o !== 0) offsets.push(o);
    return offsets.map((off) => {
      const iso = addDaysISO(date, off);
      const cached = dayCache.current.get(iso);
      return { iso, off, items: cached ? buildItems(cached.plan, cached.external) : [] };
    });
  }, [date, maxOffset, cacheTick]);

  // week strip (Monday-first, week containing the selected date)
  const week = useMemo(() => {
    const d = new Date(`${date}T12:00:00`);
    const dow = (d.getDay() + 6) % 7;
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(d.getTime() + (i - dow) * 86400000);
      return {
        iso: dd.toISOString().slice(0, 10),
        letter: dd.toLocaleDateString(undefined, { weekday: "narrow" }),
        num: dd.getDate(),
      };
    });
  }, [date]);

  const status = (it: Item): "past" | "current" | "future" => {
    if (isPastDay) return "past";
    if (!isToday) return "future";
    if (it.endMin <= nowMin) return "past";
    if (it.startMin <= nowMin) return "current";
    return "future";
  };
  const nowInsideItem = isToday && items.some((it) => it.startMin <= nowMin && nowMin < it.endMin);

  // rows: events + free-time gaps, with the now-line spliced in chronologically
  const rows: React.ReactNode[] = [];
  let nowPlaced = !isToday || nowInsideItem;
  const pushNow = () => {
    rows.push(
      <div key="now" className="flex items-center gap-3 py-1" aria-label="Current time">
        <span className="w-14 shrink-0 text-right text-[11px] font-semibold tabular-nums" style={{ color: "#d95d5d" }}>
          {fmtMin(nowMin)}
        </span>
        <span className="relative w-9 shrink-0 self-stretch flex items-center justify-center">
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2" style={{ background: "var(--line)" }} />
          <span className="now-dot relative z-[1] w-2.5 h-2.5 rounded-full" style={{ background: "#d95d5d" }} />
        </span>
        <span className="flex-1 h-[2px] rounded-full" style={{ background: "#d95d5d", opacity: 0.85 }} />
      </div>
    );
    nowPlaced = true;
  };
  let prevEnd: number | null = null;
  items.forEach((it) => {
    const gap = prevEnd !== null ? it.startMin - prevEnd : 0;
    if (!nowPlaced && nowMin < it.startMin && (prevEnd === null || nowMin >= prevEnd)) {
      if (gap >= 20 && prevEnd !== null && nowMin > prevEnd) {
        rows.push(<GapRow key={`g${it.key}`} minutes={gap} dim={isPastDay} />);
        pushNow();
      } else {
        pushNow();
        if (gap >= 20) rows.push(<GapRow key={`g${it.key}`} minutes={gap} dim={isPastDay} />);
      }
    } else if (gap >= 20) {
      rows.push(<GapRow key={`g${it.key}`} minutes={gap} dim={isPastDay || (isToday && it.startMin <= nowMin)} />);
    }
    rows.push(<EventRow key={it.key} item={it} status={status(it)} nowMin={nowMin} />);
    prevEnd = Math.max(prevEnd ?? 0, it.endMin);
  });
  if (!nowPlaced && items.length > 0) pushNow();

  const previewCols = (side: "left" | "right") =>
    previews
      .filter((p) => (side === "left" ? p.off < 0 : p.off > 0))
      .map((p) => (
        <PreviewColumn
          key={p.iso}
          iso={p.iso}
          items={p.items}
          width={PREVIEW_WIDTH[Math.abs(p.off)]}
          opacity={PREVIEW_OPACITY[Math.abs(p.off)]}
          onSelect={setDateAnimated}
        />
      ));

  return (
    <div className="h-full flex flex-col relative" onWheel={onDayWheel}>
      <style>{`
        @keyframes plannerPulse {
          0% { box-shadow: 0 0 0 0 rgba(217,93,93,0.45); }
          70% { box-shadow: 0 0 0 9px rgba(217,93,93,0); }
          100% { box-shadow: 0 0 0 0 rgba(217,93,93,0); }
        }
        .now-dot { animation: plannerPulse 2s ease-out infinite; }
      `}</style>

      {/* compact date header + weekday strip (fixed above the carousel row) */}
      <div className="shrink-0 z-10 px-6 pt-8 pb-3 no-drag"
        style={{ background: "color-mix(in srgb, var(--bg) 88%, transparent)", backdropFilter: "blur(6px)" }}>
        <div className="max-w-xl mx-auto">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-display text-xl font-semibold truncate">
              {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </h1>
            <div className="flex items-center gap-2 shrink-0">
              {!isToday && (
                <button onClick={() => setDateAnimated(todayISO())}
                  className="px-2.5 py-1 rounded-full text-[11px] font-medium border bg-white transition-transform duration-[120ms] hover:scale-105 active:scale-95"
                  style={{ borderColor: "var(--line)", color: "var(--accent)" }}>
                  Today
                </button>
              )}
              <input type="date" value={date} onChange={(e) => e.target.value && setDateAnimated(e.target.value)}
                aria-label="Pick a date"
                className="border rounded-full px-2.5 py-1 text-[11px] bg-white"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }} />
            </div>
          </div>
          <div className="flex items-center gap-1">
          <button onClick={() => shiftDay(-7)} title="Previous week" className="px-1.5 py-1 rounded-md text-sm" style={{ color: "var(--muted)" }}>&#8249;</button>
          <div className="mt-3 grid grid-cols-7 gap-1.5 flex-1">
            {week.map((d) => {
              const selected = d.iso === date;
              const today = d.iso === todayISO();
              return (
                <button key={d.iso} onClick={() => setDateAnimated(d.iso)}
                  className="flex flex-col items-center gap-0.5 rounded-2xl py-1.5 transition-[background-color,transform] duration-[120ms] hover:scale-105 active:scale-95"
                  style={selected
                    ? { background: "var(--accent)", color: "white", boxShadow: "0 2px 8px rgba(214,138,164,0.4)" }
                    : { background: "color-mix(in srgb, white 55%, transparent)", color: "var(--ink)" }}>
                  <span className="text-[10px] uppercase tracking-wide" style={{ opacity: selected ? 0.9 : 0.55 }}>
                    {d.letter}
                  </span>
                  <span className="text-sm font-semibold tabular-nums leading-none">{d.num}</span>
                  <span className="w-1 h-1 rounded-full"
                    style={{ background: today ? (selected ? "white" : "var(--accent)") : "transparent" }} />
                </button>
              );
            })}
          </div>
          <button onClick={() => shiftDay(7)} title="Next week" className="px-1.5 py-1 rounded-md text-sm" style={{ color: "var(--muted)" }}>&#8250;</button>
          </div>
        </div>
      </div>

      {/* carousel row: tapering no-text preview columns flank the scrolling center day */}
      <div className="flex-1 min-h-0 px-4 pb-3 flex items-stretch justify-center gap-2.5">
        {previewCols("left")}

        {/* center day — keyed by date so each flip re-enters with a subtle slide+fade */}
        <div className="w-full max-w-xl min-w-0 overflow-y-auto px-2 pb-32">
        <div key={date} className={slideDir.current >= 0 ? "day-enter-fwd" : "day-enter-back"}>
          {items.length > 0 ? (
            <div className="mt-1">{rows}</div>
          ) : (
            <div className="mt-6 rounded-2xl border-2 border-dashed px-4 py-10 flex flex-col items-center gap-2 text-center"
              style={{ borderColor: "var(--accent-soft)", color: "var(--muted)" }}>
              <span className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: "var(--pink-1)", color: "var(--accent)" }}>
                <TypeIcon type="event" size={18} />
              </span>
              <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>Nothing scheduled</p>
              <p className="text-xs">A clear day — plan it or let it breathe.</p>
            </div>
          )}

          <PlanControls plan={plan} onChange={refresh} />
          {outcomes.length > 0 && <OutcomeCapture blocks={outcomes} onDone={refresh} />}
        </div>
        </div>

        {previewCols("right")}
      </div>
    </div>
  );
}

/** One event card on the timeline: time gutter, tinted icon circle on the spine, rounded card. */
function EventRow({ item, status, nowMin }: { item: Item; status: "past" | "current" | "future"; nowMin: number }) {
  const c = COLORS[item.type] ?? FALLBACK_COLOR;
  const dur = item.endMin - item.startMin;
  const progress = status === "current" ? Math.min(100, Math.max(0, ((nowMin - item.startMin) / Math.max(1, dur)) * 100)) : 0;
  const dim = status === "past";
  return (
    <div className="flex gap-3 py-1" style={{ opacity: dim ? 0.55 : 1 }}>
      <span className="w-14 shrink-0 pt-2.5 text-right text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
        {fmtMin(item.startMin)}
      </span>
      <span className="relative w-9 shrink-0 flex justify-center">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2" style={{ background: "var(--line)" }} />
        <span className="relative z-[1] mt-1 w-9 h-9 rounded-full flex items-center justify-center shadow-sm"
          style={{ background: c.bg, color: c.fg, border: "2px solid var(--bg)" }}>
          <TypeIcon type={item.type} />
        </span>
      </span>
      <div className="flex-1 min-w-0 rounded-2xl border px-3.5 py-2.5 shadow-sm"
        style={{
          background: item.external
            ? "color-mix(in srgb, var(--pink-1) 40%, white)"
            : `color-mix(in srgb, ${c.bg} 22%, white)`,
          borderColor: item.external ? "var(--accent-soft)" : "color-mix(in srgb, var(--line) 65%, transparent)",
          borderStyle: item.external ? "dashed" : "solid",
          outline: status === "current" ? "2px solid var(--accent)" : item.locked ? "2px solid var(--danger)" : "none",
          outlineOffset: "1px",
        }}>
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0 truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {item.title}
          </span>
          {item.locked && <span title="Locked" style={{ color: "var(--danger)" }}><LockGlyph /></span>}
          {item.external && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wide"
              style={{ background: "var(--pink-1)", color: "var(--accent)" }}>
              Google
            </span>
          )}
          {!item.external && item.anchor && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wide"
              style={{ background: "var(--panel)", color: "var(--muted)" }}>
              Anchor
            </span>
          )}
          <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium tabular-nums"
            style={{ background: "color-mix(in srgb, white 65%, transparent)", color: "var(--muted)", border: "1px solid var(--line)" }}>
            {fmtDur(dur)}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
          {fmtMin(item.startMin)} – {fmtMin(item.endMin)}
          {status === "current" && <span className="ml-2 font-semibold" style={{ color: "var(--accent)" }}>Now</span>}
        </div>
        {status === "current" && (
          <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: "var(--pink-1)" }}>
            <div className="h-full rounded-full transition-[width]" style={{ width: `${progress}%`, background: "var(--accent)" }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Free time between events, shown as a subtle dashed affordance. */
function GapRow({ minutes, dim }: { minutes: number; dim: boolean }) {
  return (
    <div className="flex gap-3 py-0.5" style={{ opacity: dim ? 0.45 : 1 }}>
      <span className="w-14 shrink-0" />
      <span className="relative w-9 shrink-0 flex justify-center">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 border-l border-dashed" style={{ borderColor: "var(--line)" }} />
      </span>
      <div className="flex-1 rounded-xl border border-dashed px-3.5 py-1.5 text-[11px]"
        style={{ borderColor: "var(--line)", color: "var(--muted)", background: "color-mix(in srgb, var(--wash) 45%, transparent)" }}>
        Free time · {fmtDur(minutes)}
      </div>
    </div>
  );
}

/** Compact narration + accept/push strip; planning itself happens in the top-right command box. */
function PlanControls({ plan, onChange }: { plan: PlanView | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!plan?.plan) return (
    <p className="text-xs mt-4 text-center" style={{ color: "var(--muted)" }}>
      No plan yet — use the sparkle button (top right) to braindump the day.
    </p>
  );
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setMsg(null);
    try { await fn(); onChange(); } catch (e) { setMsg(String((e as Error).message ?? e)); }
    setBusy(null);
  };
  return (
    <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: "var(--line)" }}>
      {plan.plan.narration && (
        <p className="text-xs leading-relaxed mb-2" style={{ color: "var(--muted)" }}>{plan.plan.narration}</p>
      )}
      {(plan.unplaced?.length ?? 0) > 0 && (
        <p className="text-xs mb-2" style={{ color: "var(--danger)" }}>
          Didn't fit: {plan.unplaced.map((u) => `${u.title} (${u.reason.replace(/_/g, " ")})`).join(", ")}
        </p>
      )}
      <div className="flex items-center gap-2">
        {!plan.plan.accepted_at && (
          <button onClick={() => run("Accepting…", () => window.pos.plan.accept(plan.plan.id))}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm" style={{ background: "var(--accent)" }}>
            {busy ?? "Accept plan"}
          </button>
        )}
        {plan.plan.accepted_at && (
          <button onClick={() => run("Pushing…", async () => {
              const r = await window.pos.plan.push(plan.plan.id);
              if (!r.ok) throw new Error(r.error ?? "connect Google in Settings first");
            })}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm" style={{ background: "var(--accent)" }}>
            {busy ?? "Push to Google"}
          </button>
        )}
        {msg && <span className="text-xs" style={{ color: "var(--danger)" }}>{msg}</span>}
      </div>
    </div>
  );
}

function OutcomeCapture({ blocks, onDone }: { blocks: any[]; onDone: () => void }) {
  const [state, setState] = useState<Record<number, { completed: boolean; focus: number | null }>>(
    Object.fromEntries(blocks.map((b) => [b.id, { completed: true, focus: null }]))
  );
  const submit = async () => {
    await window.pos.outcomes.capture(
      blocks.map((b) => ({ blockId: b.id, completed: state[b.id].completed, perceivedFocus: state[b.id].focus }))
    );
    onDone();
  };
  return (
    <div className="rounded-2xl border p-4 bg-white mt-4 shadow-sm" style={{ borderColor: "var(--line)" }}>
      <div className="text-sm font-semibold mb-2 font-display">Yesterday — how did it go?</div>
      {blocks.map((b) => (
        <div key={b.id} className="flex items-center gap-3 text-sm py-1.5 border-b last:border-b-0"
          style={{ borderColor: "color-mix(in srgb, var(--line) 55%, transparent)" }}>
          <input type="checkbox" checked={state[b.id].completed} className="accent-[var(--accent)]"
            onChange={(e) => setState((s) => ({ ...s, [b.id]: { ...s[b.id], completed: e.target.checked } }))} />
          <span className="flex-1 truncate">{b.title || b.block_type}</span>
          <select value={state[b.id].focus ?? ""} className="border rounded-full px-2 py-0.5 text-xs bg-white"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            onChange={(e) => setState((s) => ({ ...s, [b.id]: { ...s[b.id], focus: e.target.value ? Number(e.target.value) : null } }))}>
            <option value="">focus?</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ))}
      <button onClick={submit} className="mt-3 px-3.5 py-1.5 rounded-full text-sm font-medium text-white shadow-sm"
        style={{ background: "var(--accent)" }}>
        Save outcomes
      </button>
    </div>
  );
}
