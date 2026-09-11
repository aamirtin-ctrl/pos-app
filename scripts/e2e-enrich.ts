// Bio-track E2E (2026-09-11 audit): runEnrichment on a throwaway DB copy, budget 3.
// Proves smart→fast fallback delivers the first bios in the app's lifetime.
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { runEnrichment } from "../main/crm/enrich.ts";

setTimeout(() => { console.error("E2E TIMEOUT"); process.exit(2); }, 150_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-enrich.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const llm = new LlmClient(db, secrets);
  db.prepare("DELETE FROM setting WHERE key LIKE '%llm_last_failure%'").run();
  db.prepare("DELETE FROM enrichment_attempt WHERE attempted_at > datetime('now','-1 day')").run();

  const before = db.prepare("SELECT count(*) AS n FROM person WHERE bio IS NOT NULL AND length(bio) > 10").get();
  const e = await runEnrichment(db, llm, { synthesis: { budget: 2 }, mining: { budget: 2 } });
  const after = db.prepare("SELECT count(*) AS n FROM person WHERE bio IS NOT NULL AND length(bio) > 10").get();
  const sample = db.prepare(
    "SELECT display_name, substr(bio,1,220) AS bio FROM person WHERE updated_at > datetime('now','-5 minutes') AND bio IS NOT NULL LIMIT 3"
  ).all();
  fs.writeFileSync("/tmp/enrich-result.json", JSON.stringify({ before, e, after, sample }, null, 1));
  console.log("written");
  app.exit(0);
});
