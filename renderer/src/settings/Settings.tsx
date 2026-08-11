import { useCallback, useEffect, useState } from "react";

// Settings: integrations (keys + Google + sync connectors), spend meter,
// doctrine, adherence. Every mutation refetches its section; nothing here
// holds state the main process doesn't own.

type KeyRow = { name: string; present: boolean };
type Spend = { total: number; byFeature: Record<string, number>; ceiling: number };
// Mirrors LlmHealth in pos.d.ts (main/llm/provider.ts). `ok: false` is the state the app
// used to keep to itself: calls fail, the deterministic fallbacks take over, and nothing
// on screen changes except the quality of the output.
type LlmHealth = {
  provider: "anthropic" | "gemini" | null;
  configured: boolean;
  ok: boolean;
  reason?: "no_key" | "quota" | "ceiling" | "error";
  lastFailureAt?: string;
  monthSpend: number;
  ceiling: number;
};
// canWrite is false when the stored token predates the calendar-write scope widening:
// it still refreshes, so nothing looks disconnected, but every push is refused with 403.
type GcalState = { connected: boolean; hasCreds: boolean; canWrite: boolean };
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
      <GlobalShortcut />
      <Integrations />
      <AboutYou />
      <Preferences />
      <SpendMeter />
      <Doctrine />
      <Adherence />
    </div>
  );
}

// ── a0. Global shortcut ──────────────────────────────────────────────────────
//
// The system-wide chord that opens the floating voice HUD with the mic already
// recording (main/index.ts globalShortcut → "pos:voice-capture" → overlay/VoiceHud.tsx).
// It is a *chord* on purpose: registered globally, a bare Shift+A would fire on every
// capital letter the owner typed in every other app. main/ipc.ts validateAccelerator
// refuses anything whose only modifier is Shift, and the register-time refusal (some
// other app already owns the chord) comes back here rather than failing silently.

type HotkeyState = { accelerator: string; registered: boolean; error?: string };

/** How the accelerator reads on a Mac keyboard: CommandOrControl+Shift+A → ⌘⇧A. */
function prettyAccelerator(acc: string): string {
  const glyph: Record<string, string> = {
    commandorcontrol: "⌘", cmdorctrl: "⌘", command: "⌘", cmd: "⌘", meta: "⌘", super: "⌘",
    control: "⌃", ctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧",
  };
  return acc
    .split("+")
    .map((p) => glyph[p.trim().toLowerCase()] ?? p.trim())
    .join("");
}

/**
 * Turn a real key press into an Electron accelerator string. Reads `code` rather than
 * `key` for letters and digits: on macOS, Alt+V reports key "√", and holding Shift
 * reports "A" for the same physical key either way.
 */
