import { useCallback, useEffect, useRef, useState } from "react";

// Contacts list: debounced search over name/org/role, group chips (migrated CRM
// groups; click to filter, "All" resets — plus an "Unverified" chip filtering by
// the 'unverified' tag connectors put on auto-created unknown senders), freshness
// dot (opacity decays with days since last contact), multi-select → merge
// duplicates or bulk-assign to a group. Unverified rows get a hover ✕ quick-delete
// (person + history). Header has a CSV export of the whole address book.
//
// The chip row is local (not Home.tsx's read-only GroupChips) because it also owns
// group management: "+ New group" and a per-chip caret menu with hide / hide+contacts /
// unhide / rename / delete. Hidden groups live behind a "Hidden" disclosure so they can
// always be brought back. Members of a hide-with-contacts group never reach this list —
// main/ipc.ts people.list filters them via crm/groups.ts hiddenPersonIds.

type PersonListItem = {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
  next_touch_due_at: string | null;
  tags: string[];
  groups: string[];
  freshness_days: number | null;
};

// <30d full opacity, linear fade to 0.15 at >=180d; never-contacted sits at the floor.
function freshnessOpacity(days: number | null): number {
  if (days == null) return 0.15;
  if (days < 30) return 1;
  if (days >= 180) return 0.15;
  return 1 - ((days - 30) / 150) * 0.85;
}

type GroupRow = {
  id: number;
  name: string;
  hidden: number;
  hide_contacts: number;
  suppress_follow_ups: number;
  members: number;
};

// Pseudo-group chip backed by the 'unverified' person_tag (client-side filter).
const UNVERIFIED_CHIP = "Unverified";
const isUnverified = (p: PersonListItem) => (p.tags ?? []).includes("unverified");

const CHIP_BASE =
  "flex items-center rounded-full border text-[11px] whitespace-nowrap shrink-0 overflow-hidden";

