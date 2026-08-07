import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PreviewColumn from "./PreviewColumn.tsx";
import EventPopover from "./EventPopover.tsx";
import NotionTab from "./NotionTab.tsx";
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

/** Solver slot size — a drag lands on the same grid the engine schedules on. */
const MOVE_SNAP_MIN = 15;
/** Movement only begins after this much travel, so a click still opens the popover. */
const DRAG_THRESHOLD_PX = 4;


type StripTask = {
  id: number; title: string; status: string;
  planDate: string | null; fromGoogle: boolean; scheduled: boolean;
};

/** Where the strip parks: 04:00, which is always empty, and never occupies any minutes. */
const STRIP_MIN = 4 * 60;

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
  // The Google Tasks strip (owner ask 2026-08-06). A task only becomes visible once the solver
  // gives it a block, so everything UNDATED — most of what arrives from Google Tasks — existed
  // in the database and appeared nowhere he looks. He asked whether things had populated and
  // could not tell, which is exactly the gap this closes.
  const [stripTasks, setStripTasks] = useState<StripTask[]>([]);
  const [stripOpen, setStripOpen] = useState(false);

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

  // ── drag to move: pin, then let the day rebuild around the pin ──
  //
  // Owner ask 2026-08-06: "when I move around the events, the breaks and whatever else can
  // change accordingly to the scheduling best practices." So the drag does NOT nudge
  // neighbours by hand — it pins one block and re-solves the day, which is what recomputes
  // recovery breaks, meeting transitions and everything else from doctrine.
  const [moving, setMoving] = useState(false);
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // The date cell being hovered while a card is carried — drives the strip highlight.
  const [carryTarget, setCarryTarget] = useState<string | null>(null);
  const moveToDate = useCallback(async (blockId: number, target: string) => {
    setMoving(true);
    setMoveNote(null);
    try {
      const r = await window.pos.plan.moveBlockToDay(blockId, target);
      const res = (r.ok ? r.data : null) as { moved?: boolean; error?: string } | null;
      if (!r.ok || res?.error) {
        setMoveNote(
          res?.error === "no_task"
            ? "That one is part of the day's structure — only real work moves between days."
            : res?.error === "external_event"
              ? "That event lives on your Google calendar — move it there."
              : res?.error === "past_day"
                ? "That day has already been."
                : "Could not move that to another day."
        );
      } else {
        const when = new Date(`${target}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" });
        setMoveNote(`Moved to ${when} — that day will place it.`);
      }
      await refresh();
    } catch {
      setMoveNote("Could not move that to another day.");
    }
    setMoving(false);
  }, [refresh]);

  const resizeBlock = useCallback(async (blockId: number, startMin: number, endMin: number) => {
    setMoving(true);
    setMoveNote(null);
    try {
      const r = await window.pos.plan.resizeBlock(blockId, startMin, endMin);
      const res = (r.ok ? r.data : null) as { moved?: boolean; error?: string } | null;
      if (!r.ok || res?.error) {
        setMoveNote(
          res?.error === "external_event"
            ? "That event lives on your Google calendar — change its length there."
            : "Could not resize that block."
        );
      }
      await refresh();
    } catch {
      setMoveNote("Could not resize that block.");
    }
    setMoving(false);
  }, [refresh]);

  const moveBlock = useCallback(async (blockId: number, startMin: number) => {
    setMoving(true);
    setMoveNote(null);
    try {
      const r = await window.pos.plan.moveBlock(blockId, startMin);
      const res = (r.ok ? r.data : null) as { moved?: boolean; error?: string } | null;
      if (!r.ok) setMoveNote("Could not move that block.");
      else if (res?.error === "external_event") {
        setMoveNote("That event lives on your Google calendar — move it there and POS will follow.");
      } else if (res?.error) setMoveNote("Could not move that block.");
      await refresh();
    } catch {
      setMoveNote("Could not move that block.");
    }
    setMoving(false);
  }, [refresh]);

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
  // Owner report 2026-08-06: "I just marked as completed several google tasks. This didn't
  // reflect on the app." The strip was fetch-on-mount only, so a completion that landed on
  // the backend (the 15-min tick, or main's on-focus reconcile) had no way to reach the
  // screen without navigating away and back. A local DB read is cheap; poll it.
  useEffect(() => {
    const t = setInterval(() => {
      void window.pos.tasks.strip(dateRef.current).then((sr) => {
        if (sr.ok && Array.isArray(sr.data)) setStripTasks(sr.data as StripTask[]);
      });
    }, 60000);
    return () => clearInterval(t);
  }, []);
  // Task lookup for the popover — purely additive detail, so failures stay silent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        void window.pos.tasks.strip(date).then((sr) => {
          if (!cancelled && sr.ok && Array.isArray(sr.data)) setStripTasks(sr.data as StripTask[]);
        });
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
      {/* The long-term list lives HERE, inside the day view, so it exists only on the calendar
          page — mounting it in App would put it on Relationships and Messaging too. */}
      <NotionTab />
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
                <button key={d.iso} data-day-iso={d.iso} onClick={() => setDateAnimated(d.iso)}
                  className="flex flex-col items-center gap-0.5 rounded-2xl py-1.5 transition-[background-color,transform] duration-[120ms] hover:scale-105 active:scale-95"
                  style={carryTarget === d.iso
                    // The cell under a carried card: unmistakably "drop it here".
                    ? { background: "var(--accent)", color: "white", boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent)", transform: "scale(1.12)" }
                    : selected
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

            <TasksStrip
              tasks={stripTasks}
              open={stripOpen}
              onToggle={() => setStripOpen((v) => !v)}
              onDone={async (id) => {
                await window.pos.tasks.setStatus(id, "done");
                const sr = await window.pos.tasks.strip(date);
                if (sr.ok && Array.isArray(sr.data)) setStripTasks(sr.data as StripTask[]);
              }}
            />
            {moveNote && (
              <div className="absolute z-[70] left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] shadow-sm border"
                style={{ top: 6, background: "white", borderColor: "var(--line)", color: "var(--danger)" }}>
                {moveNote}
              </div>
            )}
            {moving && (
              <div className="absolute z-[70] left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] shadow-sm border"
                style={{ top: 6, background: "white", borderColor: "var(--line)", color: "var(--muted)" }}>
                Rebuilding the day around it…
              </div>
            )}
            {laid.map((it) => (
              <EventCard key={it.key} item={it} height={heights.get(it.key) ?? (it.endMin - it.startMin) * PX_PER_MIN}
                status={status(it)} nowMin={nowMin}
                open={openKey === it.key}
                onToggle={() => setOpenKey((k) => (k === it.key ? null : it.key))}
                onClose={closePopover}
                onMove={moveBlock}
                onResize={resizeBlock}
                onDropOnDate={moveToDate}
                onCarryHover={setCarryTarget}
                onDragStart={closePopover}
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
function EventCard({ item, height, status, nowMin, open, onToggle, onClose, task, onMove, onResize, onDropOnDate, onCarryHover, dragOffset, onDragStart }: {
  item: LaidOutItem; height: number; status: "past" | "current" | "future"; nowMin: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  task: { title: string; status: string } | null;
  /** Commit a drag: the block is pinned here and the day re-solves around it. */
  onMove?: (blockId: number, startMin: number) => void;
  /** Commit an edge drag: the block keeps its other edge and the day re-solves. */
  onResize?: (blockId: number, startMin: number, endMin: number) => void;
  /** Commit a drop on the week strip: the WORK moves to that date. */
  onDropOnDate?: (blockId: number, iso: string) => void | Promise<void>;
  /** The date cell currently hovered while carrying, or null — drives the strip highlight. */
  onCarryHover?: (iso: string | null) => void;
  /** Live px offset while this card is being dragged (0 when it is not). */
  dragOffset?: number;
  onDragStart?: (blockId: number, startMin: number) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // External events belong to the calendar they came from — moving them here would put the
  // two copies out of step. Those are moved in Google/Apple, and the sync picks the change up.
  // What may be dragged.
  //
  // `anchor` alone is NOT the test, and using it was a bug: since past blocks are carried
  // forward and pins are re-read as fixed anchors, most of his day became is_anchor=1 and
  // therefore undraggable — including the blocks he had just moved. An anchor he PINNED is his
  // own placement and must stay draggable; an anchor that is an external calendar event (or
  // already behind him) is not ours to move.
  const movable = !item.external && item.blockId != null && !!onMove && (!item.anchor || item.locked);
  const c = COLORS[item.type] ?? FALLBACK_COLOR;
  const dur = item.endMin - item.startMin;
  const progress = status === "current" ? Math.min(100, Math.max(0, ((nowMin - item.startMin) / Math.max(1, dur)) * 100)) : 0;
  const dim = status === "past";
  const micro = height < 30;   // one compact line: small icon + title, nothing else
  const tight = height < 44;   // no time row / meta pills
  const roomy = height >= 76;  // full card: icon circle, time row, progress bar
  const laneW = 100 / item.lanes;
  // Pointer drag: the card follows the cursor, snapped to the solver's 15-minute grid, and
  // commits on release. Movement only starts after a few px so a click still opens the popover.
  const drag = useRef<{ id: number; x0: number; y0: number; start0: number; live: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!movable) return; // NOT gated on `open`: an open popover used to make the card
                          // undraggable, so one stray click disabled dragging until it closed.
    drag.current = { id: item.blockId!, x0: e.clientX, y0: e.clientY, start0: item.startMin, live: false };
    // Capture NOW, not once the threshold is crossed. A quick drag leaves a short card (a
    // 45-minute block is 54px tall) before the 4px is measured, and without capture the
    // pointermove events then go to whatever is underneath and the drag never starts.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  // ── carrying a card to another day (owner spec 2026-08-06, second pass) ──
  //
  // His words, correcting the first version: "when you click on it to drag it, it should kind
  // of minimize it into a smaller card, and then you drag it into another day from the top bar
  // where you can see the actual dates." So: the moment the pointer reaches the week strip,
  // the card is PICKED UP — it shrinks to a chip that rides the pointer — and the date cells
  // become the drop targets. Releasing over one moves the work to that date; releasing
  // anywhere else cancels the carry and nothing changes.
  //
  // Hit-testing is elementFromPoint against [data-day-iso], because pointer capture routes
  // every pointer event to the card itself — the strip never sees a pointerenter of its own.
  const [carry, setCarry] = useState<{ x: number; y: number; iso: string | null } | null>(null);
  const cellUnder = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest?.("[data-day-iso]")?.getAttribute("data-day-iso") ?? null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    const dx = e.clientX - d.x0;
    if (!d.live && Math.abs(dy) < DRAG_THRESHOLD_PX && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!d.live) {
      d.live = true;
      onDragStart?.(d.id, d.start0); // closes the popover, so the card is not dragged under it
    }
    const iso = cellUnder(e.clientX, e.clientY);
    if (iso !== null || carry !== null) {
      // Over the strip (or returning from it): the card is a chip in the hand, not a block on
      // the grid. Vertical position is meaningless while carried.
      setCarry(iso !== null || Math.abs(dx) > 40 ? { x: e.clientX, y: e.clientY, iso } : null);
      onCarryHover?.(iso);
      setGhost(0);
      return;
    }
    const snapped = Math.round(dy / PX_PER_MIN / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
    setGhost(snapped * PX_PER_MIN);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const wasCarrying = carry;
    setCarry(null);
    onCarryHover?.(null);
    if (!d?.live) return;
    e.stopPropagation();
    const iso = cellUnder(e.clientX, e.clientY);
    if (iso) {
      setGhost(0);
      void onDropOnDate?.(d.id, iso);
      return;
    }
    if (wasCarrying) {
      // Picked up and put back down nowhere — a cancel, not a move.
      setGhost(0);
      return;
    }
    const dy = e.clientY - d.y0;
    const deltaMin = Math.round(dy / PX_PER_MIN / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
    if (deltaMin === 0) { setGhost(0); return; }
    // HOLD the dragged position while the day re-solves. Clearing it here is what made the
    // move feel broken (owner report 2026-08-06: "it didn't update in real time, it went back
    // to how it was then a minute later updated") — the card snapped home the instant the
    // pointer lifted and only jumped once a full re-solve, narration and Google push had
    // finished. The offset now survives until the new plan arrives and this card unmounts.
    void onMove?.(d.id, Math.max(0, d.start0 + deltaMin));
  };
  const [ghost, setGhost] = useState(0);
  const offset = ghost || dragOffset || 0;

  // ── edge handles: extend or limit the time this takes ──
  //
  // Owner ask 2026-08-06: "make it so i can easily move the top/bottom of events to
  // extend/limit time." Dragging an edge keeps the OTHER edge fixed, which is the whole
  // difference from moving — and it says "this takes longer than you thought", so the task's
  // estimate is corrected too (see planner.resizeBlock).
  const [edge, setEdge] = useState<{ side: "top" | "bottom"; delta: number } | null>(null);
  const resizable = movable && !!onResize;
  const startResize = (side: "top" | "bottom") => (e: React.PointerEvent) => {
    if (!resizable) return;
    e.stopPropagation(); // never let the card's own move-drag also claim this gesture
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const y0 = e.clientY;
    const onMoveEdge = (ev: PointerEvent) => {
      const raw = (ev.clientY - y0) / PX_PER_MIN;
      setEdge({ side, delta: Math.round(raw / MOVE_SNAP_MIN) * MOVE_SNAP_MIN });
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMoveEdge);
      el.removeEventListener("pointerup", onUp);
      el.releasePointerCapture?.(ev.pointerId);
      const raw = (ev.clientY - y0) / PX_PER_MIN;
      const delta = Math.round(raw / MOVE_SNAP_MIN) * MOVE_SNAP_MIN;
      setEdge(null);
      if (delta === 0) return;
      const nextStart = side === "top" ? item.startMin + delta : item.startMin;
      const nextEnd = side === "bottom" ? item.endMin + delta : item.endMin;
      if (nextEnd - nextStart < MOVE_SNAP_MIN) return; // a block keeps at least one slot
      onResize?.(item.blockId!, nextStart, nextEnd);
    };
    el.addEventListener("pointermove", onMoveEdge);
    el.addEventListener("pointerup", onUp);
  };
  const topShift = edge?.side === "top" ? edge.delta * PX_PER_MIN : 0;
  const heightShift =
    edge?.side === "bottom" ? edge.delta * PX_PER_MIN : edge?.side === "top" ? -edge.delta * PX_PER_MIN : 0;
  const shownHeight = Math.max(MOVE_SNAP_MIN * PX_PER_MIN, height + heightShift);

  return (
    <div className="absolute"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={() => { drag.current = null; setGhost(0); setCarry(null); onCarryHover?.(null); }}
      style={{
        top: yOf(item.startMin) + offset + topShift, height: shownHeight,
        transition: offset ? "none" : "top 140ms ease",
        cursor: movable ? (offset ? "grabbing" : "grab") : "default",
        left: `calc(${GUTTER_PX + 6}px + (100% - ${GUTTER_PX + 10}px) * ${item.lane * laneW / 100})`,
        width: `calc((100% - ${GUTTER_PX + 10}px) * ${item.span * laneW / 100} - 4px)`,
        // While carried, the real card stays home but fades — the chip in the hand IS the card.
        opacity: carry ? 0.35 : dim ? 0.55 : 1,
        zIndex: (offset || carry ? 60 : open ? 40 : 2) + item.lane, // dragged > open > neighbors
      }}>
      <div ref={cardRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { if (ghost) { e.preventDefault(); return; } onToggle(); }}
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
          // A pin is a choice the owner made, not a problem: danger-red read as an error
          // ("it duplicated the math test and then locked it"). Same weight, calmer colour.
          outline: open || status === "current" ? "2px solid var(--accent)" : item.locked ? "2px dashed var(--accent-soft)" : "none",
          outlineOffset: "1px",
        }}
        title={`${item.title} · ${fmtMin(item.startMin)} – ${fmtMin(item.endMin)}${
          item.locked ? " · pinned here — drag again to move it" : movable ? " · drag to move" : ""
        }`}>
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
      {resizable && (
        <>
          {/* Grab strips on the edges: invisible until hovered, above the card so they win the
              gesture, and never taller than a quarter of a short block's body. */}
          <div
            onPointerDown={startResize("top")}
            className="absolute left-0 right-0 opacity-0 hover:opacity-100 transition-opacity"
            style={{ top: -3, height: Math.min(8, Math.max(5, shownHeight / 4)), cursor: "ns-resize", zIndex: 5 }}
            title="Drag to change when this starts"
          >
            <div className="mx-auto rounded-full" style={{ width: 26, height: 3, marginTop: 2, background: "var(--accent)" }} />
          </div>
          <div
            onPointerDown={startResize("bottom")}
            className="absolute left-0 right-0 opacity-0 hover:opacity-100 transition-opacity"
            style={{ bottom: -3, height: Math.min(8, Math.max(5, shownHeight / 4)), cursor: "ns-resize", zIndex: 5 }}
            title="Drag to change how long this takes"
          >
            <div className="mx-auto rounded-full" style={{ width: 26, height: 3, marginTop: 3, background: "var(--accent)" }} />
          </div>
        </>
      )}
      {carry &&
        createPortal(
          <div
            className="fixed z-[90] rounded-xl border shadow-lg px-2.5 py-1.5 flex items-center gap-1.5 pointer-events-none"
            style={{
              left: carry.x + 10, top: carry.y + 10, maxWidth: 200,
              background: `color-mix(in srgb, ${c.bg} 30%, white)`,
              borderColor: carry.iso ? "var(--accent)" : "var(--line)",
            }}
          >
            <span style={{ color: c.fg === "white" ? "var(--ink)" : c.fg }}><TypeIcon type={item.type} size={12} /></span>
            <span className="text-[11px] truncate" style={{ color: "var(--ink)" }}>{item.title}</span>
          </div>,
          document.body
        )}
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

/**
 * "named without AI" — the tell that block titles are the owner's own braindump text rather
 * than headlines the model wrote (main/engine/parse.ts deterministicParse).
 *
 * DELIBERATE APPROXIMATION: braindump() returns `usedLlm`, but that value is not carried on
 * the plan row and `plan.get` therefore cannot report it. Rather than plumb a new field
 * through the main process for a chip, this asks `llm.health` AT RENDER TIME — so it means
 * "the AI is unavailable right now", not "this specific plan was parsed without it". The two
 * disagree only in the window between a plan being generated and the provider changing
 * state, and in that window the chip is still telling the owner something true and useful.
 */
function useAiUnavailable(): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await window.pos.llm.health();
      if (alive && r.ok) setDown(!(r.data as { ok: boolean }).ok);
    })();
    return () => { alive = false; };
  }, []);
  return down;
}

/** Always-visible footer: why the engine shaped the day the way it did. */
function NarrationFooter({ plan }: { plan: PlanView | null }) {
  const text = firstSentences(plan?.plan?.narration, 2) || DOCTRINE_NARRATION;
  const aiDown = useAiUnavailable();
  return (
    <div className="mt-5 rounded-2xl border px-4 py-3"
      style={{
        borderColor: "color-mix(in srgb, var(--line) 70%, transparent)",
        background: "color-mix(in srgb, var(--wash) 60%, white)",
      }}>
      <div className="text-[10px] font-medium uppercase tracking-wide mb-1 flex items-center gap-2" style={{ color: "var(--accent)", opacity: 0.85 }}>
        <span>Why today looks like this</span>
        {aiDown && (
          <span
            className="normal-case tracking-normal font-normal rounded-full border px-1.5 py-[1px]"
            title="The AI is unavailable, so block titles are your own words rather than rewritten headlines. See Settings → Spend."
            style={{ borderColor: "var(--line)", color: "var(--muted)", opacity: 0.9 }}
          >
            named without AI
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{text}</p>
    </div>
  );
}

/** What plan.accept / plan.push report back (mirrors PlanPushResult in pos.d.ts). */
type PushResult = { pushed: number; tasks: number; withdrawn?: number; error?: string };

/** The stale-grant case: the owner must re-authorize before anything can go out. */
const RECONSENT = "reconsent_required";

/** Mirrors solver.DEFERRED_REASON — the one "unplaced" reason that means "not today". */
const DEFERRED_REASON = "deferred_within_window";

/** "2026-08-07" → "Friday". Falls back to the raw date if it will not parse. */
function weekdayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: "long" });
}

/** Plain-English reason for a typed push error. */
function pushErrorCopy(error: string): string {
  if (error === RECONSENT) return "Google needs re-authorizing since POS's calendar permissions changed.";
  if (error === "not_connected") return "Not on Google — connect Google in Settings.";
  if (error === "auto_push_off") return "Automatic push is off — use Push now, or turn it back on in Settings.";
  return `Not on Google — ${error}`;
}

function pushOkCopy(r: PushResult): string {
  const parts = [`${r.pushed} block${r.pushed === 1 ? "" : "s"}`];
  if (r.tasks > 0) parts.push(`${r.tasks} task${r.tasks === 1 ? "" : "s"}`);
  const withdrawn = r.withdrawn ?? 0;
  const tail = withdrawn > 0 ? ` (${withdrawn} stale event${withdrawn === 1 ? "" : "s"} removed)` : "";
  return `On your Google Calendar — ${parts.join(" and ")}${tail}.`;
}

/**
 * Sync/accept strip; the narration itself lives in NarrationFooter above.
 *
 * Pushing is AUTOMATIC (owner directive 2026-08-06: "it should automatically populate to my
 * Google Calendar, it shouldn't require me to press a button"). The plan goes out the moment
 * it is generated and again whenever it changes, so this strip REPORTS the sync rather than
 * asking for it. "Push now" is a retry, shown only when Google does not have the current plan;
 * a `reconsent_required` failure additionally offers Reconnect Google, which re-runs the push
 * as soon as consent comes back.
 *
 * Accept survives with its ORIGINAL and narrower meaning — the owner has read this day and
 * locked it — because that is what the evening outcome capture and the re-plan logic key on
 * (an un-accepted plan re-solves freely; an accepted one is defended). It is no longer the
 * gate on reaching Google, which is what used to leave a perfectly good plan stranded locally.
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

  // A button press in this component wins; otherwise report the push that generation already
  // did, so a reconsent failure is visible immediately rather than only after a manual retry.
  const shown = push ?? plan.push ?? null;
  const failed = !!shown?.error;
  // Retry is offered whenever Google does not have this plan — a failure we just saw, or a
  // plan whose automatic push has not landed yet. Acceptance is deliberately NOT part of this
  // condition any more: an un-accepted plan is exactly the case that used to strand.
  const showRetry = failed || (!shown && !plan.plan.pushed_at);
  // Nothing has failed and nothing is pending → say so from the persisted stamp, so the
  // status survives a reload instead of only existing in this component's state.
  const syncedCopy = shown
    ? null
    : plan.plan.pushed_at
      ? "On your Google Calendar — syncs automatically as the day changes."
      : "Not on Google yet — this pushes automatically, or use Push now.";

  const unplaced = plan.unplaced ?? [];
  const deferred = unplaced.filter((u) => u.reason === DEFERRED_REASON);
  const overflow = unplaced.filter((u) => u.reason !== DEFERRED_REASON);

  return (
    <div className="mt-3 rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: "var(--line)" }}>
      {/* A deferral is a DECISION, not a failure — the work has days left in its window and
          the engine spent today on what could not wait. Listing it under "Didn't fit" in the
          same red as real overflow told the owner the opposite of what happened. */}
      {deferred.length > 0 && (
        <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
          Moved to a later day: {deferred.map((u) => `${u.title}${u.movedTo ? ` (${weekdayOf(u.movedTo)})` : ""}`).join(", ")}
        </p>
      )}
      {overflow.length > 0 && (
        <p className="text-xs mb-2" style={{ color: "var(--danger)" }}>
          Didn't fit: {overflow.map((u) => `${u.title} (${u.reason.replace(/_/g, " ")})`).join(", ")}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {!plan.plan.accepted_at && (
          <button onClick={accept} disabled={!!busy}
            title="Lock this day in — stops it re-solving on its own and turns on tonight's outcome check-in."
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm disabled:opacity-60"
            style={{ background: "var(--accent)" }}>
            {busy ?? "Lock this day"}
          </button>
        )}
        {showRetry && (
          <button onClick={pushNow} disabled={!!busy}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium border bg-white shadow-sm disabled:opacity-60"
            style={{ borderColor: "var(--line)" }}>
            {busy ?? "Push now"}
          </button>
        )}
        {failed && shown?.error === RECONSENT && (
          <button onClick={reconnect} disabled={!!busy}
            className="px-3.5 py-1.5 rounded-full text-xs font-medium text-white shadow-sm disabled:opacity-60"
            style={{ background: "var(--accent)" }}>
            Reconnect Google
          </button>
        )}
        {msg && <span className="text-xs" style={{ color: "var(--danger)" }}>{msg}</span>}
      </div>
      <p className="text-xs mt-2" style={{ color: shown?.error ? "var(--danger)" : "var(--muted)" }}>
        {shown ? (shown.error ? pushErrorCopy(shown.error) : pushOkCopy(shown)) : syncedCopy}
      </p>
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


/**
 * Tasks parked on the grid at 04:00 — a reading surface, not a block.
 *
 * Owner ask 2026-08-06: "add little tasks that are on the calendar shown with the drop down
 * list, like Google Tasks, and you can always place it at like a four AM time slot. It's not
 * actually a calendar event, but it's just a place for me to see the Google tasks."
 *
 * It occupies no minutes, the solver never sees it, and it cannot be dragged. Collapsed it is
 * one line with a count; open it lists what is outstanding, marking which items already have a
 * block on the grid below and which came from Google.
 */
function TasksStrip({
  tasks, open, onToggle, onDone,
}: {
  tasks: StripTask[];
  open: boolean;
  onToggle: () => void;
  onDone: (id: number) => void | Promise<void>;
}) {
  if (tasks.length === 0) return null;
  const undated = tasks.filter((t) => t.planDate === null).length;
  return (
    <div
      className="absolute"
      style={{
        top: yOf(STRIP_MIN),
        left: GUTTER_PX + 6,
        right: 4,
        zIndex: 3,
      }}
    >
      <button
        onClick={onToggle}
        className="w-full text-left rounded-2xl border px-3 py-1.5 shadow-sm transition-[background-color] duration-[120ms]"
        style={{
          background: "color-mix(in srgb, var(--pink-1) 30%, white)",
          borderColor: "var(--accent-soft)",
          borderStyle: "dashed",
        }}
        title="Your tasks — not calendar events"
      >
        <span className="text-xs font-medium" style={{ color: "var(--ink)" }}>
          {open ? "▾" : "▸"} Tasks · {tasks.length}
        </span>
        {undated > 0 && (
          <span className="text-[10px] ml-2" style={{ color: "var(--muted)" }}>
            {undated} with no date
          </span>
        )}
      </button>

      {open && (
        <div
          className="mt-1 rounded-2xl border shadow-sm px-3 py-2"
          style={{ background: "white", borderColor: "var(--line)" }}
        >
          {tasks.map((t) => (
            <div key={t.id} className="flex items-start gap-2 py-1">
              <input
                type="checkbox"
                onChange={() => void onDone(t.id)}
                className="mt-0.5 shrink-0 cursor-pointer"
                title="Mark done"
              />
              <span className="text-xs flex-1" style={{ color: "var(--ink)" }}>
                {t.title}
                {t.scheduled && (
                  <span className="text-[10px] ml-1.5" style={{ color: "var(--muted)" }}>
                    · on the grid
                  </span>
                )}
                {t.planDate === null && (
                  <span className="text-[10px] ml-1.5" style={{ color: "var(--accent)" }}>
                    · no date
                  </span>
                )}
              </span>
              {t.fromGoogle && (
                <span className="text-[10px] shrink-0" style={{ color: "var(--muted)" }} title="From Google Tasks">
                  G
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
