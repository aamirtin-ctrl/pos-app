import { useCallback, useEffect, useState } from "react";

// Settings: integrations (keys + Google + sync connectors), spend meter,
// doctrine, adherence. Every mutation refetches its section; nothing here
// holds state the main process doesn't own.

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
      <Integrations />
      <SpendMeter />
      <Doctrine />
      <Adherence />
    </div>
  );
}

// ── a. Integrations ──────────────────────────────────────────────────────────

type IntegrationStatus = "connected" | "ready" | "needs-setup";

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: "Connected",
  ready: "Ready",
  "needs-setup": "Needs setup",
};

function StatusChip({ status }: { status: IntegrationStatus }) {
  const style: React.CSSProperties =
    status === "connected"
      ? { background: "var(--accent-soft)", color: "var(--ink)", borderColor: "transparent" }
      : status === "ready"
        ? { background: "transparent", color: "var(--accent)", borderColor: "var(--line)" }
        : { background: "transparent", color: "var(--muted)", borderColor: "var(--line)" };
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full border shrink-0" style={style}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0 transition-transform"
      style={{ color: "var(--muted)", transform: open ? "rotate(90deg)" : "none" }}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IntegrationCard({
  name,
  description,
  status,
  open,
  onToggle,
  steps,
  children,
}: {
  name: string;
  description: string;
  status: IntegrationStatus;
  open: boolean;
  onToggle: () => void;
  steps: string[];
  children: React.ReactNode;
}) {
  return (
    <div
      className="bg-white rounded-xl border"
      style={{ borderColor: "var(--line)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
    >
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 text-left no-drag">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium" style={{ color: "var(--ink)" }}>{name}</div>
          <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{description}</div>
        </div>
        <StatusChip status={status} />
        <Chevron open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
          <ol className="list-decimal pl-5 space-y-1 text-xs mb-3" style={{ color: "var(--muted)" }}>
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {children}
        </div>
      )}
    </div>
  );
}

function LastRunLine({ row }: { row: SyncRow }) {
  return (
    <p className="text-xs mt-2" style={{ color: row.error ? "var(--danger)" : "var(--muted)" }}>
      {row.error
        ? `Error: ${row.error}`
        : row.lastRun
          ? `Last synced ${row.lastRun.slice(0, 16).replace("T", " ")}${row.ingested != null ? ` — ${row.ingested} ingested` : ""}`
          : "Never synced."}
    </p>
  );
}

const EMPTY_ROW = (source: string): SyncRow => ({ source, lastRun: null, ingested: null, error: null });

function Integrations() {
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [gcal, setGcal] = useState<GcalState | null>(null);
  const [syncRows, setSyncRows] = useState<SyncRow[]>(normalizeSyncRows(null));
  const [openCard, setOpenCard] = useState<string | null>(null);

  const refetchKeys = useCallback(async () => {
    const r = await window.pos.settings.keys();
    if (r.ok) {
      const map: Record<string, boolean> = {};
      for (const k of r.data as KeyRow[]) map[k.name] = k.present;
      setPresent(map);
    }
  }, []);

  const refetchGcal = useCallback(async () => {
    const r = await window.pos.gcal.connected();
    if (r.ok) setGcal(r.data as GcalState);
  }, []);

  const refetchSync = useCallback(async () => {
    const r = await window.pos.sync.status();
    setSyncRows(r.ok ? normalizeSyncRows(r.data) : normalizeSyncRows(null));
  }, []);

  useEffect(() => {
    refetchKeys();
    refetchGcal();
    refetchSync();
  }, [refetchKeys, refetchGcal, refetchSync]);

  const syncRow = (source: string) => syncRows.find((r) => r.source === source) ?? EMPTY_ROW(source);
  const toggle = (id: string) => setOpenCard((cur) => (cur === id ? null : id));

  return (
    <Section title="Integrations">
      <div className="space-y-2">
        <GoogleCard
          gcal={gcal}
          present={present}
          open={openCard === "google"}
          onToggle={() => toggle("google")}
          onCredsSaved={() => { refetchKeys(); refetchGcal(); }}
        />
        <GmailCard
          present={present}
          row={syncRow("gmail")}
          open={openCard === "gmail"}
          onToggle={() => toggle("gmail")}
          onKeySaved={refetchKeys}
          refetchSync={refetchSync}
        />
        <IMessageCard
          row={syncRow("imessage")}
          open={openCard === "imessage"}
          onToggle={() => toggle("imessage")}
          refetchSync={refetchSync}
        />
        <PickImportCard
          id="linkedin"
          name="LinkedIn"
          description="Import your connections and messages from a LinkedIn data export."
          buttonLabel="Import LinkedIn export…"
          steps={[
            "On LinkedIn: Settings & Privacy → Data privacy → Get a copy of your data.",
            'Choose "Connections" and "Messages", request archive.',
            "When the email arrives (~10 min), download and unzip it.",
            "Click Import and select that folder.",
          ]}
          row={syncRow("linkedin")}
          open={openCard === "linkedin"}
          onToggle={() => toggle("linkedin")}
          refetchSync={refetchSync}
        />
        <PickImportCard
          id="mailfile"
          name="Mail export (.mbox/.eml)"
          description="Import a mailbox exported from Apple Mail or any other client."
          buttonLabel="Import mail export…"
          steps={[
            "Export a mailbox from Apple Mail (Mailbox → Export Mailbox…) or any client that saves .mbox/.eml.",
            "Click Import and select the file.",
          ]}
          row={syncRow("mailfile")}
          open={openCard === "mailfile"}
          onToggle={() => toggle("mailfile")}
          refetchSync={refetchSync}
        />
        <AiCard
          present={present}
          open={openCard === "ai"}
          onToggle={() => toggle("ai")}
          onKeySaved={refetchKeys}
        />
      </div>
      <EmbedProfiles />
    </Section>
  );
}

function GoogleCard({
  gcal,
  present,
  open,
  onToggle,
  onCredsSaved,
}: {
  gcal: GcalState | null;
  present: Record<string, boolean>;
  open: boolean;
  onToggle: () => void;
  onCredsSaved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const connect = async () => {
    setBusy("connect");
    setMsg(null);
    const r = await window.pos.gcal.connect();
    if (!r.ok) setMsg(r.error ?? "connection failed");
    setBusy(null);
    onCredsSaved();
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

  const status: IntegrationStatus =
    gcal?.connected ? "connected" : gcal?.hasCreds ? "ready" : "needs-setup";

  return (
    <IntegrationCard
      name="Google Calendar & Tasks"
      description="Push planned blocks to Calendar and tasks to the POS list."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Go to console.cloud.google.com → APIs & Services → Credentials.",
        'Create an OAuth client ID, type "Desktop app".',
        'Enable the "Google Calendar API" and "Google Tasks API" under Library.',
        "Paste the client ID and secret below, then Connect.",
      ]}
    >
      {gcal == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : !gcal.hasCreds ? (
        <div className="space-y-2">
          <KeyRowView
            row={{ name: "GOOGLE_OAUTH_CLIENT_ID", present: present.GOOGLE_OAUTH_CLIENT_ID ?? false }}
            onSaved={onCredsSaved}
          />
          <KeyRowView
            row={{ name: "GOOGLE_OAUTH_CLIENT_SECRET", present: present.GOOGLE_OAUTH_CLIENT_SECRET ?? false }}
            onSaved={onCredsSaved}
          />
        </div>
      ) : !gcal.connected ? (
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
    </IntegrationCard>
  );
}

function GmailCard({
  present,
  row,
  open,
  onToggle,
  onKeySaved,
  refetchSync,
}: {
  present: Record<string, boolean>;
  row: SyncRow;
  open: boolean;
  onToggle: () => void;
  onKeySaved: () => void;
  refetchSync: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runSync = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.run("gmail");
    const dataError = str((r.data as RawSyncRow | undefined)?.error);
    const err = r.ok ? dataError : (r.error ?? "sync failed");
    if (err) setMsg(`gmail: ${err}`);
    setBusy(false);
    refetchSync();
  };

  const hasCreds = (present.GMAIL_USER ?? false) && (present.GMAIL_APP_PASSWORD ?? false);
  const status: IntegrationStatus = hasCreds ? "connected" : "needs-setup";

  return (
    <IntegrationCard
      name="Gmail"
      description="Pull mail directly over IMAP with an app password."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Turn on 2-step verification for the Google account.",
        "Visit myaccount.google.com/apppasswords.",
        'Create an app password named "POS".',
        "Enter your Gmail address and that 16-character password below.",
      ]}
    >
      <div className="space-y-2">
        <KeyRowView
          row={{ name: "GMAIL_USER", present: present.GMAIL_USER ?? false }}
          secret={false}
          onSaved={onKeySaved}
        />
        <KeyRowView
          row={{ name: "GMAIL_APP_PASSWORD", present: present.GMAIL_APP_PASSWORD ?? false }}
          onSaved={onKeySaved}
        />
      </div>
      <button
        onClick={runSync}
        disabled={busy}
        className="mt-3 px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={{ borderColor: "var(--line)" }}
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
      <LastRunLine row={row} />
      {msg && <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>{msg}</p>}
    </IntegrationCard>
  );
}

function IMessageCard({
  row,
  open,
  onToggle,
  refetchSync,
}: {
  row: SyncRow;
  open: boolean;
  onToggle: () => void;
  refetchSync: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runSync = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.run("imessage");
    const dataError = str((r.data as RawSyncRow | undefined)?.error);
    const err = r.ok ? dataError : (r.error ?? "sync failed");
    if (err) setMsg(`imessage: ${err}`);
    setBusy(false);
    refetchSync();
  };

  const status: IntegrationStatus = row.error?.includes("full_disk_access")
    ? "needs-setup"
    : row.lastRun && !row.error
      ? "connected"
      : "ready";

  return (
    <IntegrationCard
      name="iMessage"
      description="Read your Messages history locally — needs Full Disk Access."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        'Click "Grant Full Disk Access" below (opens System Settings).',
        "Enable POS in the list (add it with + from /Users/…/pos/release if missing).",
        "Come back and hit Sync.",
      ]}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => window.pos.app.openFullDiskAccess()}
          className="px-3 py-1.5 rounded-md text-sm border bg-white"
          style={{ borderColor: "var(--line)" }}
        >
          Grant Full Disk Access
        </button>
        <button
          onClick={runSync}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </div>
      <LastRunLine row={row} />
      {msg && <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>{msg}</p>}
    </IntegrationCard>
  );
}

