import React, { useCallback, useEffect, useState } from "react";

// Messaging: unanswered inbound messages with auto-drafted replies in your own
// per-platform voice. Drafts are suggestions — copy, tweak, send from the native
// app. POS never auto-sends.

type Draft = {
  id: number; channel: string; body: string; subject: string | null;
  inbound: string | null; occurred_at: string; person_id: number; who: string;
};

const CHANNEL_BADGE: Record<string, string> = {
  gmail: "Email", mailfile: "Email", outlook: "Email",
  imessage: "iMessage", linkedin: "LinkedIn", slack: "Slack",
};
const DEEP_LINK: Record<string, string | null> = {
  gmail: "https://mail.google.com", mailfile: "https://mail.google.com", outlook: "https://outlook.com",
  linkedin: "https://linkedin.com/messaging", imessage: null, slack: null,
};

export default function Inbox() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const refetch = useCallback(async () => {
    const r = await window.pos.drafts.list();
    setDrafts(r.ok ? (r.data as Draft[]) : []);
  }, []);
  useEffect(() => { refetch(); }, [refetch]);

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
    setMsg(r.ok ? `Voice profiles updated for: ${Object.keys(r.data as object).join(", ") || "none yet (sync some messages first)"}.` : r.error ?? "failed");
    setBusy(null);
  };
  const act = async (id: number, status: "dismissed" | "sent") => {
    await window.pos.drafts.setStatus(id, status);
    refetch();
  };
  const copy = async (d: Draft) => {
    await navigator.clipboard.writeText(d.body);
    setCopied(d.id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="drag-region h-4" />
      <h1 className="font-display text-2xl font-semibold mb-1 no-drag">Messaging</h1>
      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
        Auto-drafted replies in your own voice per platform — learned from how you actually write.
        Copy, tweak, send from the real app. Nothing sends itself.
      </p>
      <div className="flex gap-2 mb-5 no-drag">
        <button onClick={generate} disabled={!!busy}
          className="px-3.5 py-1.5 rounded-lg text-sm text-white disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, var(--pink-3), var(--accent))" }}>
          {busy === "generate" ? "Drafting…" : "Draft replies"}
        </button>
        <button onClick={() => window.pos.app.openLinkedIn()}
          className="px-3 py-1.5 rounded-lg text-sm border bg-white" style={{ borderColor: "var(--line)" }}>
          Open LinkedIn messaging
        </button>
        <button onClick={learnVoice} disabled={!!busy}
          className="px-3 py-1.5 rounded-lg text-sm border bg-white disabled:opacity-50" style={{ borderColor: "var(--line)" }}>
          {busy === "voice" ? "Reading your messages…" : "Re-learn my voice"}
        </button>
        {msg && <span className="text-xs self-center" style={{ color: "var(--muted)" }}>{msg}</span>}
      </div>

      {drafts.length === 0 ? (
        <div className="rounded-xl border bg-white p-6 text-sm text-center" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
          No suggested drafts. Hit "Draft replies" after a mail or iMessage sync — unanswered
          messages from the last two weeks get a reply written in your voice.
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <div key={d.id} className="rounded-xl border bg-white p-4" style={{ borderColor: "var(--line)" }}>
              <div className="flex items-baseline gap-2 mb-1">
                <a href={`#/contact/${d.person_id}`} className="font-medium text-sm" style={{ color: "var(--ink)" }}>{d.who}</a>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--accent-soft)", color: "var(--ink)" }}>
                  {CHANNEL_BADGE[d.channel] ?? d.channel}
                </span>
                <span className="text-[11px] ml-auto" style={{ color: "var(--muted)" }}>{d.occurred_at?.slice(0, 10)}</span>
              </div>
              <p className="text-xs mb-2 italic" style={{ color: "var(--muted)" }}>
                “{(d.subject ? `${d.subject} — ` : "") + (d.inbound ?? "")}”
              </p>
              <p className="text-sm leading-relaxed rounded-lg p-2.5 mb-2"
                style={{ background: "linear-gradient(160deg, white, var(--wash))", border: "1px solid var(--line)" }}>
                {d.body}
              </p>
              <div className="flex gap-2 text-xs">
                <button onClick={() => copy(d)} className="px-2.5 py-1 rounded-md text-white" style={{ background: "var(--accent)" }}>
                  {copied === d.id ? "Copied" : "Copy draft"}
                </button>
                {DEEP_LINK[d.channel] && (
                  <a href={DEEP_LINK[d.channel]!} target="_blank" rel="noreferrer"
                    className="px-2.5 py-1 rounded-md border bg-white" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                    Open {CHANNEL_BADGE[d.channel]}
                  </a>
                )}
                <button onClick={() => act(d.id, "sent")} className="px-2.5 py-1 rounded-md border bg-white" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                  Mark sent
                </button>
                <button onClick={() => act(d.id, "dismissed")} className="px-2.5 py-1 rounded-md" style={{ color: "var(--muted)" }}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
