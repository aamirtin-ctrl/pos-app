// LlmClient.call tier fallback: asked-for tier → the other tier → Groq, and health after.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { resetFailureCache } from "../main/llm/meter.ts";
import { LlmClient, llmHealth } from "../main/llm/provider.ts";
import type { SecretStore } from "../main/secrets.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-llm-fallback-"));
  db = openDb(path.join(dir, "pos.db"));
  resetFailureCache();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const secrets = { get: (n: string) => (n === "GEMINI_API_KEY" || n === "GROQ_API_KEY" ? "k" : null) } as unknown as SecretStore;
const QUOTA = () => new Error('got status: 429 {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');

/** Client whose Gemini answers per model: "ok" or throw quota; Groq likewise. */
function client(gemini: Record<string, "ok" | "quota">, groq: "ok" | "fail" = "fail") {
  const c = new LlmClient(db, secrets);
  const tried: string[] = [];
  (c as any).callGemini = async (model: string) => {
    tried.push(model);
    if (gemini[model] !== "ok") throw QUOTA();
    return { text: "x", model, inputTokens: 1, outputTokens: 1 };
  };
  (c as any).callGroq = async () => {
    tried.push("groq");
    if (groq !== "ok") throw new Error("groq 429");
    return { text: "g", model: "groq", inputTokens: 1, outputTokens: 1 };
  };
  return { c, tried };
}

describe("LlmClient.call fallback", () => {
  it("fast over quota → served by the smart model, and health stays ok", async () => {
    const { c, tried } = client({ "gemini-2.5-flash": "quota", "gemini-flash-latest": "ok" });
    const r = await c.call("t", "fast", "p");
    expect(r?.model).toBe("gemini-flash-latest");
    expect(tried).toEqual(["gemini-2.5-flash", "gemini-flash-latest"]);
    expect(llmHealth(db, secrets).ok).toBe(true);
  });
  it("smart over quota → served by the fast model", async () => {
    const { c, tried } = client({ "gemini-flash-latest": "quota", "gemini-2.5-flash": "ok" });
    expect((await c.call("t", "smart", "p"))?.model).toBe("gemini-2.5-flash");
    expect(tried).toEqual(["gemini-flash-latest", "gemini-2.5-flash"]);
  });
  it("both tiers spent → Groq; Groq answering counts as healthy", async () => {
    const { c, tried } = client({}, "ok");
    expect((await c.call("t", "fast", "p"))?.model).toBe("groq");
    expect(tried).toEqual(["gemini-2.5-flash", "gemini-flash-latest", "groq"]);
    expect(llmHealth(db, secrets).ok).toBe(true);
  });
  it("everything spent → null and health reports the outage (gates the capture drain)", async () => {
    const { c } = client({});
    expect(await c.call("t", "fast", "p")).toBeNull();
    expect(llmHealth(db, secrets)).toMatchObject({ ok: false, reason: "quota" });
  });
  it("a 503 overload on one model falls through to the other (flash-latest 'high demand', 2026-10-20)", async () => {
    const c = new LlmClient(db, secrets);
    (c as any).callGemini = async (m: string) => {
      if (m === "gemini-flash-latest")
        throw new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
      return { text: "x", model: m, inputTokens: 1, outputTokens: 1 };
    };
    expect((await c.call("t", "smart", "p"))?.model).toBe("gemini-2.5-flash");
  });
  it("a non-quota error surfaces — no fallback hop", async () => {
    const c = new LlmClient(db, secrets);
    const tried: string[] = [];
    (c as any).callGemini = async (m: string) => (tried.push(m), Promise.reject(new Error("400 bad request")));
    expect(await c.call("t", "fast", "p")).toBeNull();
    expect(tried).toEqual(["gemini-2.5-flash"]);
  });
});

describe("LlmClient.call deadline (2026-10-23: Reconnect stuck on 'Writing…')", () => {
  it("a provider that never answers returns null within the deadline, health untouched", async () => {
    const c = new LlmClient(db, secrets);
    const tried: string[] = [];
    (c as any).callGemini = (model: string) => { tried.push(model); return new Promise(() => {}); };
    (c as any).callGroq = () => { tried.push("groq"); return new Promise(() => {}); };
    const t0 = Date.now();
    expect(await c.call("t", "fast", "p", { deadlineMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(tried).toEqual(["gemini-2.5-flash"]);
    expect(llmHealth(db, secrets).ok).toBe(true);
  });
  it("an answer inside the deadline is still served", async () => {
    const { c } = client({ "gemini-2.5-flash": "ok" });
    expect((await c.call("t", "fast", "p", { deadlineMs: 5_000 }))?.model).toBe("gemini-2.5-flash");
  });
});
