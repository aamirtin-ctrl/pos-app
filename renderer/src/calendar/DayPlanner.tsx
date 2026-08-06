import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PreviewColumn from "./PreviewColumn.tsx";
import EventPopover from "./EventPopover.tsx";
import {
  COLORS, DOCTRINE_NARRATION, FALLBACK_COLOR, GRID_END_MIN, GRID_START_MIN, GUTTER_PX,
  PX_PER_MIN, WINDOW_START_MIN, addDaysISO, buildItems, cardHeights, firstSentences, fmtDur,
  fmtHour, fmtMin, freeGaps, layoutLanes, todayISO, yOf,
  type DayData, type ExternalEvent, type Item, type LaidOutItem, type PlanView,
} from "./shared.ts";

// Structured-style day view on the cream/pink/brown watercolor theme, rendered
// as a TIME-PROPORTIONAL grid: every card is absolutely positioned by clock
// time (top = startMin * PX_PER_MIN, height = duration * PX_PER_MIN), so a 7am
// block sits near the top of the day and a 7pm one near the bottom. The full
// 24h is drawn and the container scrolls; 07:00 is scrolled into view on mount
// and on every date change. Tinted icon circles, rounded cards, dimmed past /
// outlined current with a progress bar, a pulsing now-line and hour gridlines
// with labels in a left gutter carry the same aesthetic as before. External
// Google events populate the grid even before a plan exists; a generated plan
// overlays them as anchors. All plan/gcal/outcomes behavior is unchanged.
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
  // Detail popover: the key of the ONE card currently open (null = none).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const closePopover = useCallback(() => setOpenKey(null), []);
  // Task title/status per task_id for this day, so a plan block that came from a
  // braindumped task can name it in the popover. Best-effort: the popover just
  // omits the line when the lookup misses (e.g. the task is already done).
  const [tasksById, setTasksById] = useState<Map<number, { title: string; status: string }>>(() => new Map());

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
    setOpenKey(null); // a popover must never survive a day flip
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
  // Task lookup for the popover — purely additive detail, so failures stay silent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await window.pos.tasks.list(date);
        if (cancelled || !r.ok || !Array.isArray(r.data)) return;
        const m = new Map<number, { title: string; status: string }>();
        for (const t of r.data as Record<string, unknown>[]) {
          if (typeof t?.id === "number") m.set(t.id, { title: String(t.title ?? ""), status: String(t.status ?? "") });
        }
        setTasksById(m);
      } catch { /* the popover simply omits the task line */ }
    })();
    return () => { cancelled = true; };
  }, [date]);

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

  const status = (it: { startMin: number; endMin: number }): "past" | "current" | "future" => {
    if (isPastDay) return "past";
    if (!isToday) return "future";
    if (it.endMin <= nowMin) return "past";
    if (it.startMin <= nowMin) return "current";
    return "future";
  };

  // Side-by-side lanes for anything that overlaps in time (see layoutLanes).
  const laid = useMemo(() => layoutLanes(items), [items]);
  // Painted height per card — the readable minimum, capped so a short block
  // (break, transition) can never spill onto the block that follows it.
  const heights = useMemo(() => cardHeights(laid), [laid]);
  // Empty stretches, painted as faint dashed affordances in otherwise-blank grid.
  const gaps = useMemo(() => freeGaps(items), [items]);

  // Scroll 07:00 into view on mount and whenever the day changes. The scroll
  // container stays mounted across flips (only its contents are keyed for the
  // slide animation), so this has to be re-applied per date.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, yOf(WINDOW_START_MIN) - 8);
  }, [date]);

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

        {/* center day — the scroll container is stable (so 7am can be scrolled
            into view); its contents are keyed by date for the slide+fade */}
        <div ref={scrollRef} className="w-full max-w-xl min-w-0 overflow-y-auto px-2 pb-32">
        <div key={date} className={slideDir.current >= 0 ? "day-enter-fwd" : "day-enter-back"}>
          {/* time-proportional grid: full 24h, absolutely positioned by clock time */}
          <div className="relative mt-1" style={{ height: yOf(GRID_END_MIN) }}>
            <HourGrid />

            {/* free time is just empty grid — a faint dashed hint, never a row */}
            {gaps.map((g) => (
              <GapHint key={`g${g.startMin}`} startMin={g.startMin} endMin={g.endMin}
                dim={isPastDay || (isToday && g.endMin <= nowMin)} />
            ))}

            {laid.map((it) => (
              <EventCard key={it.key} item={it} height={heights.get(it.key) ?? (it.endMin - it.startMin) * PX_PER_MIN}
                status={status(it)} nowMin={nowMin}
                open={openKey === it.key}
                onToggle={() => setOpenKey((k) => (k === it.key ? null : it.key))}
                onClose={closePopover}
                task={(it.taskId != null && tasksById.get(it.taskId)) || null} />
            ))}

            {isToday && <NowLine nowMin={nowMin} />}

            {items.length === 0 && (
              <div className="absolute rounded-2xl border-2 border-dashed px-4 py-8 flex flex-col items-center gap-2 text-center"
                style={{
                  top: yOf(WINDOW_START_MIN) + 120, left: GUTTER_PX + 6, right: 4,
                  borderColor: "var(--accent-soft)", color: "var(--muted)",
                  background: "color-mix(in srgb, var(--bg) 70%, transparent)",
                }}>
                <span className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ background: "var(--pink-1)", color: "var(--accent)" }}>
                  <TypeIcon type="event" size={18} />
                </span>
                <p className="text-sm font-medium" style={{ color: "var(--ink)" }}>Nothing scheduled</p>
                <p className="text-xs">A clear day — plan it or let it breathe.</p>
              </div>
            )}
          </div>

          <NarrationFooter plan={plan} />
          <PlanControls plan={plan} onChange={refresh} />
          {outcomes.length > 0 && <OutcomeCapture blocks={outcomes} onDone={refresh} />}
        </div>
        </div>

        {previewCols("right")}
      </div>
    </div>
  );
}

