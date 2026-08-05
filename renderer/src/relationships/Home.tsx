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

type GroupRow = { id: number; name: string; suppress_follow_ups: number };

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

/**
 * Horizontal chip row for group filtering. `null` value = the "All" chip.
 *
 * When `onToggleMute` is supplied (the Reconnect panel), each named chip also carries a
 * follow-up mute control: muted groups show a persistent "muted" pill, unmuted ones reveal
 * "mute" on hover. Callers that only filter (Contacts) pass neither prop and see no change.
 */
export function GroupChips({
  groups,
  active,
  onPick,
  muted,
  onToggleMute,
}: {
  groups: string[];
  active: string | null;
  onPick: (g: string | null) => void;
  muted?: Set<string>;
  onToggleMute?: (group: string, next: boolean) => void;
}) {
  if (groups.length === 0) return null;
  const chip = (label: string, value: string | null) => {
    const selected = active === value;
    const isMuted = value !== null && !!muted?.has(value);
    const skin = selected
      ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
      : { background: "white", borderColor: "var(--line)", color: "var(--muted)" };
    return (
      <span
        key={value ?? "__all"}
        className="group inline-flex items-center gap-1 pl-2.5 pr-2 py-0.5 rounded-full border text-[11px] whitespace-nowrap shrink-0 transition-[background-color,color,transform] duration-[120ms] hover:scale-105"
        style={{ ...skin, opacity: isMuted && !selected ? 0.7 : 1 }}
      >
        <button onClick={() => onPick(value)} className="active:scale-95" style={{ color: "inherit" }}>
          {label}
        </button>
        {onToggleMute && value !== null && (
          <button
            onClick={() => onToggleMute(value, !isMuted)}
            title={
              isMuted
                ? `Follow-ups are muted for ${value} — click to re-enable`
                : `Mute follow-ups for ${value}`
            }
            className={`text-[10px] leading-none px-1 py-0.5 rounded-full border ${
              isMuted ? "" : "opacity-0 group-hover:opacity-100 transition-opacity duration-[120ms]"
            }`}
            style={{
              borderColor: selected ? "rgba(255,255,255,0.6)" : "var(--line)",
              color: selected ? "white" : isMuted ? "var(--danger)" : "var(--muted)",
            }}
          >
            {isMuted ? "muted" : "mute"}
          </button>
        )}
      </span>
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
  // Groups whose follow-ups are muted (grp.suppress_follow_ups) — their members never
  // appear in `reconnect`, so the chips have to come from the group list itself.
  const [mutedGroups, setMutedGroups] = useState<string[]>([]);
  const [snoozeFor, setSnoozeFor] = useState<number | null>(null);

  const refetch = useCallback(async () => {
    const [rec, com, ppl, grp] = await Promise.all([
      window.pos.people.reconnect(),
      window.pos.commitments.list("open"),
      window.pos.people.list(),
      window.pos.groups.list(),
    ]);
    setReconnect(rec.ok ? (rec.data as ReconnectRow[]) : []);
    setCommitments(com.ok ? (com.data as CommitmentRow[]) : []);
    if (ppl.ok) {
      setPeopleById(new Map((ppl.data as PersonLite[]).map((p) => [p.id, p])));
    }
    setMutedGroups(
      grp.ok
        ? (grp.data as GroupRow[]).filter((g) => g.suppress_follow_ups === 1).map((g) => g.name)
        : []
    );
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

  // Anything the autonomy layer did NOT convert stays unconfirmed — that whole set is
  // the review queue, regardless of confidence. Confirmed rows are the solid list.
  const needsReview = commitments.filter((c) => c.confirmed_by_user === 0);
  const solid = commitments.filter((c) => c.confirmed_by_user !== 0);

  // Approve all: confirm + convert each review row through the same toTask flow the
  // per-row button uses (no date picker in batch — toTask falls back to due date/today).
  const [approvingAll, setApprovingAll] = useState(false);
  const approveAll = async () => {
    if (approvingAll || needsReview.length === 0) return;
    setApprovingAll(true);
    try {
      for (const c of needsReview) {
        await window.pos.commitments.toTask(c.id);
      }
    } finally {
      setApprovingAll(false);
      await refetch();
    }
  };

  // Group chips over the reconnect list: names from the rows themselves, plus the muted
  // groups (whose members are filtered out upstream) so they can be un-muted from here.
  const mutedSet = useMemo(() => new Set(mutedGroups), [mutedGroups]);
  const reconnectGroups = useMemo(
    () => Array.from(new Set([...reconnect.flatMap((r) => r.groups ?? []), ...mutedGroups])).sort(),
    [reconnect, mutedGroups]
  );
  const activeFilter = groupFilter && reconnectGroups.includes(groupFilter) ? groupFilter : null;
  const reconnectShown = activeFilter
    ? reconnect.filter((r) => (r.groups ?? []).includes(activeFilter))
    : reconnect;

  const toggleMute = async (group: string, next: boolean) => {
    await window.pos.groups.suppressFollowUps(group, next);
    await refetch();
  };

  /** days = null → dismissed indefinitely. */
  const snooze = async (personId: number, days: number | null) => {
    setSnoozeFor(null);
    await window.pos.people.dismissReconnect(personId, days);
    await refetch();
  };

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
          <GroupChips
            groups={reconnectGroups}
            active={activeFilter}
            onPick={setGroupFilter}
            muted={mutedSet}
            onToggleMute={toggleMute}
          />
          {reconnectShown.length === 0 ? (
            <p className="text-sm py-2" style={{ color: "var(--muted)" }}>
              {activeFilter && mutedSet.has(activeFilter)
                ? "Follow-ups are muted for this group."
                : activeFilter
                  ? "Nobody overdue in this group."
                  : "Nobody is overdue. Nice."}
            </p>
          ) : (
            <div className="space-y-0.5">
              {reconnectShown.map((r) => (
                <div
                  key={r.id}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white transition-[background-color] duration-[120ms]"
                  style={{ color: "var(--ink)" }}
                >
                  <a href={`#/contact/${r.id}`} className="flex-1 truncate" style={{ color: "var(--ink)" }}>
                    {r.display_name}
                  </a>
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded-full border shrink-0"
                    style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                  >
                    {tierLabel(r.tier)}
                  </span>
                  <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--danger)" }}>
                    {r.overdue_days}d over
                  </span>
                  {/* Snooze / dismiss (gap #22): hidden until the row is hovered or opened. */}
                  <span
                    className={`flex gap-1 shrink-0 ${
                      snoozeFor === r.id ? "" : "opacity-0 group-hover:opacity-100 transition-opacity duration-[120ms]"
                    }`}
                  >
                    {snoozeFor === r.id ? (
                      <>
                        <button
                          onClick={() => snooze(r.id, 30)}
                          className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:shadow-sm active:scale-95"
                          style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                        >
                          30d
                        </button>
                        <button
                          onClick={() => snooze(r.id, 90)}
                          className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:shadow-sm active:scale-95"
                          style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                        >
                          90d
                        </button>
                        <button
                          onClick={() => snooze(r.id, null)}
                          title="Hide indefinitely"
                          className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:shadow-sm active:scale-95"
                          style={{ borderColor: "var(--line)", color: "var(--danger)" }}
                        >
                          Dismiss
                        </button>
                        <button
                          onClick={() => setSnoozeFor(null)}
                          className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:shadow-sm active:scale-95"
                          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setSnoozeFor(r.id)}
                        className="text-[11px] px-1.5 py-0.5 rounded border bg-white hover:shadow-sm active:scale-95"
                        style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                      >
                        Snooze
                      </button>
                    )}
                  </span>
                </div>
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
                    className="flex items-center gap-2 mt-3 mb-1 pt-2 border-t"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                      Needs review
                    </span>
                    <span
                      className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full"
                      style={{ background: "var(--accent)", color: "white" }}
                    >
                      {needsReview.length}
                    </span>
                    <button
                      onClick={approveAll}
                      disabled={approvingAll}
                      className="ml-auto text-[11px] px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60 transition-[background-color,transform] duration-[120ms] active:scale-95"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      {approvingAll ? "Approving…" : "Approve all"}
                    </button>
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
  // Always-prompt picker: "Add task" (date) and "Add event" (date+time) BOTH open this
  // inline picker first, prefilled from the commitment's due date; nothing is created
  // until Create is clicked with explicit values.
  const [picker, setPicker] = useState<{ id: number; mode: "task" | "event"; date: string; time: string } | null>(null);
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

  const pad = (n: number) => String(n).padStart(2, "0");
  const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** Prefill: task date = due date else today; event date = due date else tomorrow,
   *  time = the due date's clock time when it has one (non-midnight), else 10:00. */
  const openPicker = (c: CommitmentRow, mode: "task" | "event") => {
    setNotice(null);
    const due = c.due_at ? c.due_at.slice(0, 10) : null;
    if (mode === "task") {
      setPicker({ id: c.id, mode, date: due ?? isoDate(new Date()), time: "" });
    } else {
      const dueTime = c.due_at ? c.due_at.slice(11, 16) : "";
      setPicker({
        id: c.id,
        mode,
        date: due ?? isoDate(new Date(Date.now() + 24 * 60 * 60_000)),
        time: dueTime && dueTime !== "00:00" ? dueTime : "10:00",
      });
    }
  };

  const addTask = async (id: number, dateISO: string) => {
    if (pending) return;
    setPending({ id, action: "task" });
    setNotice(null);
    try {
      const r = await window.pos.commitments.toTask(id, dateISO);
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
      setPicker(null);
      await markAdded(id);
    } finally {
      setPending(null);
    }
  };

  const addEvent = async (id: number, dateISO: string, hhmm: string) => {
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
        // Shouldn't happen (the picker always sends a date) — reopen it as a fallback.
        setPicker({ id, mode: "event", date: isoDate(new Date(Date.now() + 24 * 60 * 60_000)), time: "10:00" });
        setNotice({ text: "No due date on this commitment — pick a date below.", kind: "info" });
        return;
      }
      setPicker(null);
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
                      onClick={() => openPicker(c, "task")}
                      disabled={rowPending !== null}
                      className="px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60 transition-[background-color,transform] duration-[120ms] active:scale-95"
                      style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                    >
                      {rowPending === "task" ? "Adding…" : "Add task"}
                    </button>
                    <button
                      onClick={() => openPicker(c, "event")}
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
            {picker?.id === c.id && (
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                <span>{picker.mode === "task" ? "Task date:" : "Event date + time:"}</span>
                <input
                  type="date"
                  value={picker.date}
                  onChange={(e) => setPicker({ ...picker, date: e.target.value })}
                  className="px-1 py-0.5 rounded border bg-white"
                  style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                />
                {picker.mode === "event" && (
                  <input
                    type="time"
                    value={picker.time}
                    onChange={(e) => setPicker({ ...picker, time: e.target.value })}
                    className="px-1 py-0.5 rounded border bg-white"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  />
                )}
                <button
                  onClick={() =>
                    picker.mode === "task"
                      ? addTask(c.id, picker.date)
                      : addEvent(c.id, picker.date, picker.time)
                  }
                  disabled={rowPending !== null || !picker.date}
                  className="px-1.5 py-0.5 rounded border hover:bg-white disabled:opacity-60"
                  style={{ borderColor: "var(--line)", color: "var(--accent)" }}
                >
                  {rowPending !== null ? "Creating…" : "Create"}
                </button>
                <button
                  onClick={() => setPicker(null)}
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
