// Wholesale reset of the POS Google Tasks list (owner ask 2026-08-19: the row-by-row purge was
// quota-throttled to ~100 deletes/hour with ~5,000 strays left — days of crawling). The POS list
// contains ONLY app-generated copies, all regenerable from the local db, so ONE tasklists.delete
// removes every stray at once. The app's next push recreates the list with the ~handful of real
// rows. The owner's own list ('@default') is never wholesale-deleted — it gets the normal
// row-by-row purge, which is small (~100 rows).
import { app } from "electron";
app.setName("POS");
import path from "node:path";
import { openDb, getSetting, setSetting } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { tasksApi, POS_TASKLIST_NAME } from "../main/gcal/sync.ts";
import { purgeOrphanedGoogleTasks } from "../main/gtasks-sync.ts";

const APPLY = process.argv.includes("apply");
const log = (s: string) => console.log(`[nuke] ${s}`);

app.setPath("userData", path.join(app.getPath("appData"), "pos"));

app.whenReady().then(async () => {
  let code = 0;
  try {
    const userData = app.getPath("userData");
    const db = openDb(path.join(userData, "pos.db"));
    const secrets = new SecretStore(userData);
    const api = tasksApi(secrets);

    // Resolve the POS list (setting first, else by name).
    let listId = getSetting(db, "pos_tasklist_id");
    if (!listId) {
      const lists = await api.tasklists.list({ maxResults: 100 });
      listId = lists.data.items?.find((l) => l.title === POS_TASKLIST_NAME)?.id ?? null;
    }
    if (listId) {
      log(`deleting entire POS list ${listId} (regenerable app copies only)`);
      if (APPLY) {
        await api.tasklists.delete({ tasklist: listId });
        // Local rows that pointed into the deleted list (gtasks_list NULL = POS list) must
        // forget their links so the next push re-creates cleanly instead of 404-churning.
        const r = db
          .prepare("UPDATE task SET gtasks_id = NULL WHERE gtasks_list IS NULL AND gtasks_id IS NOT NULL")
          .run();
        setSetting(db, "pos_tasklist_id", "");
        log(`POS list deleted; unlinked ${r.changes} local rows`);
      }
    } else {
      log("no POS list found (already gone)");
    }

    // Row-by-row clean of the owner's own list only (small). ensureTasklist inside recreates
    // an EMPTY POS list, so its scan is trivial.
    const r = await purgeOrphanedGoogleTasks(db, secrets, { apply: APPLY });
    log(`@default purge: scanned=${r.scanned} deleted=${r.deleted} kept=${r.kept}${r.error ? ` error=${r.error}` : ""}`);
    if (r.error) code = 2;
  } catch (e) {
    log(`FAILED: ${(e as Error).message}`);
    code = 1;
  }
  app.exit(code);
});
