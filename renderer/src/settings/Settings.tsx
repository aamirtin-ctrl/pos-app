import { useCallback, useEffect, useState } from "react";

// Settings: keys, spend meter, doctrine, Google, sync, adherence. Every mutation
// refetches its section; nothing here holds state the main process doesn't own.

type KeyRow = { name: string; present: boolean };
type Spend = { total: number; byFeature: Record<string, number>; ceiling: number };
type GcalState = { connected: boolean; hasCreds: boolean };
type AdherenceRow = { blockType: string; planned: number; completed: number; rate: number };

// workers.ts is still landing — normalize whatever row shape sync.status() returns.
type RawSyncRow = Record<string, unknown>;
type SyncRow = { source: string; lastRun: string | null; ingested: number | null; error: string | null };

const SYNC_SOURCES = ["gmail", "imessage"] as const;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function normalizeSyncRows(data: unknown): SyncRow[] {
  const rows: SyncRow[] = [];
  const push = (source: string, raw: RawSyncRow) => {
    // workers.ts syncStatus nests the latest sync_run under `last_run`; tolerate flat rows too.
    const run = (raw.last_run && typeof raw.last_run === "object" ? raw.last_run : raw) as RawSyncRow;
    rows.push({
      source,
      lastRun: str(run.finished_at) ?? str(run.started_at) ?? str(raw.last_sync_at),
      ingested: num(run.records_ingested) ?? num(run.ingested),
      error: str(run.error),
    });
  };
  if (Array.isArray(data)) {
    for (const r of data as RawSyncRow[]) {
      const source = str(r.source);
      if (source) push(source, r);
    }
  } else if (data && typeof data === "object") {
    for (const [source, r] of Object.entries(data as Record<string, RawSyncRow>)) {
      if (r && typeof r === "object") push(source, r);
    }
  }
  for (const s of SYNC_SOURCES) {
    if (!rows.some((r) => r.source === s)) rows.push({ source: s, lastRun: null, ingested: null, error: null });
  }
  return rows;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium border-b pb-2 mb-3" style={{ borderColor: "var(--line)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Settings() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="drag-region h-4" />
      <h1 className="font-display text-2xl font-semibold mb-5 no-drag">Settings</h1>
      <ApiKeys />
      <SpendMeter />
      <Doctrine />
      <Google />
      <Sync />
      <Adherence />
    </div>
  );
}

// ── a. API keys ──────────────────────────────────────────────────────────────

const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: "when set, planning uses Claude; otherwise Gemini",
};

