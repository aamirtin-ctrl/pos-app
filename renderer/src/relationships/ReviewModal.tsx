import React, { useCallback, useEffect, useMemo, useState } from "react";

// Review queue modal — the pos port of PersonalCRM2 components/ReviewModal.tsx
// (GAP_REPORT #7, #8, #9). Three tabs over one payload (main/crm/review.ts):
//
//   New contacts       — people connectors auto-created and tagged 'unverified'.
//                        Click / shift-click / cmd-click to multi-select, then bulk
//                        Keep · Add to group… · Discard.
//   Possible duplicates— clusters of people who look like the same human, showing the
//                        fields that differ. Merge, or "Not duplicates" (remembered).
//   Ambiguous          — handles that matched several people. Pick one, or dismiss.
//
// Deliberately NOT auto-opening (the old app popped itself up on every import): it is
// mounted app-wide from App.tsx and opened by the count badge on the Relationships
// header, via the window event below.

export const REVIEW_OPEN_EVENT = "pos:review-open";
export const REVIEW_CHANGED_EVENT = "pos:review-changed";

/** Open the review modal from anywhere (the Relationships badge). */
export function openReview(): void {
  window.dispatchEvent(new CustomEvent(REVIEW_OPEN_EVENT));
}

type Handle = { kind: string; value: string };

type PendingContact = {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  tier: number;
  created_at: string;
  handles: Handle[];
  interactions: number;
  last_snippet: string | null;
  last_channel: string | null;
  last_at: string | null;
  groups: string[];
};

type DuplicateMember = {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
  handles: string[];
  interactions: number;
  unverified: boolean;
};

type DuplicateCluster = {
  key: string;
  confidence: "high" | "medium";
  reasons: string[];
  members: DuplicateMember[];
  differing: { field: string; values: (string | null)[] }[];
};

type AmbiguousItem = {
  key: string;
  handleKind: string;
  handleValue: string;
  name: string | null;
  sampleText: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  hits: number;
  candidates: { id: number; display_name: string; org: string | null; role: string | null }[];
};

type Queue = {
  contacts: PendingContact[];
  duplicates: DuplicateCluster[];
  ambiguous: AmbiguousItem[];
  counts: { contacts: number; duplicates: number; ambiguous: number; total: number };
};

type Tab = "contacts" | "duplicates" | "ambiguous";

const sub = (role: string | null, org: string | null) => [role, org].filter(Boolean).join(" · ");

/** Live count of everything awaiting review — drives the badge on the Relationships header. */
export function useReviewCount(): number {
  const [total, setTotal] = useState(0);
  const load = useCallback(async () => {
    const r = await window.pos.review.pending();
    setTotal(r.ok ? (r.data as Queue).counts.total : 0);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(REVIEW_CHANGED_EVENT, load);
    return () => window.removeEventListener(REVIEW_CHANGED_EVENT, load);
  }, [load]);
  return total;
}

function Btn({
  children,
  onClick,
  variant = "ghost",
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: "ghost" | "solid" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const skin =
    variant === "solid"
      ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
      : variant === "danger"
        ? { background: "white", borderColor: "var(--line)", color: "var(--danger)" }
        : { background: "white", borderColor: "var(--line)", color: "var(--ink)" };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="px-2 py-1 rounded-lg border text-[11.5px] whitespace-nowrap disabled:opacity-50 hover:shadow-sm transition-[box-shadow,transform] duration-[120ms] active:scale-95"
      style={skin}
    >
      {children}
    </button>
  );
}

