import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Google-Calendar-style day view on the cream/pink/brown theme.
// Braindump lives in a movable floating card. External Google events populate the
// grid even before a plan exists; a generated plan overlays them as anchors.

type Block = {
  id: number; block_type: string; title: string; starts_at: string; ends_at: string;
  is_anchor: number; is_locked: number;
};
type PlanView = { plan: any; blocks: Block[]; unplaced: { title: string; reason: string }[] };
type ExternalEvent = { startMin: number; endMin: number; title: string; blockType: string };

// Watercolor washes: translucent pinks + ink grays, like the artwork.
const COLORS: Record<string, { bg: string; fg: string }> = {
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

const todayISO = () => new Date().toISOString().slice(0, 10);
const hhmm = (iso: string) => iso.slice(11, 16);
const minOf = (iso: string) => parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);
const DAY_START = 6 * 60, DAY_END = 24 * 60, PX_PER_MIN = 1.4;
const y = (m: number) => (m - DAY_START) * PX_PER_MIN;

export default function DayPlanner() {
  const [date, setDate] = useState(todayISO());
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [external, setExternal] = useState<ExternalEvent[]>([]);
  const [outcomes, setOutcomes] = useState<any[]>([]);
  const [now, setNow] = useState(new Date());

  const refresh = useCallback(async () => {
    const r = await window.pos.plan.get(date);
    setPlan(r.ok ? (r.data as PlanView | null) : null);
    const g = await window.pos.gcal.events(date);
    setExternal(g.ok && Array.isArray(g.data) ? (g.data as ExternalEvent[]) : []);
    const yday = new Date(new Date(date).getTime() - 86400000).toISOString().slice(0, 10);
    const o = await window.pos.outcomes.needed(yday);
    setOutcomes(o.ok ? (o.data as any[]) : []);
  }, [date]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = date === todayISO();

  // hide external events that a plan already shows as anchors
  const externalsToShow = useMemo(() => {
    if (!plan) return external;
    const spans = new Set(plan.blocks.map((b) => `${minOf(b.starts_at)}-${minOf(b.ends_at)}`));
    return external.filter((e) => !spans.has(`${e.startMin}-${e.endMin}`));
  }, [plan, external]);

  return (
    <div className="h-full overflow-auto relative">
      {/* date bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-6 pt-8 pb-2 no-drag"
        style={{ background: "color-mix(in srgb, var(--bg) 88%, transparent)", backdropFilter: "blur(6px)" }}>
        <h1 className="font-display text-xl font-semibold">
          {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </h1>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="border rounded-md px-2 py-1 text-sm bg-white" style={{ borderColor: "var(--line)" }} />
      </div>

      {/* grid */}
      <div className="px-6 pb-32">
        <div className="relative rounded-xl border"  style={{ borderColor: "var(--line)", height: `${(DAY_END - DAY_START) * PX_PER_MIN}px`, background: "linear-gradient(160deg, white 55%, var(--wash))" }}>
          {Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60).map((m) => (
            <div key={m} className="absolute left-0 right-0 flex" style={{ top: `${y(m)}px` }}>
              <span className="w-14 -mt-2 pl-2 text-[11px] text-right pr-2 tabular-nums" style={{ color: "var(--muted)" }}>
                {m === DAY_START ? "" : `${((m / 60 - 1) % 12) + 1} ${m / 60 < 12 ? "AM" : "PM"}`}
              </span>
              <span className="flex-1 border-t" style={{ borderColor: "var(--line)" }} />
            </div>
          ))}

          {externalsToShow.map((e, i) => (
            <div key={`x${i}`} className="absolute left-16 right-3 rounded-lg border-2 border-dashed px-2 py-0.5 overflow-hidden"
              style={{ top: `${y(e.startMin)}px`, height: `${Math.max(20, (e.endMin - e.startMin) * PX_PER_MIN - 2)}px`,
                borderColor: "var(--accent-soft)", background: "color-mix(in srgb, var(--pink-1) 45%, white)" }}>
              <span className="text-[11px] font-medium" style={{ color: "var(--ink)" }}>{e.title} · Google</span>
            </div>
          ))}

          {(plan?.blocks ?? []).map((b) => {
            const c = COLORS[b.block_type] ?? { bg: "#c8b6a6", fg: "white" };
            const h = Math.max(18, (minOf(b.ends_at) - minOf(b.starts_at)) * PX_PER_MIN - 2);
            return (
              <div key={b.id} title={`${hhmm(b.starts_at)}–${hhmm(b.ends_at)} ${b.title}`}
                className="absolute left-16 right-3 rounded-xl px-2 py-0.5 overflow-hidden shadow-sm backdrop-blur-[1px]"
                style={{ top: `${y(minOf(b.starts_at))}px`, height: `${h}px`, background: c.bg, color: c.fg,
                  opacity: b.is_anchor ? 0.75 : 1, outline: b.is_locked ? "2px solid var(--danger)" : "none" }}>
                <div className="text-[11px] font-semibold truncate">{b.title || b.block_type}</div>
                {h > 34 && <div className="text-[10px] opacity-80">{hhmm(b.starts_at)} – {hhmm(b.ends_at)}</div>}
              </div>
            );
          })}

          {isToday && nowMin >= DAY_START && nowMin <= DAY_END && (
            <div className="absolute left-14 right-0 z-10 pointer-events-none" style={{ top: `${y(nowMin)}px` }}>
              <div className="relative border-t-2" style={{ borderColor: "#d95d5d" }}>
                <span className="absolute -left-1.5 -top-[5px] w-2.5 h-2.5 rounded-full" style={{ background: "#d95d5d" }} />
              </div>
            </div>
          )}
        </div>

        <PlanControls plan={plan} onChange={refresh} />
        {outcomes.length > 0 && <OutcomeCapture blocks={outcomes} onDone={refresh} />}
      </div>

    </div>
  );
}