function PickImportCard({
  id,
  name,
  description,
  buttonLabel,
  steps,
  row,
  open,
  onToggle,
  refetchSync,
}: {
  id: "linkedin" | "mailfile";
  name: string;
  description: string;
  buttonLabel: string;
  steps: string[];
  row: SyncRow;
  open: boolean;
  onToggle: () => void;
  refetchSync: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runImport = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.pickAndRun(id);
    const d = r.data as { canceled?: boolean; error?: string; ingested?: number } | undefined;
    if (!r.ok) setMsg(`${id}: ${r.error}`);
    else if (d?.canceled) { /* user closed the picker */ }
    else if (d?.error) setMsg(`${id}: ${d.error}`);
    else setMsg(`${id}: imported ${d?.ingested ?? 0} records.`);
    setBusy(false);
    refetchSync();
  };

  const status: IntegrationStatus = row.lastRun && !row.error ? "connected" : "ready";

  return (
    <IntegrationCard
      name={name}
      description={description}
      status={status}
      open={open}
      onToggle={onToggle}
      steps={steps}
    >
      <button
        onClick={runImport}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={{ borderColor: "var(--line)" }}
      >
        {busy ? "Importing…" : buttonLabel}
      </button>
      {msg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{msg}</p>}
    </IntegrationCard>
  );
}

