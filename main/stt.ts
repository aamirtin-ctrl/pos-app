// Speech-to-text via whisper.cpp (local, offline). Renderer records 16kHz mono WAV;
// we shell out to whisper-cli. Model auto-downloads once (tiny.en, ~75MB).
//
// Two rules learned the hard way:
//   1. A GUI app launched from Finder does NOT inherit the login shell's PATH, so
//      `which whisper-cli` finds nothing even when Homebrew has it. Resolve absolute
//      candidates with fs stat/access checks — never by executing the binary (spawning
//      whisper just to probe costs ~200ms of Metal/BLAS backend loading, and a CLI that
//      exits non-zero on `--help` would be wrongly rejected).
//   2. whisper-cli exits 0 even when it fails to read the audio file ("error: failed to
//      read audio file ..." on stderr, empty stdout). Exit status alone cannot be
//      trusted; stdout emptiness + stderr must be inspected.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";

/** Absolute locations Homebrew (arm64 + intel) installs whisper.cpp to. */
export const BIN_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cpp",
  "/usr/local/bin/whisper-cpp",
];

/** PATH to hand `which`, since a Finder-launched app's PATH is just /usr/bin:/bin:… */
export const AUGMENTED_PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

/** Typed failure codes. `transcribe_failed` carries a `: <detail>` suffix. */
export type SttErrorCode =
  | "whisper_missing"
  | "model_download_failed"
  | "no_audio"
  | "transcribe_failed";

export type SttResult = { text?: string; error?: string; hint?: string };

/** Minimum captured audio we consider a real utterance. Shorter is a mis-click. */
export const MIN_AUDIO_SECONDS = 0.3;

const NO_AUDIO_HINT =
  "microphone permission may be denied — check System Settings → Privacy & Security → Microphone";

// ── binary discovery ──────────────────────────────────────────────────────────

/** True when `p` exists and is executable. Never runs the file. */
export function isExecutable(p: string, fsImpl: typeof fs = fs): boolean {
  try {
    if (!fsImpl.existsSync(p)) return false;
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the whisper binary from absolute candidates (stat-only), falling back to
 * `which` with an augmented PATH. Pure w.r.t. its injected deps so tests can drive it.
 */
export function findBinSync(
  candidates: string[] = BIN_CANDIDATES,
  fsImpl: typeof fs = fs
): string | null {
  for (const c of candidates) if (isExecutable(c, fsImpl)) return c;
  return null;
}

let cachedBin: string | null | undefined;

/** Cached resolution. Absolute candidates first, then `which` with an augmented PATH. */
export function findBin(): Promise<string | null> {
  if (cachedBin !== undefined) return Promise.resolve(cachedBin);
  const direct = findBinSync();
  if (direct) {
    cachedBin = direct;
    return Promise.resolve(direct);
  }
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/which",
      ["whisper-cli", "whisper-cpp"],
      { env: { ...process.env, PATH: AUGMENTED_PATH } },
      (_err, stdout) => {
        const hit = (stdout ?? "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && isExecutable(l));
        cachedBin = hit ?? null;
        resolve(cachedBin);
      }
    );
  });
}

/** Test seam — drop the memoised binary path. */
export function resetBinCache(): void {
  cachedBin = undefined;
}

// ── audio validation ──────────────────────────────────────────────────────────

/**
 * Inspect a 16-bit PCM WAV produced by the renderer. Returns null when the buffer is
 * usable, or a reason when there is effectively nothing to transcribe — an empty
 * capture, a sub-{@link MIN_AUDIO_SECONDS} blip, or pure digital silence (which is what
 * a denied-but-not-rejected microphone yields).
 */
export function inspectWav(wav: Uint8Array): { reason: string } | null {
  if (wav.length <= 44) return { reason: "no audio was captured" };
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sampleRate = view.getUint32(24, true) || 16000;
  const dataBytes = Math.min(view.getUint32(40, true), wav.length - 44);
  const sampleCount = Math.floor(dataBytes / 2);
  const seconds = sampleCount / sampleRate;
  if (seconds < MIN_AUDIO_SECONDS)
    return { reason: `only ${seconds.toFixed(2)}s of audio was captured` };
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = Math.abs(view.getInt16(44 + i * 2, true));
    if (s > peak) peak = s;
  }
  // Digital silence only. A measured quiet room already peaks around 46/32767, so
  // anything near that is a real (if quiet) capture; only a mic that never opened —
  // or one muted in hardware — comes back this flat.
  if (peak < 8) return { reason: "the captured audio was silent" };
  return null;
}

// ── model ─────────────────────────────────────────────────────────────────────

async function ensureModel(dir: string): Promise<string> {
  const modelDir = path.join(dir, "models");
  const modelPath = path.join(modelDir, "ggml-tiny.en.bin");
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 10_000_000) return modelPath;
  fs.mkdirSync(modelDir, { recursive: true });
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
  return modelPath;
}

// ── output classification ─────────────────────────────────────────────────────

/**
 * Turn a whisper-cli run into a result. whisper-cli exits 0 on audio-read failures, so
 * an empty stdout paired with an `error:` line on stderr is the only way to see them.
 */
export function classifyWhisperRun(
  err: (Error & { killed?: boolean }) | null,
  stdout: string,
  stderr: string
): SttResult {
  const text = (stdout ?? "").replace(/\[[^\]]*\]/g, "").trim();
  const errLine =
    (stderr ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(error|whisper_\w+: (failed|error))/i.test(l))
      .pop() ?? "";
  if (err) {
    if (err.killed) return { error: "transcribe_failed: whisper timed out after 60s" };
    return { error: `transcribe_failed: ${errLine || err.message}` };
  }
  if (text) return { text };
  if (errLine) return { error: `transcribe_failed: ${errLine}` };
  return { error: "no_audio", hint: NO_AUDIO_HINT };
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function transcribe(appDir: string, wav: Uint8Array): Promise<SttResult> {
  const bad = inspectWav(wav);
  if (bad) return { error: `no_audio: ${bad.reason}`, hint: NO_AUDIO_HINT };

  const bin = await findBin();
  if (!bin) return { error: "whisper_missing" };

  let model: string;
  try {
    model = await ensureModel(appDir);
  } catch (e) {
    return { error: `model_download_failed: ${(e as Error).message}` };
  }

  const tmp = path.join(os.tmpdir(), `pos-stt-${Date.now()}.wav`);
  fs.writeFileSync(tmp, Buffer.from(wav));
  return new Promise((resolve) => {
    // Verified against whisper-cli (whisper.cpp / ggml 0.18): -m model -f file -nt -np.
    // Backend chatter goes to stderr; the transcript is the whole of stdout.
    execFile(bin, ["-m", model, "-f", tmp, "-nt", "-np"], { timeout: 60_000 }, (err, out, errOut) => {
      fs.rmSync(tmp, { force: true });
      resolve(classifyWhisperRun(err as (Error & { killed?: boolean }) | null, out, errOut));
    });
  });
}
