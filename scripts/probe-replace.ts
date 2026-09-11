// Replace-vs-append test (owner question 2026-09-11): a person whose existing mined
// bullet says one job, whose new conversation says they CHANGED jobs. Correct behavior:
// one updated bullet, stale line gone. Runs the real mineBios on a throwaway DB copy.
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { mineBios, composeBio } from "../main/crm/enrich.ts";

setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 120_000);
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-replace.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const llm = new LlmClient(db, secrets);
  db.prepare("DELETE FROM setting WHERE key LIKE '%llm_last_failure%'").run();
  db.prepare("DELETE FROM enrichment_attempt WHERE attempted_at > datetime('now','-2 day')").run();

  // Synthetic person with a stale professional bullet, high interaction recency.
  const pid = Number(db.prepare("INSERT INTO person (display_name, tier, bio) VALUES ('Replace Test Subject', 1, ?)")
    .run(composeBio("Old college friend.", ["Sales rep at Acme Corp", "Training for a marathon"])).lastInsertRowid);
  const ins = db.prepare("INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary) VALUES (?, 'imessage', ?, datetime('now', ?), ?)");
  ins.run(pid, "inbound", "-2 hours", "big news — I left Acme last month. I'm now head of growth at Zenith Labs, we do battery recycling");
  ins.run(pid, "outbound", "-1 hours", "congrats man thats huge");
  ins.run(pid, "inbound", "-30 minutes", "thanks! marathon training still going too, race is in october");

  const m = await mineBios(db, llm, { budget: 2 });
  const bio = (db.prepare("SELECT bio FROM person WHERE id = ?").get(pid) as { bio: string }).bio;
  fs.writeFileSync("/tmp/replace-result.json", JSON.stringify({ m, bio }, null, 1));
  console.log("written");
  app.exit(0);
});