/** Compact narration + accept/push strip; planning itself happens in the top-right command box. */
function PlanControls({ plan, onChange }: { plan: PlanView | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!plan?.plan) return (
    <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
      No plan yet — use the sparkle button (top right) to braindump the day.
    </p>
  );
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setMsg(null);
    try { await fn(); onChange(); } catch (e) { setMsg(String((e as Error).message ?? e)); }
    setBusy(null);
  };
  return (
    <div className="mt-3 rounded-xl border bg-white p-3" style={{ borderColor: "var(--line)" }}>
      {plan.plan.narration && (
        <p className="text-xs leading-relaxed mb-2" style={{ color: "var(--muted)" }}>{plan.plan.narration}</p>
      )}
      {(plan.unplaced?.length ?? 0) > 0 && (
        <p className="text-xs mb-2" style={{ color: "var(--danger)" }}>
          Didn't fit: {plan.unplaced.map((u) => `${u.title} (${u.reason.replace(/_/g, " ")})`).join(", ")}
        </p>
      )}
      <div className="flex gap-2">
        {!plan.plan.accepted_at && (
          <button onClick={() => run("Accepting…", () => window.pos.plan.accept(plan.plan.id))}
            className="px-3 py-1 rounded-lg text-xs text-white" style={{ background: "var(--accent)" }}>
            {busy ?? "Accept plan"}
          </button>
        )}
        {plan.plan.accepted_at && (
          <button onClick={() => run("Pushing…", async () => {
              const r = await window.pos.plan.push(plan.plan.id);
              if (!r.ok) throw new Error(r.error ?? "connect Google in Settings first");
            })}
            className="px-3 py-1 rounded-lg text-xs text-white" style={{ background: "var(--accent)" }}>
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
    <div className="rounded-xl border p-3 bg-white mt-4" style={{ borderColor: "var(--line)" }}>
      <div className="text-sm font-medium mb-2">Yesterday — how did it go?</div>
      {blocks.map((b) => (
        <div key={b.id} className="flex items-center gap-3 text-sm py-1">
          <input type="checkbox" checked={state[b.id].completed}
            onChange={(e) => setState((s) => ({ ...s, [b.id]: { ...s[b.id], completed: e.target.checked } }))} />
          <span className="flex-1 truncate">{b.title || b.block_type}</span>
          <select value={state[b.id].focus ?? ""} className="border rounded px-1 text-xs" style={{ borderColor: "var(--line)" }}
            onChange={(e) => setState((s) => ({ ...s, [b.id]: { ...s[b.id], focus: e.target.value ? Number(e.target.value) : null } }))}>
            <option value="">focus?</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ))}
      <button onClick={submit} className="mt-2 px-3 py-1 rounded-lg text-sm text-white" style={{ background: "var(--accent)" }}>
        Save outcomes
      </button>
    </div>
  );
}
