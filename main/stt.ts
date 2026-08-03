// Speech-to-text via whisper.cpp (local, offline). Renderer records 16kHz mono WAV;
// we shell out to whisper-cli. Model auto-downloads once (tiny.en, ~75MB).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
const CANDIDATES = ["whisper-cli", "whisper-cpp", "/opt/homebrew/bin/whisper-cli", "/opt/homebrew/bin/whisper-cpp", "/usr/local/bin/whisper-cli"];

function findBin(): Promise<string | null> {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= CANDIDATES.length) return resolve(null);
      const c = CANDIDATES[i++];
      execFile(path.isAbsolute(c) ? c : "/usr/bin/which", path.isAbsolute(c) ? ["--help"] : [c], (err, stdout) => {
        if (path.isAbsolute(c)) return err ? tryNext() : resolve(c);
        const p = stdout?.trim();
        p ? resolve(p) : tryNext();
      });
    };
    tryNext();
  });
}

async function ensureModel(dir: string): Promise<string> {
  const modelDir = path.join(dir, "models");
  const modelPath = path.join(modelDir, "ggml-tiny.en.bin");
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 10_000_000) return modelPath;
  fs.mkdirSync(modelDir, { recursive: true });
  const res = await fetch(MODEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  fs.writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
  return modelPath;
}

export async function transcribe(appDir: string, wav: Uint8Array): Promise<{ text?: string; error?: string }> {
  const bin = await findBin();
  if (!bin)
    return { error: "whisper.cpp not found — run `brew install whisper-cpp` in Terminal, then try again." };
  let model: string;
  try {
    model = await ensureModel(appDir);
  } catch (e) {
    return { error: `Couldn't download the speech model: ${(e as Error).message}` };
  }
  const tmp = path.join(os.tmpdir(), `pos-stt-${Date.now()}.wav`);
  fs.writeFileSync(tmp, Buffer.from(wav));
  return new Promise((resolve) => {
    execFile(bin, ["-m", model, "-f", tmp, "-nt", "-np"], { timeout: 60000 }, (err, stdout, stderr) => {
      fs.rmSync(tmp, { force: true });
      if (err) return resolve({ error: `transcription failed: ${stderr?.slice(0, 120) || err.message}` });
      resolve({ text: stdout.replace(/\[[^\]]*\]/g, "").trim() });
    });
  });
}
