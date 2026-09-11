// One-off: run the unsaved-sender name inference over EVERY current candidate at once
// (owner ask 2026-09-11), instead of the daily 8-person drip. Same code path as the
// worker — inferUnknownNames with a raised limit/budget — against the live DB.
import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { inferUnknownNames } from "../main/crm/name-infer.ts";

setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 150_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb(path.join(app.getPath("appData"), "POS", "pos.db"));
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const llm = new LlmClient(db, secrets);

  const s = await inferUnknownNames(db, llm, { limit: 40, budget: 40 });
  console.log(JSON.stringify(s));
  const named = db.prepare(
    `SELECT id, display_name FROM person WHERE name_inferred_at > datetime('now','-5 minutes') ORDER BY display_name`
  ).all();
  for (const r of named as { id: number; display_name: string }[]) console.log(`named: #${r.id} ${r.display_name}`);
  const attempts = db.prepare(
    `SELECT status, detail, COUNT(*) n FROM enrichment_attempt
     WHERE source='name-infer' AND attempted_at > datetime('now','-5 minutes') GROUP BY status, detail`
  ).all();
  console.log(JSON.stringify(attempts));
  db.close();
  app.quit();
}).catch((e) => { console.error((e as Error).stack); process.exit(1); });
