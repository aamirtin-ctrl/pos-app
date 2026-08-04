import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Messaging: a real two-pane unified inbox. Left = conversations grouped by
// person (unanswered first). Right = the recent thread + a compose box prefilled
// with the auto-drafted reply. Send routes per channel: email → SMTP via
// inbox.sendEmail, iMessage → inbox.sendIMessage, LinkedIn → open the real
// messaging window + copy the draft (no fake send). Every send is an explicit
// user click — POS never auto-sends.

type ThreadMessage = {
  id: number; channel: string; direction: string | null;
  subject: string | null; body_summary: string | null; occurred_at: string | null;
};
type InboxItem = {
  id: number; person_id: number; person_name: string; channel: string;
  subject: string | null; body_summary: string | null; occurred_at: string | null;
  external_id: string | null; has_draft: 0 | 1; draft_id: number | null;
  draft_body: string | null; answered: 0 | 1; unanswered: 0 | 1; thread: ThreadMessage[];
};
type Handles = { email: string | null; imessage: string | null };
type MailAccount = { id: string; provider: string; user: string; host: string };

type Conversation = {
  personId: number; name: string; channel: string; latest: InboxItem;
  unanswered: boolean; draft: string | null;
};

const EMAIL_CHANNELS = new Set(["gmail", "outlook", "icloud", "mailfile"]);
const CHANNEL_LABEL: Record<string, string> = {
  gmail: "Gmail", outlook: "Outlook", icloud: "iCloud", mailfile: "Email",
  imessage: "iMessage", linkedin: "LinkedIn", slack: "Slack",
};

const ERROR_TEXT: Record<string, string> = {
  automation_denied:
    "Grant Automation permission for Messages (System Settings → Privacy & Security → Automation), then try again.",
  no_email_account: "Connect an email account in Settings to send email.",
  account_not_found: "That mail account is no longer configured — check Settings.",
  smtp_unsupported_provider:
    "Sending works for Gmail, Outlook and iCloud accounts only. Copy the draft and send from your mail app.",
  no_recipient: "No address on file for this person.",
};
function friendlyError(code: string | undefined): string {
  if (!code) return "Send failed.";
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code.startsWith("imessage_failed:")) return `Messages error: ${code.slice(16).trim()}`;
  return code;
}

