import { useCallback, useEffect, useState } from "react";

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
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {rows.map((c) => {
        const person = c.person_id != null ? peopleById.get(c.person_id) : undefined;
        return (
          <div key={c.id} className="rounded-md border bg-white px-2.5 py-2" style={{ borderColor: "var(--line)" }}>
            <div className="text-sm leading-snug">{c.description}</div>
            <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
              {person && (
                <a href={`#/contact/${person.id}`} className="underline decoration-dotted" style={{ color: "var(--muted)" }}>
                  {person.display_name}
                </a>
              )}
              <span>{c.direction === "they_owe_me" ? "they owe me" : "I owe them"}</span>
              {c.due_at && <span>due {c.due_at.slice(0, 10)}</span>}
              <span className="tabular-nums">conf {Math.round(c.confidence * 100)}%</span>
              {c.confirmed_by_user === 0 && (
                <span className="ml-auto flex gap-1">
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
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
