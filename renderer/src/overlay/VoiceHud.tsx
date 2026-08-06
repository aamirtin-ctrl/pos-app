// The floating voice HUD — what the global hotkey (default Control+Alt+Space) actually
// opens. Rendered into its own frameless, transparent, always-on-top BrowserWindow that
// main/index.ts shows with showInactive(), so it appears over whatever the owner is
// working in WITHOUT taking keyboard focus from it. He keeps typing; POS listens.
//
// It is the same renderer bundle as the main window, routed here by App.tsx on the
// `#/overlay` hash — which is why the recorder and the STT error copy live in this file
// and are imported by App.tsx rather than the other way round: one implementation, and
// no import cycle between the shell and the overlay.

import { useCallback, useEffect, useRef, useState } from "react";

// ── shared with the in-app CommandBar (renderer/src/App.tsx) ─────────────────

/**
 * Maps main/stt.ts's typed error codes ("whisper_missing", "no_audio: …", …) to
 * something the user can act on. Anything unrecognised falls through verbatim.
 */
export function sttMessage(error: string, hint?: string): string {
  const code = error.split(":")[0].trim();
  const detail = error.slice(code.length + 1).trim();
  if (code === "whisper_missing")
    return "Speech-to-text needs whisper.cpp. Install with: brew install whisper-cpp";
  if (code === "model_download_failed")
    return `Couldn't download the speech model${detail ? ` (${detail})` : ""}. Check your connection and try again.`;
  if (code === "no_audio")
    return `Nothing was recorded${detail ? ` — ${detail}` : ""}. ${hint ?? ""}`.trim();
  if (code === "transcribe_failed")
    return `Transcription failed${detail ? `: ${detail}` : ""}`;
  return error;
}

/** 16kHz mono WAV recorder for whisper.cpp. Focus-independent — getUserMedia does not
 *  require the window to be active, which is what lets the HUD record unfocused. */
export function makeRecorder() {
  let ctx: AudioContext, stream: MediaStream, proc: ScriptProcessorNode;
  // `src` and `sink` are held in the closure on purpose: an unreferenced
  // MediaStreamAudioSourceNode can be collected mid-recording and capture goes silent.
  let src: MediaStreamAudioSourceNode, sink: GainNode;
  let chunks: Float32Array[] = [];
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext({ sampleRate: 16000 });
      src = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(4096, 1, 1);
      chunks = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      // A ScriptProcessorNode only runs while it reaches the destination, but routing the
      // mic straight to the speakers is a feedback loop — go through a muted gain node.
      sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    },
    stop(): Uint8Array {
      proc.onaudioprocess = null;
      src.disconnect(); proc.disconnect(); sink.disconnect();
      stream.getTracks().forEach((t) => t.stop()); ctx.close();
      const len = chunks.reduce((a, c) => a + c.length, 0);
      const pcm = new Int16Array(len);
      let o = 0;
      for (const c of chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, c[i] * 32767));
      const buf = new ArrayBuffer(44 + pcm.length * 2);
      const v = new DataView(buf);
      const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, pcm.length * 2, true);
      new Int16Array(buf, 44).set(pcm);
      return new Uint8Array(buf);
    },
  };
}

// ── the HUD itself ───────────────────────────────────────────────────────────

/** How long the outcome line stays readable before the window puts itself away. */
const RESULT_MS = 1500;
/** Errors need longer — they usually name an install step or a permission to change. */
const ERROR_MS = 4200;

type Phase =
  | { kind: "starting" }
  | { kind: "recording" }
  | { kind: "transcribing" }
  | { kind: "thinking"; text: string }
  | { kind: "done"; text: string; reply: string }
  | { kind: "error"; message: string }
  | { kind: "idle" };

/** The transparent HUD window still loads index.css, whose body paints the app's paper
 *  background and a noise overlay — both of which would fill the rounded corners with an
 *  opaque rectangle. Scoped to this window: only the overlay route mounts it. */
const TRANSPARENT_WINDOW_CSS = `
  html, body, #root { background: transparent !important; height: 100%; }
  body::before, body::after { display: none !important; }
  body { overflow: hidden; }
`;

