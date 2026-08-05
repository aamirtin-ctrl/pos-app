import { useCallback, useEffect, useRef, useState } from "react";
import { GroupChips } from "./Home.tsx";

// Contacts list: debounced search over name/org/role, group chips (migrated CRM
// groups; click to filter, "All" resets — plus an "Unverified" chip filtering by
// the 'unverified' tag connectors put on auto-created unknown senders), freshness
// dot (opacity decays with days since last contact), multi-select → merge
// duplicates. Unverified rows get a hover ✕ quick-delete (person + history).

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

type GroupRow = { id: number; name: string; hidden: number; members: number };

// Pseudo-group chip backed by the 'unverified' person_tag (client-side filter).
const UNVERIFIED_CHIP = "Unverified";
const isUnverified = (p: PersonListItem) => (p.tags ?? []).includes("unverified");

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
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async (query: string) => {
    const r = await window.pos.people.list(query.trim() || undefined);
    setPeople(r.ok ? (r.data as PersonListItem[]) : []);
    setLoaded(true);
  }, []);

  useEffect(() => { refetch(""); }, [refetch]);
  useEffect(() => {
    window.pos.groups.list().then((r) => {
      if (r.ok) setGroups((r.data as GroupRow[]).filter((g) => !g.hidden));
    });
  }, []);

  // people.list already returns each person's groups + tags — filter client-side
  const shown =
    groupFilter === UNVERIFIED_CHIP
      ? people.filter(isUnverified)
      : groupFilter
      ? people.filter((p) => (p.groups ?? []).includes(groupFilter))
      : people;
  const hasUnverified = people.some(isUnverified);
  const chipNames = [...groups.map((g) => g.name), ...(hasUnverified ? [UNVERIFIED_CHIP] : [])];

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

  return (
    <div className="p-6 max-w-3xl mx-auto relative min-h-full">
      <div className="drag-region h-4" />
      <div className="flex items-baseline justify-between mb-4 no-drag">
        <h1 className="font-display text-2xl font-semibold">Contacts</h1>
        <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>{shown.length}</span>
      </div>

      <input
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search name, org, role…"
        className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-3"
        style={{ borderColor: "var(--line)" }}
      />

      <GroupChips groups={chipNames} active={groupFilter} onPick={setGroupFilter} />

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

      {selected.size >= 2 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full shadow-lg border bg-white px-4 py-2 flex items-center gap-3"
          style={{ borderColor: "var(--line)" }}
        >
          <span className="text-sm" style={{ color: "var(--muted)" }}>{selected.size} selected</span>
          <button
            onClick={merge}
            disabled={merging}
            className="px-3 py-1 rounded-full text-sm text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {merging ? "Merging…" : `Merge ${selected.size}`}
          </button>
          <button
            onClick={() => setSelected(new Set())}
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
