import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient, extractJson } from "../main/llm/provider.ts";
setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 90_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-groq.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const llm = new LlmClient(db, secrets);
  const res = await llm.call("groq-probe", "fast",
    'Return STRICT JSON ONLY — an array: [{"n": 1, "verdict": "ok"}, {"n": 2, "verdict": "ok"}]. No prose.',
    { json: true, maxTokens: 200 });
  if (!res) { console.log("NULL — all providers refused"); app.exit(1); return; }
  let parsed: unknown = null; let note = "";
  try { parsed = extractJson(res.text); note = Array.isArray(parsed) ? `array:${(parsed as unknown[]).length}` : typeof parsed; }
  catch (e) { note = "PARSE FAIL: " + (e as Error).message.slice(0, 60); }
  console.log(JSON.stringify({ model: res.model, out: res.outputTokens, parse: note, head: res.text.slice(0, 120) }));
  app.exit(0);
});
