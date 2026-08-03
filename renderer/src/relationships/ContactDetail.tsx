import { useCallback, useEffect, useState } from "react";

// Contact detail: identity header (tier is editable in place), profile text the
// user owns (bio / relationship summary), sidecars (tags, groups, aliases),
// interaction timeline, and this person's open commitments.

type PersonDetail = {
  id: number;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  bio: string | null;
  relationship_summary: string | null;
  last_contact_at: string | null;
  next_touch_due_at: string | null;
  freshness_days: number | null;
  tags: string[];
  groups: string[];
  aliases: { id: number; kind: string; value: string; is_primary: number }[];
  interactions: {
    id: number;
    channel: string;
    direction: string | null;
    occurred_at: string | null;
    subject: string | null;
    body_summary: string | null;
  }[];
  open_commitments: {
    id: number;
    direction: string;
    description: string;
    due_at: string | null;
    confidence: number;
    confirmed_by_user: number;
  }[];
};

const TIERS = [
  [0, "Inner"],
  [1, "Active"],
  [2, "Network"],
  [3, "Archive"],
] as const;

const truncate = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");

export default function ContactDetail({ id }: { id: number }) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [bio, setBio] = useState("");
  const [summary, setSummary] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const r = await window.pos.people.get(id);
    const p = r.ok ? ((r.data as PersonDetail | null) ?? null) : null;
    setPerson(p);
    if (p) {
      setBio(p.bio ?? "");
      setSummary(p.relationship_summary ?? "");
      setDirty(false);
    }
    setLoaded(true);
  }, [id]);
  useEffect(() => { refetch(); }, [refetch]);

  const patch = async (fields: Record<string, unknown>) => {
    setError(null);
    const r = await window.pos.people.patch(id, fields);
    if (!r.ok) setError(r.error ?? "save failed");
    await refetch();
  };

  const saveText = async () => {
    setSaving(true);
    await patch({ bio: bio || null, relationship_summary: summary || null });
    setSaving(false);
  };

  const addGroup = async () => {
    const name = newGroup.trim();
    if (!name) return;
    await window.pos.groups.assign(id, name);
    setNewGroup("");
    await refetch();
  };

  if (!loaded) return <div className="p-6" />;
  if (!person) {
    return (
      <div className="p-6">
        <div className="drag-region h-4" />
        <a href="#/relationships/contacts" className="text-sm no-drag" style={{ color: "var(--muted)" }}>&larr; Contacts</a>
        <p className="mt-6 text-sm" style={{ color: "var(--muted)" }}>Contact not found — it may have been merged away.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="drag-region h-4" />
      <a href="#/relationships/contacts" className="text-sm no-drag" style={{ color: "var(--muted)" }}>&larr; Contacts</a>

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 mt-3 mb-1">
        <div>
          <h1 className="font-display text-2xl font-semibold">{person.display_name}</h1>
          {(person.role || person.org || person.location) && (
            <div className="text-sm mt-0.5" style={{ color: "var(--muted)" }}>
              {[person.role, person.org, person.location].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs shrink-0" style={{ color: "var(--muted)" }}>
          Tier
          <select
            value={person.tier}
            onChange={(e) => patch({ tier: Number(e.target.value) })}
            className="border rounded-md px-2 py-1 text-sm bg-white"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            {TIERS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="text-xs mb-4" style={{ color: "var(--muted)" }}>
        {person.freshness_days == null
          ? "Never contacted"
          : `Last contact ${person.freshness_days === 0 ? "today" : `${person.freshness_days}d ago`}`}
      </div>
      {error && <p className="text-xs mb-3" style={{ color: "var(--danger)" }}>{error}</p>}

      {/* ── Tags + groups ── */}
      {person.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {person.tags.map((t) => (
            <span key={t} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "var(--panel)", color: "var(--muted)" }}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 mb-5">
        {person.groups.map((g) => (
          <span
            key={g}
            className="text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1"
            style={{ borderColor: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {g}
            <button
              title={`Remove from ${g}`}
              onClick={async () => { await window.pos.groups.remove(id, g); await refetch(); }}
              className="leading-none hover:opacity-70"
              style={{ color: "var(--muted)" }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }}
          placeholder="add to group…"
          className="text-[11px] px-2 py-0.5 rounded-full border bg-white w-28"
          style={{ borderColor: "var(--line)" }}
        />
      </div>

      {/* ── Aliases ── */}
      {person.aliases.length > 0 && (
        <div className="mb-5 text-xs space-y-0.5" style={{ color: "var(--muted)" }}>
          {person.aliases.map((a) => (
            <div key={a.id}>
              <span className="uppercase tracking-wide text-[10px] mr-1.5">{a.kind}:</span>
              {a.value}
              {a.is_primary === 1 && <span className="ml-1 text-[10px]">(primary)</span>}
            </div>
          ))}
        </div>
      )}

      {/* ── Bio / relationship summary ── */}
      <div className="grid grid-cols-2 gap-4 mb-2">
        <label className="block">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Bio</span>
          <textarea
            value={bio}
            onChange={(e) => { setBio(e.target.value); setDirty(true); }}
            rows={4}
            className="mt-1 w-full border rounded-lg p-2.5 text-sm bg-white resize-none"
            style={{ borderColor: "var(--line)" }}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Relationship</span>
          <textarea
            value={summary}
            onChange={(e) => { setSummary(e.target.value); setDirty(true); }}
            rows={4}
            className="mt-1 w-full border rounded-lg p-2.5 text-sm bg-white resize-none"
            style={{ borderColor: "var(--line)" }}
          />
        </label>
      </div>
      {dirty && (
        <button
          onClick={saveText}
          disabled={saving}
          className="mb-5 px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}

      {/* ── Open commitments ── */}
      {person.open_commitments.length > 0 && (
        <section className="mb-6">
          <h2 className="font-display text-lg font-medium border-b pb-2 mb-2" style={{ borderColor: "var(--line)" }}>
            Open commitments
          </h2>
          <div className="space-y-1.5">
            {person.open_commitments.map((c) => (
              <div key={c.id} className="rounded-md border bg-white px-2.5 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                {c.description}
                <div className="text-[11px] mt-0.5 flex gap-2" style={{ color: "var(--muted)" }}>
                  <span>{c.direction === "they_owe_me" ? "they owe me" : "I owe them"}</span>
                  {c.due_at && <span>due {c.due_at.slice(0, 10)}</span>}
                  <span className="tabular-nums">conf {Math.round(c.confidence * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Timeline ── */}
      <section>
        <h2 className="font-display text-lg font-medium border-b pb-2 mb-2" style={{ borderColor: "var(--line)" }}>
          Timeline
        </h2>
        {person.interactions.length === 0 ? (
          <p className="text-sm py-2" style={{ color: "var(--muted)" }}>No interactions yet.</p>
        ) : (
          <div className="space-y-1">
            {person.interactions.map((it) => (
              <div key={it.id} className="flex items-baseline gap-3 py-1.5 text-sm border-b" style={{ borderColor: "var(--line)" }}>
                <span className="text-xs tabular-nums shrink-0 w-20" style={{ color: "var(--muted)" }}>
                  {it.occurred_at ? it.occurred_at.slice(0, 10) : "—"}
                </span>
                <span
                  className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: "var(--panel)", color: "var(--muted)" }}
                >
                  {it.channel}
                </span>
                <span className="min-w-0 truncate">
                  {it.subject && <span className="font-medium">{truncate(it.subject, 70)}</span>}
                  {it.subject && it.body_summary && <span style={{ color: "var(--muted)" }}> — </span>}
                  {it.body_summary && <span style={{ color: "var(--muted)" }}>{truncate(it.body_summary, 110)}</span>}
                  {!it.subject && !it.body_summary && <span style={{ color: "var(--muted)" }}>({it.direction ?? "interaction"})</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
