import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Messaging: a real two-pane unified inbox. Left = conversations (one row per
// conversation key from listInbox — group chats keyed by chat guid, 1:1 by
// person), unanswered first. Right = the recent thread + a compose box
// prefilled with the auto-drafted reply. Send routes per channel: email → SMTP
// via inbox.sendEmail, 1:1 iMessage → inbox.sendIMessage, group iMessage →
// inbox.sendIMessageChat, LinkedIn → open the real messaging window + copy the
// draft (no fake send). Every send is an explicit user click — POS never
// auto-sends.

type ThreadMessage = {
  id: number; channel: string; direction: string | null;
  subject: string | null; body_summary: string | null; occurred_at: string | null;
  sender_name: string | null;
};
type InboxItem = {
  id: number; person_id: number; person_name: string; channel: string;
  subject: string | null; body_summary: string | null; occurred_at: string | null;
  external_id: string | null; thread_external_id: string | null;
  thread_key: string; is_group: 0 | 1; group_name: string | null;
  has_draft: 0 | 1; draft_id: number | null;
  draft_body: string | null; answered: 0 | 1; unanswered: 0 | 1; thread: ThreadMessage[];
};
type Handles = { email: string | null; imessage: string | null };
type MailAccount = { id: string; provider: string; user: string; host: string };

type Conversation = {
  key: string; personId: number; name: string; channel: string; latest: InboxItem;
  unanswered: boolean; draft: string | null; isGroup: boolean;
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

// multi-person icon for group conversations
function GroupIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="5.2" r="2.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 13c.5-2.3 2.1-3.6 4-3.6s3.5 1.3 4 3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11.3" cy="5.8" r="1.9" stroke="currentColor" strokeWidth="1.2" />
      <path d="M11.6 9.6c1.6.2 2.7 1.3 3 3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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

/** Distinct sender names across the thread, for the group-row subtitle. */
function senderNames(thread: ThreadMessage[]): string {
  return [...new Set(thread.map((m) => m.sender_name).filter(Boolean) as string[])].join(", ");
}

export default function Inbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // thread_key
  const [handles, setHandles] = useState<Handles | null>(null);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountUser, setAccountUser] = useState<string>("");
  const [compose, setCompose] = useState("");
  const composeFor = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "generate" | "voice" | "send" | "delete"
  const [msg, setMsg] = useState<string | null>(null);
  const [sendState, setSendState] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null); // row showing the inline delete confirm

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

  // listInbox already collapses to one row per conversation key, sorted
  // unanswered-first then newest — a straight map is all that's left.
  const conversations = useMemo<Conversation[]>(
    () =>
      items.map((it) => ({
        key: it.thread_key,
        personId: it.person_id,
        name: it.is_group ? it.group_name ?? "Group chat" : it.person_name,
        channel: it.channel,
        latest: it,
        unanswered: it.unanswered === 1,
        draft: it.draft_body,
        isGroup: it.is_group === 1,
      })),
    [items]
  );

  const convo = conversations.find((c) => c.key === selected) ?? null;

  // Select the first conversation once loaded; refresh handles + compose per selection.
  useEffect(() => {
    if (selected === null && conversations.length > 0) setSelected(conversations[0].key);
  }, [conversations, selected]);
  useEffect(() => {
    if (!convo) return;
    setHandles(null);
    setSendState(null);
    window.pos.inbox.handles(convo.personId).then((r) => setHandles(r.ok ? (r.data as Handles) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo?.key, convo?.personId]);
  useEffect(() => {
    if (!convo) return;
    if (composeFor.current !== convo.key) {
      composeFor.current = convo.key;
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
      if (convo.isGroup) {
        // Group send exists for iMessage only; other channels fall through to the
        // buttons below (LinkedIn opens the real window).
        if (channel !== "imessage") return;
        const chatGuid = convo.latest.thread_external_id;
        if (!chatGuid) { setSendState({ kind: "err", text: "No chat id on file for this group." }); return; }
        const r = await window.pos.inbox.sendIMessageChat({
          chatGuid, body: compose, personId: convo.personId,
        });
        if (!r.ok) { setSendState({ kind: "err", text: friendlyError(r.error) }); return; }
        setSendState({ kind: "ok", text: `Sent to ${convo.name}.` });
      } else if (EMAIL_CHANNELS.has(channel)) {
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

  // Quick-delete: removes the person the row represents (for groups, the thread's
  // most recent sender) and, via DB cascade, their interactions and drafts.
  const removeConvo = async (c: Conversation) => {
    if (busy) return;
    setBusy("delete");
    try {
      await window.pos.people.delete(c.personId);
      setConfirmKey(null);
      if (selected === c.key) {
        setSelected(null); // auto-select the next conversation after refetch
        composeFor.current = null;
        setCompose("");
      }
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
    ? convo.isGroup
      ? convo.channel === "imessage" ? "via iMessage — replies go to the whole group"
        : `via ${CHANNEL_LABEL[convo.channel] ?? convo.channel}`
      : EMAIL_CHANNELS.has(convo.channel)
      ? `via ${accountUser || "email"}`
      : convo.channel === "imessage" ? "via iMessage"
      : convo.channel === "linkedin" ? "via LinkedIn — sends from the LinkedIn window"
      : `via ${CHANNEL_LABEL[convo.channel] ?? convo.channel}`
    : "";
  const canSend =
    !!convo &&
    (convo.isGroup
      ? convo.channel === "imessage"
      : EMAIL_CHANNELS.has(convo.channel) || convo.channel === "imessage");

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
              const active = c.key === selected;
              const confirming = confirmKey === c.key;
              return (
                <div key={c.key} onClick={() => setSelected(c.key)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelected(c.key); }}
                  className="group w-full text-left px-3 py-2.5 border-b block cursor-pointer"
                  style={{
                    borderColor: "var(--line)",
                    background: active ? "linear-gradient(160deg, white, var(--wash))" : "transparent",
                  }}>
                  <div className="flex items-center gap-1.5">
                    {c.unanswered && (
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--petal)" }} title="Needs a reply" />
                    )}
                    {c.isGroup && (
                      <span className="shrink-0" style={{ color: "var(--accent)" }} title="Group chat"><GroupIcon /></span>
                    )}
                    <span className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>{c.name}</span>
                    <span className="ml-auto shrink-0 flex items-center gap-1.5">
                      <span style={{ color: "var(--accent)" }}><ChannelIcon channel={c.channel} /></span>
                      <span className="text-[10px]" style={{ color: "var(--muted)" }}>{fmtDate(c.latest.occurred_at)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmKey(confirming ? null : c.key); }}
                        title={c.isGroup ? "Remove this sender" : "Remove contact"}
                        aria-label={c.isGroup ? "Remove this sender" : "Remove contact"}
                        className="opacity-0 group-hover:opacity-100 transition-opacity duration-[120ms] text-xs leading-none px-1 py-0.5 rounded hover:bg-black/[0.06]"
                        style={{ color: "var(--muted)" }}>
                        ✕
                      </button>
                    </span>
                  </div>
                  {confirming ? (
                    <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
                      <span className="text-[11px]" style={{ color: "var(--danger)" }}>
                        {c.isGroup ? "Remove this sender and their history?" : "Remove contact and history?"}
                      </span>
                      <button onClick={() => removeConvo(c)} disabled={!!busy}
                        className="text-[11px] px-1.5 py-0.5 rounded border disabled:opacity-50"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                        {busy === "delete" ? "Removing…" : "Remove"}
                      </button>
                      <button onClick={() => setConfirmKey(null)}
                        className="text-[11px] px-1.5 py-0.5 rounded border"
                        style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="text-xs truncate mt-0.5" style={{ color: "var(--muted)" }}>
                      {c.isGroup
                        ? senderNames(c.latest.thread) || c.latest.body_summary || ""
                        : (c.latest.subject ? `${c.latest.subject} — ` : "") + (c.latest.body_summary ?? "")}
                    </div>
                  )}
                </div>
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
                  <span style={{ color: "var(--accent)" }}>
                    {convo.isGroup ? <GroupIcon size={16} /> : <ChannelIcon channel={convo.channel} size={16} />}
                  </span>
                  {convo.isGroup ? (
                    <span className="text-sm font-medium" style={{ color: "var(--ink)" }}>{convo.name}</span>
                  ) : (
                    <a href={`#/contact/${convo.personId}`} className="text-sm font-medium" style={{ color: "var(--ink)" }}>{convo.name}</a>
                  )}
                  <span className="text-[11px]" style={{ color: "var(--muted)" }}>{viaLabel}</span>
                  {!convo.isGroup && EMAIL_CHANNELS.has(convo.channel) && accounts.length > 1 && (
                    <select value={accountUser} onChange={(e) => setAccountUser(e.target.value)}
                      className="ml-auto text-[11px] border rounded-md px-1 py-0.5 bg-white"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      {accounts.map((a) => <option key={a.id} value={a.user}>{a.user}</option>)}
                    </select>
                  )}
                </div>
                {convo.isGroup && senderNames(convo.latest.thread) && (
                  <div className="px-4 py-1.5 border-b text-[11px] truncate shrink-0 bg-white/40"
                    style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                    {senderNames(convo.latest.thread)}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                  {convo.latest.thread.map((m) => {
                    const out = m.direction === "outbound";
                    return (
                      <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[78%] rounded-xl px-3 py-2 text-sm leading-relaxed border"
                          style={out
                            ? { background: "linear-gradient(160deg, var(--pink-1), var(--wash))", borderColor: "var(--pink-2)", color: "var(--ink)" }
                            : { background: "linear-gradient(160deg, white, var(--panel))", borderColor: "var(--line)", color: "var(--ink)" }}>
                          {convo.isGroup && !out && m.sender_name && (
                            <div className="text-[11px] font-medium mb-0.5" style={{ color: "var(--accent)" }}>{m.sender_name}</div>
                          )}
                          {/* in group threads the subject is the chat name on every row — the sender line replaces it */}
                          {!convo.isGroup && m.subject && (
                            <div className="text-[11px] font-medium mb-0.5" style={{ color: "var(--muted)" }}>{m.subject}</div>
                          )}
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
                      <button onClick={send} disabled={!!busy || !compose.trim() || (!convo.isGroup && !handles)}
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
