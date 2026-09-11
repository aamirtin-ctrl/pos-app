// Field-separation test: re-synthesize the two people whose boxes overlapped.
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { synthesizeProfiles } from "../main/crm/enrich.ts";

setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 120_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-synth2.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const real = new LlmClient(db, secrets);
  const raw: string[] = [];
  const llm = { call: async (f: string, t: any, pr: string, o: any) => { const r = await real.call(f, t, pr, o); if (r) raw.push(r.text); return r; } } as unknown as LlmClient;
  db.prepare("DELETE FROM setting WHERE key LIKE '%llm_last_failure%'").run();
  db.prepare("DELETE FROM enrichment_attempt WHERE attempted_at > datetime('now','-2 day')").run();
  // Force these two back into candidacy.
  db.prepare("UPDATE person SET profile_synthesized_at = NULL WHERE display_name IN ('Insiya Bootwala','Hasan Boot')").run();
  const s = await synthesizeProfiles(db, llm, { budget: 2 });
  const rows = db.prepare(
    "SELECT display_name, substr(bio,1,300) AS bio, substr(coalesce(relationship_summary,''),1,300) AS rel FROM person WHERE display_name IN ('Insiya Bootwala','Hasan Boot')"
  ).all();
  fs.writeFileSync("/tmp/synth2-result.json", JSON.stringify({ s, rows, rawHead: raw[0]?.slice(0, 400) }, null, 1));
  console.log("written");
  app.exit(0);
});
