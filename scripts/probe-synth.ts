import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient, extractJson } from "../main/llm/provider.ts";
import { synthesizeProfiles } from "../main/crm/enrich.ts";

setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 120_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-enrich.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const raw: string[] = [];
  const real = new LlmClient(db, secrets);
  const spy = {
    call: async (f: string, t: any, p: string, o: any) => {
      const r = await real.call(f, t, p, o);
      if (r) raw.push(r.text);
      return r;
    },
  } as unknown as LlmClient;
  db.prepare("DELETE FROM setting WHERE key LIKE '%llm_last_failure%'").run();
  db.prepare("DELETE FROM enrichment_attempt WHERE attempted_at > datetime('now','-1 day')").run();
  const s = await synthesizeProfiles(db, spy, { budget: 2 });
  let parseNote = "no raw";
  if (raw.length) {
    try { const j = extractJson(raw[0]); parseNote = "extractJson OK, type=" + (Array.isArray(j) ? "array:" + j.length : typeof j); }
    catch (e) { parseNote = "extractJson THREW: " + (e as Error).message.slice(0, 80); }
  }
  fs.writeFileSync("/tmp/synth-raw.json", JSON.stringify({ s, parseNote, rawHead: raw[0]?.slice(0, 600), rawTail: raw[0]?.slice(-200) }, null, 1));
  console.log("written");
  app.exit(0);
});
