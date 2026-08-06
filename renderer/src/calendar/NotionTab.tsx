import React, { useCallback, useEffect, useState } from "react";

// The Notion tab — his page, editable, beside the calendar.
//
// Owner ask 2026-08-06: "a little side tab below the sparkle button, only viewed on the
// calendar page… whatever is in there, this tab is also in my notion, and they all talk to
// each other." Then, after the first version: "there are, like, a bunch of untitled pages, I
// don't know why. I only gave it access to my Instagram content calendar, my habit tracker,
// and my Stanford first year course planner." And: "I get the option to add to this page, but
// I don't know where it's adding. I wanna specifically be able to add in specific spots. Maybe
// the pop ups should just be, like, the notion page, basically, but editable."
//
// Both were the same mistake in different clothes — the first version treated Notion as a
// list to append to rather than as documents to edit:
//
//   - The untitled wall: those three things are DATABASES, and Notion's search returns every
//     ROW of a shared database as a page. Filtering to `object: page` dropped the three he
//     named and kept their contents. The top level is now what he connected; rows live inside
//     the database they belong to.
//   - "I don't know where it's adding": every line went to the end of the page. Now each block
//     is editable in place and carries its own insert point, so a line goes exactly where he
//     put it.
//
// Still no local copy: every read and write goes straight to Notion, which is what makes
// "they all talk to each other" true by construction rather than by a sync that drifts.

type PageRef = { id: string; title: string; type: "page" | "database"; url: string | null; editedAt: string | null };
type Block = { id: string; kind: "todo" | "text" | "heading" | "other"; text: string; checked?: boolean; editable: boolean };