export default function ReviewModal() {
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [tab, setTab] = useState<Tab>("contacts");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // multi-select over the New contacts list
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [groupName, setGroupName] = useState("");

  const load = useCallback(async (pick?: boolean) => {
    const r = await window.pos.review.pending();
    if (!r.ok) {
      setError(r.error ?? "could not load the review queue");
      return;
    }
    const q = r.data as Queue;
    setQueue(q);
    setError(null);
    if (pick) {
      setTab(
        q.counts.contacts > 0 ? "contacts" : q.counts.duplicates > 0 ? "duplicates" : q.counts.ambiguous > 0 ? "ambiguous" : "contacts"
      );
    }
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setError(null);
      load(true);
    };
    window.addEventListener(REVIEW_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(REVIEW_OPEN_EVENT, onOpen);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
    setGrouping(false);
    setGroupName("");
  };

  /** Any mutation: run it, refetch, and let the badge know. */
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(r.error ?? "action failed");
        return;
      }
      setError(null);
      clearSelection();
      await load();
      window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT));
    } finally {
      setBusy(false);
    }
  };

  const contacts = queue?.contacts ?? [];

  const onRowClick = (id: number, index: number, e: React.MouseEvent) => {
    const order = contacts.map((c) => c.id);
    if (e.shiftKey && anchor !== null) {
      const a = order.indexOf(anchor);
      if (a !== -1) {
        const [lo, hi] = a < index ? [a, index] : [index, a];
        setSelected(new Set(order.slice(lo, hi + 1)));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
      return;
    }
    setSelected((prev) => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
    setAnchor(id);
  };

  const ids = useMemo(() => [...selected], [selected]);
  const counts = queue?.counts ?? { contacts: 0, duplicates: 0, ambiguous: 0, total: 0 };

  if (!open) return null;

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: "contacts", label: "New contacts", count: counts.contacts },
    { key: "duplicates", label: "Possible duplicates", count: counts.duplicates },
    { key: "ambiguous", label: "Ambiguous", count: counts.ambiguous },
  ];

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(91,70,54,0.32)" }}
      onClick={() => setOpen(false)}
    >
      <div
        className="flex flex-col w-full max-w-2xl rounded-2xl border shadow-xl view-enter"
        style={{ borderColor: "var(--line)", background: "var(--bg)", maxHeight: "84vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header + tabs */}
        <div className="px-5 pt-4 pb-2 border-b" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-baseline gap-2">
            <h2 className="font-display text-lg font-medium" style={{ color: "var(--ink)" }}>
              Review
            </h2>
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>
              {counts.total === 0 ? "all caught up" : `${counts.total} to look at`}
            </span>
            <button
              onClick={() => setOpen(false)}
              className="ml-auto text-sm px-2 leading-none"
              style={{ color: "var(--muted)" }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          <div className="flex gap-1.5 mt-3">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => { setTab(t.key); clearSelection(); }}
                className="px-3 py-1 rounded-full border text-[12px] transition-colors duration-[120ms]"
                style={
                  tab === t.key
                    ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
                    : { background: "white", borderColor: "var(--line)", color: "var(--muted)" }
                }
              >
                {t.label}
                <span className="ml-1.5 tabular-nums">{t.count}</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div
            className="mx-5 mt-3 text-[12px] px-2 py-1 rounded-md border"
            style={{ color: "var(--danger)", borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, white)" }}
          >
            {error}
          </div>
        )}

        <div className="overflow-y-auto px-5 py-3 flex-1" style={{ userSelect: tab === "contacts" ? "none" : "auto" }}>
          {/* ── #8 New contacts ── */}
          {tab === "contacts" &&
            (contacts.length === 0 ? (
              <p className="text-sm py-2" style={{ color: "var(--muted)" }}>
                No new contacts awaiting triage.
              </p>
            ) : (
              <>
                <p className="text-[11px] mb-1.5" style={{ color: "var(--muted)" }}>
                  Click to select · shift-click for a range · cmd-click to toggle
                </p>
                {contacts.map((c, i) => {
                  const isSel = selected.has(c.id);
                  return (
                    <div
                      key={c.id}
                      onClick={(e) => onRowClick(c.id, i, e)}
                      className="flex items-start gap-2.5 px-2 py-2 rounded-lg border-b cursor-pointer transition-[background-color] duration-[120ms]"
                      style={{
                        borderColor: "var(--line)",
                        background: isSel ? "var(--wash)" : "transparent",
                        opacity: busy && isSel ? 0.55 : 1,
                      }}
                    >
                      <span
                        className="mt-0.5 shrink-0 w-[15px] h-[15px] rounded border text-[10px] leading-[13px] text-center"
                        style={{
                          borderColor: isSel ? "var(--accent)" : "var(--line)",
                          background: isSel ? "var(--accent)" : "transparent",
                          color: "white",
                        }}
                      >
                        {isSel ? "✓" : ""}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-display text-[14.5px]" style={{ color: "var(--ink)" }}>
                            {c.display_name}
                          </span>
                          {sub(c.role, c.org) && (
                            <span className="text-[11.5px] truncate" style={{ color: "var(--muted)" }}>
                              {sub(c.role, c.org)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] truncate" style={{ color: "var(--muted)" }}>
                          {c.handles.map((h) => h.value).join(" · ") || "no handle"}
                          {c.interactions > 0 && ` · ${c.interactions} message${c.interactions === 1 ? "" : "s"}`}
                          {c.last_channel && ` · ${c.last_channel}`}
                        </div>
                        {c.last_snippet && (
                          <div className="text-[11.5px] mt-0.5 truncate" style={{ color: "var(--ink-gray)" }}>
                            “{c.last_snippet}”
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            ))}

          {/* ── #9 Possible duplicates ── */}
          {tab === "duplicates" &&
            (queue && queue.duplicates.length > 0 ? (
              <div className="space-y-2.5">
                {queue.duplicates.map((d) => (
                  <div key={d.key} className="rounded-xl border bg-white px-3 py-2.5" style={{ borderColor: "var(--line)" }}>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-[14.5px]" style={{ color: "var(--ink)" }}>
                        {d.members.map((m) => m.display_name).join("  ·  ")}
                      </span>
                      <span
                        className="text-[10.5px] px-1.5 py-0.5 rounded-full border"
                        style={
                          d.confidence === "high"
                            ? { background: "var(--accent-soft)", borderColor: "var(--accent-soft)", color: "var(--ink)" }
                            : { borderColor: "var(--line)", color: "var(--muted)" }
                        }
                      >
                        {d.confidence === "high" ? "likely the same person" : "possible"}
                      </span>
                    </div>
                    {d.reasons.length > 0 && (
                      <div className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>
                        matched on {d.reasons.join(", ")}
                      </div>
                    )}
                    {d.differing.length > 0 && (
                      <table className="mt-1.5 text-[11.5px] w-full">
                        <tbody>
                          {d.differing.map((row) => (
                            <tr key={row.field}>
                              <td className="pr-3 align-top py-0.5 whitespace-nowrap" style={{ color: "var(--muted)" }}>
                                {row.field}
                              </td>
                              {row.values.map((v, i) => (
                                <td key={i} className="pr-3 align-top py-0.5" style={{ color: "var(--ink)" }}>
                                  {v ?? "—"}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="flex gap-1.5 mt-2">
                      <Btn
                        variant="solid"
                        disabled={busy}
                        onClick={() => act(() => window.pos.review.mergeCluster(d.members.map((m) => m.id)))}
                      >
                        Merge {d.members.length}
                      </Btn>
                      <Btn disabled={busy} onClick={() => act(() => window.pos.review.dismissDuplicates(d.key))}>
                        Not duplicates
                      </Btn>
                      {d.members.map((m) => (
                        <a
                          key={m.id}
                          href={`#/contact/${m.id}`}
                          onClick={() => setOpen(false)}
                          className="px-2 py-1 rounded-lg border text-[11.5px] hover:shadow-sm"
                          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                        >
                          Open {m.display_name}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm py-2" style={{ color: "var(--muted)" }}>
                No suspected duplicates.
              </p>
            ))}

          {/* ── #7 Ambiguous ── */}
          {tab === "ambiguous" &&
            (queue && queue.ambiguous.length > 0 ? (
              <div className="space-y-2.5">
                {queue.ambiguous.map((a) => (
                  <div key={a.key} className="rounded-xl border bg-white px-3 py-2.5" style={{ borderColor: "var(--line)" }}>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-[14.5px]" style={{ color: "var(--ink)" }}>
                        {a.name || a.handleValue}
                      </span>
                      <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                        {a.handleKind} · {a.handleValue}
                        {a.hits > 1 && ` · ${a.hits} messages`}
                      </span>
                    </div>
                    {a.sampleText && (
                      <div className="text-[11.5px] mt-0.5" style={{ color: "var(--ink-gray)" }}>
                        “{a.sampleText}”
                      </div>
                    )}
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {a.candidates.map((c) => (
                        <Btn
                          key={c.id}
                          variant="solid"
                          disabled={busy}
                          title={`Attach ${a.handleValue} to ${c.display_name}`}
                          onClick={() => act(() => window.pos.review.resolveAmbiguous(a.key, c.id))}
                        >
                          {c.display_name}
                          {c.org ? ` · ${c.org}` : ""}
                        </Btn>
                      ))}
                      <Btn disabled={busy} onClick={() => act(() => window.pos.review.dismissAmbiguous(a.key))}>
                        Dismiss
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm py-2" style={{ color: "var(--muted)" }}>
                Nothing ambiguous right now.
              </p>
            ))}
        </div>

        {/* footer: bulk bar for the contacts tab, otherwise just Close */}
        <div className="flex items-center gap-2 px-5 py-3 border-t" style={{ borderColor: "var(--line)" }}>
          {tab === "contacts" && selected.size > 0 ? (
            <>
              <span className="text-[12.5px]" style={{ color: "var(--ink)" }}>
                {selected.size} selected
              </span>
              <div className="flex-1" />
              {grouping ? (
                <>
                  <input
                    autoFocus
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && groupName.trim()) act(() => window.pos.review.group(ids, groupName.trim()));
                      if (e.key === "Escape") setGrouping(false);
                    }}
                    placeholder="group name"
                    className="w-36 border rounded-lg px-2 py-1 text-[12px]"
                    style={{ borderColor: "var(--line)" }}
                  />
                  <Btn
                    variant="solid"
                    disabled={busy || !groupName.trim()}
                    onClick={() => act(() => window.pos.review.group(ids, groupName.trim()))}
                  >
                    Add to group
                  </Btn>
                  <Btn onClick={() => setGrouping(false)}>Cancel</Btn>
                </>
              ) : (
                <>
                  <Btn onClick={clearSelection}>Clear</Btn>
                  <Btn variant="solid" disabled={busy} onClick={() => act(() => window.pos.review.keep(ids))}>
                    Keep
                  </Btn>
                  <Btn disabled={busy} onClick={() => setGrouping(true)}>
                    Add to group…
                  </Btn>
                  <Btn variant="danger" disabled={busy} onClick={() => act(() => window.pos.review.discard(ids))}>
                    Discard
                  </Btn>
                </>
              )}
            </>
          ) : (
            <>
              {tab === "contacts" && contacts.length > 0 && (
                <button
                  onClick={() => setSelected(new Set(contacts.map((c) => c.id)))}
                  className="text-[12.5px]"
                  style={{ color: "var(--accent)" }}
                >
                  Select all
                </button>
              )}
              <div className="flex-1" />
              <Btn onClick={() => setOpen(false)}>Close</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