function AiCard({
  present,
  open,
  onToggle,
  onKeySaved,
}: {
  present: Record<string, boolean>;
  open: boolean;
  onToggle: () => void;
  onKeySaved: () => void;
}) {
  const hasKey = (present.ANTHROPIC_API_KEY ?? false) || (present.GEMINI_API_KEY ?? false);
  const status: IntegrationStatus = hasKey ? "connected" : "needs-setup";

  return (
    <IntegrationCard
      name="AI — Claude / Gemini"
      description="Powers planning — Claude is preferred when its key is present."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "For Claude: console.anthropic.com → API keys → Create key.",
        "For Gemini: aistudio.google.com/apikey.",
        "Paste either or both below — Claude is preferred automatically when present.",
      ]}
    >
      <div className="space-y-2">
        <KeyRowView
          row={{ name: "ANTHROPIC_API_KEY", present: present.ANTHROPIC_API_KEY ?? false }}
          hint="when set, planning uses Claude; otherwise Gemini"
          onSaved={onKeySaved}
        />
        <KeyRowView
          row={{ name: "GEMINI_API_KEY", present: present.GEMINI_API_KEY ?? false }}
          onSaved={onKeySaved}
        />
      </div>
    </IntegrationCard>
  );
}

function EmbedProfiles() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const embed = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.embed();
    if (r.ok) {
      const n = (r.data as { embedded?: number } | undefined)?.embedded ?? 0;
      setMsg(n === 0 ? "All profiles already embedded." : `Embedded ${n} profile${n === 1 ? "" : "s"}.`);
    } else setMsg(r.error ?? "embedding failed");
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap mt-3">
      <button
        onClick={embed}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={{ borderColor: "var(--line)" }}
      >
        {busy ? "Embedding…" : "Embed profiles"}
      </button>
      <span className="text-xs" style={{ color: "var(--muted)" }}>
        {msg ?? "rebuild people embeddings after a big import"}
      </span>
    </div>
  );
}

function KeyRowView({
  row,
  hint,
  onSaved,
  secret = true,
}: {
  row: KeyRow;
  hint?: string;
  onSaved: () => void;
  secret?: boolean;
}) {
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
          type={secret ? "password" : "text"}
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

// ── d. Adherence ─────────────────────────────────────────────────────────────

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
