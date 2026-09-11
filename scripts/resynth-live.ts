// One-shot: rewrite the queued profiles NOW under the tightened prompt (live DB).
import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { synthesizeProfiles } from "../main/crm/enrich.ts";
setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 240_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const dir = path.join(app.getPath("appData"), "pos");
  const db = openDb(path.join(dir, "pos.db"));
  const llm = new LlmClient(db, new SecretStore(dir));
  const s = await synthesizeProfiles(db, llm, { budget: 90 });
  console.log(JSON.stringify(s));
  app.exit(0);
});