export default function VoiceHud() {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [elapsed, setElapsed] = useState(0);

  // Refs, not state: the hotkey handler and the dismiss timer both read "what is
  // happening right now" from outside React's render cycle.
  const recRef = useRef<ReturnType<typeof makeRecorder> | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const busyRef = useRef(false); // a capture is mid-flight; ignore re-entrant toggles
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false); // StrictMode remounts the effect; only auto-start once

  const clearDismiss = () => {
    if (dismissRef.current) clearTimeout(dismissRef.current);
    dismissRef.current = null;
  };

  /** Hand the window back to main, which hides it. Reset to idle so the next press of
   *  the hotkey starts a clean capture in this same (still-mounted) window. */
  const finish = useCallback((payload: { status: "done" | "cancelled" | "error"; text?: string; reply?: string }, delay: number) => {
    clearDismiss();
    dismissRef.current = setTimeout(() => {
      dismissRef.current = null;
      setPhase({ kind: "idle" });
      setElapsed(0);
      busyRef.current = false;
      void window.pos.hud.result(payload);
    }, delay);
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    clearDismiss();
    setElapsed(0);
    setPhase({ kind: "starting" });
    const rc = makeRecorder();
    try {
      await rc.start();
      recRef.current = rc;
      setPhase({ kind: "recording" });
    } catch (e) {
      recRef.current = null;
      const denied = (e as Error)?.name === "NotAllowedError";
      setPhase({
        kind: "error",
        message: denied
          ? "Microphone blocked — allow POS in System Settings → Privacy & Security → Microphone."
          : `Couldn't open the microphone: ${(e as Error)?.message ?? "unknown error"}`,
      });
      finish({ status: "error" }, ERROR_MS);
    }
  }, [finish]);

  /** Stop, transcribe, run it through the assistant, show what happened, then hide. */
  const stopAndSend = useCallback(async () => {
    const rc = recRef.current;
    if (!rc) return;
    recRef.current = null;
    setPhase({ kind: "transcribing" });

    const wav = rc.stop();
    const r = await window.pos.stt.transcribe(wav);
    const d = r.data as { text?: string; error?: string; hint?: string } | undefined;
    const text = d?.text?.trim();
    if (!text) {
      setPhase({ kind: "error", message: sttMessage(d?.error ?? r.error ?? "transcribe_failed", d?.hint) });
      finish({ status: "error" }, ERROR_MS);
      return;
    }

    setPhase({ kind: "thinking", text });
    const c = await window.pos.assistant.command(text);
    const reply = c.ok
      ? ((c.data as { reply?: string } | undefined)?.reply ?? "Done.")
      : (c.error ?? "That didn't go through.");
    setPhase({ kind: "done", text, reply });
    finish({ status: "done", text, reply }, RESULT_MS);
  }, [finish]);

  /** Escape / click: drop the audio on the floor. Nothing reaches the assistant. */
  const cancel = useCallback(() => {
    clearDismiss();
    const rc = recRef.current;
    recRef.current = null;
    if (rc) { try { rc.stop(); } catch { /* already torn down */ } }
    busyRef.current = false;
    setPhase({ kind: "idle" });
    setElapsed(0);
    void window.pos.hud.result({ status: "cancelled" });
  }, []);

  // Recording starts the moment the window appears — the whole point is that the hotkey
  // and the microphone are one gesture, with no second confirmation to hunt for.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Each hotkey press while the window exists is a toggle: listening → stop and send;
  // anything else → begin a fresh capture. main/index.ts sends nothing on the very first
  // press, because the mount above already covers it.
  useEffect(() => {
    const off = window.pos.onVoiceCapture(() => {
      const k = phaseRef.current.kind;
      if (k === "recording") void stopAndSend();
      else if (k === "idle" || k === "error" || k === "done") void start();
      // "starting" / "transcribing" / "thinking": a press mid-handshake is almost always
      // an impatient double-tap, and cancelling there would lose audio he already spoke.
    });
    return off;
  }, [start, stopAndSend]);

  // Only fires once the HUD has focus (i.e. after he clicks it) — an unfocused window
  // receives no key events by design, which is exactly the property this feature is built
  // on. The click that gives it focus is itself a cancel, so Escape is the belt to that
  // braces: it also covers a second capture started while the HUD happens to be frontmost.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  useEffect(() => {
    if (phase.kind !== "recording") return;
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [phase.kind]);

  useEffect(() => () => clearDismiss(), []);

  const live = phase.kind === "recording" || phase.kind === "starting";
  const isError = phase.kind === "error";

  return (
    <>
      <style>{TRANSPARENT_WINDOW_CSS}</style>
      {/* A slim strip along the top stays draggable so the HUD can be nudged out of the
          way; everything below it cancels on click. */}
      <div className="drag-region absolute top-0 left-0 right-0 h-3 z-10" />
      <div
        onClick={cancel}
        title="Click or press Escape to cancel"
        className="no-drag w-full h-full flex items-center gap-3 px-4 rounded-2xl border cursor-pointer select-none"
        style={{
          borderColor: isError ? "var(--danger)" : "var(--line)",
          background: "color-mix(in srgb, white 92%, var(--pink-1))",
          boxShadow: "0 8px 28px rgba(91,70,54,0.28)",
          backdropFilter: "blur(12px)",
        }}
      >
        <span
          className={live ? "shrink-0 inline-block w-3 h-3 rounded-full animate-pulse" : "shrink-0 inline-block w-3 h-3 rounded-full"}
          style={{
            background: isError
              ? "var(--danger)"
              : live
                ? "var(--danger)"
                : "var(--accent)",
            opacity: phase.kind === "idle" ? 0.35 : 1,
            boxShadow: live ? "0 0 0 4px color-mix(in srgb, var(--danger) 20%, transparent)" : undefined,
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium" style={{ color: isError ? "var(--danger)" : "var(--ink)" }}>
              {phase.kind === "starting" && "Starting microphone…"}
              {phase.kind === "recording" && "Listening…"}
              {phase.kind === "transcribing" && "Transcribing…"}
              {phase.kind === "thinking" && "Working on it…"}
              {phase.kind === "done" && phase.reply}
              {phase.kind === "error" && "Couldn't capture that"}
              {phase.kind === "idle" && "Ready"}
            </span>
            {phase.kind === "recording" && (
              <span className="tabular-nums text-[12px] shrink-0" style={{ color: "var(--muted)" }}>
                {elapsed.toFixed(1)}s
              </span>
            )}
          </div>
          <div className="text-[11px] leading-snug line-clamp-2" style={{ color: "var(--muted)" }}>
            {phase.kind === "thinking" && `"${phase.text}"`}
            {phase.kind === "done" && `"${phase.text}"`}
            {phase.kind === "error" && phase.message}
            {(phase.kind === "recording" || phase.kind === "starting") && "Press the shortcut again to send · Esc to cancel"}
            {phase.kind === "transcribing" && "whisper.cpp, on this Mac"}
          </div>
        </div>
      </div>
    </>
  );
}