// ── channel icons (inline SVG, stroke follows currentColor) ──
function ChannelIcon({ channel, size = 14 }: { channel: string; size?: number }) {
  if (channel === "linkedin") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <text x="8" y="11.6" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor" fontFamily="ui-sans-serif, sans-serif">in</text>
      </svg>
    );
  }
  if (channel === "imessage") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.2c3.6 0 6.3 2.2 6.3 5.1S11.6 12.4 8 12.4c-.7 0-1.4-.1-2-.3-.9.7-2 1.2-3.2 1.3.7-.7 1.1-1.4 1.2-2.1C2.6 10.4 1.7 9 1.7 7.3c0-2.9 2.7-5.1 6.3-5.1z"
          stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  // envelope: gmail / outlook / icloud / mailfile / anything else
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 4.5 8 9l5.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Inbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<number | null>(null); // person_id
  const [handles, setHandles] = useState<Handles | null>(null);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountUser, setAccountUser] = useState<string>("");
  const [compose, setCompose] = useState("");
  const composeFor = useRef<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "generate" | "voice" | "send"
  const [msg, setMsg] = useState<string | null>(null);
  const [sendState, setSendState] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refetch = useCallback(async () => {
    const r = await window.pos.inbox.list({ limit: 50 });
    setItems(r.ok ? (r.data as InboxItem[]) : []);
  }, []);
  useEffect(() => {
    refetch();
    window.pos.mail.list().then((r) => {
      const list = r.ok ? (r.data as MailAccount[]) : [];
      setAccounts(list);
      if (list.length > 0) setAccountUser(list[0].user);
    });
  }, [refetch]);

  // Group by person; conversation order = unanswered first, then newest.
  const conversations = useMemo<Conversation[]>(() => {
    const byPerson = new Map<number, Conversation>();
    for (const it of items) {
      const existing = byPerson.get(it.person_id);
      if (!existing) {
        byPerson.set(it.person_id, {
          personId: it.person_id, name: it.person_name, channel: it.channel,
          latest: it, unanswered: it.unanswered === 1, draft: it.draft_body,
        });
      } else {
        if ((it.occurred_at ?? "") > (existing.latest.occurred_at ?? "")) {
          existing.latest = it; existing.channel = it.channel;
        }
        if (it.unanswered === 1) existing.unanswered = true;
        if (!existing.draft && it.draft_body) existing.draft = it.draft_body;
      }
    }
    return [...byPerson.values()].sort((a, b) => {
      if (a.unanswered !== b.unanswered) return a.unanswered ? -1 : 1;
      return (b.latest.occurred_at ?? "").localeCompare(a.latest.occurred_at ?? "");
    });
  }, [items]);

  const convo = conversations.find((c) => c.personId === selected) ?? null;

  // Select the first conversation once loaded; refresh handles + compose per selection.
  useEffect(() => {
    if (selected === null && conversations.length > 0) setSelected(conversations[0].personId);
  }, [conversations, selected]);
  useEffect(() => {
    if (selected === null) return;
    setHandles(null);
    setSendState(null);
    window.pos.inbox.handles(selected).then((r) => setHandles(r.ok ? (r.data as Handles) : null));
  }, [selected]);
  useEffect(() => {
    if (!convo) return;
    if (composeFor.current !== convo.personId) {
      composeFor.current = convo.personId;
      setCompose(convo.draft ?? "");
    }
  }, [convo]);

  const generate = async () => {
    setBusy("generate"); setMsg(null);
    const r = await window.pos.drafts.generate();
    const d = r.data as { drafted?: number; skipped?: string | null } | undefined;
    if (!r.ok) setMsg(r.error ?? "failed");
    else if (d?.skipped) setMsg(d.skipped);
    else setMsg(`Drafted ${d?.drafted ?? 0} repl${(d?.drafted ?? 0) === 1 ? "y" : "ies"}.`);
    setBusy(null); refetch();
  };
  const learnVoice = async () => {
    setBusy("voice"); setMsg(null);
    const r = await window.pos.voice.synthesize();
    setMsg(r.ok
      ? `Voice profiles updated for: ${Object.keys(r.data as object).join(", ") || "none yet (sync some messages first)"}.`
      : r.error ?? "failed");
    setBusy(null);
  };

  const send = async () => {
    if (!convo || !compose.trim() || busy) return;
    const channel = convo.channel;
    setBusy("send"); setSendState(null);
    try {
      if (EMAIL_CHANNELS.has(channel)) {
        const to = handles?.email;
        if (!to) { setSendState({ kind: "err", text: friendlyError("no_recipient") }); return; }
        const subj = convo.latest.subject
          ? (/^re:/i.test(convo.latest.subject) ? convo.latest.subject : `Re: ${convo.latest.subject}`)
          : "";
        const r = await window.pos.inbox.sendEmail({
          personId: convo.personId, to, subject: subj, body: compose,
          accountUser: accountUser || undefined,
        });
        if (!r.ok) { setSendState({ kind: "err", text: friendlyError(r.error) }); return; }
        setSendState({ kind: "ok", text: `Sent to ${to}.` });
      } else if (channel === "imessage") {
        const handle = handles?.imessage;
        if (!handle) { setSendState({ kind: "err", text: "No iMessage handle or phone on file." }); return; }
        const r = await window.pos.inbox.sendIMessage({ personId: convo.personId, handle, body: compose });
        if (!r.ok) { setSendState({ kind: "err", text: friendlyError(r.error) }); return; }
        setSendState({ kind: "ok", text: `Sent via iMessage to ${handle}.` });
      } else {
        return; // linkedin/slack have no send path — buttons below handle them
      }
      setCompose("");
      composeFor.current = null; // allow re-prefill after refetch
      await refetch();
    } finally {
      setBusy(null);
    }
  };

  const copyDraft = async () => {
    await navigator.clipboard.writeText(compose);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const viaLabel = convo
    ? EMAIL_CHANNELS.has(convo.channel)
      ? `via ${accountUser || "email"}`
      : convo.channel === "imessage" ? "via iMessage"
      : convo.channel === "linkedin" ? "via LinkedIn — sends from the LinkedIn window"
      : `via ${CHANNEL_LABEL[convo.channel] ?? convo.channel}`
    : "";
  const canSend = !!convo && (EMAIL_CHANNELS.has(convo.channel) || convo.channel === "imessage");

  return (
    <div className="p-6 h-full flex flex-col max-w-5xl mx-auto">
      <div className="drag-region h-4 shrink-0" />
      <div className="flex items-baseline gap-3 no-drag shrink-0">
        <h1 className="font-display text-2xl font-semibold">Messaging</h1>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          One inbox for every channel. Replies draft themselves in your voice — nothing sends without you.
        </span>
      </div>
      <div className="flex gap-2 my-4 no-drag shrink-0 items-center flex-wrap">
        <button onClick={generate} disabled={!!busy}
          className="px-3.5 py-1.5 rounded-lg text-sm text-white disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, var(--pink-3), var(--accent))" }}>
          {busy === "generate" ? "Drafting…" : "Draft replies"}
        </button>
        <button onClick={learnVoice} disabled={!!busy}
          className="px-3 py-1.5 rounded-lg text-sm border bg-white disabled:opacity-50" style={{ borderColor: "var(--line)" }}>
          {busy === "voice" ? "Reading your messages…" : "Re-learn my voice"}
        </button>
        <button onClick={() => window.pos.app.openLinkedIn()}
          className="px-3 py-1.5 rounded-lg text-sm border bg-white" style={{ borderColor: "var(--line)" }}>
          Open LinkedIn messaging
        </button>
        {msg && <span className="text-xs" style={{ color: "var(--muted)" }}>{msg}</span>}
      </div>

      {conversations.length === 0 ? (
        <div className="rounded-xl border bg-white p-6 text-sm text-center" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
          Nothing here yet. Sync mail or iMessage, then hit "Draft replies" — unanswered
          messages show up with a reply already written in your voice.
        </div>
      ) : (
        <div className="flex gap-3 flex-1 min-h-0 no-drag">
          {/* ── left: conversation list ── */}
          <div className="w-72 shrink-0 overflow-y-auto rounded-xl border bg-white/70" style={{ borderColor: "var(--line)" }}>
            {conversations.map((c) => {
              const active = c.personId === selected;
              return (
                <button key={c.personId} onClick={() => setSelected(c.personId)}
                  className="w-full text-left px-3 py-2.5 border-b block"
                  style={{
                    borderColor: "var(--line)",
                    background: active ? "linear-gradient(160deg, white, var(--wash))" : "transparent",
                  }}>
                  <div className="flex items-center gap-1.5">
                    {c.unanswered && (
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--petal)" }} title="Needs a reply" />
                    )}
                    <span className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>{c.name}</span>
                    <span className="ml-auto shrink-0 flex items-center gap-1.5">
                      <span style={{ color: "var(--accent)" }}><ChannelIcon channel={c.channel} /></span>
                      <span className="text-[10px]" style={{ color: "var(--muted)" }}>{fmtDate(c.latest.occurred_at)}</span>
                    </span>
                  </div>
                  <div className="text-xs truncate mt-0.5" style={{ color: "var(--muted)" }}>
                    {(c.latest.subject ? `${c.latest.subject} — ` : "") + (c.latest.body_summary ?? "")}
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── right: thread + compose ── */}
          <div className="flex-1 min-w-0 flex flex-col rounded-xl border bg-white/70 overflow-hidden" style={{ borderColor: "var(--line)" }}>
            {!convo ? (
              <div className="p-6 text-sm" style={{ color: "var(--muted)" }}>Pick a conversation.</div>
            ) : (
              <>
                <div className="px-4 py-2.5 border-b flex items-center gap-2 shrink-0 bg-white/60" style={{ borderColor: "var(--line)" }}>
                  <span style={{ color: "var(--accent)" }}><ChannelIcon channel={convo.channel} size={16} /></span>
                  <a href={`#/contact/${convo.personId}`} className="text-sm font-medium" style={{ color: "var(--ink)" }}>{convo.name}</a>
                  <span className="text-[11px]" style={{ color: "var(--muted)" }}>{viaLabel}</span>
                  {EMAIL_CHANNELS.has(convo.channel) && accounts.length > 1 && (
                    <select value={accountUser} onChange={(e) => setAccountUser(e.target.value)}
                      className="ml-auto text-[11px] border rounded-md px-1 py-0.5 bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      {accounts.map((a) => <option key={a.id} value={a.user}>{a.user}</option>)}
                    </select>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                  {convo.latest.thread.map((m) => {
                    const out = m.direction === "outbound";
                    return (
                      <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[78%] rounded-xl px-3 py-2 text-sm leading-relaxed border"
                          style={out
                            ? { background: "linear-gradient(160deg, var(--pink-1), var(--wash))", borderColor: "var(--pink-2)", color: "var(--ink)" }
                            : { background: "linear-gradient(160deg, white, var(--panel))", borderColor: "var(--line)", color: "var(--ink)" }}>
                          {m.subject && <div className="text-[11px] font-medium mb-0.5" style={{ color: "var(--muted)" }}>{m.subject}</div>}
                          <div>{m.body_summary ?? <span style={{ color: "var(--muted)" }}>(no preview)</span>}</div>
                          <div className="text-[10px] mt-1 flex items-center gap-1" style={{ color: "var(--muted)" }}>
                            <ChannelIcon channel={m.channel} size={10} />
                            {fmtDate(m.occurred_at)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t p-3 shrink-0 bg-white/60" style={{ borderColor: "var(--line)" }}>
                  {convo.draft && compose === convo.draft && (
                    <div className="text-[11px] mb-1" style={{ color: "var(--muted)" }}>
                      Suggested draft in your voice — edit freely before sending.
                    </div>
                  )}
                  <textarea value={compose} onChange={(e) => setCompose(e.target.value)}
                    rows={4} placeholder={`Reply to ${convo.name}…`}
                    className="w-full text-sm rounded-lg border p-2.5 resize-none bg-white"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }} />
                  <div className="flex items-center gap-2 mt-2">
                    {canSend ? (
                      <button onClick={send} disabled={!!busy || !compose.trim() || !handles}
                        className="px-3.5 py-1.5 rounded-lg text-sm text-white disabled:opacity-50"
                        style={{ background: "linear-gradient(135deg, var(--pink-3), var(--accent))" }}>
                        {busy === "send" ? "Sending…" : "Send"}
                      </button>
                    ) : convo.channel === "linkedin" ? (
                      <button onClick={() => window.pos.app.openLinkedIn()}
                        className="px-3.5 py-1.5 rounded-lg text-sm border bg-white" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                        Open LinkedIn messaging
                      </button>
                    ) : (
                      <span className="text-xs" style={{ color: "var(--muted)" }}>
                        No direct send for {CHANNEL_LABEL[convo.channel] ?? convo.channel} — copy the draft.
                      </span>
                    )}
                    <button onClick={copyDraft} disabled={!compose.trim()}
                      className="px-3 py-1.5 rounded-lg text-sm border bg-white disabled:opacity-50"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      {copied ? "Copied" : "Copy draft"}
                    </button>
                    {sendState && (
                      <span className="text-xs" style={{ color: sendState.kind === "err" ? "var(--danger)" : "var(--muted)" }}>
                        {sendState.text}
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
