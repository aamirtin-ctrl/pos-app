import React, { useCallback, useEffect, useState } from "react";

// Reconnect composer (owner ask 2026-10-23): a three-sentence "how are you + my news"
// note, editable, opened prefilled in Messages / Mail / LinkedIn. Nothing is sent from
// here — "Open" hands the text to the real app, "I sent it" logs the touch.

type Channel = "text" | "email" | "linkedin";
type Draft = {
  personId: number;
  name: string;
  channel: Channel;
  targets: { text: string | null; email: string | null; linkedin: string | null };
  subject: string | null;
  body: string;
  usedLlm: boolean;
};

const LABEL: Record<Channel, string> = { text: "Text", email: "Email", linkedin: "LinkedIn" };
const APP: Record<Channel, string> = { text: "Messages", email: "Mail", linkedin: "LinkedIn" };

const btn =
  "text-xs px-2 py-1 rounded border bg-white hover:shadow-sm active:scale-95 transition-[box-shadow,transform] duration-[120ms] disabled:opacity-40";

export default function ReconnectComposer({
  personId,
  onClose,
  onSent,
}: {
  personId: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  const load = useCallback(
    async (channel?: Channel) => {
      setLoading(true);
      setError(null);
      const r = await window.pos.people.reconnectDraft(personId, channel);
      if (r.ok) {
        const d = r.data as Draft;
        setDraft(d);
        setBody(d.body);
        setSubject(d.subject ?? "");
      } else setError(r.error ?? "couldn't write a draft");
      setLoading(false);
    },
    [personId]
  );
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reachable = (c: Channel) => c === "linkedin" || !!draft?.targets[c];

  const open = async () => {
    if (!draft) return;
    setError(null);
    const r = await window.pos.people.openReconnectDraft({
      personId,
      channel: draft.channel,
      body,
      subject: draft.channel === "email" ? subject : null,
    });
    if (r.ok) setOpened(true);
    else setError(r.error ?? "couldn't open the app");
  };

  const markSent = async () => {
    if (!draft) return;
    const r = await window.pos.people.markReachedOut(personId, draft.channel, body);
    if (r.ok) onSent();
    else setError(r.error ?? "couldn't log it");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div
        className="w-[30rem] rounded-xl border bg-white p-4 shadow-xl"
        style={{ borderColor: "var(--line)", color: "var(--ink)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <p className="font-medium text-sm flex-1 truncate">Reach out to {draft?.name ?? "…"}</p>
          {(["text", "email", "linkedin"] as Channel[]).map((c) => (
            <button
              key={c}
              disabled={loading || !reachable(c)}
              title={reachable(c) ? undefined : `No ${c === "text" ? "phone number" : "email"} on file`}
              onClick={() => { setOpened(false); void load(c); }}
              className={btn}
              style={{
                borderColor: draft?.channel === c ? "var(--accent)" : "var(--line)",
                color: draft?.channel === c ? "var(--accent)" : "var(--muted)",
              }}
            >
              {LABEL[c]}
            </button>
          ))}
        </div>

        {draft?.channel === "email" && (
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full mb-2 rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--line)" }}
          />
        )}
        <textarea
          value={loading ? "Writing…" : body}
          onChange={(e) => setBody(e.target.value)}
          disabled={loading}
          rows={draft?.channel === "email" ? 9 : 5}
          className="w-full rounded-md border px-2 py-1.5 text-sm leading-snug resize-none"
          style={{ borderColor: "var(--line)" }}
        />

        <p className="text-[11px] mt-1 min-h-[1rem]" style={{ color: error ? "var(--danger)" : "var(--muted)" }}>
          {error
            ? error
            : opened
              ? draft?.channel === "linkedin"
                ? "Copied. Open the chat on LinkedIn and paste."
                : `Opened in ${APP[draft!.channel]} (also copied, in case it didn't prefill).`
              : draft && !draft.usedLlm && !loading
                ? "Simple version: the AI wasn't available. Edit freely."
                : draft?.channel === "text"
                  ? `To ${draft.targets.text}`
                  : draft?.channel === "email"
                    ? `To ${draft.targets.email}`
                    : ""}
        </p>

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => void load(draft?.channel)}
            disabled={loading}
            className={btn}
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            Rewrite
          </button>
          <span className="flex-1" />
          <button onClick={onClose} className={btn} style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
            Cancel
          </button>
          {opened && (
            <button
              onClick={markSent}
              title="Log it and take them off the Reconnect list"
              className={btn}
              style={{ borderColor: "var(--line)", color: "var(--accent)" }}
            >
              I sent it
            </button>
          )}
          <button
            onClick={open}
            disabled={loading || !body.trim() || !draft}
            className={btn}
            style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
          >
            Open in {draft ? APP[draft.channel] : "…"}
          </button>
        </div>
      </div>
    </div>
  );
}