/** Hour rules across the grid with their labels in the left gutter. */
function HourGrid() {
  const hours: number[] = [];
  for (let m = GRID_START_MIN; m <= GRID_END_MIN; m += 60) hours.push(m);
  return (
    <>
      {/* the gutter's own soft spine */}
      <div className="absolute inset-y-0" style={{ left: GUTTER_PX - 6, width: 1, background: "var(--line)" }} />
      {hours.map((m) => {
        const inWindow = m >= WINDOW_START_MIN && m <= GRID_END_MIN;
        return (
          <React.Fragment key={m}>
            <div className="absolute text-[10px] tabular-nums -translate-y-1/2 text-right"
              style={{ top: yOf(m), left: 0, width: GUTTER_PX - 12, color: "var(--muted)", opacity: inWindow ? 0.85 : 0.5 }}>
              {m === GRID_END_MIN ? "" : fmtHour(m)}
            </div>
            <div className="absolute" style={{ top: yOf(m), left: GUTTER_PX - 6, right: 0, height: 1, background: "var(--line)", opacity: 0.75 }} />
            {m + 30 < GRID_END_MIN && (
              <div className="absolute" style={{ top: yOf(m + 30), left: GUTTER_PX - 6, right: 0, height: 1, background: "var(--line)", opacity: 0.3 }} />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** Free time: a faint dashed affordance sitting in the empty grid space itself. */
function GapHint({ startMin, endMin, dim }: { startMin: number; endMin: number; dim: boolean }) {
  const height = (endMin - startMin) * PX_PER_MIN;
  return (
    <div className="absolute rounded-xl border border-dashed flex items-center justify-center pointer-events-none"
      style={{
        top: yOf(startMin) + 2, height: Math.max(0, height - 4), left: GUTTER_PX + 6, right: 4,
        borderColor: "var(--line)", background: "color-mix(in srgb, var(--wash) 35%, transparent)",
        opacity: dim ? 0.35 : 0.7,
      }}>
      {height >= 46 && (
        <span className="text-[10px] tabular-nums" style={{ color: "var(--muted)" }}>
          Free · {fmtDur(endMin - startMin)}
        </span>
      )}
    </div>
  );
}

/**
 * One event, absolutely positioned by clock time: `top` is its start minute and
 * `height` comes from `cardHeights` — its duration scaled by PX_PER_MIN, allowed
 * to round up to a readable minimum ONLY into empty grid, never over the next
 * block. Horizontally it occupies its packed lane span, so overlapping events sit
 * side by side. The card sheds detail as it gets shorter: first the time row and
 * meta pills, then padding and the icon shrink to a single compact line.
 *
 * The card is also the trigger for the detail popover: it carries button
 * semantics (click, Enter/Space, aria-expanded) and anchors EventPopover to its
 * own rect. Only one popover is open at a time — the open card's key lives in
 * DayPlanner, not here.
 */
function EventCard({ item, height, status, nowMin, open, onToggle, onClose, task }: {
  item: LaidOutItem; height: number; status: "past" | "current" | "future"; nowMin: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  task: { title: string; status: string } | null;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const c = COLORS[item.type] ?? FALLBACK_COLOR;
  const dur = item.endMin - item.startMin;
  const progress = status === "current" ? Math.min(100, Math.max(0, ((nowMin - item.startMin) / Math.max(1, dur)) * 100)) : 0;
  const dim = status === "past";
  const micro = height < 30;   // one compact line: small icon + title, nothing else
  const tight = height < 44;   // no time row / meta pills
  const roomy = height >= 76;  // full card: icon circle, time row, progress bar
  const laneW = 100 / item.lanes;
  return (
    <div className="absolute"
      style={{
        top: yOf(item.startMin), height,
        left: `calc(${GUTTER_PX + 6}px + (100% - ${GUTTER_PX + 10}px) * ${item.lane * laneW / 100})`,
        width: `calc((100% - ${GUTTER_PX + 10}px) * ${item.span * laneW / 100} - 4px)`,
        opacity: dim ? 0.55 : 1,
        zIndex: (open ? 40 : 2) + item.lane, // an open card rides above its neighbors
      }}>
      <div ref={cardRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        }}
        className={`no-drag cursor-pointer h-full w-full rounded-2xl border shadow-sm overflow-hidden flex transition-transform duration-[120ms] hover:scale-[1.01] active:scale-[0.99] ${micro ? "gap-1.5 items-center" : tight ? "gap-2 items-center" : "gap-2 items-start"}`}
        style={{
          padding: micro ? "0 6px" : tight ? "3px 8px" : "7px 10px",
          borderRadius: micro ? 8 : tight ? 10 : 14,
          background: item.external
            ? "color-mix(in srgb, var(--pink-1) 40%, white)"
            : `color-mix(in srgb, ${c.bg} 22%, white)`,
          borderColor: item.external ? "var(--accent-soft)" : "color-mix(in srgb, var(--line) 65%, transparent)",
          borderStyle: item.external ? "dashed" : "solid",
          outline: open || status === "current" ? "2px solid var(--accent)" : item.locked ? "2px solid var(--danger)" : "none",
          outlineOffset: "1px",
        }}
        title={`${item.title} · ${fmtMin(item.startMin)} – ${fmtMin(item.endMin)}`}>
        {/* tinted type circle, shrinking with the card */}
        <span className="shrink-0 rounded-full flex items-center justify-center shadow-sm"
          style={{
            width: micro ? 14 : roomy ? 28 : 20, height: micro ? 14 : roomy ? 28 : 20,
            background: c.bg, color: c.fg, border: micro ? "1px solid var(--bg)" : "1.5px solid var(--bg)",
          }}>
          <TypeIcon type={item.type} size={micro ? 9 : roomy ? 14 : 11} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="flex-1 min-w-0 truncate font-semibold"
              style={{ color: "var(--ink)", fontSize: micro ? 10 : tight ? 11 : 13, lineHeight: micro ? 1.1 : 1.3 }}>
              {item.title}
            </span>
            {item.locked && <span title="Locked" style={{ color: "var(--danger)" }}><LockGlyph /></span>}
            {!tight && item.external && (
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wide"
                style={{ background: "var(--pink-1)", color: "var(--accent)" }}>
                Google
              </span>
            )}
            {!tight && !item.external && item.anchor && (
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wide"
                style={{ background: "var(--panel)", color: "var(--muted)" }}>
                Anchor
              </span>
            )}
            {!tight && (
              <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium tabular-nums"
                style={{ background: "color-mix(in srgb, white 65%, transparent)", color: "var(--muted)", border: "1px solid var(--line)" }}>
                {fmtDur(dur)}
              </span>
            )}
          </div>
          {!tight && (
            <div className="mt-0.5 text-[11px] tabular-nums truncate" style={{ color: "var(--muted)" }}>
              {fmtMin(item.startMin)} – {fmtMin(item.endMin)}
              {status === "current" && <span className="ml-2 font-semibold" style={{ color: "var(--accent)" }}>Now</span>}
            </div>
          )}
          {status === "current" && roomy && (
            <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--pink-1)" }}>
              <div className="h-full rounded-full transition-[width]" style={{ width: `${progress}%`, background: "var(--accent)" }} />
            </div>
          )}
        </div>
      </div>
      {open && <EventPopover item={item} anchorRef={cardRef} task={task} onClose={onClose} />}
    </div>
  );
}

/** Pulsing current-time line, positioned by the same time → px mapping. */
function NowLine({ nowMin }: { nowMin: number }) {
  return (
    <div className="absolute flex items-center pointer-events-none" aria-label="Current time"
      style={{ top: yOf(nowMin), left: 0, right: 0, height: 0, zIndex: 30 }}>
      <span className="shrink-0 text-right text-[10px] font-semibold tabular-nums leading-none"
        style={{
          width: GUTTER_PX - 12, color: "#d95d5d", padding: "2px 0", borderRadius: 4,
          background: "color-mix(in srgb, var(--bg) 92%, transparent)", // sits over the hour label
        }}>
        {fmtMin(nowMin)}
      </span>
      <span className="now-dot shrink-0 w-2.5 h-2.5 rounded-full ml-1.5" style={{ background: "#d95d5d" }} />
      <span className="flex-1 h-[2px] rounded-full" style={{ background: "#d95d5d", opacity: 0.85 }} />
    </div>
  );
}

/** Always-visible footer: why the engine shaped the day the way it did. */
function NarrationFooter({ plan }: { plan: PlanView | null }) {
  const text = firstSentences(plan?.plan?.narration, 2) || DOCTRINE_NARRATION;
  return (
    <div className="mt-5 rounded-2xl border px-4 py-3"
      style={{
        borderColor: "color-mix(in srgb, var(--line) 70%, transparent)",
        background: "color-mix(in srgb, var(--wash) 60%, white)",
      }}>
      <div className="text-[10px] font-medium uppercase tracking-wide mb-1" style={{ color: "var(--accent)", opacity: 0.85 }}>
        Why today looks like this
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{text}</p>
    </div>
  );
}

/** What plan.accept / plan.push report back (mirrors PlanPushResult in pos.d.ts). */
type PushResult = { pushed: number; tasks: number; error?: string };

/** The stale-grant case: the owner must re-authorize before anything can go out. */
const RECONSENT = "reconsent_required";

/** Plain-English reason for a typed push error. */
function pushErrorCopy(error: string): string {
  if (error === RECONSENT) return "Google needs re-authorizing since POS's calendar permissions changed.";
  if (error === "not_connected") return "Not pushed — connect Google in Settings.";
  if (error === "auto_push_off") return "Automatic push is off — use Push now, or turn it back on in Settings.";
  return `Not pushed — ${error}`;
}

function pushOkCopy(r: PushResult): string {
  const blocks = `Pushed ${r.pushed} block${r.pushed === 1 ? "" : "s"} to Google`;
  return r.tasks > 0 ? `${blocks} and ${r.tasks} task${r.tasks === 1 ? "" : "s"}` : blocks;
}

/**
 * Accept/push strip; the narration itself lives in NarrationFooter above.
 *
 * Accept is the whole gesture (owner directive 2026-08-05) — it accepts AND pushes, and
 * reports what landed inline. "Push now" is only a retry, shown when a push has actually
 * failed; a `reconsent_required` failure additionally offers Reconnect Google, which
 * re-runs the push as soon as consent comes back.
 */
function PlanControls({ plan, onChange }: { plan: PlanView | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [push, setPush] = useState<PushResult | null>(null);
  if (!plan?.plan) return (
    <p className="text-xs mt-4 text-center" style={{ color: "var(--muted)" }}>
      No plan yet — use the sparkle button (top right) to braindump the day.
    </p>
  );
  const planId = plan.plan.id;

  const run = async (label: string, fn: () => Promise<PushResult | null>) => {
    setBusy(label); setMsg(null);
    try {
      const res = await fn();
      if (res) setPush(res);
      onChange();
    } catch (e) {
      setMsg(String((e as Error).message ?? e));
    }
    setBusy(null);
  };

  const accept = () => run("Accepting…", async () => {
    const r = await window.pos.plan.accept(planId);
    if (!r.ok) throw new Error(r.error ?? "could not accept the plan");
    return (r.data as { push?: PushResult } | undefined)?.push ?? null;
  });

  const pushNow = () => run("Pushing…", async () => {
    const r = await window.pos.plan.push(planId);
    if (!r.ok) throw new Error(r.error ?? "connect Google in Settings first");
    return (r.data as PushResult) ?? null;
  });

  // Re-consent, then immediately retry — the owner asked for one click, not two.
  const reconnect = () => run("Reconnecting…", async () => {
    const r = await window.pos.gcal.connect();
    if (!r.ok || r.data === false) throw new Error(r.error ?? "Google sign-in did not complete");
    const p = await window.pos.plan.push(planId);
    if (!p.ok) throw new Error(p.error ?? "push failed after reconnecting");
    return (p.data as PushResult) ?? null;
  });

  const failed = !!push?.error;
  // Retry is offered for a failure we saw, or for an accepted plan Google never got.
  const showRetry = !!plan.plan.accepted_at && (failed || (!push && !plan.plan.pushed_at));

  return (
    <div className="mt-3 rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: "var(--line)" }}>
      {(plan.unplaced?.length ?? 0) > 0 && (
        <p className="text-xs mb-2" style={{ color: "var(--danger)" }}>
          Didn't fit: {plan.unplaced.map((u) => `${u.title} (${u.reason.replace(/_/g, " ")})`).join(", ")}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {!plan.plan.accepted_at && (
          <button onClick={accept} disabled={!!busy}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm disabled:opacity-60"
            style={{ background: "var(--accent)" }}>
            {busy ?? "Accept & push"}
          </button>
        )}
        {showRetry && (
          <button onClick={pushNow} disabled={!!busy}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium border bg-white shadow-sm disabled:opacity-60"
            style={{ borderColor: "var(--line)" }}>
            {busy ?? "Push now"}
          </button>
        )}
        {failed && push?.error === RECONSENT && (
          <button onClick={reconnect} disabled={!!busy}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm disabled:opacity-60"
            style={{ background: "var(--accent)" }}>
            Reconnect Google
          </button>
        )}
        {msg && <span className="text-xs" style={{ color: "var(--danger)" }}>{msg}</span>}
      </div>
      {push && (
        <p className="text-xs mt-2" style={{ color: push.error ? "var(--danger)" : "var(--muted)" }}>
          {push.error ? pushErrorCopy(push.error) : pushOkCopy(push)}
        </p>
      )}
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
