import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  groups: string[];
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

/** Horizontal chip row for group filtering. `null` value = the "All" chip. */
export function GroupChips({
  groups,
  active,
  onPick,
}: {
  groups: string[];
  active: string | null;
  onPick: (g: string | null) => void;
}) {
  if (groups.length === 0) return null;
  const chip = (label: string, value: string | null) => {
    const selected = active === value;
    return (
      <button
        key={value ?? "__all"}
        onClick={() => onPick(value)}
        className="px-2.5 py-0.5 rounded-full border text-[11px] whitespace-nowrap shrink-0 transition-[background-color,color,transform] duration-[120ms] hover:scale-105 active:scale-95"
        style={
          selected
            ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
            : { background: "white", borderColor: "var(--line)", color: "var(--muted)" }
        }
      >
        {label}
      </button>
    );
  };
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1.5 mb-1.5 no-drag" style={{ scrollbarWidth: "none" }}>
      {chip("All", null)}
      {groups.map((g) => chip(g, g))}
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
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

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

  // group chips over the reconnect list — names come from the rows themselves
  const reconnectGroups = useMemo(
    () => Array.from(new Set(reconnect.flatMap((r) => r.groups ?? []))).sort(),
    [reconnect]
  );
  const activeFilter = groupFilter && reconnectGroups.includes(groupFilter) ? groupFilter : null;
  const reconnectShown = activeFilter
    ? reconnect.filter((r) => (r.groups ?? []).includes(activeFilter))
    : reconnect;

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
          <SectionHead title="Reconnect" count={reconnectShown.length} />
          <GroupChips groups={reconnectGroups} active={activeFilter} onPick={setGroupFilter} />
          {reconnectShown.length === 0 ? (
            <p className="text-sm py-2" style={{ color: "var(--muted)" }}>
              {activeFilter ? "Nobody overdue in this group." : "Nobody is overdue. Nice."}
            </p>
          ) : (
            <div className="space-y-0.5">
              {reconnectShown.map((r) => (
                <a
                  key={r.id}
                  href={`#/contact/${r.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white transition-[background-color,transform] duration-[120ms] hover:scale-[1.01] active:scale-[0.99]"
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

const SWIPE_MAX = 96; // px the row can travel / width of the revealed Delete button
const SWIPE_OPEN_AT = 48; // reveal threshold on gesture end
const SWIPE_SETTLE_MS = 120; // "gesture ended" = this long without wheel events

type Notice = { text: string; kind: "info" | "error" } | null;

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
  // Swipe-to-delete: the row follows the trackpad continuously (x px revealed, 0..SWIPE_MAX),
  // then snaps open/closed with a springy transition once the gesture settles.
  const [swipe, setSwipe] = useState<{ id: number; x: number; live: boolean } | null>(null);
  const swipeRef = useRef<{ id: number; x: number } | null>(null);
  const swipeEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<{ id: number; action: "task" | "event" } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [eventPicker, setEventPicker] = useState<{ id: number; date: string; time: string } | null>(null);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
      if (swipeEndTimer.current) clearTimeout(swipeEndTimer.current);
    };
  }, []);

  const resetSwipe = () => {
    swipeRef.current = null;
    setSwipe(null);
  };

  const onRowWheel = (id: number) => (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const cur = swipeRef.current?.id === id ? swipeRef.current.x : 0;
    const x = Math.max(0, Math.min(SWIPE_MAX, cur + e.deltaX));
    swipeRef.current = { id, x };
    setSwipe({ id, x, live: true }); // live: track the finger, no transition
    if (swipeEndTimer.current) clearTimeout(swipeEndTimer.current);
    swipeEndTimer.current = setTimeout(() => {
      const s = swipeRef.current;
      if (!s) return;
      if (s.x >= SWIPE_OPEN_AT) {
        swipeRef.current = { id: s.id, x: SWIPE_MAX };
        setSwipe({ id: s.id, x: SWIPE_MAX, live: false }); // snap open (springy)
      } else {
        swipeRef.current = null;
        setSwipe({ id: s.id, x: 0, live: false }); // snap closed
      }
    }, SWIPE_SETTLE_MS);
  };

  const markAdded = async (id: number) => {
    setAddedIds((prev) => new Set(prev).add(id));
    await new Promise((r) => setTimeout(r, 700)); // let "Added" show before the row refetches away
    await act(async () => {});
  };

  const addTask = async (id: number) => {
    if (pending) return;
    setPending({ id, action: "task" });
    setNotice(null);
    try {
      const r = await window.pos.commitments.toTask(id);
      if (!r.ok) {
        setNotice({ text: `Could not add task: ${r.error ?? "unknown error"}`, kind: "error" });
        return;
      }
      const d = r.data as { google?: boolean; reason?: string; duplicate?: boolean };
      if (d.google === false) {
        setNotice(
          d.reason === "Google not connected"
            ? { text: "Task added locally. Connect Google in Settings to sync it to your phone.", kind: "info" }
            : { text: `Task added locally, but the Google sync failed: ${d.reason ?? "unknown error"}`, kind: "error" }
        );
      } else {
        setNotice({ text: d.duplicate ? "Task already existed — synced to Google." : "Task added and synced to Google.", kind: "info" });
      }
      await markAdded(id);
    } finally {
      setPending(null);
    }
  };

  const addEvent = async (id: number, dateISO?: string, hhmm?: string) => {
    if (pending) return;
    setPending({ id, action: "event" });
    setNotice(null);
    try {
      const r = await window.pos.commitments.toEvent(id, dateISO, hhmm);
      if (!r.ok) {
        setNotice({ text: `Could not add event: ${r.error ?? "unknown error"}`, kind: "error" });
        return;
      }
      const d = r.data as { needsDate?: boolean; starts_at?: string };
      if (d.needsDate) {
        const t = new Date(Date.now() + 24 * 60 * 60_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        setEventPicker({ id, date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, time: "10:00" });
        setNotice({ text: "No due date on this commitment — pick a date below.", kind: "info" });
        return;
      }
      setEventPicker(null);
      setNotice({ text: `Event pinned for ${d.starts_at ? d.starts_at.replace("T", " at ").slice(0, 19) : "the chosen time"}.`, kind: "info" });
      await markAdded(id);
    } finally {
      setPending(null);
    }
  };

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {notice && (
        <div
          className="text-[12px] px-2 py-1 rounded-md border"
          style={
            notice.kind === "error"
              ? { color: "var(--danger)", borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, white)" }
              : { color: "var(--ink)", borderColor: "var(--accent-soft)", background: "var(--wash)" }
          }
        >
          {notice.text}
        </div>
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
        const revealed = swipe?.id === c.id ? swipe.x : 0;
        const live = swipe?.id === c.id && swipe.live;
        const rowPending = pending?.id === c.id ? pending.action : null;
        return (
          <div key={c.id} className="relative overflow-hidden rounded-md">
          <button
            onClick={() => { resetSwipe(); act(() => window.pos.commitments.drop(c.id)); }}
            className="absolute inset-y-0 right-0 text-xs font-medium text-white"
            style={{
              width: SWIPE_MAX,
              background: "var(--danger)",
              opacity: revealed / SWIPE_MAX, // fades in proportionally to the swipe
              pointerEvents: revealed >= SWIPE_OPEN_AT ? "auto" : "none",
            }}
          >
            Delete
          </button>
          <div className="rounded-md border bg-white px-2.5 py-2"
            style={{
              borderColor: "var(--line)",
              transform: `translateX(${-revealed}px)`,
              // live gesture: follow the trackpad 1:1; settle: springy snap
              transition: live ? "none" : "transform 180ms cubic-bezier(.2,.8,.3,1.1)",
            }}
            onWheel={onRowWheel(c.id)}
            onClick={() => {
              if (revealed > 0) {
                swipeRef.current = null;
                setSwipe({ id: c.id, x: 0, live: false }); // animate closed
              }
            }}
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
                      disabled={rowPending !== null}
                      className="px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60 transition-[background-color,transform] duration-[120ms] active:scale-95"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      {rowPending === "task" ? "Adding…" : "Add task"}
                    </button>
                    <button
                      onClick={() => addEvent(c.id)}
                      disabled={rowPending !== null}
                      className="px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60 transition-[background-color,transform] duration-[120ms] active:scale-95"
                      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                    >
                      {rowPending === "event" ? "Adding…" : "Add event"}
                    </button>
                  </>
                )}
                {c.confirmed_by_user === 0 && (
                  <>
                    <button
                      onClick={() => act(() => window.pos.commitments.confirm(c.id))}
                      className="px-1.5 py-0.5 rounded border hover:bg-white transition-[background-color,transform] duration-[120ms] active:scale-95"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => act(() => window.pos.commitments.drop(c.id))}
                      className="px-1.5 py-0.5 rounded border hover:bg-white transition-[background-color,transform] duration-[120ms] active:scale-95"
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
                  disabled={rowPending !== null}
                  className="px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60"
                  style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                >
                  {rowPending === "event" ? "Creating…" : "Create"}
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
