// Rebuild the "POS" Google Tasks list instead of deleting orphans one by one.
//
// The row-by-row purge was the wrong shape for this mess: ~11k orphaned rows against a
// per-user quota of ~60 requests/minute meant DAYS of dripping, and three runs died to
// rate limits, a parallel npm rebuild, and a Dock-quit before finishing. tasklists.delete
// removes the list AND every task in it in ONE call. So: read the list (~1 call per 100
// rows), keep what is real, nuke the list, recreate it, re-insert the keepers.
//
// Kept: rows still backed by a live local task/commitment (re-linked to their new ids),
// and every unmarked row — those are the owner's own, including the old-PersonalCRM
// entries he asked to preserve. The @default "Tasks" list is never touched.
//
//   npx electron dist-main/nuke-poslist.cjs           # dry run: counts only
//   npx electron dist-main/nuke-poslist.cjs apply
import path from "node:path";
import { app } from "electron";
import { google } from "googleapis";
import { openDb, setSetting } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { oauthClient } from "../main/gcal/auth.ts";
import { ensurePosTasklist } from "../main/gcal/sync.ts";
import { taskIdFromNotes, commitmentIdFromNotes, type GoogleTaskLite } from "../main/gtasks-sync.ts";

const APPLY = process.argv[2] === "apply";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.setName("POS");
app.dock?.hide();
app.setPath("userData", path.join(app.getPath("appData"), "pos"));

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const db = openDb(path.join(userData, "pos.db"));
  const secrets = new SecretStore(userData);
  const api = google.tasks({ version: "v1", auth: oauthClient(secrets) });

  const listId = await ensurePosTasklist(db, secrets);

  // 1. Read the whole list. ~1 call per 100 rows; paced under the rate limit.
  const rows: GoogleTaskLite[] = [];
  let pageToken: string | undefined;
  do {
    const res = await api.tasks.list({
      tasklist: listId, maxResults: 100, pageToken,
      showCompleted: true, showDeleted: true, showHidden: true,
    });
    rows.push(...((res.data.items ?? []) as GoogleTaskLite[]));
    pageToken = res.data.nextPageToken ?? undefined;
    await sleep(1_100);
  } while (pageToken);

  // 2. Partition. Junk = POS's own prefix, or a marker pointing at a dead local row.
  const liveTask = db.prepare("SELECT 1 FROM task WHERE id = ?");
  const liveCommitment = db.prepare(
    "SELECT 1 FROM commitment WHERE id = ? AND status IN ('open','scheduled')"
  );
  const keep: GoogleTaskLite[] = [];
  let junk = 0;
  for (const g of rows) {
    if (g.deleted === true) continue; // tombstone — dies with the list either way
    const title = (g.title ?? "").trim();
    if (!title) continue;
    if (/^tentative:\s/i.test(title)) { junk++; continue; }
    const tId = taskIdFromNotes(g.notes);
    const cId = commitmentIdFromNotes(g.notes);
    if (tId != null) { if (liveTask.get(tId)) keep.push(g); else junk++; continue; }
    if (cId != null) { if (liveCommitment.get(cId)) keep.push(g); else junk++; continue; }
    keep.push(g); // no marker → his own row (old PersonalCRM included) → preserved
  }
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", inList: rows.length, junk, keep: keep.length }));
  if (!APPLY) { app.exit(0); return; }

  // 3. Keepers to disk FIRST — the delete below is irreversible, and a crash during the
  //    hour of re-inserts must never cost a row. The file is the recovery path.
  const backupPath = path.join(userData, `poslist-keepers-${Date.now()}.json`);
  require("node:fs").writeFileSync(backupPath, JSON.stringify(keep, null, 1));
  console.log(JSON.stringify({ keepersBackedUpTo: backupPath }));

  //    One call: the list and everything in it, gone.
  await api.tasklists.delete({ tasklist: listId });
  setSetting(db, "pos_tasklist_id", "");

  // 4. Recreate and re-insert the keepers, re-linking live local rows to new ids.
  const newListId = await ensurePosTasklist(db, secrets);
  const freshIds = new Set<string>();
  let reinserted = 0;
  for (const g of keep) {
    const res = await api.tasks.insert({
      tasklist: newListId,
      requestBody: {
        title: g.title ?? "",
        notes: g.notes ?? undefined,
        due: g.due ?? undefined,
        status: g.status ?? undefined,
        completed: g.status === "completed" ? (g.completed ?? undefined) : undefined,
      },
    });
    const newId = res.data.id ?? null;
    if (newId) {
      freshIds.add(newId);
      const tId = taskIdFromNotes(g.notes);
      if (tId != null) {
        db.prepare("UPDATE task SET gtasks_id = ?, gtasks_list = NULL WHERE id = ?").run(newId, tId);
      }
    }
    reinserted++;
    await sleep(1_100);
  }

  // 5. Local rows still pointing at ids that died with the old list: clear the link so
  //    the reconcile doesn't read "gone from Google" as "he deleted these on his phone".
  const stale = db
    .prepare("SELECT id, gtasks_id FROM task WHERE gtasks_id IS NOT NULL AND gtasks_list IS NULL")
    .all() as { id: number; gtasks_id: string }[];
  let unlinked = 0;
  for (const t of stale) {
    if (!freshIds.has(t.gtasks_id)) {
      db.prepare("UPDATE task SET gtasks_id = NULL WHERE id = ?").run(t.id);
      unlinked++;
    }
  }

  console.log(JSON.stringify({ done: true, junkRemoved: junk, reinserted, unlinked }));
  app.exit(0);
});
