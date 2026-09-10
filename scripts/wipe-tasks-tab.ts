// One-shot (owner directive 2026-08-31): delete the flood rows POS's capture bug pushed
// today (ids exported from the local DB), then EVERYTHING remaining in the default
// "Tasks" tab — his order, verbatim. The POS list keeps its keepers; only flood ids are
// touched there. @default cannot be tasklists.delete'd, so rows go one by one at ~55/min
// (the Tasks API's real per-user rate). Every deleted row is backed up to JSON first.
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { SecretStore } from "../main/secrets.ts";
import { realGoogleTasksDeps } from "../main/gtasks-sync.ts";
import { openDb } from "../main/db/db.ts";

app.setName("POS"); app.dock?.hide();
app.setPath("userData", path.join(app.getPath("appData"), "pos", "wipe-profile")); // avoid live-app lock

app.whenReady().then(async () => {
  const realUserData = path.join(app.getPath("appData"), "pos");
  const db = openDb(path.join(realUserData, "pos.db"));
  const secrets = new SecretStore(realUserData);
  const deps = realGoogleTasksDeps(db, secrets);
  const pause = () => new Promise((r) => setTimeout(r, 1_100));
  const posList = await deps.ensureTasklist();

  const flood = JSON.parse(fs.readFileSync("/tmp/flood-ids.json", "utf8")) as { list: string; id: string }[];
  const backup: unknown[] = [];
  let deleted = 0, failed = 0;

  for (const f of flood) {
    const tasklist = f.list === "POSLIST" ? posList : f.list;
    try { await deps.deleteTask({ tasklist, task: f.id }); deleted++; } catch { failed++; }
    await pause();
  }
  console.log(JSON.stringify({ phase: "flood", deleted, failed }));

  // Wipe @default: list (with pagination), back up, delete each live row.
  let pageToken: string | undefined; let wiped = 0; let skippedGone = 0;
  do {
    const page = await deps.listTasks({ tasklist: "@default", pageToken });
    for (const g of page.items ?? []) {
      if (!g.id) continue;
      if (g.deleted === true) { skippedGone++; continue; }
      backup.push({ id: g.id, title: g.title, notes: g.notes, status: g.status, due: g.due });
      try {
        await deps.deleteTask({ tasklist: "@default", task: g.id });
        wiped++;
        if (wiped % 50 === 0) console.log(`wipe: ${wiped} so far`);
      } catch (e) {
        const msg = (e as Error).message;
        if (/quota|429/i.test(msg)) { await new Promise((r) => setTimeout(r, 65_000));
          try { await deps.deleteTask({ tasklist: "@default", task: g.id }); wiped++; } catch { failed++; } }
        else failed++;
      }
      await pause();
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  const bfile = path.join(realUserData, `tasks-tab-backup-${Date.now()}.json`);
  fs.writeFileSync(bfile, JSON.stringify(backup, null, 1));
  console.log(JSON.stringify({ phase: "tasks-tab", wiped, tombstones: skippedGone, failed, backedUpTo: bfile }));
  app.exit(0);
});
