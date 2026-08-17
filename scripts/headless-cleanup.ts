// One-shot Google Tasks cleanup (owner report 2026-08-17: 3,298 rows in the POS list, 102 in
// Tasks, plus duplicated local tasks). Runs headless with the app's own credentials:
//
//   1. Local dedupe: open tasks sharing (title, plan_date) — the pull imported the push's
//      stray marker copies as separate local tasks. Keeps the row linked to the owner's own
//      Google row (no pos: marker) when that is determinable, else the oldest; deletes the rest.
//   2. purgeOrphanedGoogleTasks({apply}) with the duplicate-aware rules: dead markers,
//      Tentative: rows, and non-canonical copies of live items all go; owner rows never do.
//
// Usage:  electron dist-main/headless-cleanup.cjs [apply]     (no arg = dry run)
// Paced at ~1 delete/1.1s with quota backoff — thousands of rows take an hour+. Run it in the
// background and watch the log.
import { app } from "electron";
app.setName("POS");
import path from "node:path";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { purgeOrphanedGoogleTasks, realGoogleTasksDeps } from "../main/gtasks-sync.ts";

const APPLY = process.argv.includes("apply");
const log = (s: string) => console.log(`[cleanup] ${s}`);

app.setPath("userData", path.join(app.getPath("appData"), "pos"));

app.whenReady().then(async () => {
  let code = 0;
  try {
    const userData = app.getPath("userData");
    const db = openDb(path.join(userData, "pos.db"));
    const secrets = new SecretStore(userData);
    const deps = realGoogleTasksDeps(db, secrets);

    // Map every Google row id → notes, across both lists (also warms nothing — reads only).
    const posList = await deps.ensureTasklist();
    const notesById = new Map<string, string>();
    for (const tasklist of [posList, "@default"]) {
      let pageToken: string | undefined;
      do {
        const page = await deps.listTasks({ tasklist, pageToken });
        for (const g of page.items ?? []) if (g.id) notesById.set(g.id, g.notes ?? "");
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken);
    }
    log(`indexed ${notesById.size} Google rows`);

    // ── 1. local dedupe ──
    const dupes = db
      .prepare(
        `SELECT title, coalesce(plan_date,'') AS pd FROM task
          WHERE status IN ('inbox','planned','in_progress') AND recurrence_parent_id IS NULL
          GROUP BY title, pd HAVING count(*) > 1`
      )
      .all() as { title: string; pd: string }[];
    for (const d of dupes) {
      const rows = db
        .prepare(
          `SELECT id, gtasks_id, gtasks_list FROM task
            WHERE title = ? AND coalesce(plan_date,'') = ? AND status IN ('inbox','planned','in_progress')
              AND recurrence_parent_id IS NULL ORDER BY id`
        )
        .all(d.title, d.pd) as { id: number; gtasks_id: string | null; gtasks_list: string | null }[];

      // Prefer keeping the row whose Google copy the OWNER created (no pos: marker).
      let keep = rows[0].id;
      for (const r of rows) {
        const notes = r.gtasks_id ? notesById.get(r.gtasks_id) : undefined;
        if (notes !== undefined && !/pos:(task|commitment):\d+/.test(notes)) {
          keep = r.id; // linked to a row the owner typed himself — that one survives
          break;
        }
      }
      for (const r of rows) {
        if (r.id === keep) continue;
        log(`local dupe: deleting task ${r.id} "${d.title}" (keeping ${keep})`);
        if (APPLY) db.prepare("DELETE FROM task WHERE id = ?").run(r.id);
      }
    }

    // ── 2. Google-side purge ──
    log(`purge starting (${APPLY ? "APPLY" : "dry run"})…`);
    const r = await purgeOrphanedGoogleTasks(db, secrets, { apply: APPLY });
    log(`purge: scanned=${r.scanned} deleted=${r.deleted} kept=${r.kept}${r.error ? ` error=${r.error}` : ""}`);
    if (r.samples.length) log(`samples: ${r.samples.slice(0, 8).join(" | ")}`);
    if (r.error) code = 2;
  } catch (e) {
    log(`FAILED: ${(e as Error).message}`);
    code = 1;
  }
  app.exit(code);
});
