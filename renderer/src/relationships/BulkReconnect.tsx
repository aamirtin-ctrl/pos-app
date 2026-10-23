import React, { useEffect, useState } from "react";

// Bulk reconnect (owner ask 2026-10-23): select several people on the Reconnect list,
// and POS drafts every note at once — each person on their own best channel. Then one
// button walks the queue: open in Messages / Mail / LinkedIn, log it as reached out,
// move to the next. Still never sends — Messages only holds one prefilled compose at a
// time, so opening them all at once would leave only the last one standing.

type Channel = "text" | "email" | "linkedin";
type Draft = {
  personId: number;
  name: string;
  channel: Channel;
  subject: string | null;
  body: string;
};
type Row = { id: number; draft: Draft | null; error: string | null; status: "drafting" | "ready" | "opened" | "skipped" };

const APP: Record<Channel, string> = { text: "Messages", email: "Mail", linkedin: "LinkedIn" };
const btn =
  "text-xs px-2 py-1 rounded border bg-white hover:shadow-sm active:scale-95 transition-[box-shadow,transform] duration-[120ms] disabled:opacity-40";

/** Draft up to N at a time — the LLM ceiling is per-call, and 20 parallel calls is rude. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export default function BulkReconnect({
  personIds,
  onClose,
  onDone,
}: {
  personIds: number[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => personIds.map((id) => ({ id, draft: null, error: null, status: "drafting" })));
  const [busy, setBusy] = useState(false);
  const patch = (id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const setBody = (id: number, body: string) =>
    setRows((rs) => rs.map((r) => (r.id === id && r.draft ? { ...r, draft: { ...r.draft, body } } : r)));

  useEffect(() => {
    void pool(personIds, 3, async (id) => {
      const r = await window.pos.people.reconnectDraft(id);
      if (r.ok) patch(id, { draft: r.data as Draft, status: "ready" });
      else patch(id, { error: r.error ?? "couldn't write a draft", status: "skipped" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const next = rows.find((r) => r.status === "ready");
  const drafting = rows.filter((r) => r.status === "drafting").length;
  const opened = rows.filter((r) => r.status === "opened").length;

  /** Open one prefilled, log it as reached out (drops off the Reconnect list). */
  const openOne = async (row: Row) => {
    if (!row.draft) return;
    setBusy(true);
    const d = row.draft;
    const r = await window.pos.people.openReconnectDraft({ personId: d.personId, channel: d.channel, body: d.body, subject: d.subject });
    if (r.ok) {
      await window.pos.people.markReachedOut(d.personId, d.channel, d.body);
      patch(row.id, { status: "opened" });
    } else patch(row.id, { error: r.error ?? "couldn't open", status: "skipped" });
    setBusy(false);
  };

  /** Mail and LinkedIn tolerate many windows at once; Messages does not — texts stay one by one. */
  const openAllNonText = async () => {
    for (const r of rows) if (r.status === "ready" && r.draft && r.draft.channel !== "text") await openOne(r);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] flex flex-col rounded-lg border bg-white p-4 shadow-lg"
        style={{ borderColor: "var(--line)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-2">
          <h3 className="text-sm font-semibold">Reach out to {rows.length} people</h3>
          <span className="flex-1" />
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            {drafting ? `drafting ${drafting}...` : `${opened}/${rows.length} opened`}
          </span>
        </div>
        <div className="flex-1 overflow-auto space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded border p-2" style={{ borderColor: "var(--line)", opacity: r.status === "opened" ? 0.5 : 1 }}>
              <div className="flex items-center text-xs mb-1">
                <span className="font-medium">{r.draft?.name ?? `#${r.id}`}</span>
                {r.draft && <span className="ml-2" style={{ color: "var(--muted)" }}>via {APP[r.draft.channel]}</span>}
                <span className="flex-1" />
                {r.status === "ready" && (
                  <>
                    <button className={btn} disabled={busy} onClick={() => openOne(r)} style={{ color: "var(--accent)" }}>Open</button>
                    <button className={`${btn} ml-1`} disabled={busy} onClick={() => patch(r.id, { status: "skipped" })} style={{ color: "var(--muted)" }}>Skip</button>
                  </>
                )}
                {r.status === "opened" && <span style={{ color: "var(--muted)" }}>opened</span>}
                {r.status === "skipped" && <span style={{ color: r.error ? "var(--danger)" : "var(--muted)" }}>{r.error ?? "skipped"}</span>}
              </div>
              {r.status === "drafting" && <p className="text-xs" style={{ color: "var(--muted)" }}>Writing...</p>}
              {r.draft && r.status === "ready" && (
                <textarea
                  className="w-full text-xs rounded border p-1.5"
                  style={{ borderColor: "var(--line)" }}
                  rows={r.draft.channel === "email" ? 6 : 3}
                  value={r.draft.body}
                  onChange={(e) => setBody(r.id, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <span className="text-[11px]" style={{ color: "var(--muted)" }}>Nothing is sent. Each opens prefilled; you hit send.</span>
          <span className="flex-1" />
          <button className={btn} disabled={busy || !rows.some((r) => r.status === "ready" && r.draft?.channel !== "text")} onClick={openAllNonText}>
            Open all emails/LinkedIn
          </button>
          <button
            className={btn}
            disabled={busy || !next}
            onClick={() => next && openOne(next)}
            style={{ color: "white", background: "var(--accent)", borderColor: "var(--accent)" }}
          >
            {next ? `Open next: ${next.draft?.name}` : "All done"}
          </button>
          <button className={btn} onClick={() => { onDone(); onClose(); }}>Close</button>
        </div>
      </div>
    </div>
  );
}
