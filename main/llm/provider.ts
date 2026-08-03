// LLM provider abstraction (§3.3) with cost metering baked in.
//
// FLAGGED DEVIATION from BUILD_SPEC: spec routes to Anthropic (Haiku/Sonnet). No
// Anthropic key exists yet, so the default live provider is Gemini (existing key).
// The tier mapping keeps spec semantics: 'fast' = Haiku-class, 'smart' = Sonnet-class.
// Adding ANTHROPIC_API_KEY in Settings flips routing to Anthropic with zero code change.

import { GoogleGenAI } from "@google/genai";
import type { Db } from "../db/db.ts";
import { recordCall, underCeiling } from "./meter.ts";
import type { SecretStore } from "../secrets.ts";

export type LlmTier = "fast" | "smart";

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmOptions {
  json?: boolean;
  system?: string;
  maxTokens?: number;
}

const MODELS: Record<"anthropic" | "gemini", Record<LlmTier, string>> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", smart: "claude-sonnet-5" },
  gemini: { fast: "gemini-2.5-flash", smart: "gemini-2.5-pro" },
};

export class LlmClient {
  constructor(private db: Db, private secrets: SecretStore) {}

  /** Which provider is live right now (Anthropic wins when a key is present). */
  provider(): "anthropic" | "gemini" | null {
    if (this.secrets.get("ANTHROPIC_API_KEY")) return "anthropic";
    if (this.secrets.get("GEMINI_API_KEY")) return "gemini";
    return null;
  }

  /**
   * Returns null (never throws) when: no key, over monthly ceiling, or API error.
   * Callers MUST degrade deterministically on null — the app never hard-fails on LLM.
   */
  async call(feature: string, tier: LlmTier, prompt: string, opts: LlmOptions = {}): Promise<LlmResult | null> {
    const provider = this.provider();
    if (!provider) return null;
    if (!underCeiling(this.db)) {
      console.warn(`llm: monthly ceiling reached; '${feature}' degrading to deterministic`);
      return null;
    }
    const model = MODELS[provider][tier];
    try {
      const res =
        provider === "anthropic"
          ? await this.callAnthropic(model, prompt, opts)
          : await this.callGemini(model, prompt, opts);
      recordCall(this.db, feature, res.model, res.inputTokens, res.outputTokens);
      return res;
    } catch (e) {
      console.warn(`llm(${feature}/${model}) failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async callGemini(model: string, prompt: string, opts: LlmOptions): Promise<LlmResult> {
    const ai = new GoogleGenAI({ apiKey: this.secrets.get("GEMINI_API_KEY")! });
    const response = await ai.models.generateContent({
      model,
      contents: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
      config: {
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
        ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
      },
    });
    const u = response.usageMetadata;
    return {
      text: response.text ?? "",
      model,
      inputTokens: u?.promptTokenCount ?? 0,
      outputTokens: u?.candidatesTokenCount ?? 0,
    };
  }

  private async callAnthropic(model: string, prompt: string, opts: LlmOptions): Promise<LlmResult> {
    // Plain fetch keeps the dependency surface small; swaps trivially for the SDK.
    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
      ...(opts.system ? { system: opts.system } : {}),
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.secrets.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as any;
    const text = (j.content ?? []).map((c: any) => c.text ?? "").join("");
    return {
      text,
      model,
      inputTokens: j.usage?.input_tokens ?? 0,
      outputTokens: j.usage?.output_tokens ?? 0,
    };
  }
}

/** Defensive JSON extraction, ported from PersonalCRM2 lib/llm.ts (battle-tested). */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  if (!(t.startsWith("{") || t.startsWith("["))) {
    const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i !== -1);
    if (starts.length === 0) throw new Error("no JSON value");
    const start = Math.min(...starts);
    const close = t[start] === "{" ? "}" : "]";
    const end = t.lastIndexOf(close);
    if (end <= start) throw new Error("no JSON value");
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}