const shortWhen = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export default function NotionTab() {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<PageRef[] | null>(null);
  /** Breadcrumb: [database] or [database, row] or [page]. Empty = the top list. */
  const [trail, setTrail] = useState<PageRef[]>([]);
  const [rows, setRows] = useState<PageRef[] | null>(null);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Block id being edited, and its working text. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** Where a new line goes: the block id to insert AFTER, or "end". */
  const [insertAt, setInsertAt] = useState<string | "end" | null>(null);
  const [draft, setDraft] = useState("");
  const [newPage, setNewPage] = useState("");
  const [creating, setCreating] = useState(false);

  const here = trail[trail.length - 1] ?? null;

  const loadPages = useCallback(async () => {
    setStatus(null);
    const r = await window.pos.notion.pages();
    if (!r.ok) {
      setStatus(
        /token/i.test(String(r.error ?? ""))
          ? "Connect Notion in Settings → Integrations to use this."
          : `Notion: ${r.error ?? "unavailable"}`
      );
      setPages([]);
      return;
    }
    setPages((r.data as PageRef[]) ?? []);
  }, []);

  const openItem = useCallback(async (item: PageRef, push = true) => {
    setStatus(null);
    setBlocks(null);
    setRows(null);
    setEditing(null);
    setInsertAt(null);
    if (push) setTrail((t) => [...t, item]);
    if (item.type === "database") {
      const r = await window.pos.notion.rows(item.id);
      setRows(r.ok ? ((r.data as PageRef[]) ?? []) : []);
      if (!r.ok) setStatus(`Couldn't open that database: ${r.error ?? "unknown error"}`);
      return;
    }
    const r = await window.pos.notion.page(item.id);
    setBlocks(r.ok ? ((r.data as Block[]) ?? []) : []);
    if (!r.ok) setStatus(`Couldn't open that page: ${r.error ?? "unknown error"}`);
  }, []);

  const reopen = useCallback(async () => {
    if (here) await openItem(here, false);
  }, [here, openItem]);

  const back = () => {
    const next = trail.slice(0, -1);
    setTrail(next);
    setBlocks(null);
    setRows(null);
    setEditing(null);
    setInsertAt(null);
    const parent = next[next.length - 1];
    if (parent) void openItem(parent, false);
  };

  useEffect(() => {
    if (open && pages === null) void loadPages();
  }, [open, pages, loadPages]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, whenFailed: string) => {
    setBusy(true);
    const r = await fn();
    if (!r.ok) setStatus(`${whenFailed}: ${r.error ?? "unknown error"}`);
    else await reopen();
    setBusy(false);
    return r.ok;
  };

  const addLine = async () => {
    const line = draft.trim();
    if (!line || !here || busy) return;
    const after = insertAt && insertAt !== "end" ? insertAt : undefined;
    setDraft("");
    setInsertAt(null);
    const ok = await run(() => window.pos.notion.append(here.id, line, "todo", after), "Couldn't add that");
    if (!ok) setDraft(line);
  };

  const saveEdit = async () => {
    if (!editing || busy) return;
    const b = blocks?.find((x) => x.id === editing.id);
    const line = editing.text.trim();
    setEditing(null);
    if (!b || !line || line === b.text) return;
    await run(
      () => window.pos.notion.updateBlock(b.id, b.kind === "todo" ? "todo" : "text", line),
      "Couldn't save that line"
    );
  };

  const toggle = async (b: Block) => {
    if (b.kind !== "todo" || busy) return;
    setBlocks((bs) => bs?.map((x) => (x.id === b.id ? { ...x, checked: !x.checked } : x)) ?? bs);
    setBusy(true);
    const r = await window.pos.notion.check(b.id, !b.checked);
    if (!r.ok) {
      setStatus(`Couldn't update that: ${r.error ?? "unknown error"}`);
      setBlocks((bs) => bs?.map((x) => (x.id === b.id ? { ...x, checked: b.checked } : x)) ?? bs);
    }
    setBusy(false);
  };

  const create = async () => {
    const title = newPage.trim();
    if (!title || busy) return;
    setBusy(true);
    const r = await window.pos.notion.createPage(title);
    if (!r.ok) setStatus(r.error ?? "Couldn't create that page");
    else {
      setNewPage("");
      setCreating(false);
      await loadPages();
      const made = r.data as PageRef;
      if (made?.id) await openItem(made);
    }
    setBusy(false);
  };

  /** The "insert here" affordance between two blocks. */
  const InsertHere = ({ afterId }: { afterId: string | "end" }) => (
    <button
      onClick={() => { setInsertAt(afterId); setEditing(null); }}
      className="w-full text-left text-[10px] leading-none py-[3px] opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity"
      style={{ color: "var(--accent)" }}
      title="Add a line here"
    >
      + add here
    </button>
  );

  const composer = (placeholder: string) => (
    <input
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void addLine();
        if (e.key === "Escape") { setDraft(""); setInsertAt(null); }
      }}
      placeholder={placeholder}
      disabled={busy}
      className="w-full text-xs rounded-lg px-2 py-1.5 border outline-none disabled:opacity-60"
      style={{ borderColor: "var(--accent)", background: "white" }}
    />
  );

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Your Notion pages"
        aria-expanded={open}
        className="fixed z-[55] rounded-l-2xl border shadow-sm px-2 py-3 transition-[background-color,transform] duration-[120ms] active:scale-95"
        style={{
          right: 0, top: 96,
          background: open ? "var(--accent)" : "color-mix(in srgb, var(--pink-1) 55%, white)",
          borderColor: "var(--line)",
          color: open ? "white" : "var(--ink)",
          writingMode: "vertical-rl",
          letterSpacing: "0.06em",
          fontSize: 11,
        }}
      >
        Notion
      </button>

      {open && (
        <div
          className="fixed z-[54] rounded-2xl border shadow-lg flex flex-col overflow-hidden"
          style={{
            right: 34, top: 96, width: 340, maxHeight: "min(72vh, 600px)",
            background: "var(--paper, white)", borderColor: "var(--line)",
          }}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "var(--line)" }}>
            {here ? (
              <button onClick={back} className="text-xs shrink-0" style={{ color: "var(--accent)" }}>←</button>
            ) : (
              <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Your Notion</span>
            )}
            <span className="text-xs truncate" style={{ color: "var(--ink)" }}>{here?.title ?? ""}</span>
            {here?.url && (
              <a href={here.url} target="_blank" rel="noreferrer" title="Open in Notion"
                className="ml-auto text-xs shrink-0" style={{ color: "var(--muted)" }}>↗</a>
            )}
          </div>

          <div className="overflow-y-auto flex-1 px-3 py-2">
            {status && <p className="text-[11px] mb-2" style={{ color: "var(--danger)" }}>{status}</p>}

            {/* top level: what he actually connected */}
            {!here && (
              <>
                {pages === null && <p className="text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}
                {pages?.length === 0 && !status && (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    Nothing shared with POS yet. In Notion: page → ••• → Connections → add POS.
                  </p>
                )}
                {pages?.map((p) => (
                  <button key={p.id} onClick={() => void openItem(p)}
                    className="w-full text-left rounded-lg px-2 py-1.5 mb-1 hover:bg-white transition-colors"
                    style={{ border: "1px solid var(--line)" }}>
                    <span className="text-xs block truncate" style={{ color: "var(--ink)" }}>{p.title}</span>
                    <span className="text-[10px]" style={{ color: "var(--muted)" }}>
                      {p.type === "database" ? "database · " : ""}{shortWhen(p.editedAt)}
                    </span>
                  </button>
                ))}
              </>
            )}

            {/* a database: its rows */}
            {here?.type === "database" && (
              <>
                {rows === null && <p className="text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}
                {rows?.length === 0 && <p className="text-xs" style={{ color: "var(--muted)" }}>No entries yet.</p>}
                {rows?.map((r) => (
                  <button key={r.id} onClick={() => void openItem(r)}
                    className="w-full text-left rounded-lg px-2 py-1.5 mb-1 hover:bg-white transition-colors"
                    style={{ border: "1px solid var(--line)" }}>
                    <span className="text-xs block truncate" style={{ color: "var(--ink)" }}>{r.title}</span>
                    <span className="text-[10px]" style={{ color: "var(--muted)" }}>{shortWhen(r.editedAt)}</span>
                  </button>
                ))}
              </>
            )}

            {/* a page: the document, editable in place */}
            {here?.type === "page" && (
              <>
                {blocks === null && <p className="text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}
                {blocks?.length === 0 && (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>Empty — add the first line below.</p>
                )}
                {blocks?.map((b) => (
                  <div key={b.id} className="group">
                    {editing?.id === b.id ? (
                      <input
                        value={editing.text}
                        autoFocus
                        onChange={(e) => setEditing({ id: b.id, text: e.target.value })}
                        onBlur={() => void saveEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="w-full text-xs rounded px-1 py-0.5 border outline-none my-0.5"
                        style={{ borderColor: "var(--accent)", background: "white" }}
                      />
                    ) : b.kind === "todo" ? (
                      <div className="flex items-start gap-2 py-1">
                        <input type="checkbox" checked={!!b.checked} onChange={() => void toggle(b)}
                          className="mt-0.5 shrink-0 cursor-pointer" />
                        <span
                          onClick={() => b.editable && setEditing({ id: b.id, text: b.text })}
                          className={b.editable ? "text-xs cursor-text flex-1" : "text-xs flex-1"}
                          style={{
                            color: b.checked ? "var(--muted)" : "var(--ink)",
                            textDecoration: b.checked ? "line-through" : "none",
                          }}
                        >{b.text}</span>
                      </div>
                    ) : (
                      <p
                        onClick={() => b.editable && setEditing({ id: b.id, text: b.text })}
                        className={`${b.kind === "heading" ? "text-xs font-medium mt-2" : "text-xs py-0.5"} ${b.editable ? "cursor-text" : ""}`}
                        style={{ color: b.kind === "heading" ? "var(--ink)" : "var(--muted)" }}
                      >{b.text}</p>
                    )}
                    {insertAt === b.id ? (
                      <div className="py-1">{composer("New line here…")}</div>
                    ) : (
                      <InsertHere afterId={b.id} />
                    )}
                  </div>
                ))}
              </>
            )}
          </div>

          {/* footer: append to the end, or create a page at the top level */}
          <div className="border-t px-3 py-2" style={{ borderColor: "var(--line)" }}>
            {here?.type === "page" ? (
              insertAt === "end" || insertAt === null ? (
                <input
                  value={insertAt === "end" ? draft : draft}
                  onFocus={() => setInsertAt("end")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addLine(); }}
                  placeholder="Add at the end…"
                  disabled={busy}
                  className="w-full text-xs rounded-lg px-2 py-1.5 border outline-none disabled:opacity-60"
                  style={{ borderColor: "var(--line)", background: "white" }}
                />
              ) : (
                <p className="text-[11px]" style={{ color: "var(--muted)" }}>Adding above — press Esc to cancel.</p>
              )
            ) : here?.type === "database" ? (
              <p className="text-[11px]" style={{ color: "var(--muted)" }}>Open an entry to edit it.</p>
            ) : creating ? (
              <div className="flex gap-1">
                <input
                  value={newPage}
                  autoFocus
                  onChange={(e) => setNewPage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void create(); if (e.key === "Escape") setCreating(false); }}
                  placeholder="New page title…"
                  disabled={busy}
                  className="flex-1 text-xs rounded-lg px-2 py-1.5 border outline-none disabled:opacity-60"
                  style={{ borderColor: "var(--line)", background: "white" }}
                />
                <button onClick={() => void create()} disabled={busy}
                  className="text-xs px-2 rounded-lg text-white disabled:opacity-60"
                  style={{ background: "var(--accent)" }}>Add</button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)}
                className="text-xs w-full text-left" style={{ color: "var(--accent)" }}>
                + New page
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
