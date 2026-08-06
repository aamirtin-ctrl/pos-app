import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BIN_CANDIDATES,
  AUGMENTED_PATH,
  MIN_AUDIO_SECONDS,
  isExecutable,
  findBinSync,
  inspectWav,
  classifyWhisperRun,
} from "../main/stt.ts";
import { sttMessage } from "../renderer/src/App.tsx";

// Build the same 16kHz mono 16-bit WAV the renderer's makeRecorder emits.
function wav(samples: number[], sampleRate = 16000): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(Int16Array.from(samples));
  return new Uint8Array(buf);
}

const speech = (seconds = 1) =>
  wav(Array.from({ length: Math.round(16000 * seconds) }, (_, i) => Math.round(Math.sin(i / 8) * 9000)));

describe("findBin", () => {
  it("picks the first candidate that exists and is executable — without running it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-stt-"));
    try {
      const missing = path.join(dir, "nope", "whisper-cli");
      const notExec = path.join(dir, "whisper-cpp");
      const real = path.join(dir, "whisper-cli");
      // A file that would blow up if anyone tried to execute it as a probe.
      fs.writeFileSync(notExec, "not a program", { mode: 0o644 });
      fs.writeFileSync(real, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      expect(findBinSync([missing, notExec, real])).toBe(real);
      // ...and a binary that exits non-zero on --help is still accepted, because we
      // never execute it (the old findBin rejected exactly this case).
      expect(isExecutable(real)).toBe(true);
      expect(isExecutable(notExec)).toBe(false);
      expect(isExecutable(missing)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no candidate exists", () => {
    expect(findBinSync(["/definitely/not/here/whisper-cli", "/nor/here/whisper-cpp"])).toBeNull();
  });

  it("covers both Homebrew prefixes for both binary names", () => {
    expect(BIN_CANDIDATES).toEqual([
      "/opt/homebrew/bin/whisper-cli",
      "/usr/local/bin/whisper-cli",
      "/opt/homebrew/bin/whisper-cpp",
      "/usr/local/bin/whisper-cpp",
    ]);
    // A Finder-launched app has no Homebrew on PATH; the `which` fallback must add it.
    expect(AUGMENTED_PATH.startsWith("/opt/homebrew/bin:/usr/local/bin:")).toBe(true);
  });
});

describe("inspectWav", () => {
  it("accepts a normal utterance", () => {
    expect(inspectWav(speech(1))).toBeNull();
  });

  it("rejects a header-only capture", () => {
    expect(inspectWav(wav([]))?.reason).toMatch(/no audio/i);
  });

  it("rejects a capture shorter than the minimum", () => {
    const tooShort = speech(MIN_AUDIO_SECONDS - 0.1);
    expect(inspectWav(tooShort)?.reason).toMatch(/only 0\.\d+s/);
  });

  it("rejects all-zero PCM — the signature of a mic that never opened", () => {
    expect(inspectWav(wav(new Array(16000).fill(0)))?.reason).toMatch(/silent/i);
  });

  it("accepts a quiet-but-real capture (a measured quiet room peaks near 46/32767)", () => {
    const quiet = wav(Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 8) * 46)));
    expect(inspectWav(quiet)).toBeNull();
  });
});

describe("classifyWhisperRun", () => {
  it("returns the transcript with timestamp brackets stripped", () => {
    const r = classifyWhisperRun(null, "[00:00.000 --> 00:02.000]  plan my day.\n", "load_backend: ok");
    expect(r.text).toBe("plan my day.");
    expect(r.error).toBeUndefined();
  });

  it("catches whisper-cli's exit-0-with-an-error-on-stderr failure", () => {
    // Verified real behaviour: a WAV it cannot decode exits 0 with empty stdout.
    const stderr =
      "read_audio_data: trying to decode with miniaudio\n" +
      "error: failed to read the frames of the audio data (Invalid argument)\n" +
      "error: failed to read audio file '/tmp/x.wav'\n";
    const r = classifyWhisperRun(null, "", stderr);
    expect(r.error).toMatch(/^transcribe_failed: /);
    expect(r.error).toContain("failed to read audio file");
  });

  it("reports empty output with no error as no_audio, with a permissions hint", () => {
    const r = classifyWhisperRun(null, "   \n", "load_backend: loaded CPU backend");
    expect(r.error).toBe("no_audio");
    expect(r.hint).toMatch(/System Settings/);
  });

  it("distinguishes a timeout kill from a plain failure", () => {
    const killed = Object.assign(new Error("timeout"), { killed: true });
    expect(classifyWhisperRun(killed, "", "")?.error).toMatch(/timed out/);
    expect(classifyWhisperRun(new Error("spawn EACCES"), "", "")?.error).toBe(
      "transcribe_failed: spawn EACCES"
    );
  });
});

describe("sttMessage", () => {
  it("tells the user how to install whisper", () => {
    expect(sttMessage("whisper_missing")).toContain("brew install whisper-cpp");
  });

  it("surfaces the permission hint for no_audio", () => {
    const m = sttMessage("no_audio: only 0.12s of audio was captured", "microphone permission may be denied");
    expect(m).toContain("0.12s");
    expect(m).toContain("microphone permission may be denied");
  });

  it("keeps the detail on transcribe_failed and model_download_failed", () => {
    expect(sttMessage("transcribe_failed: bad model")).toBe("Transcription failed: bad model");
    expect(sttMessage("model_download_failed: HTTP 503")).toContain("HTTP 503");
  });

  it("passes unknown messages through unchanged", () => {
    expect(sttMessage("something else entirely")).toBe("something else entirely");
  });
});
