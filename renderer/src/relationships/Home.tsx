import { useCallback, useEffect, useRef, useState } from "react";

// Relationships dashboard: query hero → ranked results, plus the two standing
// panels — Reconnect (cadence debt) and Commitments (extracted obligations).
// Every card routes to Contact Detail; nothing is composed or sent from here.

type RankPerson = {
  id: number;
  display_name: string;
  role: string | null;
  org: string | null;
  bio: string | null;
  relationship_summary: string | null;
  tags: string[];
};
type RankOutcome = { results: { person: RankPerson; reason: string }[]; usedLlm: boolean; usedVec: boolean };

type ReconnectRow = {
  id: number;
  display_name: string;
  org: string | null;
  tier: number;
  last_contact_at: string | null;
  next_touch_due_at: string;
  overdue_days: number;
};

type CommitmentRow = {
  id: number;
  person_id: number | null;
  direction: "i_owe_them" | "they_owe_me";
  description: string;
  due_at: string | null;
  status: string;
  confidence: number;
  confirmed_by_user: number;
};

type PersonLite = { id: number; display_name: string; freshness_days: number | null };

const TIER_LABELS = ["Inner", "Active", "Network", "Archive"] as const;
const tierLabel = (t: number) => TIER_LABELS[t] ?? `Tier ${t}`;