function acceleratorFromEvent(e: React.KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock"].includes(e.key)) return null; // still mid-chord
  const mods: string[] = [];
  // CommandOrControl rather than Command: the same setting then means the obvious thing
  // if this ever runs anywhere but macOS.
  if (e.metaKey || e.ctrlKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const NAMED: Record<string, string> = {
    Escape: "Escape", Enter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", " ": "Space",
  };
  let key: string;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (NAMED[e.key]) key = NAMED[e.key];
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else return null;

  return [...mods, key].join("+");
}

function GlobalShortcut() {
  const [state, setState] = useState<HotkeyState | null>(null);
  const [draft, setDraft] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await window.pos.hotkey.get();
    if (!r.ok) {
      setError(r.error ?? "Couldn't read the current shortcut.");
      return;
    }
    // Main is the single source of truth for which chord ships as the default —
    // the renderer never hardcodes it, so changing it there changes it everywhere.
    const s = (r.data as HotkeyState | undefined) ?? {
      accelerator: "",
      registered: false,
      error: "Main didn't report a shortcut.",
    };
    setState(s);
    setDraft(s.accelerator);
    setError(s.registered ? null : (s.error ?? null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (accelerator: string) => {
    if (busy || !accelerator.trim()) return;
    setBusy(true);
    const r = await window.pos.hotkey.set(accelerator.trim());
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "Couldn't set that shortcut."); return; }
    const s = r.data as HotkeyState;
    // A rejected accelerator leaves the live one alone — keep showing what is registered.
    if (s.registered) { setState(s); setDraft(s.accelerator); setError(null); }
    else { setDraft(s.accelerator); setError(s.error ?? "That shortcut couldn't be registered."); }
  };

  const onCaptureKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const acc = acceleratorFromEvent(e);
    if (!acc) return;
    setDraft(acc);
    setCapturing(false);
    setError(null);
    e.currentTarget.blur();
  };

  const dirty = !!state && draft.trim() !== state.accelerator;

  return (
    <Section title="Global shortcut">
      <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
        Press this from any app. A small listener panel floats in above whatever you are
        working in and starts recording immediately — <b>POS does not come to the front and
        your keyboard focus does not move</b>, so you can keep typing where you were. Press
        it again to stop; it transcribes, does the thing, tells you what it did, and
        disappears. Escape or a click on the panel cancels without sending.
      </p>
      {state == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : (
        <div className="rounded-2xl border p-3" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="px-2.5 py-1 rounded-lg border text-sm tabular-nums"
              style={{ borderColor: "var(--line)", background: "var(--accent-soft)", color: "var(--ink)" }}
              title={state.accelerator}
            >
              {prettyAccelerator(state.accelerator)}
            </span>
            <span
              className="text-[11px] px-2 py-0.5 rounded-full border"
              style={
                state.registered
                  ? { borderColor: "transparent", background: "var(--accent-soft)", color: "var(--ink)" }
                  : { borderColor: "var(--danger)", color: "var(--danger)" }
              }
            >
              {state.registered ? "Active system-wide" : "Not registered"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
            <input
              readOnly
              value={capturing ? "Press the keys…" : draft}
              onFocus={() => setCapturing(true)}
              onBlur={() => setCapturing(false)}
              onKeyDown={onCaptureKey}
              placeholder="Click, then press a chord"
              className="w-64 border rounded-lg px-2 py-1 text-sm cursor-pointer"
              style={{
                borderColor: capturing ? "var(--accent)" : "var(--line)",
                color: capturing ? "var(--muted)" : "var(--ink)",
              }}
            />
            <button
              onClick={() => save(draft)}
              disabled={busy || !dirty}
              className="px-2.5 py-1 rounded-lg text-[12px] text-white disabled:opacity-50 active:scale-95"
              style={{ background: "var(--accent)" }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setDraft(state.accelerator); setError(state.registered ? null : (state.error ?? null)); }}
              disabled={busy || !dirty}
              className="px-2.5 py-1 rounded-lg border text-[12px] bg-white disabled:opacity-50 active:scale-95"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              Cancel
            </button>
          </div>

          {error && (
            <p className="text-[12px] mt-2" style={{ color: "var(--danger)" }}>{error}</p>
          )}

          <p className="text-[11px] mt-2 leading-relaxed" style={{ color: "var(--muted)" }}>
            <b>Fn cannot be used as a shortcut modifier on macOS — use Control, Option,
            Command or Shift combinations.</b> The Fn/Globe key is held by the system for
            emoji, dictation and F-key switching; it is never reported to apps as a
            modifier, so no app can bind it (POS would need a low-level input tap and
            Accessibility access across your whole Mac to see it at all). The default,
            Control+Option+Space, keeps the Control you wanted and avoids Control+Space,
            which macOS usually gives to input-source switching.
          </p>
          <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
            Needs a real chord. Shift on its own is not a safe global modifier — it would
            intercept every capital letter you type in every app — so Command, Control or
            Alt has to be in there. Inside POS, plain <b>Shift+A</b> still opens the command
            box as it always has; this shortcut is only for reaching it from somewhere else.
          </p>
        </div>
      )}
    </Section>
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
    const r = await window.pos.gcal.scopeStatus();
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
        <MorningCaptureCard
          row={syncRow("capture")}
          open={openCard === "capture"}
          onToggle={() => toggle("capture")}
          refetchSync={refetchSync}
        />
        <GoogleCard
          gcal={gcal}
          present={present}
          open={openCard === "google"}
          onToggle={() => toggle("google")}
          onCredsSaved={() => { refetchKeys(); refetchGcal(); }}
        />
        <AppleCalendarCard
          open={openCard === "applecal"}
          onToggle={() => toggle("applecal")}
        />
        <SubscribedCalendarsCard
          open={openCard === "ics"}
          onToggle={() => toggle("ics")}
        />
        <NotionCard
          present={present}
          row={syncRow("notion")}
          open={openCard === "notion"}
          onToggle={() => toggle("notion")}
          onKeySaved={refetchKeys}
          refetchSync={refetchSync}
        />
        <EmailAccountsCard
          row={syncRow("gmail")}
          open={openCard === "gmail"}
          onToggle={() => toggle("gmail")}
          refetchSync={refetchSync}
        />
        <IMessageCard
          row={syncRow("imessage")}
          open={openCard === "imessage"}
          onToggle={() => toggle("imessage")}
          refetchSync={refetchSync}
        />
        <MsgPlansCard
          row={syncRow("msgplans")}
          open={openCard === "msgplans"}
          onToggle={() => toggle("msgplans")}
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
          extra={<LinkedinEmailSync row={syncRow("linkedin-email")} refetchSync={refetchSync} />}
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

/** A distinct recent INBOX sender offered as a one-click allowlist add (main/capture.ts). */
type InboxSenderRow = {
  address: string;
  name: string | null;
  subject: string | null;
  count: number;
  account: string;
};

/** `capture_allowed_senders` is stored as free text — parse leniently, save normalized. */
const parseSenderCsv = (csv: string): string[] => {
  const out: string[] = [];
  for (const part of csv.split(",")) {
    const a = part.trim().toLowerCase();
    if (a.includes("@") && !out.includes(a)) out.push(a);
  }
  return out;
};

/** Morning capture: self-messages (note-to-self email / iMessage) → the unified assistant. */
function MorningCaptureCard({
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
  const [handles, setHandles] = useState("");
  const [savedHandles, setSavedHandles] = useState("");
  const [mailAccounts, setMailAccounts] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestBusy, setDigestBusy] = useState<"send" | "preview" | null>(null);
  const [digestMsg, setDigestMsg] = useState<string | null>(null);
  const [digestPreview, setDigestPreview] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [newSender, setNewSender] = useState("");
  const [candidates, setCandidates] = useState<InboxSenderRow[] | null>(null);
  const [sendersBusy, setSendersBusy] = useState(false);
  const [sendersMsg, setSendersMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const r = await window.pos.settings.get("capture_self_handles");
      if (r.ok && typeof r.data === "string") {
        setHandles(r.data);
        setSavedHandles(r.data);
      }
      const s = await window.pos.settings.get("capture_allowed_senders");
      if (s.ok && typeof s.data === "string") setAllowed(parseSenderCsv(s.data));
      const d = await window.pos.settings.get("digest_enabled");
      if (d.ok) setDigestEnabled(d.data === "1");
      const a = await window.pos.mail.list();
      if (a.ok && Array.isArray(a.data)) setMailAccounts((a.data as unknown[]).length);
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const v = handles.trim();
    const r = await window.pos.settings.set("capture_self_handles", v);
    if (r.ok) setSavedHandles(v);
    else setMsg(r.error ?? "could not save");
    setSaving(false);
  };

  const scan = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.run("capture");
    const d = r.data as (RawSyncRow & { summary?: unknown; ingested?: unknown }) | undefined;
    const err = r.ok ? str(d?.error) : (r.error ?? "scan failed");
    if (err) setMsg(`capture: ${err}`);
    else setMsg(str(d?.summary) ?? `Scanned — ${num(d?.ingested) ?? 0} new.`);
    setBusy(false);
    refetchSync();
  };

  // Allowlist of third-party senders (Alexa routines, IFTTT applets) whose mail also feeds
  // capture. Stored as one comma-separated setting; every edit writes the whole list.
  const saveAllowed = async (next: string[]) => {
    setSendersMsg(null);
    const r = await window.pos.settings.set("capture_allowed_senders", next.join(", "));
    if (r.ok) setAllowed(next);
    else setSendersMsg(r.error ?? "could not save");
  };

  const addSender = async (raw: string) => {
    const addr = raw.trim().toLowerCase();
    if (!addr.includes("@")) {
      setSendersMsg("Enter an email address.");
      return;
    }
    if (allowed.includes(addr)) {
      setNewSender("");
      return;
    }
    await saveAllowed([...allowed, addr]);
    setNewSender("");
  };

  const removeSender = (addr: string) => saveAllowed(allowed.filter((a) => a !== addr));

  const loadSenders = async () => {
    setSendersBusy(true);
    setSendersMsg(null);
    const r = await window.pos.capture.senders();
    if (r.ok && Array.isArray(r.data)) {
      const rows = r.data as InboxSenderRow[];
      setCandidates(rows);
      if (rows.length === 0) setSendersMsg("No other senders in the last 3 days.");
    } else {
      setSendersMsg(r.error ?? "could not read recent senders");
    }
    setSendersBusy(false);
  };

  const AUTOMATION_HINT =
    "macOS blocked the send. System Settings > Privacy & Security > Automation: allow POS to control Messages.";

  const toggleDigest = async () => {
    const next = !digestEnabled;
    setDigestMsg(null);
    const r = await window.pos.settings.set("digest_enabled", next ? "1" : "0");
    if (r.ok) setDigestEnabled(next);
    else setDigestMsg(r.error ?? "could not save");
  };

  const sendDigestNow = async () => {
    setDigestBusy("send");
    setDigestMsg(null);
    const r = await window.pos.digest.send();
    if (!r.ok) {
      setDigestMsg(r.error === "automation_denied" ? AUTOMATION_HINT : (r.error ?? "send failed"));
    } else {
      const d = r.data as { sent: boolean; items?: number; reason?: string; detail?: string };
      if (d.sent) {
        setDigestMsg(`Sent — ${d.items ?? 0} item${d.items === 1 ? "" : "s"} to confirm.`);
      } else if (d.reason === "automation_denied") setDigestMsg(AUTOMATION_HINT);
      else if (d.reason === "no_self_handle") setDigestMsg("Add your own phone/email handle above and save first.");
      else if (d.reason === "disabled") setDigestMsg("Turn the digest on first.");
      else setDigestMsg(`Send failed${d.detail ? `: ${d.detail}` : "."}`);
    }
    setDigestBusy(null);
  };

  const previewDigest = async () => {
    setDigestBusy("preview");
    setDigestMsg(null);
    const r = await window.pos.digest.preview();
    if (r.ok) setDigestPreview((r.data as { text?: string } | undefined)?.text ?? "");
    else setDigestMsg(r.error ?? "preview failed");
    setDigestBusy(null);
  };

  const status: IntegrationStatus =
    savedHandles.trim() || mailAccounts > 0 ? "connected" : "needs-setup";

  return (
    <IntegrationCard
      name="Morning capture"
      description="Text or email yourself — POS turns it into your day"
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Email: send a note to yourself from any connected account (same from/to address).",
        "iMessage: text your own number (the note-to-self thread) — enter your own phone/email handles below so POS knows which thread is yours.",
        "It's picked up within 15 minutes, or hit Scan now.",
      ]}
    >
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={handles}
          onChange={(e) => setHandles(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          disabled={!loaded}
          placeholder="+1214…, you@icloud.com"
          className="flex-1 border rounded-md px-2 py-1 text-sm bg-white"
          style={{ borderColor: "var(--line)" }}
        />
        <button
          onClick={save}
          disabled={saving || !loaded || handles.trim() === savedHandles.trim()}
          className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <button
        onClick={scan}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={{ borderColor: "var(--line)" }}
      >
        {busy ? "Scanning…" : "Scan now"}
      </button>
      <LastRunLine row={row} />
      {msg && <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{msg}</p>}
      <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
        <div className="text-sm font-medium mb-1" style={{ color: "var(--ink)" }}>
          Capture from these senders
        </div>
        <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
          Voice assistants: point an Alexa routine (or IFTTT applet) at one of your connected
          email addresses, then add the sender it arrives from here. What you say becomes tasks,
          events, and notes.
        </p>
        {allowed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {allowed.map((a) => (
              <span
                key={a}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              >
                {a}
                <button
                  onClick={() => removeSender(a)}
                  aria-label={`Remove ${a}`}
                  className="leading-none"
                  style={{ color: "var(--muted)" }}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addSender(newSender); }}
            disabled={!loaded}
            placeholder="alexa@amazon.com"
            className="flex-1 border rounded-md px-2 py-1 text-sm bg-white"
            style={{ borderColor: "var(--line)" }}
          />
          <button
            onClick={() => addSender(newSender)}
            disabled={!loaded || !newSender.trim()}
            className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
            style={{ borderColor: "var(--line)" }}
          >
            Add
          </button>
        </div>
        <button
          onClick={loadSenders}
          disabled={sendersBusy}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {sendersBusy ? "Reading…" : "Show recent senders"}
        </button>
        {candidates && candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {candidates
              .filter((c) => !allowed.includes(c.address))
              .map((c) => (
                <li
                  key={`${c.account}:${c.address}`}
                  className="flex items-center gap-2 text-xs border rounded-md px-2 py-1"
                  style={{ borderColor: "var(--line)" }}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate" style={{ color: "var(--ink)" }}>
                      {c.name ? `${c.name} — ${c.address}` : c.address}
                    </span>
                    {c.subject && (
                      <span className="block truncate" style={{ color: "var(--muted)" }}>
                        {c.subject}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => addSender(c.address)}
                    className="px-2 py-0.5 rounded-md border bg-white shrink-0"
                    style={{ borderColor: "var(--line)" }}
                  >
                    Add
                  </button>
                </li>
              ))}
          </ul>
        )}
        {sendersMsg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{sendersMsg}</p>}
      </div>
      <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
        <div className="text-sm font-medium mb-1" style={{ color: "var(--ink)" }}>Morning digest</div>
        <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
          Texts your own iMessage thread ~15 min after wake; reply to confirm.
        </p>
        <label className="flex items-center gap-2 text-sm mb-2 no-drag" style={{ color: "var(--ink)" }}>
          <input type="checkbox" checked={digestEnabled} onChange={toggleDigest} disabled={!loaded} />
          Send a confirmation text each morning
        </label>
        <div className="flex gap-2">
          <button
            onClick={sendDigestNow}
            disabled={digestBusy != null || !digestEnabled}
            className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
            style={{ borderColor: "var(--line)" }}
          >
            {digestBusy === "send" ? "Sending…" : "Send now"}
          </button>
          <button
            onClick={previewDigest}
            disabled={digestBusy != null}
            className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
            style={{ borderColor: "var(--line)" }}
          >
            {digestBusy === "preview" ? "Loading…" : "Preview"}
          </button>
        </div>
        {digestMsg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{digestMsg}</p>}
        {digestPreview != null && (
          <pre
            className="text-xs mt-2 p-2 rounded-md border whitespace-pre-wrap"
            style={{ borderColor: "var(--line)", color: "var(--muted)", background: "var(--accent-soft, #f6f6f4)" }}
          >
            {digestPreview || "Nothing to preview."}
          </pre>
        )}
      </div>
    </IntegrationCard>
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
  // Auto-push (setting `auto_push`, absent = on) is read here so the toggle reflects the
  // same default the main process applies.
  const [autoPush, setAutoPush] = useState(true);
  const [autoPushLoaded, setAutoPushLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await window.pos.settings.get("auto_push");
      if (r.ok) setAutoPush(r.data !== "0");
      setAutoPushLoaded(true);
    })();
  }, []);

  const toggleAutoPush = async () => {
    const next = !autoPush;
    const r = await window.pos.settings.set("auto_push", next ? "1" : "0");
    if (r.ok) setAutoPush(next);
    else setMsg(r.error ?? "could not save");
  };

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

  // Two-step on purpose: the first click only counts, and the button becomes the confirm.
  // Deleting Google rows is not undoable from here, and the count is the whole reassurance
  // — 1200 scanned, 38 kept — so it has to be seen before anything goes.
  const [purge, setPurge] = useState<PurgePreview | null>(null);

  const previewPurge = async () => {
    setBusy("purge");
    setMsg(null);
    setPurge(null);
    const r = await window.pos.gtasks.purgePreview();
    if (r.ok) {
      const d = (r.data ?? {}) as PurgePreview;
      setPurge(d);
      setMsg(
        d.deleted === 0
          ? `Nothing to clean — all ${d.kept} POS task${d.kept === 1 ? "" : "s"} in Google are still live.`
          : `${d.deleted} orphaned row${d.deleted === 1 ? "" : "s"} to delete, ${d.kept} kept. Click again to confirm.`
      );
    } else setMsg(r.error ?? "preview failed");
    setBusy(null);
  };

  const applyPurge = async () => {
    setBusy("purge");
    setMsg(null);
    const r = await window.pos.gtasks.purgeApply();
    if (r.ok) {
      const d = (r.data ?? {}) as PurgePreview;
      setMsg(`Deleted ${d.deleted} orphaned Google task${d.deleted === 1 ? "" : "s"}. ${d.kept} kept.`);
    } else setMsg(r.error ?? "purge failed");
    setPurge(null);
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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={connect}
            className="px-3 py-1.5 rounded-md text-sm text-white"
            style={{ background: "var(--accent)" }}
          >
            {busy === "connect" ? "Relaunch browser" : "Connect Google"}
          </button>
          {busy === "connect" && (
            <>
              <span className="text-xs" style={{ color: "var(--muted)" }}>Waiting for browser…</span>
              <button
                onClick={async () => { await window.pos.gcal.cancel(); setBusy(null); setMsg("Canceled."); }}
                className="px-2.5 py-1.5 rounded-md text-xs border bg-white"
                style={{ borderColor: "var(--line)", color: "var(--muted)" }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {!gcal.canWrite && (
            // Connected but the grant is too narrow — the exact reason "Push to Google"
            // silently did nothing. Nothing else in the app could say this.
            <div
              className="mb-3 rounded-md border px-3 py-2"
              style={{ borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, white)" }}
            >
              <p className="text-sm font-medium" style={{ color: "var(--danger)" }}>
                Google needs re-authorizing
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                POS&rsquo;s calendar permissions changed — it now creates its own
                &lsquo;POS — Planned&rsquo; calendar, which the older sign-in did not allow. Pushes are
                refused until you reconnect. Nothing is lost; this just re-grants access.
              </p>
              <button
                onClick={connect}
                disabled={busy === "connect"}
                className="mt-2 px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {busy === "connect" ? "Waiting for browser…" : "Reconnect Google"}
              </button>
            </div>
          )}
          <p className="text-sm mb-2">
            Connected — blocks push to &lsquo;POS — Planned&rsquo;, tasks to the &lsquo;POS&rsquo; list
          </p>
          <label className="flex items-center gap-2 text-sm mb-2 no-drag" style={{ color: "var(--ink)" }}>
            <input type="checkbox" checked={autoPush} onChange={toggleAutoPush} disabled={!autoPushLoaded} />
            Automatically push accepted plans
          </label>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
            On: accepting a plan sends it straight to Google, and anything that didn&rsquo;t get
            through is retried in the background every 15 minutes.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={reconcile}
              disabled={busy === "reconcile"}
              className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-50"
              style={{ borderColor: "var(--line)" }}
            >
              {busy === "reconcile" ? "Checking…" : "Re-check moved events"}
            </button>
            <button
              onClick={purge && purge.deleted > 0 ? applyPurge : previewPurge}
              disabled={busy === "purge"}
              className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-50"
              style={
                purge && purge.deleted > 0
                  ? { borderColor: "var(--danger)", color: "var(--danger)" }
                  : { borderColor: "var(--line)" }
              }
            >
              {busy === "purge"
                ? "Working…"
                : purge && purge.deleted > 0
                  ? `Delete ${purge.deleted} orphaned task${purge.deleted === 1 ? "" : "s"}`
                  : "Clean up orphaned tasks"}
            </button>
          </div>
          {purge && purge.deleted > 0 && purge.samples.length > 0 && (
            <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
              e.g. {purge.samples.slice(0, 4).join(" · ")}
              {purge.deleted > 4 ? " …" : ""}
            </p>
          )}
        </>
      )}
      {msg && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{msg}</p>}
    </IntegrationCard>
  );
}

/**
 * Apple Calendar: reads Calendar.app over AppleScript (needs the macOS Automation
 * permission) and mirrors the day into a dedicated "POS — Apple" Google calendar.
 */
type AppleAvailability = { ok: boolean; error?: string; calendars?: number };
type MirrorCounts = { created?: number; updated?: number; deleted?: number; skipped?: number; events?: number };

/** gtasks.purgePreview / purgeApply result (main/gtasks-sync.PurgeResult). */
type PurgePreview = { scanned: number; deleted: number; kept: number; samples: string[] };

const EXCLUDED_KEY = "apple_calendars_excluded";
const parseExcluded = (raw: unknown): string[] =>
  typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];

function AppleCalendarCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [avail, setAvail] = useState<AppleAvailability | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [calendars, setCalendars] = useState<string[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const check = useCallback(async (announce: boolean) => {
    if (announce) { setBusy("check"); setMsg(null); setErr(false); }
    // the first call is what makes macOS show the Automation prompt — it can take a moment
    const r = await window.pos.applecal.available();
    const a: AppleAvailability = r.ok
      ? (r.data as AppleAvailability)
      : { ok: false, error: r.error ?? "could not reach Calendar" };
    setAvail(a);
    if (announce) {
      setErr(!a.ok);
      setMsg(
        a.ok
          ? `Connected — ${a.calendars ?? 0} calendar${a.calendars === 1 ? "" : "s"} visible.`
          : (a.error ?? "could not reach Calendar")
      );
      setBusy(null);
    }
  }, []);

  useEffect(() => { check(false); }, [check]);

  // The calendar list is only needed once the card is open, and only when Calendar.app
  // actually answered — no point prompting for names we cannot read.
  const loadCalendars = useCallback(async () => {
    const [names, saved] = await Promise.all([
      window.pos.applecal.calendars(),
      window.pos.settings.get(EXCLUDED_KEY),
    ]);
    if (names.ok) setCalendars((names.data as string[]) ?? []);
    if (saved.ok) setExcluded(parseExcluded(saved.data));
  }, []);

  useEffect(() => {
    if (open && avail?.ok && calendars == null) loadCalendars();
  }, [open, avail?.ok, calendars, loadCalendars]);

  const toggleCalendar = async (name: string, include: boolean) => {
    const next = include ? excluded.filter((n) => n !== name) : [...excluded, name];
    setExcluded(next);
    setSaving(true);
    const r = await window.pos.settings.set(EXCLUDED_KEY, next.join(","));
    if (!r.ok) { setErr(true); setMsg(r.error ?? "could not save calendar selection"); }
    setSaving(false);
  };

  const mirror = async () => {
    setBusy("mirror");
    setMsg(null);
    setErr(false);
    const today = new Date();
    const dateISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const r = await window.pos.applecal.mirror(dateISO);
    if (r.ok) {
      const d = (r.data ?? {}) as MirrorCounts;
      const already = d.skipped ? ` ${d.skipped} already in Google, left alone.` : "";
      setMsg(
        `${d.events ?? 0} Apple event${d.events === 1 ? "" : "s"} today — ${d.created ?? 0} created, ${d.updated ?? 0} updated, ${d.deleted ?? 0} deleted in "POS — Apple".${already}`
      );
    } else {
      setErr(true);
      setMsg(r.error ?? "mirror failed");
    }
    setBusy(null);
  };

  const status: IntegrationStatus = avail == null ? "ready" : avail.ok ? "connected" : "needs-setup";

  return (
    <IntegrationCard
      name="Apple Calendar"
      description="Your Mac's calendars appear in POS and mirror into Google"
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Click Check access below — macOS will ask permission for POS to control Calendar.",
        "Approve it (System Settings → Privacy & Security → Automation if you miss the prompt).",
        'Use Mirror to Google to copy today’s Apple events into a dedicated "POS — Apple" Google calendar.',
      ]}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => check(true)}
          disabled={busy != null}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {busy === "check" ? "Checking…" : "Check access"}
        </button>
        <button
          onClick={mirror}
          disabled={busy != null}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {busy === "mirror" ? "Mirroring…" : "Mirror to Google"}
        </button>
      </div>
      {avail?.ok && (
        <div className="mt-3">
          <div className="text-xs font-medium mb-1" style={{ color: "var(--ink)" }}>
            Calendars POS reads
          </div>
          {calendars == null ? (
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>Loading calendars…</p>
          ) : calendars.length === 0 ? (
            <p className="text-[11px]" style={{ color: "var(--muted)" }}>No calendars found.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {calendars.map((name) => (
                <label key={name} className="flex items-center gap-2 text-xs no-drag" style={{ color: "var(--ink)" }}>
                  <input
                    type="checkbox"
                    checked={!excluded.includes(name)}
                    disabled={saving}
                    onChange={(e) => toggleCalendar(name, e.target.checked)}
                  />
                  <span className="truncate">{name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
            Unchecking Holidays, Birthdays or Siri Suggestions makes the daily scan much faster.
          </p>
        </div>
      )}
      <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
        Reading Calendar.app can take up to a minute the first time each day.
      </p>
      <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
        Events that already live in Google are never mirrored twice — POS matches them by their calendar UID.
      </p>
      {msg && (
        <p className="text-xs mt-1" style={{ color: err ? "var(--danger)" : "var(--muted)" }}>
          {msg}
        </p>
      )}
    </IntegrationCard>
  );
}

// ── Subscribed calendars (webcal / ICS) ──────────────────────────────────────

type IcsSubscriptionRow = { id: string; url: string; name: string };

/**
 * Subscribed calendars: read-only webcal/ICS feeds whose events join the day
 * view and anchor the planner. Add by URL; a feed is validated by fetching it.
 */
function SubscribedCalendarsCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [feeds, setFeeds] = useState<IcsSubscriptionRow[] | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const refetch = useCallback(async () => {
    const r = await window.pos.ics.list();
    if (r.ok && Array.isArray(r.data)) setFeeds(r.data as IcsSubscriptionRow[]);
    else if (!r.ok) { setErr(true); setMsg(r.error ?? "could not load feeds"); }
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const add = async () => {
    if (!url.trim() || adding) return;
    setAdding(true);
    setMsg(null);
    setErr(false);
    const r = await window.pos.ics.add(url.trim(), name.trim() || undefined);
    if (r.ok) {
      const added = r.data as IcsSubscriptionRow | undefined;
      setUrl("");
      setName("");
      setMsg(added ? `Added "${added.name}".` : "Added.");
    } else {
      setErr(true);
      setMsg(r.error ?? "could not add the feed");
    }
    setAdding(false);
    refetch();
  };

  const remove = async (id: string) => {
    setMsg(null);
    setErr(false);
    const r = await window.pos.ics.remove(id);
    if (!r.ok) { setErr(true); setMsg(r.error ?? "could not remove the feed"); }
    refetch();
  };

  const status: IntegrationStatus = (feeds?.length ?? 0) > 0 ? "connected" : "needs-setup";

  const inputCls = "border rounded-md px-2 py-1 text-sm bg-white";
  const inputStyle = { borderColor: "var(--line)" } as const;

  return (
    <IntegrationCard
      name="Subscribed calendars"
      description="webcal/ICS feeds (published iCloud, class schedules, team calendars) become anchors"
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Copy any webcal:// or .ics link.",
        "Paste below — events appear on the calendar and block planning time within 15 minutes.",
      ]}
    >
      {feeds == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : feeds.length === 0 ? (
        <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>No feeds yet — add one below.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {feeds.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5"
              style={inputStyle}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate" style={{ color: "var(--ink)" }}>{f.name}</span>
                <span className="block text-[11px] truncate" style={{ color: "var(--muted)" }}>{f.url}</span>
              </span>
              <button
                onClick={() => remove(f.id)}
                className="text-xs px-2 py-0.5 rounded-md border bg-white shrink-0"
                style={{ borderColor: "var(--line)", color: "var(--danger)" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-white px-3 py-2 space-y-1.5" style={inputStyle}>
        <div className="text-xs font-medium" style={{ color: "var(--muted)" }}>Add a feed</div>
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="webcal://… or https://….ics"
            className={`flex-1 min-w-[200px] ${inputCls}`}
            style={inputStyle}
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="name (optional)"
            className={`w-40 ${inputCls}`}
            style={inputStyle}
          />
          <button
            onClick={add}
            disabled={adding || !url.trim()}
            className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
            style={inputStyle}
          >
            {adding ? "Checking…" : "Add"}
          </button>
        </div>
      </div>
      {msg && (
        <p className="text-xs mt-2" style={{ color: err ? "var(--danger)" : "var(--muted)" }}>
          {msg}
        </p>
      )}
    </IntegrationCard>
  );
}

// ── Notion ───────────────────────────────────────────────────────────────────

type NotionTarget = { id: string; title: string; type: "page" | "database" };
type NotionCounts = { tasks?: number; commitments?: number; journal?: number; pulled?: number };

const NOTION_PARENT_KEY = "notion_parent_page_id";

/**
 * Notion: three POS databases under one user-picked page, synced both ways every
 * 15 minutes. Connected = token saved AND a parent page chosen.
 */
function NotionCard({
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
  const [targets, setTargets] = useState<NotionTarget[] | null>(null);
  const [parent, setParent] = useState("");
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const hasToken = present.NOTION_TOKEN ?? false;

  useEffect(() => {
    (async () => {
      const r = await window.pos.settings.get(NOTION_PARENT_KEY);
      if (r.ok && typeof r.data === "string") setParent(r.data);
    })();
  }, []);

  const loadTargets = useCallback(async () => {
    setLoadingTargets(true);
    setMsg(null);
    setErr(false);
    const r = await window.pos.notion.targets();
    if (r.ok && Array.isArray(r.data)) setTargets(r.data as NotionTarget[]);
    else {
      setErr(true);
      setMsg(r.error ?? "could not load pages");
    }
    setLoadingTargets(false);
  }, []);

  // Load the picker once the card opens and a token exists.
  useEffect(() => {
    if (open && hasToken && targets == null && !loadingTargets) loadTargets();
  }, [open, hasToken, targets, loadingTargets, loadTargets]);

  const pickParent = async (id: string) => {
    setParent(id);
    if (!id) return;
    const r = await window.pos.notion.setParent(id);
    if (!r.ok) {
      setErr(true);
      setMsg(r.error ?? "could not save the page choice");
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setMsg(null);
    setErr(false);
    const r = await window.pos.notion.sync();
    if (r.ok) {
      const d = (r.data ?? {}) as NotionCounts;
      setMsg(
        `Pushed ${d.tasks ?? 0} task${d.tasks === 1 ? "" : "s"}, ${d.commitments ?? 0} commitment${d.commitments === 1 ? "" : "s"}, ${d.journal ?? 0} journal — pulled ${d.pulled ?? 0} new task${d.pulled === 1 ? "" : "s"}.`
      );
    } else {
      setErr(true);
      setMsg(r.error ?? "sync failed");
    }
    setBusy(false);
    refetchSync();
  };

  const status: IntegrationStatus =
    hasToken && parent ? "connected" : hasToken ? "ready" : "needs-setup";

  return (
    <IntegrationCard
      name="Notion"
      description="Tasks, commitments, and your daily plan mirror into Notion databases."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Go to notion.so/my-integrations → New integration (Internal), copy the Secret.",
        "Paste it below.",
        "In Notion, open the page that should hold POS's databases → ••• menu → Connections → add your integration.",
        'Pick that page below — POS creates "POS Tasks", "POS Journal", "POS Commitments" databases inside it and syncs every 15 minutes.',
      ]}
    >
      <div className="mb-3">
        <KeyRowView
          row={{ name: "NOTION_TOKEN", present: hasToken }}
          onSaved={() => {
            onKeySaved();
            setTargets(null); // a new token can see different pages — reload the picker
          }}
        />
      </div>
      {hasToken && (
        <>
          <div className="text-xs font-medium mb-1" style={{ color: "var(--ink)" }}>
            Target page
          </div>
          <div className="flex gap-2 mb-2">
            <select
              value={parent}
              onChange={(e) => pickParent(e.target.value)}
              disabled={loadingTargets}
              className="flex-1 min-w-0 border rounded-md px-2 py-1 text-sm bg-white"
              style={{ borderColor: "var(--line)" }}
            >
              <option value="">
                {loadingTargets ? "Loading pages…" : "Choose a page…"}
              </option>
              {(targets ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.type === "database" ? " (database)" : ""}
                </option>
              ))}
              {parent && targets != null && !targets.some((t) => t.id === parent) && (
                <option value={parent}>Current page (not visible to this token)</option>
              )}
            </select>
            <button
              onClick={loadTargets}
              disabled={loadingTargets}
              className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40 shrink-0"
              style={{ borderColor: "var(--line)" }}
            >
              Refresh
            </button>
          </div>
          <button
            onClick={syncNow}
            disabled={busy || !parent}
            className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
            style={{ borderColor: "var(--line)" }}
          >
            {busy ? "Syncing…" : "Sync now"}
          </button>
          <LastRunLine row={row} />
        </>
      )}
      {msg && (
        <p className="text-xs mt-1" style={{ color: err ? "var(--danger)" : "var(--muted)" }}>
          {msg}
        </p>
      )}
    </IntegrationCard>
  );
}

type MailAccountRow = { id: string; provider: string; user: string; host: string; auth?: string };
// "gmail-oauth" is UI-only: it selects the Google sign-in path instead of a password add.
type MailProvider = "gmail" | "gmail-oauth" | "outlook" | "icloud" | "imap";

function EmailAccountsCard({
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
  const [accounts, setAccounts] = useState<MailAccountRow[] | null>(null);
  const [provider, setProvider] = useState<MailProvider>("gmail");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refetchAccounts = useCallback(async () => {
    const r = await window.pos.mail.list();
    if (r.ok) setAccounts(r.data as MailAccountRow[]);
  }, []);
  useEffect(() => { refetchAccounts(); }, [refetchAccounts]);

  const addAccount = async () => {
    if (provider === "gmail-oauth") return; // oauth path uses connectGoogle instead
    if (!email || !password || adding) return;
    if (provider === "imap" && !host) { setMsg("Host is required for custom IMAP."); return; }
    setAdding(true);
    setMsg(null);
    const r = await window.pos.mail.add({
      provider,
      user: email,
      password,
      ...(provider === "imap" ? { host, port: Number(port) || 993 } : {}),
    });
    if (!r.ok) setMsg(r.error ?? "could not add account");
    else { setEmail(""); setPassword(""); setHost(""); setPort("993"); }
    setAdding(false);
    refetchAccounts();
  };

  const removeAccount = async (id: string) => {
    setMsg(null);
    const r = await window.pos.mail.remove(id);
    if (!r.ok) setMsg(r.error ?? "could not remove account");
    refetchAccounts();
  };

  // OAuth path (work Gmail without app passwords): opens Google consent in the
  // browser; the account address comes back from the Gmail profile.
  const connectGoogle = async () => {
    if (adding) return;
    setAdding(true);
    setMsg(null);
    const r = await window.pos.mail.connectOAuth();
    const data = r.data as { connected?: boolean; user?: string; error?: string } | undefined;
    if (!r.ok) {
      setMsg(r.error ?? "could not connect to Google");
    } else if (!data?.connected) {
      if (data?.error === "admin_blocked") {
        setMsg("Your Google admin has blocked this app. Ask them to allow it, or use forwarding instead.");
      } else if (data?.error === "timeout") {
        setMsg("Google sign-in timed out — try again.");
      } else if (data?.error === "canceled") {
        setMsg("Google sign-in was canceled.");
      } else {
        setMsg(`Google sign-in failed${data?.error ? `: ${data.error}` : ""}.`);
      }
    }
    setAdding(false);
    refetchAccounts();
  };

  const runSync = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.run("gmail");
    const dataError = str((r.data as RawSyncRow | undefined)?.error);
    const err = r.ok ? dataError : (r.error ?? "sync failed");
    if (err) setMsg(`mail: ${err}`);
    setBusy(false);
    refetchSync();
  };

  const status: IntegrationStatus = (accounts?.length ?? 0) > 0 ? "connected" : "needs-setup";

  const inputCls = "border rounded-md px-2 py-1 text-sm bg-white";
  const inputStyle = { borderColor: "var(--line)" } as const;

  return (
    <IntegrationCard
      name="Email accounts"
      description="Pull mail over IMAP from any number of Gmail, Outlook, or custom accounts."
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Turn on 2-step verification for the Google account.",
        "Visit myaccount.google.com/apppasswords.",
        'Create an app password named "POS".',
        "Enter your Gmail address and that 16-character password below.",
        "Outlook: enable 2FA at account.microsoft.com/security, then create an app password. iCloud: create an app-specific password at account.apple.com under Sign-In and Security.",
        "Work accounts: your Google admin must allow the app — if consent shows 'admin has blocked', use forwarding instead.",
      ]}
    >
      {accounts == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>No accounts yet — add one below.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5"
              style={inputStyle}
            >
              <span className="text-sm flex-1 truncate" style={{ color: "var(--ink)" }}>
                {a.user}
                {a.auth === "oauth" ? (
                  <span
                    className="ml-2 text-[10px] px-1.5 py-0.5 rounded border align-middle"
                    style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                  >
                    OAuth
                  </span>
                ) : (
                  <span style={{ color: "var(--muted)" }}> — {a.provider}</span>
                )}
              </span>
              <button
                onClick={() => removeAccount(a.id)}
                className="text-xs px-2 py-0.5 rounded-md border bg-white shrink-0"
                style={{ borderColor: "var(--line)", color: "var(--danger)" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-white px-3 py-2 space-y-1.5" style={inputStyle}>
        <div className="text-xs font-medium" style={{ color: "var(--muted)" }}>Add an account</div>
        <div className="flex gap-2 flex-wrap">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as MailProvider)}
            className={inputCls}
            style={inputStyle}
          >
            <option value="gmail">Gmail</option>
            <option value="gmail-oauth">Gmail — sign in with Google (work/no app password)</option>
            <option value="outlook">Outlook</option>
              <option value="icloud">iCloud</option>
            <option value="imap">Custom IMAP</option>
          </select>
          {provider !== "gmail-oauth" && (
            <>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email address"
                className={`flex-1 min-w-[140px] ${inputCls}`}
                style={inputStyle}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="app password"
                className={`flex-1 min-w-[140px] ${inputCls}`}
                style={inputStyle}
              />
            </>
          )}
        </div>
        {provider === "imap" && (
          <div className="flex gap-2">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="imap.example.com"
              className={`flex-1 ${inputCls}`}
              style={inputStyle}
            />
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="993"
              className={`w-24 tabular-nums ${inputCls}`}
              style={inputStyle}
            />
          </div>
        )}
        {provider === "gmail-oauth" ? (
          <>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Opens Google in your browser — sign in with the work account and approve access. No password is stored.
            </p>
            <button
              onClick={connectGoogle}
              disabled={adding}
              className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
              style={inputStyle}
            >
              {adding ? "Waiting for Google…" : "Connect with Google"}
            </button>
          </>
        ) : (
          <button
            onClick={addAccount}
            disabled={adding || !email || !password || (provider === "imap" && !host)}
            className="px-3 py-1 rounded-md text-sm border bg-white disabled:opacity-40"
            style={inputStyle}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        )}
      </div>

      <button
        onClick={runSync}
        disabled={busy}
        className="mt-3 px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={inputStyle}
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

/** One tracked plan, as main/msgplans.ts listMsgPlans returns it. */
type MsgPlanRow = {
  id: number;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  confidence: number | null;
  personName: string | null;
};

/** "Sat Jun 6, 8:00 PM" from the stored local wall-clock string. */
function formatPlanWhen(startsAt: string | null, allDay: boolean): string {
  if (!startsAt) return "—";
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return startsAt.slice(0, 16).replace("T", " ");
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (allDay) return `${day}, all day`;
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Plans from messages: scheduling talk in iMessage becomes one event per conversation on a
 * dedicated Google calendar, updated or cancelled as the plan changes.
 */
function MsgPlansCard({
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
  const [plans, setPlans] = useState<MsgPlanRow[]>([]);

  const refetchPlans = useCallback(async () => {
    const r = await window.pos.msgplans.list();
    setPlans(r.ok && Array.isArray(r.data) ? (r.data as MsgPlanRow[]) : []);
  }, []);

  useEffect(() => {
    if (open) refetchPlans();
  }, [open, refetchPlans]);

  const scan = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.msgplans.run();
    const d = r.data as RawSyncRow | undefined;
    const err = r.ok ? str(d?.error) : (r.error ?? "scan failed");
    if (err) setMsg(`Plans from messages: ${err}`);
    else setMsg(str(d?.summary));
    setBusy(false);
    refetchSync();
    refetchPlans();
  };

  const status: IntegrationStatus = row.error?.includes("full_disk_access")
    ? "needs-setup"
    : row.lastRun && !row.error
      ? "connected"
      : "ready";

  return (
    <IntegrationCard
      name="Plans from messages"
      description="Texts about plans become events on a dedicated Google calendar"
      status={status}
      open={open}
      onToggle={onToggle}
      steps={[
        "Needs iMessage access (see the iMessage card) and Google connected.",
        "POS watches for scheduling talk and creates one event per conversation, updating or cancelling it as the plan changes.",
        'Events land on "POS — From Messages" — delete that calendar any time to remove them all.',
      ]}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={scan}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
          style={{ borderColor: "var(--line)" }}
        >
          {busy ? "Scanning…" : "Scan now"}
        </button>
      </div>
      <LastRunLine row={row} />
      {msg && <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{msg}</p>}

      <div className="mt-3">
        <div className="text-xs font-medium mb-1" style={{ color: "var(--ink)" }}>
          Active plans
        </div>
        {plans.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Nothing tracked yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {plans.map((p) => (
              <li
                key={p.id}
                className="flex items-baseline gap-2 text-xs border-t pt-1"
                style={{ borderColor: "var(--line)" }}
              >
                <span className="flex-1 min-w-0 truncate" style={{ color: "var(--ink)" }}>
                  {p.title ?? "Plans"}
                </span>
                <span className="shrink-0" style={{ color: "var(--muted)" }}>
                  {formatPlanWhen(p.startsAt, p.allDay)}
                </span>
                {p.personName && (
                  <span className="shrink-0 truncate max-w-[9rem]" style={{ color: "var(--muted)" }}>
                    {p.personName}
                  </span>
                )}
                {p.confidence != null && (
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
                    {Math.round(p.confidence * 100)}%
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
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
  extra,
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
  extra?: React.ReactNode;
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
      {extra}
    </IntegrationCard>
  );
}

/** LinkedIn card add-on: invite/accept events pulled from LinkedIn's notification emails. */
function LinkedinEmailSync({ row, refetchSync }: { row: SyncRow; refetchSync: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runSync = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.pos.sync.run("linkedin-email");
    const dataError = str((r.data as RawSyncRow | undefined)?.error);
    const err = r.ok ? dataError : (r.error ?? "sync failed");
    if (err) setMsg(`linkedin-email: ${err}`);
    setBusy(false);
    refetchSync();
  };

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
      <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
        New connections also sync automatically from LinkedIn&rsquo;s notification emails (uses your
        connected email accounts)
      </p>
      <button
        onClick={runSync}
        disabled={busy}
        className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-40"
        style={{ borderColor: "var(--line)" }}
      >
        {busy ? "Syncing…" : "Sync invites now"}
      </button>
      <LastRunLine row={row} />
      {msg && <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>{msg}</p>}
    </div>
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

// ── a2. About you ────────────────────────────────────────────────────────────
//
// The facts main/context.ts uses to resolve colloquial dates ("start of school") and to
// personalize scheduling. Everything here is user-owned and editable: the app ships a
// short list of guessed defaults precisely so they can be corrected in one place.

type Fact = {
  id: number;
  key: string;
  value: string;
  kind: string;
  starts_at: string | null;
  ends_at: string | null;
  source: string;
  updated_at: string;
};

const FACT_KINDS: { value: string; label: string }[] = [
  { value: "fact", label: "Fact" },
  { value: "date_anchor", label: "Date" },
  { value: "recurring", label: "Recurring" },
];

const prettyKey = (key: string) => key.replace(/_/g, " ");

function AboutYou() {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { value: string; kind: string; date: string }>>({});
  const [newFact, setNewFact] = useState({ key: "", value: "", kind: "fact", date: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const r = await window.pos.context.list();
    if (!r.ok) {
      setError(r.error ?? "Couldn't load your facts.");
      setFacts([]);
      return;
    }
    const rows = (r.data as Fact[]) ?? [];
    setFacts(rows);
    setDrafts(
      Object.fromEntries(
        rows.map((f) => [f.key, { value: f.value, kind: f.kind, date: (f.starts_at ?? "").slice(0, 10) }])
      )
    );
    setError(null);
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

  const save = async (key: string) => {
    const d = drafts[key];
    if (!d || !d.value.trim() || busy) return;
    setBusy(key);
    const r = await window.pos.context.set({
      key,
      value: d.value.trim(),
      kind: d.kind,
      startsAt: d.kind === "date_anchor" ? d.date || null : null,
      source: "manual",
    });
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "Couldn't save that fact."); return; }
    refetch();
  };

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(key);
    const r = await window.pos.context.delete(key);
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "Couldn't delete that fact."); return; }
    refetch();
  };

  const add = async () => {
    if (!newFact.key.trim() || !newFact.value.trim() || busy) return;
    setBusy("__new__");
    const r = await window.pos.context.set({
      key: newFact.key.trim(),
      value: newFact.value.trim(),
      kind: newFact.kind,
      startsAt: newFact.kind === "date_anchor" ? newFact.date || null : null,
      source: "manual",
    });
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "Couldn't add that fact."); return; }
    setNewFact({ key: "", value: "", kind: "fact", date: "" });
    refetch();
  };

  const dirty = (f: Fact) => {
    const d = drafts[f.key];
    if (!d) return false;
    return (
      d.value !== f.value ||
      d.kind !== f.kind ||
      (d.kind === "date_anchor" && d.date !== (f.starts_at ?? "").slice(0, 10))
    );
  };

  const inputStyle = { borderColor: "var(--line)", color: "var(--ink)" };

  return (
    <Section title="About you">
      <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
        Facts POS uses to resolve dates and personalize scheduling. Say "remember: …" in the command box to add one by voice.
      </p>
      {error && (
        <p className="text-[12px] mb-2" style={{ color: "var(--danger)" }}>{error}</p>
      )}
      {facts == null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
      ) : (
        <div className="space-y-1.5">
          {facts.map((f) => {
            const d = drafts[f.key] ?? { value: f.value, kind: f.kind, date: "" };
            return (
              <div key={f.key} className="flex items-center gap-1.5 flex-wrap text-sm">
                <span className="w-36 shrink-0 truncate" style={{ color: "var(--muted)" }} title={f.key}>
                  {prettyKey(f.key)}
                </span>
                <input
                  value={d.value}
                  onChange={(e) => setDrafts({ ...drafts, [f.key]: { ...d, value: e.target.value } })}
                  className="flex-1 min-w-[9rem] border rounded-md px-2 py-1 bg-white"
                  style={inputStyle}
                />
                <select
                  value={d.kind}
                  onChange={(e) => setDrafts({ ...drafts, [f.key]: { ...d, kind: e.target.value } })}
                  className="border rounded-md px-1.5 py-1 bg-white text-[12px]"
                  style={inputStyle}
                >
                  {FACT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                {d.kind === "date_anchor" && (
                  <input
                    type="date"
                    value={d.date}
                    onChange={(e) => setDrafts({ ...drafts, [f.key]: { ...d, date: e.target.value } })}
                    className="border rounded-md px-1.5 py-1 bg-white text-[12px]"
                    style={inputStyle}
                  />
                )}
                <button
                  onClick={() => save(f.key)}
                  disabled={!dirty(f) || busy === f.key}
                  className="px-2 py-1 rounded-md text-[12px] border bg-white disabled:opacity-40"
                  style={{ borderColor: "var(--line)" }}
                >
                  Save
                </button>
                <button
                  onClick={() => remove(f.key)}
                  disabled={busy === f.key}
                  className="px-2 py-1 rounded-md text-[12px] border bg-white disabled:opacity-40"
                  style={{ borderColor: "var(--line)", color: "var(--danger)" }}
                >
                  Delete
                </button>
              </div>
            );
          })}
          {facts.length === 0 && (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing recorded yet.</p>
          )}

          <div className="flex items-center gap-1.5 flex-wrap text-sm pt-2 mt-1 border-t" style={{ borderColor: "var(--line)" }}>
            <input
              value={newFact.key}
              onChange={(e) => setNewFact({ ...newFact, key: e.target.value })}
              placeholder="key (e.g. dorm)"
              className="w-36 shrink-0 border rounded-md px-2 py-1 bg-white"
              style={inputStyle}
            />
            <input
              value={newFact.value}
              onChange={(e) => setNewFact({ ...newFact, value: e.target.value })}
              placeholder="value"
              className="flex-1 min-w-[9rem] border rounded-md px-2 py-1 bg-white"
              style={inputStyle}
            />
            <select
              value={newFact.kind}
              onChange={(e) => setNewFact({ ...newFact, kind: e.target.value })}
              className="border rounded-md px-1.5 py-1 bg-white text-[12px]"
              style={inputStyle}
            >
              {FACT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            {newFact.kind === "date_anchor" && (
              <input
                type="date"
                value={newFact.date}
                onChange={(e) => setNewFact({ ...newFact, date: e.target.value })}
                className="border rounded-md px-1.5 py-1 bg-white text-[12px]"
                style={inputStyle}
              />
            )}
            <button
              onClick={add}
              disabled={!newFact.key.trim() || !newFact.value.trim() || busy === "__new__"}
              className="px-2.5 py-1 rounded-md text-[12px] border bg-white disabled:opacity-40"
              style={{ borderColor: "var(--line)" }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── a3. Preferences ──────────────────────────────────────────────────────────
//
// The free-text companion to About you (main/preferences.ts). About you holds facts the
// app RESOLVES ("start of school" → a date); this holds prose the app READS — how he wants
// his mornings, his focus, his meetings and his messages handled. It is a real Markdown
// file next to doctrine.yaml, which is why the card ships a Reveal in Finder button: the
// file is his, and he should be able to open it in any editor he likes.

function Preferences() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const r = await window.pos.prefs.get();
      if (r.ok) setText(r.data as string);
      else setError(r.error ?? "Couldn't read your preferences file.");
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    const r = await window.pos.prefs.set(text);
    if (!r.ok) setError(r.error ?? "Couldn't save — the file was left untouched.");
    else setSavedAt(Date.now());
    setSaving(false);
  };

  const reveal = async () => {
    const r = await window.pos.prefs.reveal();
    if (!r.ok) setError(r.error ?? "Couldn't open Finder.");
  };

  return (
    <Section title="Preferences">
      <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
        How you want your time handled, in your own words — read by the planner and the assistant.
        Say "prefer: …" in the command box to append a line, or edit the file directly. Dated facts
        belong in About you.
      </p>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSavedAt(null); }}
        spellCheck={false}
        disabled={!loaded}
        className="w-full min-h-[260px] border rounded-lg p-3 text-[12px] leading-relaxed bg-white font-mono resize-y"
        style={{ borderColor: "var(--line)" }}
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={save}
          disabled={saving || !loaded || !text.trim()}
          className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={reveal}
          disabled={!loaded}
          className="px-3 py-1.5 rounded-md text-sm border bg-white disabled:opacity-50"
          style={{ borderColor: "var(--line)" }}
        >
          Reveal in Finder
        </button>
        {savedAt && !error && (
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>Saved</span>
        )}
        {error && (
          <span className="text-[12px]" style={{ color: "var(--danger)" }}>{error}</span>
        )}
      </div>
    </Section>
  );
}

// ── b. Spend ─────────────────────────────────────────────────────────────────

/** Headline + what it costs the owner, per reason. Written to be read while annoyed. */
function healthCopy(h: LlmHealth): { title: string; detail: string } {
  const provider = h.provider === "anthropic" ? "Anthropic" : h.provider === "gemini" ? "Gemini" : "The provider";
  if (h.reason === "quota") {
    return {
      title: `${provider} is out of quota`,
      detail: `${provider} refused the last call as over-quota or rate-limited. Free-tier limits reset on their own — usually within the day.`,
    };
  }
  if (h.reason === "ceiling") {
    return {
      title: "Monthly spend ceiling reached",
      detail: "Calls are being refused locally, before they reach the provider. Raise the ceiling below to turn the AI back on.",
    };
  }
  if (h.reason === "no_key") {
    return {
      title: "No AI key set",
      detail: "Add a Gemini or Anthropic key under Integrations above.",
    };
  }
  return {
    title: "AI calls are failing",
    detail: "The provider returned an error on the last call. If it persists, check the key under Integrations.",
  };
}

/** The prominent not-ok state at the top of the Spend card. Nothing renders when healthy. */
function HealthNotice({ health }: { health: LlmHealth | null }) {
  if (!health || health.ok) return null;
  const { title, detail } = healthCopy(health);
  const when = health.lastFailureAt ? new Date(health.lastFailureAt) : null;
  return (
    <div
      className="rounded-xl border px-3 py-2.5 mb-3"
      style={{
        borderColor: "var(--danger)",
        background: "color-mix(in srgb, var(--danger) 7%, white)",
      }}
    >
      <div className="text-sm font-medium" style={{ color: "var(--danger)" }}>
        {title}
      </div>
      <p className="text-[12px] mt-1 leading-relaxed" style={{ color: "var(--ink)" }}>
        {detail}
      </p>
      {/* The concrete symptoms, so the degraded output is recognizable rather than mysterious. */}
      <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
        Until it recovers: planning still works, but block titles are copied verbatim from what
        you typed instead of being rewritten, and extraction from messages falls back to keyword
        rules.
        {when ? ` Last failure ${when.toLocaleString()}.` : ""}
      </p>
    </div>
  );
}

function SpendMeter() {
  const [spend, setSpend] = useState<Spend | null>(null);
  const [health, setHealth] = useState<LlmHealth | null>(null);
  const [ceiling, setCeilingInput] = useState("");
  const [saving, setSaving] = useState(false);

  const refetch = useCallback(async () => {
    const r = await window.pos.settings.spend();
    if (r.ok) {
      const s = r.data as Spend;
      setSpend(s);
      setCeilingInput(String(s.ceiling));
    }
    const hr = await window.pos.llm.health();
    if (hr.ok) setHealth(hr.data as LlmHealth);
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
      <HealthNotice health={health} />
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