export default function Contacts() {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  // group management
  const [creating, setCreating] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmGroupDelete, setConfirmGroupDelete] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // bulk assign + export
  const [assigning, setAssigning] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async (query: string) => {
    const r = await window.pos.people.list(query.trim() || undefined);
    setPeople(r.ok ? (r.data as PersonListItem[]) : []);
    setLoaded(true);
  }, []);

  const loadGroups = useCallback(async () => {
    const r = await window.pos.groups.list();
    if (r.ok) setGroups(r.data as GroupRow[]);
  }, []);

  useEffect(() => { refetch(""); }, [refetch]);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  // people.list already returns each person's groups + tags — filter client-side
  const shown =
    groupFilter === UNVERIFIED_CHIP
      ? people.filter(isUnverified)
      : groupFilter
      ? people.filter((p) => (p.groups ?? []).includes(groupFilter))
      : people;
  const hasUnverified = people.some(isUnverified);
  const visibleGroups = groups.filter((g) => !g.hidden);
  const hiddenGroups = groups.filter((g) => g.hidden);

  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => refetch(value), 200);
  };

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const merge = async () => {
    if (selected.size < 2 || merging) return;
    setMerging(true);
    setError(null);
    const r = await window.pos.people.merge([...selected]);
    if (!r.ok) setError(r.error ?? "merge failed");
    else setSelected(new Set());
    await refetch(q);
    setMerging(false);
  };

  // Quick-delete for unverified rows: person + interactions/aliases cascade away;
  // commitments survive with person_id nulled (see main/crm/people.ts deletePerson).
  const quickDelete = async (id: number) => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    const r = await window.pos.people.delete(id);
    if (!r.ok) setError(r.error ?? "delete failed");
    setConfirmDelete(null);
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    await refetch(q);
    setDeleting(false);
  };

  // Any group mutation can change which people are visible (hide-with-contacts), so
  // both lists are reloaded.
  const afterGroupChange = useCallback(
    async (r: { ok: boolean; error?: string }, clearedFilter?: string) => {
      if (!r.ok) {
        setError(r.error ?? "group update failed");
        return;
      }
      setError(null);
      if (clearedFilter && groupFilter === clearedFilter) setGroupFilter(null);
      await Promise.all([loadGroups(), refetch(q)]);
    },
    [groupFilter, loadGroups, refetch, q]
  );

  const createGroup = async () => {
    const name = newGroup.trim();
    setNewGroup("");
    setCreating(false);
    if (!name) return;
    await afterGroupChange(await window.pos.groups.create(name));
  };

  const commitRename = async () => {
    const from = renaming;
    const to = renameTo.trim();
    setRenaming(null);
    setRenameTo("");
    if (!from || !to || to === from) return;
    await afterGroupChange(await window.pos.groups.rename(from, to), from);
  };

  const bulkAssign = async () => {
    const name = assignTo.trim();
    if (!name || selected.size === 0) return;
    setAssignTo("");
    setAssigning(false);
    const r = await window.pos.groups.assignMany([...selected], name);
    if (!r.ok) setError(r.error ?? "add to group failed");
    else setSelected(new Set());
    await Promise.all([loadGroups(), refetch(q)]);
  };

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    const r = await window.pos.people.exportCsv();
    if (!r.ok) setError(r.error ?? "export failed");
    else {
      const d = r.data as { saved?: boolean; path?: string; canceled?: boolean };
      if (d?.saved) setNotice(`Exported to ${d.path}`);
    }
    setExporting(false);
  };

  const menuItem = (label: string, onClick: () => void, danger?: boolean) => (
    <button
      key={label}
      onClick={onClick}
      className="block w-full text-left text-[11.5px] px-2.5 py-1.5 hover:bg-black/[0.04]"
      style={{ color: danger ? "var(--danger)" : "var(--ink)" }}
    >
      {label}
    </button>
  );

  const groupChip = (g: GroupRow) => {
    const selectedChip = groupFilter === g.name;
    const open = menuFor === g.name;
    if (renaming === g.name) {
      return (
        <input
          key={g.id}
          autoFocus
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setRenaming(null); setRenameTo(""); }
          }}
          onBlur={commitRename}
          className="rounded-full border px-2.5 py-0.5 text-[11px] shrink-0 w-32 outline-none"
          style={{ borderColor: "var(--accent)", color: "var(--ink)" }}
        />
      );
    }
    return (
      <span key={g.id} className="relative shrink-0">
        <span
          className={CHIP_BASE}
          style={
            selectedChip
              ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
              : {
                  background: "white",
                  borderColor: "var(--line)",
                  color: "var(--muted)",
                  ...(g.hidden ? { opacity: 0.6, fontStyle: "italic" } : {}),
                }
          }
        >
          <button
            onClick={() => setGroupFilter(selectedChip ? null : g.name)}
            onContextMenu={(e) => { e.preventDefault(); setMenuFor(open ? null : g.name); }}
            title="Click to filter · right-click for options"
            className="pl-2.5 pr-1 py-0.5 transition-transform duration-[120ms] active:scale-95"
          >
            {g.name}
            <span className="ml-1 tabular-nums opacity-70">{g.members}</span>
            {g.hide_contacts ? <span className="ml-1 opacity-70">· contacts hidden</span> : null}
          </button>
          <button
            onClick={() => { setMenuFor(open ? null : g.name); setConfirmGroupDelete(null); }}
            title="Group options"
            aria-label={`Options for ${g.name}`}
            className="pr-2 pl-0.5 py-0.5 leading-none hover:bg-black/[0.06]"
          >
            ⌄
          </button>
        </span>
        {open && (
          <span
            className="absolute left-0 top-full mt-1 z-20 min-w-[9.5rem] rounded-lg border bg-white shadow-lg overflow-hidden flex flex-col"
            style={{ borderColor: "var(--line)" }}
          >
            {g.hidden
              ? menuItem("Unhide", async () => {
                  setMenuFor(null);
                  await afterGroupChange(await window.pos.groups.hide(g.name, false));
                })
              : [
                  menuItem("Hide group", async () => {
                    setMenuFor(null);
                    await afterGroupChange(await window.pos.groups.hide(g.name, true), g.name);
                  }),
                  menuItem("Hide group + contacts", async () => {
                    setMenuFor(null);
                    await afterGroupChange(await window.pos.groups.hideContacts(g.name, true), g.name);
                  }),
                ]}
            {menuItem("Rename", () => {
              setMenuFor(null);
              setRenameTo(g.name);
              setRenaming(g.name);
            })}
            {confirmGroupDelete === g.name
              ? menuItem(
                  "Really delete?",
                  async () => {
                    setMenuFor(null);
                    setConfirmGroupDelete(null);
                    await afterGroupChange(await window.pos.groups.delete(g.name), g.name);
                  },
                  true
                )
              : menuItem("Delete", () => setConfirmGroupDelete(g.name), true)}
          </span>
        )}
      </span>
    );
  };

  const plainChip = (label: string, value: string | null) => {
    const selectedChip = groupFilter === value;
    return (
      <button
        key={value ?? "__all"}
        onClick={() => setGroupFilter(value)}
        className="px-2.5 py-0.5 rounded-full border text-[11px] whitespace-nowrap shrink-0 transition-[background-color,color,transform] duration-[120ms] hover:scale-105 active:scale-95"
        style={
          selectedChip
            ? { background: "var(--accent)", borderColor: "var(--accent)", color: "white" }
            : { background: "white", borderColor: "var(--line)", color: "var(--muted)" }
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div className="p-6 max-w-3xl mx-auto relative min-h-full">
      <div className="drag-region h-4" />
      <div className="flex items-baseline justify-between mb-4 no-drag">
        <h1 className="font-display text-2xl font-semibold">Contacts</h1>
        <span className="flex items-center gap-3">
          <button
            onClick={exportCsv}
            disabled={exporting}
            className="text-[11px] px-2 py-0.5 rounded-full border disabled:opacity-50 transition-transform duration-[120ms] hover:scale-105 active:scale-95"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>{shown.length}</span>
        </span>
      </div>

      <input
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search name, org, role…"
        className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-3"
        style={{ borderColor: "var(--line)" }}
      />

      <div className="flex gap-1.5 items-center overflow-x-auto pb-1.5 mb-1.5 no-drag" style={{ scrollbarWidth: "none" }}>
        {plainChip("All", null)}
        {visibleGroups.map(groupChip)}
        {hasUnverified && plainChip(UNVERIFIED_CHIP, UNVERIFIED_CHIP)}
        {creating ? (
          <input
            autoFocus
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createGroup();
              if (e.key === "Escape") { setCreating(false); setNewGroup(""); }
            }}
            onBlur={createGroup}
            placeholder="group name"
            className="rounded-full border px-2.5 py-0.5 text-[11px] shrink-0 w-32 outline-none"
            style={{ borderColor: "var(--accent)", color: "var(--ink)" }}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            title="New group"
            className="px-2.5 py-0.5 rounded-full border border-dashed text-[11px] whitespace-nowrap shrink-0 transition-transform duration-[120ms] hover:scale-105 active:scale-95"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            + New group
          </button>
        )}
        {hiddenGroups.length > 0 && (
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="px-2 py-0.5 text-[11px] shrink-0"
            style={{ color: "var(--muted)" }}
          >
            {showHidden ? "Hide hidden" : `Hidden ${hiddenGroups.length}`}
          </button>
        )}
      </div>

      {showHidden && hiddenGroups.length > 0 && (
        <div className="flex gap-1.5 items-center overflow-x-auto pb-1.5 mb-1.5 no-drag" style={{ scrollbarWidth: "none" }}>
          {hiddenGroups.map(groupChip)}
        </div>
      )}

      {loaded && shown.length === 0 ? (
        <p className="text-sm py-6 text-center" style={{ color: "var(--muted)" }}>
          {groupFilter
            ? `Nobody in "${groupFilter}"${q.trim() ? " matches this search" : ""}.`
            : q.trim() ? "No matches." : "No contacts yet — run a sync in Settings to pull them in."}
        </p>
      ) : (
        <div className="rounded-xl border bg-white divide-y" style={{ borderColor: "var(--line)" }}>
          {shown.map((p) => (
            <div
              key={p.id}
              className="group flex items-center gap-3 px-3 py-2 hover:bg-black/[0.02] transition-colors duration-[120ms]"
              style={{ borderColor: "var(--line)" }}
            >
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                onClick={(e) => e.stopPropagation()}
              />
              <span
                title={p.freshness_days == null ? "never contacted" : `${p.freshness_days}d since last contact`}
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: "var(--accent)", opacity: freshnessOpacity(p.freshness_days) }}
              />
              <a href={`#/contact/${p.id}`} className="flex-1 min-w-0 flex items-center gap-3" style={{ color: "var(--ink)" }}>
                <span className="text-sm font-medium truncate">{p.display_name}</span>
                {(p.org || p.role) && (
                  <span className="text-xs truncate" style={{ color: "var(--muted)" }}>
                    {[p.org, p.role].filter(Boolean).join(" · ")}
                  </span>
                )}
                <span className="ml-auto flex gap-1 shrink-0">
                  {p.tags.slice(0, 4).map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{ background: "var(--panel)", color: "var(--muted)" }}
                    >
                      {t}
                    </span>
                  ))}
                </span>
              </a>
              {isUnverified(p) &&
                (confirmDelete === p.id ? (
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[11px]" style={{ color: "var(--danger)" }}>
                      Remove contact and history?
                    </span>
                    <button
                      onClick={() => quickDelete(p.id)}
                      disabled={deleting}
                      className="text-[11px] px-1.5 py-0.5 rounded border disabled:opacity-50"
                      style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                    >
                      {deleting ? "Removing…" : "Remove"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="text-[11px] px-1.5 py-0.5 rounded border"
                      style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(p.id)}
                    title="Remove contact"
                    aria-label="Remove contact"
                    className="opacity-0 group-hover:opacity-100 transition-opacity duration-[120ms] text-xs leading-none px-1 py-0.5 rounded hover:bg-black/[0.06] shrink-0"
                    style={{ color: "var(--muted)" }}
                  >
                    ✕
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>{error}</p>}
      {notice && <p className="text-xs mt-2 truncate" style={{ color: "var(--muted)" }}>{notice}</p>}

      {selected.size >= 1 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full shadow-lg border bg-white px-4 py-2 flex items-center gap-3"
          style={{ borderColor: "var(--line)" }}
        >
          <span className="text-sm" style={{ color: "var(--muted)" }}>{selected.size} selected</span>
          {selected.size >= 2 && (
            <button
              onClick={merge}
              disabled={merging}
              className="px-3 py-1 rounded-full text-sm text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {merging ? "Merging…" : `Merge ${selected.size}`}
            </button>
          )}
          {assigning ? (
            <input
              autoFocus
              list="pos-group-names"
              value={assignTo}
              onChange={(e) => setAssignTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") bulkAssign();
                if (e.key === "Escape") { setAssigning(false); setAssignTo(""); }
              }}
              placeholder="group name"
              className="rounded-full border px-3 py-1 text-sm w-40 outline-none"
              style={{ borderColor: "var(--accent)" }}
            />
          ) : (
            <button
              onClick={() => setAssigning(true)}
              className="px-3 py-1 rounded-full text-sm border"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}
            >
              Add to group…
            </button>
          )}
          <datalist id="pos-group-names">
            {groups.map((g) => (
              <option key={g.id} value={g.name} />
            ))}
          </datalist>
          <button
            onClick={() => { setSelected(new Set()); setAssigning(false); setAssignTo(""); }}
            className="text-sm"
            style={{ color: "var(--muted)" }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