function freshnessText(days: number | null): string {
  if (days == null) return "never contacted";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function SectionHead({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 border-b pb-2 mb-2" style={{ borderColor: "var(--line)" }}>
      <h2 className="font-display text-lg font-medium">{title}</h2>
      {count !== undefined && (
        <span className="text-[13px] tabular-nums" style={{ color: "var(--muted)" }}>{count}</span>
      )}
    </div>
  );
}

export default function Home() {
  const [inquiry, setInquiry] = useState("");
  const [ranked, setRanked] = useState<RankOutcome | null>(null);
  const [ranking, setRanking] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);

  const [reconnect, setReconnect] = useState<ReconnectRow[]>([]);
  const [commitments, setCommitments] = useState<CommitmentRow[]>([]);
  const [peopleById, setPeopleById] = useState<Map<number, PersonLite>>(new Map());

  const refetch = useCallback(async () => {
    const [rec, com, ppl] = await Promise.all([
      window.pos.people.reconnect(),
      window.pos.commitments.list("open"),
      window.pos.people.list(),
    ]);
    setReconnect(rec.ok ? (rec.data as ReconnectRow[]) : []);
    setCommitments(com.ok ? (com.data as CommitmentRow[]) : []);
    if (ppl.ok) {
      setPeopleById(new Map((ppl.data as PersonLite[]).map((p) => [p.id, p])));
    }
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const runQuery = async () => {
    const q = inquiry.trim();
    if (!q || ranking) return;
    setRanking(true);
    setRankError(null);
    const r = await window.pos.query.rank(q);
    if (r.ok) setRanked(r.data as RankOutcome);
    else { setRanked(null); setRankError(r.error ?? "ranking failed"); }
    setRanking(false);
  };

  const act = async (fn: () => Promise<unknown>) => { await fn(); await refetch(); };

  const needsReview = commitments.filter((c) => c.confidence < 0.7);
  const solid = commitments.filter((c) => c.confidence >= 0.7);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="drag-region h-4" />
      <h1 className="font-display text-2xl font-semibold mb-1 no-drag">Relationships</h1>
      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
        Ask anything — "who should I talk to about X", "note about Sarah: …" — from the sparkle button, top right.
      </p>

      <div className="grid grid-cols-2 gap-6 items-start">
        {/* ── Reconnect ── */}
        <section>
          <SectionHead title="Reconnect" count={reconnect.length} />
          {reconnect.length === 0 ? (
            <p className="text-sm py-2" style={{ color: "var(--muted)" }}>Nobody is overdue. Nice.</p>
          ) : (
            <div className="space-y-0.5">
              {reconnect.map((r) => (
                <a
                  key={r.id}
                  href={`#/contact/${r.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white"
                  style={{ color: "var(--ink)" }}
                >
                  <span className="flex-1 truncate">{r.display_name}</span>
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded-full border shrink-0"
                    style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                  >
                    {tierLabel(r.tier)}
                  </span>
                  <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--danger)" }}>
                    {r.overdue_days}d over
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>

        {/* ── Commitments ── */}
        <section>
          <SectionHead title="Commitments" count={commitments.length} />
          {commitments.length === 0 ? (
            <p className="text-sm py-2" style={{ color: "var(--muted)" }}>No open commitments.</p>
          ) : (
            <>
              <CommitmentList rows={solid} peopleById={peopleById} act={act} />
              {needsReview.length > 0 && (
                <>
                  <div
                    className="text-xs font-medium mt-3 mb-1 pt-2 border-t"
                    style={{ color: "var(--muted)", borderColor: "var(--line)" }}
                  >
                    Needs review
                  </div>
                  <CommitmentList rows={needsReview} peopleById={peopleById} act={act} />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function CommitmentList({
  rows,
  peopleById,
  act,
}: {
  rows: CommitmentRow[];
  peopleById: Map<number, PersonLite>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [swiped, setSwiped] = useState<number | null>(null); // row with Delete revealed
  const wheelAcc = useRef(0);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [eventPicker, setEventPicker] = useState<{ id: number; date: string; time: string } | null>(null);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const markAdded = async (id: number) => {
    setAddedIds((prev) => new Set(prev).add(id));
    await new Promise((r) => setTimeout(r, 700)); // let "Added" show before the row refetches away
    await act(async () => {});
  };

  const addTask = async (id: number) => {
    const r = await window.pos.commitments.toTask(id);
    if (!r.ok) { setNotice(r.error ?? "could not add task"); return; }
    const d = r.data as { google?: boolean; reason?: string };
    setNotice(d.google === false ? "Task added locally; connect Google to sync." : null);
    await markAdded(id);
  };

  const addEvent = async (id: number, dateISO?: string, hhmm?: string) => {
    const r = await window.pos.commitments.toEvent(id, dateISO, hhmm);
    if (!r.ok) { setNotice(r.error ?? "could not add event"); return; }
    const d = r.data as { needsDate?: boolean };
    if (d.needsDate) {
      const t = new Date(Date.now() + 24 * 60 * 60_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      setEventPicker({ id, date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, time: "10:00" });
      return;
    }
    setEventPicker(null);
    setNotice(null);
    await markAdded(id);
  };

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {notice && (
        <div className="text-[11px] px-0.5" style={{ color: "var(--muted)" }}>{notice}</div>
      )}
      {menu && (
        <div className="fixed z-50 rounded-lg border bg-white shadow-lg py-1 text-sm"
          style={{ left: menu.x, top: menu.y, borderColor: "var(--line)" }}>
          <button className="block w-full text-left px-3 py-1 hover:bg-[var(--wash)]"
            onClick={() => { const id = menu.id; setMenu(null); act(() => window.pos.commitments.schedule(id)); }}>
            Add to today's plan
          </button>
        </div>
      )}
      {rows.map((c) => {
        const person = c.person_id != null ? peopleById.get(c.person_id) : undefined;
        return (
          <div key={c.id} className="relative overflow-hidden rounded-md">
          <button
            onClick={() => { setSwiped(null); act(() => window.pos.commitments.drop(c.id)); }}
            className="absolute inset-y-0 right-0 w-20 text-xs font-medium text-white"
            style={{ background: "var(--danger)" }}
          >
            Delete
          </button>
          <div className="rounded-md border bg-white px-2.5 py-2 transition-transform duration-150"
            style={{ borderColor: "var(--line)", transform: swiped === c.id ? "translateX(-80px)" : "translateX(0)" }}
            onWheel={(e) => {
              if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
              wheelAcc.current += e.deltaX;
              if (wheelAcc.current > 60) { setSwiped(c.id); wheelAcc.current = 0; }
              else if (wheelAcc.current < -60) { setSwiped(null); wheelAcc.current = 0; }
            }}
            onClick={() => swiped === c.id && setSwiped(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: c.id }); }}>
            {editing?.id === c.id ? (
              <input
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { const t = editing.text; setEditing(null); act(() => window.pos.commitments.updateText(c.id, t)); }
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={() => { const t = editing.text; setEditing(null); act(() => window.pos.commitments.updateText(c.id, t)); }}
                className="w-full text-sm border rounded px-1 py-0.5"
                style={{ borderColor: "var(--accent-soft)" }}
              />
            ) : (
              <div className="text-sm leading-snug cursor-text" title="Double-click to edit"
                onDoubleClick={() => setEditing({ id: c.id, text: c.description })}>{c.description}</div>
            )}
            <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
              {person && (
                <a href={`#/contact/${person.id}`} className="underline decoration-dotted" style={{ color: "var(--muted)" }}>
                  {person.display_name}
                </a>
              )}
              <span>{c.direction === "they_owe_me" ? "they owe me" : "I owe them"}</span>
              {c.due_at && <span>due {c.due_at.slice(0, 10)}</span>}
              <span className="tabular-nums">conf {Math.round(c.confidence * 100)}%</span>
              <span className="ml-auto flex gap-1">
                {addedIds.has(c.id) ? (
                  <span className="px-1.5 py-0.5" style={{ color: "var(--accent)" }}>Added</span>
                ) : (
                  <>
                    <button
                      onClick={() => addTask(c.id)}
                      className="px-1.5 py-0.5 rounded border hover:bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      Add task
                    </button>
                    <button
                      onClick={() => addEvent(c.id)}
                      className="px-1.5 py-0.5 rounded border hover:bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                    >
                      Add event
                    </button>
                  </>
                )}
                {c.confirmed_by_user === 0 && (
                  <>
                    <button
                      onClick={() => act(() => window.pos.commitments.confirm(c.id))}
                      className="px-1.5 py-0.5 rounded border hover:bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => act(() => window.pos.commitments.drop(c.id))}
                      className="px-1.5 py-0.5 rounded border hover:bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--danger)" }}
                    >
                      Drop
                    </button>
                  </>
                )}
              </span>
            </div>
            {eventPicker?.id === c.id && (
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                <span>No due date — pick one:</span>
                <input
                  type="date"
                  value={eventPicker.date}
                  onChange={(e) => setEventPicker({ ...eventPicker, date: e.target.value })}
                  className="px-1 py-0.5 rounded border bg-white"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                />
                <input
                  type="time"
                  value={eventPicker.time}
                  onChange={(e) => setEventPicker({ ...eventPicker, time: e.target.value })}
                  className="px-1 py-0.5 rounded border bg-white"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                />
                <button
                  onClick={() => addEvent(c.id, eventPicker.date, eventPicker.time)}
                  className="px-1.5 py-0.5 rounded border hover:bg-white"
                  style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                >
                  Create
                </button>
                <button
                  onClick={() => setEventPicker(null)}
                  className="px-1.5 py-0.5 rounded border hover:bg-white"
                  style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          </div>
        );
      })}
    </div>
  );
}
