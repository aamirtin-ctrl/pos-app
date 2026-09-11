// LLM provider abstraction (§3.3) with cost metering baked in.
//
// FLAGGED DEVIATION from BUILD_SPEC: spec routes to Anthropic (Haiku/Sonnet). No
// Anthropic key exists yet, so the default live provider is Gemini (existing key).
// The tier mapping keeps spec semantics: 'fast' = Haiku-class, 'smart' = Sonnet-class.
// Adding ANTHROPIC_API_KEY in Settings flips routing to Anthropic with zero code change.

import { GoogleGenAI } from "@google/genai";
import type { Db } from "../db/db.ts";
import {
  recordCall,
  underCeiling,
  recordFailure,
  clearFailure,
  inQuotaCooldown,
  lastFailure,
  failureIsCurrent,
  monthSpend,
  getCeiling,
} from "./meter.ts";
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
  // 'smart' is the -latest ALIAS on purpose (2026-08-31): the pinned "gemini-2.5-pro"
  // was retired for new users and every smart-tier call — bio mining, profile synthesis,
  // the notes glean — returned 404 for WEEKS, warned only to a console nobody watches
  // (315 'llm returned null' rows in the enrichment ledger). The alias tracks whatever
  // pro-class model Google currently serves, so a model retirement can never silently
  // kill half the app again.
  gemini: { fast: "gemini-2.5-flash", smart: "gemini-pro-latest" },
};

export type LlmProvider = "anthropic" | "gemini";

/** Which provider a key set selects (Anthropic wins when a key is present). */
export function providerFor(secrets: SecretStore): LlmProvider | null {
  if (secrets.get("ANTHROPIC_API_KEY")) return "anthropic";
  if (secrets.get("GEMINI_API_KEY")) return "gemini";
  return null;
}

export class LlmClient {
  constructor(private db: Db, private secrets: SecretStore) {}

  /** Which provider is live right now (Anthropic wins when a key is present). */
  provider(): LlmProvider | null {
    return providerFor(this.secrets);
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
    // A quota refusal seconds ago answers for this call too. Without this every feature in
    // the tick pays its own doomed round-trip to be told the same thing. See QUOTA_COOLDOWN_MS.
    if (inQuotaCooldown(lastFailure(this.db), new Date(), tier)) {
      console.warn(`llm: within quota cooldown; '${feature}' degrading to deterministic`);
      return null;
    }
    const model = MODELS[provider][tier];
    try {
      const res =
        provider === "anthropic"
          ? await this.callAnthropic(model, prompt, opts)
          : await this.callGemini(model, prompt, opts);
      recordCall(this.db, feature, res.model, res.inputTokens, res.outputTokens);
      // A call that lands is the only proof the provider is healthy again.
      clearFailure(this.db);
      return res;
    } catch (e) {
      // Classified and remembered so the UI can say WHY the app went deterministic —
      // silence here is what let an exhausted quota look like a styling change.
      const f = recordFailure(this.db, e, new Date(), tier);
      console.warn(`llm(${feature}/${model}) failed [${f.code}]: ${(e as Error).message}`);
      // Smart tier starved → degrade to the fast model ONCE rather than to nothing.
      // Free-tier pro quota is a few calls a day, and every smart-tier feature (bio
      // mining, profile synthesis, notes glean) had NEVER completed because of it
      // (found 2026-09-11: zero llm_call rows ever for all three). A flash answer is
      // worse than a pro answer and far better than a feature that has not run in the
      // app's lifetime. Quota only — a malformed request would fail identically on
      // both models and deserves to surface.
      if (f.code === "quota" && tier === "smart" && !inQuotaCooldown(lastFailure(this.db), new Date(), "fast")) {
        const fastModel = MODELS[provider].fast;
        try {
          const res =
            provider === "anthropic"
              ? await this.callAnthropic(fastModel, prompt, opts)
              : await this.callGemini(fastModel, prompt, opts);
          recordCall(this.db, feature, res.model, res.inputTokens, res.outputTokens);
          console.warn(`llm(${feature}) served by ${fastModel} — smart tier over quota`);
          return res;
        } catch (e2) {
          const f2 = recordFailure(this.db, e2, new Date(), "fast");
          console.warn(`llm(${feature}/${fastModel}) fallback failed [${f2.code}]: ${(e2 as Error).message}`);
        }
      }
      return null;
    }
  }

  private async callGemini(model: string, prompt: string, opts: LlmOptions): Promise<LlmResult> {
    const ai = new GoogleGenAI({ apiKey: this.secrets.get("GEMINI_API_KEY")! });
    // One retry on 503 UNAVAILABLE ("high demand… usually temporary" — Google's words).
    // A single overload blip used to void a whole feature for the tick (2026-09-11: a
    // verify batch no-op'd this way). Deliberately NOT retrying 429s — quota belongs to
    // the cooldown/fallback machinery in call(), not a blind hammer here.
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
        config: {
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
          ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        },
      });
    } catch (e) {
      if (!/UNAVAILABLE|"code"\s*:\s*503|high demand/i.test(String((e as Error).message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 2_500));
      response = await ai.models.generateContent({
        model,
        contents: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
        config: {
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
          ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        },
      });
    }
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

// ── health ───────────────────────────────────────────────────────────────────
//
// One answer to "is the AI actually working right now?", for the settings gear ring, the
// Spend card and the planner's "named without AI" chip. Cheap enough to poll: two small
// SQLite reads plus the cached failure state.

export type LlmHealthReason = "no_key" | "quota" | "ceiling" | "error";

export interface LlmHealth {
  provider: LlmProvider | null;
  /** A key exists for some provider. */
  configured: boolean;
  /** False whenever the next call would degrade to the deterministic path. */
  ok: boolean;
  reason?: LlmHealthReason;
  /** ISO time of the failure behind a "quota"/"error" reason. */
  lastFailureAt?: string;
  /** Month-to-date spend, so the caller can render the ceiling case without a second IPC. */
  monthSpend: number;
  ceiling: number;
}

/**
 * Reasons are ordered by what the owner would have to DO about them: no key beats the
 * ceiling beats a provider-side failure, because fixing the earlier one is a precondition
 * for the later one mattering at all. A failure older than FAILURE_WINDOW_MS is treated as
 * past — the provider may well have recovered, and a stale red ring teaches people to
 * ignore rings.
 */
export function llmHealth(db: Db, secrets: SecretStore, now: Date = new Date()): LlmHealth {
  const provider = providerFor(secrets);
  const spend = monthSpend(db).total;
  const ceiling = getCeiling(db);
  const base = { provider, configured: provider !== null, monthSpend: spend, ceiling };

  if (!provider) return { ...base, ok: false, reason: "no_key" };
  if (!underCeiling(db)) return { ...base, ok: false, reason: "ceiling" };

  const failure = lastFailure(db);
  if (failureIsCurrent(failure, now)) {
    return { ...base, ok: false, reason: failure!.code, lastFailureAt: failure!.at };
  }
  return { ...base, ok: true };
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
