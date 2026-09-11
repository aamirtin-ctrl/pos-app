// E2E probe (troubleshooting session 2026-09-11): a synthetic message runs the REAL
// pipeline — extractCommitmentsLlm → pending_verify → verifyPendingCommitments — on a
// throwaway DB copy, spending only fast-tier calls. Proves the track end to end.
import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { LlmClient } from "../main/llm/provider.ts";
import { extractCommitmentsLlm, verifyPendingCommitments } from "../main/crm/commitments.ts";

app.setName("POS"); app.dock?.hide();
// Watchdog: a hung provider call must not hang the probe.
setTimeout(() => { console.error("E2E TIMEOUT — provider call hung"); process.exit(2); }, 90_000);
app.whenReady().then(async () => {
  const db = openDb("/tmp/pos-e2e.db");
  const secrets = new SecretStore(path.join(app.getPath("appData"), "pos"));
  const llm = new LlmClient(db, secrets);

  // Clear any recorded failure so a stale cooldown can't skew the probe.
  db.prepare("DELETE FROM setting WHERE key LIKE '%llm_last_failure%'").run();

  const person = db.prepare("SELECT id FROM person WHERE display_name='Mufaddal'").get() as { id: number };
  const ins = db.prepare(
    `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary)
     VALUES (?, 'imessage', ?, datetime('now'), ?)`
  );
  const ask = Number(ins.run(person.id, "inbound", "hey can you send me the pitch deck by friday? also lol did you see the game last night, insane").lastInsertRowid);
  const yes = Number(ins.run(person.id, "outbound", "yeah for sure, I'll get it to you by friday").lastInsertRowid);
  const iid = yes;

  const ext = await extractCommitmentsLlm(db, llm, [ask, yes]);
  const pend = db.prepare(
    "SELECT id, description, direction, confidence FROM commitment WHERE source_interaction_id IN (?,?)"
  ).all(ask, yes);
  const ver = await verifyPendingCommitments(db, llm);
  const after = db.prepare(
    "SELECT id, status, description FROM commitment WHERE source_interaction_id IN (?,?)"
  ).all(ask, yes);
  require("node:fs").writeFileSync("/tmp/e2e-result.json", JSON.stringify({ ext, pend, ver, after }, null, 1));
  console.log("written /tmp/e2e-result.json");
  app.exit(0);
});
