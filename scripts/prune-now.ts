// One-shot: tombstone + withdraw the calendar events of retired tasks, immediately.
import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { pruneRetiredTaskBlocks, drainTombstones } from "../main/gcal/sync.ts";
app.setName("POS"); app.dock?.hide();
app.whenReady().then(async () => {
  const dir = path.join(app.getPath("appData"), "pos");
  const db = openDb(path.join(dir, "pos.db"));
  const secrets = new SecretStore(dir);
  const pr = pruneRetiredTaskBlocks(db);
  const dt = await drainTombstones(db, secrets);
  console.log(JSON.stringify({ pruned: pr.pruned, eventsWithdrawn: dt.deleted }));
  app.exit(0);
});