function ApiKeys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const refetch = useCallback(async () => {
    const r = await window.pos.settings.keys();
    if (r.ok) {
      const all = r.data as KeyRow[];
      // GOOGLE_OAUTH_TOKENS is written by the connect flow, not typed by hand.
      const visible = all.filter((k) => k.name !== "GOOGLE_OAUTH_TOKENS");
      visible.sort((a, b) =>
        a.name === "ANTHROPIC_API_KEY" ? -1 : b.name === "ANTHROPIC_API_KEY" ? 1 : 0
      );
      setKeys(visible);
    }
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  return (
    <Section title="API keys">
      <div className="space-y-2">
        {keys.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No keys defined.</p>}
        {keys.map((k) => (
          <KeyRowView key={k.name} row={k} hint={KEY_HINTS[k.name]} onSaved={refetch} />
        ))}
      </div>
    </Section>
  );
}

function KeyRowView({ row, hint, onSaved }: { row: KeyRow; hint?: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!value || saving) return;
    setSaving(true);
    await window.pos.settings.setKey(row.name, value);
    setValue("");
    setSaving(false);
    onSaved();
  };
  return (
    <div className="rounded-lg border bg-white px-3 py-2" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium flex-1 truncate">{row.name}</span>
        <span
          className="text-[11px] px-1.5 py-0.5 rounded-full border shrink-0"
          style={{
            borderColor: "var(--line)",
            color: row.present ? "var(--accent)" : "var(--muted)",
            background: row.present ? "var(--accent-soft)" : "transparent",
          }}
        >
          {row.present ? "saved" : "set"}
        </span>
      </div>
      {hint && <div className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>{hint}</div>}
      <div className="flex gap-2 mt-1.5">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder={row.present ? "replace value…" : "paste value…"}
          className="flex-1 border rounded-md px-2 py-1 text-sm bg-white"
          style={{ borderColor: "var(--line)" }}
        />
        <button
          onClick={save}
          disabled={!value || saving}
          className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ── b. Spend ─────────────────────────────────────────────────────────────────

function SpendMeter() {
  const [spend, setSpend] = useState<Spend | null>(null);
  const [ceiling, setCeilingInput] = useState("");
  const [saving, setSaving] = useState(false);

  const refetch = useCallback(async () => {
    const r = await window.pos.settings.spend();
    if (r.ok) {
      const s = r.data as Spend;
      setSpend(s);
      setCeilingInput(String(s.ceiling));
    }
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const saveCeiling = async () => {
    const v = Number(ceiling);
    if (!Number.isFinite(v) || v < 0 || saving) return;
    setSaving(true);
    await window.pos.settings.setCeiling(v);
    setSaving(false);
    refetch();
  };

  const features = spend ? Object.entries(spend.byFeature).sort((a, b) => b[1] - a[1]) : [];
  const over = spend != null && spend.total >= spend.ceiling;

  return (
    <Section title="Spend">
      {spend == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : (
        <>
          {features.length === 0 ? (
            <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>No API calls this month.</p>
          ) : (
            <table className="w-full text-sm mb-2">
              <tbody>
                {features.map(([feature, cost]) => (
                  <tr key={feature} className="border-b" style={{ borderColor: "var(--line)" }}>
                    <td className="py-1">{feature}</td>
                    <td className="py-1 text-right tabular-nums" style={{ color: "var(--muted)" }}>{usd(cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium tabular-nums" style={{ color: over ? "var(--danger)" : "var(--ink)" }}>
              {usd(spend.total)}
            </span>
            <span style={{ color: "var(--muted)" }}>of</span>
            <input
              type="number"
              min={0}
              step={1}
              value={ceiling}
              onChange={(e) => setCeilingInput(e.target.value)}
              className="w-20 border rounded-md px-2 py-1 text-sm bg-white tabular-nums"
              style={{ borderColor: "var(--line)" }}
            />
            <button
              onClick={saveCeiling}
              disabled={saving || Number(ceiling) === spend.ceiling}
              className="px-2.5 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
              style={{ borderColor: "var(--line)" }}
            >
              Set ceiling
            </button>
          </div>
          <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
            over ceiling, planning degrades to deterministic — never fails
          </p>
        </>
      )}
    </Section>
  );
}

// ── c. Doctrine ──────────────────────────────────────────────────────────────

function Doctrine() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const r = await window.pos.settings.doctrineGet();
      if (r.ok) setText(r.data as string);
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    const r = await window.pos.settings.doctrineSet(text);
    if (!r.ok) setError(r.error ?? "invalid doctrine — file left untouched");
    else setSavedAt(Date.now());
    setSaving(false);
  };

  return (
    <Section title="Doctrine">
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSavedAt(null); }}
        spellCheck={false}
        disabled={!loaded}
        className="w-full min-h-[400px] border rounded-lg p-3 text-[12px] leading-relaxed bg-white font-mono resize-y"
        style={{ borderColor: "var(--line)" }}
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={save}
          disabled={saving || !loaded}
          className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {saving ? "Saving…" : "Save doctrine"}
        </button>
        {error && <span className="text-xs" style={{ color: "var(--danger)" }}>{error} (file unchanged)</span>}
        {savedAt && <span className="text-xs" style={{ color: "var(--muted)" }}>Saved.</span>}
      </div>
    </Section>
  );
}

// ── d. Google ────────────────────────────────────────────────────────────────

function Google() {
  const [state, setState] = useState<GcalState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const r = await window.pos.gcal.connected();
    if (r.ok) setState(r.data as GcalState);
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const connect = async () => {
    setBusy("connect");
    setMsg(null);
    const r = await window.pos.gcal.connect();
    if (!r.ok) setMsg(r.error ?? "connection failed");
    setBusy(null);
    refetch();
  };

  const reconcile = async () => {
    setBusy("reconcile");
    setMsg(null);
    const r = await window.pos.gcal.reconcile();
    if (r.ok) {
      const locked = (r.data as { locked?: number } | undefined)?.locked ?? 0;
      setMsg(locked === 0 ? "Nothing moved." : `${locked} moved event${locked === 1 ? "" : "s"} locked in.`);
    } else setMsg(r.error ?? "reconcile failed");
    setBusy(null);
  };

  return (
    <Section title="Google">
      {state == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : !state.hasCreds ? (
        <>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
            create an OAuth Desktop client in Google Cloud Console; Calendar + Tasks scopes
          </p>
          <div className="space-y-2">
            <KeyRowView row={{ name: "GOOGLE_OAUTH_CLIENT_ID", present: false }} onSaved={refetch} />
            <KeyRowView row={{ name: "GOOGLE_OAUTH_CLIENT_SECRET", present: false }} onSaved={refetch} />
          </div>
        </>
      ) : !state.connected ? (
        <button
          onClick={connect}
          disabled={busy === "connect"}
          className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {busy === "connect" ? "Waiting for browser…" : "Connect Google"}
        </button>
      ) : (
        <>
          <p className="text-sm mb-2">
            Connected — blocks push to &lsquo;POS — Planned&rsquo;, tasks to the &lsquo;POS&rsquo; list
          </p>
          <button
            onClick={reconcile}
            disabled={busy === "reconcile"}
            className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-50"
            style={{ borderColor: "var(--line)" }}
          >
            {busy === "reconcile" ? "Checking…" : "Re-check moved events"}
          </button>
        </>
      )}
      {msg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{msg}</p>}
    </Section>
  );
}

// ── e. Sync ──────────────────────────────────────────────────────────────────

function Sync() {
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [needsFda, setNeedsFda] = useState(false);

  const refetch = useCallback(async () => {
    const r = await window.pos.sync.status();
    const next = r.ok ? normalizeSyncRows(r.data) : normalizeSyncRows(null);
    setRows(next);
    if (next.some((row) => row.source === "imessage" && row.error?.includes("full_disk_access"))) {
      setNeedsFda(true);
    }
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const runSync = async (source: string) => {
    setBusy(source);
    setMsg(null);
    const r = await window.pos.sync.run(source);
    const dataError = str((r.data as RawSyncRow | undefined)?.error);
    const err = r.ok ? dataError : (r.error ?? "sync failed");
    if (err) {
      if (err.includes("full_disk_access")) setNeedsFda(true);
      setMsg(`${source}: ${err}`);
    }
    setBusy(null);
    refetch();
  };

  const embed = async () => {
    setBusy("embed");
    setMsg(null);
    const r = await window.pos.sync.embed();
    if (r.ok) {
      const n = (r.data as { embedded?: number } | undefined)?.embedded ?? 0;
      setMsg(n === 0 ? "All profiles already embedded." : `Embedded ${n} profile${n === 1 ? "" : "s"}.`);
    } else setMsg(r.error ?? "embedding failed");
    setBusy(null);
  };

  return (
    <Section title="Sync">
      <table className="w-full text-sm mb-3">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            <th className="py-1 font-medium">Source</th>
            <th className="py-1 font-medium">Last run</th>
            <th className="py-1 font-medium text-right">Ingested</th>
            <th className="py-1 font-medium">Error</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.source} className="border-t" style={{ borderColor: "var(--line)" }}>
              <td className="py-1.5">{row.source}</td>
              <td className="py-1.5 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                {row.lastRun ? row.lastRun.slice(0, 16).replace("T", " ") : "never"}
              </td>
              <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--muted)" }}>
                {row.ingested ?? "—"}
              </td>
              <td className="py-1.5 text-xs max-w-40 truncate" title={row.error ?? undefined} style={{ color: row.error ? "var(--danger)" : "var(--muted)" }}>
                {row.error ?? "—"}
              </td>
              <td className="py-1.5 text-right">
                {(SYNC_SOURCES as readonly string[]).includes(row.source) && (
                  <button
                    onClick={() => runSync(row.source)}
                    disabled={busy !== null}
                    className="px-2.5 py-1 rounded-md text-xs border bg-white disabled:opacity-40"
                    style={{ borderColor: "var(--line)" }}
                  >
                    {busy === row.source ? "Syncing…" : "Sync now"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={embed}
          disabled={busy !== null}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {busy === "embed" ? "Embedding…" : "Embed profiles"}
        </button>
        {(["linkedin", "mailfile"] as const).map((src) => (
          <button
            key={src}
            onClick={async () => {
              setBusy(src);
              setMsg(null);
              const r = await window.pos.sync.pickAndRun(src);
              const d = r.data as { canceled?: boolean; error?: string; ingested?: number } | undefined;
              if (!r.ok) setMsg(`${src}: ${r.error}`);
              else if (d?.canceled) { /* user closed the picker */ }
              else if (d?.error) setMsg(`${src}: ${d.error}`);
              else setMsg(`${src}: imported ${d?.ingested ?? 0} records.`);
              setBusy(null);
              refetch();
            }}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
            style={{ borderColor: "var(--line)" }}
          >
            {busy === src
              ? "Importing…"
              : src === "linkedin"
                ? "Import LinkedIn export…"
                : "Import mail export…"}
          </button>
        ))}
        {needsFda && (
          <button
            onClick={() => window.pos.app.openFullDiskAccess()}
            className="px-3 py-1.5 rounded-md text-sm text-white"
            style={{ background: "var(--danger)" }}
          >
            Grant Full Disk Access
          </button>
        )}
      </div>
      {msg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{msg}</p>}
    </Section>
  );
}

// ── f. Adherence ─────────────────────────────────────────────────────────────

function Adherence() {
  const [rows, setRows] = useState<AdherenceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await window.pos.outcomes.adherence();
      if (r.ok) setRows(r.data as AdherenceRow[]);
      setLoaded(true);
    })();
  }, []);

  const gym = rows.find((r) => r.blockType === "gym");

  return (
    <Section title="Adherence">
      {loaded && rows.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No outcome data yet — capture a day first.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              <th className="py-1 font-medium">Block</th>
              <th className="py-1 font-medium text-right">Planned</th>
              <th className="py-1 font-medium text-right">Completed</th>
              <th className="py-1 font-medium text-right">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.blockType} className="border-t" style={{ borderColor: "var(--line)" }}>
                <td className="py-1.5">{r.blockType.replace(/_/g, " ")}</td>
                <td className="py-1.5 text-right tabular-nums">{r.planned}</td>
                <td className="py-1.5 text-right tabular-nums">{r.completed}</td>
                <td className="py-1.5 text-right tabular-nums" style={{ color: r.rate < 0.5 ? "var(--danger)" : "var(--muted)" }}>
                  {Math.round(r.rate * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {gym && gym.rate < 0.5 && (
        <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>
          Gym adherence is low — the doctrine window may be wrong.
        </p>
      )}
    </Section>
  );
}
