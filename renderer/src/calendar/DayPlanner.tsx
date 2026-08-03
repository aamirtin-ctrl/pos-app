import React, { useCallback, useEffect, useMemo, useState } from "react";

// The Calendar Engine surface: braindump → generate → review → accept → push.
// Timeline renders capacity heat behind blocks; unplaced list is explicit — an
// over-committed day that says so beats a plan that quietly deletes input.

type Block = {
  id: number; block_type: string; title: string; starts_at: string; ends_at: string;
  is_anchor: number; is_locked: number; capacity_score_at_placement: number | null;
};
type PlanView = { plan: any; blocks: Block[]; unplaced: { title: string; reason: string }[] };

const COLORS: Record<string, string> = {
  deep_work: "#334155", focused_work: "#64748b", admin: "#a8a29e", comms: "#78716c",
  meeting: "#7c6f64", gym: "#4d7c0f", break: "#d6d3d1", meal: "#d6bfa3",
  transition: "#e7e5e4", shutdown: "#57534e", personal: "#9a8c98",
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const t = (iso: string) => iso.slice(11, 16);
const minOf = (iso: string) => parseInt(iso.slice(11, 13), 10) * 60 + parseInt(iso.slice(14, 16), 10);

export default function DayPlanner() {
  const [date, setDate] = useState(todayISO());
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<any[]>([]);

  const refresh = useCallback(async () => {
    const r = await window.pos.plan.get(date);
    setPlan(r.ok ? (r.data as PlanView | null) : null);
    const y = new Date(new Date(date).getTime() - 86400000).toISOString().slice(0, 10);
    const o = await window.pos.outcomes.needed(y);
    setOutcomes(o.ok ? (o.data as any[]) : []);
  }, [date]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(null);
    try { await fn(); await refresh(); }
    catch (e) { setMsg(String(e)); }
    finally { setBusy(null); }
  };

  const generate = () =>
    run("Planning…", async () => {
      if (text.trim()) {
        const r = await window.pos.tasks.braindump(text.trim(), date);
        if (!r.ok) throw new Error(r.error);
        setText("");
      }
      const g = await window.pos.plan.generate(date);
      if (!g.ok) throw new Error(g.error);
    });

  const dayStart = 6 * 60, dayEnd = 24 * 60, span = dayEnd - dayStart;
  const pct = (m: number) => ((m - dayStart) / span) * 100;

  const laidOut = useMemo(() => (plan?.blocks ?? []).map((b) => ({
    ...b, top: pct(minOf(b.starts_at)), height: Math.max(1.2, pct(minOf(b.ends_at)) - pct(minOf(b.starts_at))),
  })), [plan]);

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 overflow-auto">
        <div className="drag-region h-4" />
        <div className="flex items-baseline justify-between mb-4 no-drag">
          <h1 className="font-display text-2xl font-semibold">Day plan</h1>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="border rounded-md px-2 py-1 text-sm bg-white" style={{ borderColor: "var(--line)" }} />
        </div>

        <div className="mb-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Braindump the day. e.g. "finish the Novum quote, call the fabricator, 2hrs on the physics pset, gym, reply to Sarah"`}
            rows={3}
            className="w-full border rounded-lg p-3 text-sm bg-white resize-none"
            style={{ borderColor: "var(--line)" }}
          />
          <div className="flex gap-2 mt-2 items-center">
            <button onClick={generate} disabled={!!busy}
              className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}>
              {busy ?? "Generate plan"}
            </button>
            {plan?.plan && !plan.plan.accepted_at && (
              <button onClick={() => run("Accepting…", () => window.pos.plan.accept(plan.plan.id))}
                className="px-3 py-1.5 rounded-md text-sm border bg-white" style={{ borderColor: "var(--line)" }}>
                Accept
              </button>
            )}
            {plan?.plan?.accepted_at && (
              <button onClick={() => run("Pushing…", async () => {
                  const r = await window.pos.plan.push(plan.plan.id);
                  if (!r.ok) throw new Error(r.error ?? "push failed — connect Google in Settings");
                })}
                className="px-3 py-1.5 rounded-md text-sm border bg-white" style={{ borderColor: "var(--line)" }}>
                Push to Google
              </button>
            )}
            {msg && <span className="text-xs" style={{ color: "var(--danger)" }}>{msg}</span>}
          </div>
        </div>

        {plan?.plan?.narration && (
          <p className="text-sm mb-4 leading-relaxed border-l-2 pl-3"
             style={{ color: "var(--muted)", borderColor: "var(--accent-soft)" }}>
            {plan.plan.narration}
          </p>
        )}

        {(plan?.unplaced?.length ?? 0) > 0 && (
          <div className="mb-4 rounded-lg border p-3 bg-white" style={{ borderColor: "var(--danger)" }}>
            <div className="text-sm font-medium mb-1" style={{ color: "var(--danger)" }}>
              Didn’t fit ({plan!.unplaced.length})
            </div>
            {plan!.unplaced.map((u, i) => (
              <div key={i} className="text-sm flex justify-between">
                <span>{u.title}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>{u.reason.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        )}

        {outcomes.length > 0 && <OutcomeCapture blocks={outcomes} onDone={refresh} />}
      </div>

      <div className="w-96 shrink-0 border-l overflow-auto p-4" style={{ borderColor: "var(--line)" }}>
        <div className="relative bg-white rounded-lg border" style={{ borderColor: "var(--line)", height: "1400px" }}>
          {Array.from({ length: 18 }, (_, i) => dayStart + i * 60).map((m) => (
            <div key={m} className="absolute w-full border-t text-[10px] pl-1"
              style={{ top: `${pct(m)}%`, borderColor: "var(--line)", color: "var(--muted)" }}>
              {`${String(Math.floor(m / 60)).padStart(2, "0")}:00`}
            </div>
          ))}
          {laidOut.map((b) => (
            <div key={b.id} title={`${t(b.starts_at)}–${t(b.ends_at)} ${b.title}`}
              className="absolute left-10 right-2 rounded-md px-2 py-0.5 overflow-hidden text-white"
              style={{
                top: `${b.top}%`, height: `${b.height}%`,
                background: COLORS[b.block_type] ?? "#888",
                opacity: b.is_anchor ? 0.55 : 1,
                outline: b.is_locked ? "2px solid var(--danger)" : "none",
              }}>
              <div className="text-[11px] font-medium truncate">
                {t(b.starts_at)} {b.title || b.block_type}
                {b.is_anchor ? " ·fixed" : ""}{b.is_locked ? " ·locked" : ""}
              </div>
            </div>
          ))}
        </div>
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
      blocks.map((b) => ({
        blockId: b.id,
        completed: state[b.id].completed,
        perceivedFocus: state[b.id].focus,
      }))
    );
    onDone();
  };
  return (
    <div className="rounded-lg border p-3 bg-white mb-4" style={{ borderColor: "var(--line)" }}>
      <div className="text-sm font-medium mb-2">Yesterday — how did it go? (one prompt, feeds the learning loop)</div>
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
      <button onClick={submit} className="mt-2 px-3 py-1 rounded-md text-sm text-white" style={{ background: "var(--accent)" }}>
        Save outcomes
      </button>
    </div>
  );
}
