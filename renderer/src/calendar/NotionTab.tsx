import React, { useCallback, useEffect, useState } from "react";

// The long-term tab — his Notion, borrowed.
//
// Owner ask 2026-08-06: "add in, like, a long term to-do list… a little side tab below the
// sparkle button, only viewed on the calendar page. Make this actually a tab that connects to
// my notion — so whatever is in there, this tab is also in my notion, and they all talk to
// each other. Currently in my notion I have my social media scheduling and another page. So I
// should be able to view both of these from that tab and then also create pages and add info."
//
// There is NO local copy. Every read and write goes straight to Notion, so "they all talk to
// each other" is true by construction rather than by a sync that drifts — a long-term list is
// exactly the thing that gets edited on a phone at midnight and here the next morning. The
// cost is that the tab needs the network and shows nothing without a token, which is what the
// empty state says rather than looking broken.
//
// Deliberately NOT the day planner's concern: this is the slow list (learning agentic
// engineering, learning the basics of coding), parked beside the calendar rather than
// scheduled into it. Nothing here becomes a block unless he asks for it.

type PageRef = { id: string; title: string; url: string | null; editedAt: string | null };
type Block = { id: string; kind: "todo" | "text" | "heading" | "other"; text: string; checked?: boolean };

/** Notion's own page ids are dashed uuids; the tab never shows one to the owner. */
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
  const [pageId, setPageId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [newPage, setNewPage] = useState("");
  const [creating, setCreating] = useState(false);

  const loadPages = useCallback(async () => {
    setStatus(null);
    const r = await window.pos.notion.pages();
    if (!r.ok) {
      // The two cases worth distinguishing: never connected vs connected and failing.
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

  const loadPage = useCallback(async (id: string) => {
    setPageId(id);
    setBlocks(null);
    const r = await window.pos.notion.page(id);
    setBlocks(r.ok ? ((r.data as Block[]) ?? []) : []);
    if (!r.ok) setStatus(`Couldn't open that page: ${r.error ?? "unknown error"}`);
  }, []);

  useEffect(() => {
    if (open && pages === null) void loadPages();
  }, [open, pages, loadPages]);

  const addLine = async () => {
    const line = draft.trim();
    if (!line || !pageId || busy) return;
    setBusy(true);
    setDraft("");
    const r = await window.pos.notion.append(pageId, line);
    if (!r.ok) { setStatus(`Couldn't add that: ${r.error ?? "unknown error"}`); setDraft(line); }
    else await loadPage(pageId);
    setBusy(false);
  };

  const toggle = async (b: Block) => {
    if (b.kind !== "todo" || busy) return;
    setBusy(true);
    // Optimistic: the checkbox answers immediately, then Notion confirms.
    setBlocks((bs) => bs?.map((x) => (x.id === b.id ? { ...x, checked: !x.checked } : x)) ?? bs);
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
      if (made?.id) await loadPage(made.id);
    }
    setBusy(false);
  };

  const current = pages?.find((p) => p.id === pageId) ?? null;

  return (
    <>
      {/* the tab itself — sits under the sparkle, calendar page only */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Long-term list — your Notion pages"
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
        Long-term
      </button>

      {open && (
        <div
          className="fixed z-[54] rounded-2xl border shadow-lg flex flex-col overflow-hidden"
          style={{
            right: 34, top: 96, width: 320, maxHeight: "min(70vh, 560px)",
            background: "var(--paper, white)", borderColor: "var(--line)",
          }}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "var(--line)" }}>
            {current ? (
              <button onClick={() => { setPageId(null); setBlocks(null); }}
                className="text-xs" style={{ color: "var(--accent)" }}>← pages</button>
            ) : (
              <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Your Notion</span>
            )}
            <span className="ml-auto text-xs truncate" style={{ color: "var(--ink)", maxWidth: 190 }}>
              {current?.title ?? ""}
            </span>
            {current?.url && (
              <a href={current.url} target="_blank" rel="noreferrer" title="Open in Notion"
                className="text-xs shrink-0" style={{ color: "var(--muted)" }}>↗</a>
            )}
          </div>

          <div className="overflow-y-auto flex-1 px-3 py-2">
            {status && (
              <p className="text-[11px] mb-2" style={{ color: "var(--danger)" }}>{status}</p>
            )}

            {/* page list */}
            {!current && (
              <>
                {pages === null && <p className="text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}
                {pages?.length === 0 && !status && (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    No pages shared with POS yet. In Notion, open a page → ••• → Connections → add POS.
                  </p>
                )}
                {pages?.map((p) => (
                  <button key={p.id} onClick={() => void loadPage(p.id)}
                    className="w-full text-left rounded-lg px-2 py-1.5 mb-1 hover:bg-white transition-colors"
                    style={{ border: "1px solid var(--line)" }}>
                    <span className="text-xs block truncate" style={{ color: "var(--ink)" }}>{p.title}</span>
                    <span className="text-[10px]" style={{ color: "var(--muted)" }}>{shortWhen(p.editedAt)}</span>
                  </button>
                ))}
              </>
            )}

            {/* one page's contents */}
            {current && (
              <>
                {blocks === null && <p className="text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}
                {blocks?.length === 0 && (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>Empty — add the first line below.</p>
                )}
                {blocks?.map((b) =>
                  b.kind === "todo" ? (
                    <label key={b.id} className="flex items-start gap-2 py-1 cursor-pointer">
                      <input type="checkbox" checked={!!b.checked} onChange={() => void toggle(b)}
                        className="mt-0.5 shrink-0" />
                      <span className="text-xs" style={{
                        color: b.checked ? "var(--muted)" : "var(--ink)",
                        textDecoration: b.checked ? "line-through" : "none",
                      }}>{b.text}</span>
                    </label>
                  ) : (
                    <p key={b.id} className={b.kind === "heading" ? "text-xs font-medium mt-2" : "text-xs py-0.5"}
                      style={{ color: b.kind === "heading" ? "var(--ink)" : "var(--muted)" }}>{b.text}</p>
                  )
                )}
              </>
            )}
          </div>

          {/* composer */}
          <div className="border-t px-3 py-2" style={{ borderColor: "var(--line)" }}>
            {current ? (
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void addLine(); }}
                placeholder="Add to this page…"
                disabled={busy}
                className="w-full text-xs rounded-lg px-2 py-1.5 border outline-none disabled:opacity-60"
                style={{ borderColor: "var(--line)", background: "white" }}
              />
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
