// Google Tasks ⇄ POS reconciliation — the PULL half of the phone sync.
//
// gcal/sync.ts only ever PUSHED (local task/commitment → the "POS" Google Tasks list),
// so anything the owner did on the phone was invisible here: "I deleted some tasks from
// Google Tasks but they still show in the app. It should work vice versa as well."
// This module adds the missing direction and then runs the existing push, in that order.
//
// Ordering matters: pull FIRST, push second. A task the owner deleted in Google must be
// closed locally before pushTasks runs, otherwise the same run would re-create it and the
// deletion would look like it never happened.
//
// Reconciliation matrix (Google is the most recent statement of intent; local rows are
// never hard-deleted — POS keeps history and the planner/worklog read it):
//
//   Google state                          Local task                       Commitment
//   ────────────────────────────────────  ───────────────────────────────  ─────────────────
//   deleted:true, or id gone from list    status='deferred', gtasks_id=NULL  back to 'open'
//   status='completed'                    status='done', completed_at        'done' + resolved_at
//   title / due changed                   title / hard_deadline_at updated   —
//   exists, no local counterpart          INSERT status='inbox'              —
//   commitment marker task, completed     —                                  'done' + resolved_at
//   commitment marker task, deleted       —                                  'dropped' + resolved_at
//
// The two marker rows exist because pushTasks writes confirmed commitments straight to
// Google with a `pos:commitment:<id>` note and no local task row. Without them a
// commitment ticked off (or binned) on the phone stays 'open' here and the very next
// pushTasks re-creates it — the owner's complaint, in its second form.
//
// No migration: every write below uses columns that already exist.

import { google, type tasks_v1 } from "googleapis";
import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { isGoogleConnected, oauthClient } from "./gcal/auth.ts";
import { ensurePosTasklist, pushTasks, DEFAULT_TASKLIST_ID } from "./gcal/sync.ts";

/** Whole reconciliation is time-boxed — it runs on a cron and must never wedge. */
export const RECONCILE_TIMEOUT_MS = 60_000;

/** Local statuses that are still "live" and therefore worth reconciling against Google. */
const LIVE_STATUSES = ["inbox", "planned", "in_progress"] as const;

/** The note pushTasks stamps on a commitment it pushed with no local task row. */
export const COMMITMENT_MARKER_PREFIX = "pos:commitment:";

/** The note pushTasks stamps on every task it pushes — the push's idempotency key. */
export const TASK_MARKER_PREFIX = "pos:task:";

/** Only the Google Task fields this module reads (keeps the fake API in tests honest). */
export interface GoogleTaskLite {
  id?: string | null;
  title?: string | null;
  notes?: string | null;
  /** "needsAction" | "completed" */
  status?: string | null;
  /** RFC 3339; Google stores date-only semantics at UTC midnight. */
  due?: string | null;
  completed?: string | null;
  deleted?: boolean | null;
  hidden?: boolean | null;
  /** RFC 3339 last-modified stamp Google maintains. The remote half of the conflict clock. */
  updated?: string | null;
}

export interface GoogleTasksPage {
  items: GoogleTaskLite[];
  nextPageToken?: string | null;
}

/**
 * Injectable Google surface. Every member defaults to the real googleapis call
 * (see realGoogleTasksDeps); tests pass fakes so nothing touches the network.
 *
 * `patchTask` / `insertTask` are the WRITE seam. The pull pass deliberately performs no
 * Google writes — the push pass owns that — so tests assert these are never called.
 */
export interface GoogleTasksDeps {
  isConnected(secrets: SecretStore): boolean;
  ensureTasklist(): Promise<string>;
  listTasks(args: { tasklist: string; pageToken?: string }): Promise<GoogleTasksPage>;
  patchTask(args: { tasklist: string; task: string; body: Partial<GoogleTaskLite> }): Promise<void>;
  insertTask(args: { tasklist: string; body: Partial<GoogleTaskLite> }): Promise<GoogleTaskLite>;
  /** Hard-delete one row. Only purgeOrphanedGoogleTasks uses this; the sync never deletes. */
  deleteTask(args: { tasklist: string; task: string }): Promise<void>;
  /** Local → Google. Defaults to gcal/sync.pushTasks; never reimplemented here. */
  pushTasks(): Promise<{ pushed: number; completed: number }>;
  now(): Date;
  timeoutMs: number;
}

export interface ReconcileResult {
  /** Google-side edits and Google-only tasks adopted into POS. */
  pulled: number;
  /** Local tasks/commitments closed because Google says they are done. */
  completedLocally: number;
  /** Local tasks/commitments retired because Google says they are gone. */
  deletedLocally: number;
  /** From the push pass (gcal/sync.pushTasks). */
  pushed: number;
  /** Set instead of throwing: "not_connected", a timeout, or a Google/DB failure. */
  error?: string;
}

function tasksApi(secrets: SecretStore): tasks_v1.Tasks {
  return google.tasks({ version: "v1", auth: oauthClient(secrets) });
}

/** The production Google surface. */
export function realGoogleTasksDeps(db: Db, secrets: SecretStore): GoogleTasksDeps {
  return {
    isConnected: isGoogleConnected,
    ensureTasklist: () => ensurePosTasklist(db, secrets),
    async listTasks({ tasklist, pageToken }) {
      const res = await tasksApi(secrets).tasks.list({
        tasklist,
        maxResults: 100,
        pageToken,
        // The whole point: a task the owner deleted or completed on the phone must come
        // back in this listing, otherwise the pull direction cannot see it happen.
        showCompleted: true,
        showDeleted: true,
        showHidden: true,
      });
      return { items: (res.data.items ?? []) as GoogleTaskLite[], nextPageToken: res.data.nextPageToken };
    },
    async patchTask({ tasklist, task, body }) {
      await tasksApi(secrets).tasks.patch({ tasklist, task, requestBody: body });
    },
    async deleteTask({ tasklist, task }) {
      await tasksApi(secrets).tasks.delete({ tasklist, task });
    },
    async insertTask({ tasklist, body }) {
      const res = await tasksApi(secrets).tasks.insert({ tasklist, requestBody: body });
      return res.data as GoogleTaskLite;
    },
    pushTasks: () => pushTasks(db, secrets),
    now: () => new Date(),
    timeoutMs: RECONCILE_TIMEOUT_MS,
  };
}

// ── small pure helpers ───────────────────────────────────────────────────────

/**
 * Google's `due` is RFC 3339 at UTC midnight but means a DATE. Comparing or storing the
 * timestamp would drift a day either side of the owner's timezone, so both sides of every
 * comparison are reduced to "YYYY-MM-DD".
 */
export function dueDateOf(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/**
 * The due date Google would be holding for a local deadline, i.e. exactly what pushTasks
 * sent (`new Date(hard_deadline_at).toISOString()`). East of UTC a local midnight lands on
 * the previous UTC day, so without this the pull pass would read our own push as "the
 * owner moved the due date" and walk the deadline backwards one day per run.
 */
export function pushedDueDateOf(hardDeadlineAt: string | null | undefined): string | null {
  if (!hardDeadlineAt) return null;
  const d = new Date(hardDeadlineAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** SQLite datetime('now') shape ("YYYY-MM-DD HH:MM:SS", UTC) so worklog/notion queries work. */
export function sqliteUtc(value: string | null | undefined, fallback: Date): string {
  const d = value ? new Date(value) : fallback;
  const ok = Number.isNaN(d.getTime()) ? fallback : d;
  return ok.toISOString().slice(0, 19).replace("T", " ");
}

/** Commitment id carried by a pushed marker task, or null for a normal task. */
export function commitmentIdFromNotes(notes: string | null | undefined): number | null {
  const m = new RegExp(`${COMMITMENT_MARKER_PREFIX}(\\d+)`).exec(notes ?? "");
  return m ? Number(m[1]) : null;
}

/** The local task id a pushed Google task carries in its notes (TASK_MARKER_PREFIX). */
export function taskIdFromNotes(notes: string | null | undefined): number | null {
  const m = new RegExp(`${TASK_MARKER_PREFIX}(\\d+)`).exec(notes ?? "");
  return m ? Number(m[1]) : null;
}

/** Reject-after-timeout. Does not cancel `p`; the partial result object is already valid. */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── the reconciliation ───────────────────────────────────────────────────────

interface LocalTaskRow {
  id: number;
  title: string;
  hard_deadline_at: string | null;
  plan_date: string | null;
  commitment_id: number | null;
  gtasks_id: string;
  /** Local half of the conflict clock (migration 11). NULL = never edited here. */
  updated_at: string | null;
}

/**
 * Should Google's version of a field replace ours?
 *
 * Only when Google's edit is genuinely newer. A local task with no `updated_at` has not been
 * touched here since the column existed, so Google wins by default — which keeps every
 * pre-migration task behaving exactly as before. An unparseable stamp on either side is
 * treated the same way: fall back to the old "remote wins" rule rather than silently
 * dropping the owner's phone edit.
 */
export function remoteIsNewer(remoteUpdated: string | null | undefined, localUpdated: string | null): boolean {
  if (!localUpdated) return true;
  const local = Date.parse(localUpdated);
  if (Number.isNaN(local)) return true;
  const remote = Date.parse(remoteUpdated ?? "");
  if (Number.isNaN(remote)) return false; // no remote clock, but we know ours changed
  return remote > local;
}

/**
 * Bidirectional Google Tasks sync: pull Google's state into POS, then push POS's state
 * back up. Single entry point — safe to call from a cron.
 *
 * Never throws: a timeout, a Google failure or a half-finished pass is reported in
 * `error` alongside whatever counts were already committed to the DB.
 */
export async function reconcileGoogleTasks(
  db: Db,
  secrets: SecretStore,
  overrides: Partial<GoogleTasksDeps> = {}
): Promise<ReconcileResult> {
  const deps: GoogleTasksDeps = { ...realGoogleTasksDeps(db, secrets), ...overrides };
  const result: ReconcileResult = { pulled: 0, completedLocally: 0, deletedLocally: 0, pushed: 0 };
  if (!deps.isConnected(secrets)) return { ...result, error: "not_connected" };
  try {
    await withDeadline(runReconcile(db, deps, result), deps.timeoutMs, "google tasks reconcile timed out");
  } catch (e) {
    // Partial progress stands: every local write below is committed as it happens.
    result.error = (e as Error).message;
  }
  return result;
}

/** The lists one reconcile reads: POS's own, plus the phone's default "My Tasks". */
export const DEFAULT_TASKLIST = "@default";

async function runReconcile(db: Db, deps: GoogleTasksDeps, result: ReconcileResult): Promise<void> {
  const posList = await deps.ensureTasklist();

  // Owner report 2026-08-07: "in my google tasks i added from much earlier i need to do my
  // physics diagnostic today. yet its not scheduling for that." He types tasks into the
  // normal Google Tasks app, which lands them in '@default' — a list this reconcile never
  // read, so they simply did not exist here. Both lists are read now; each imported row
  // remembers which list it came from (task.gtasks_list, NULL = POS list) so every write
  // back goes to the right one.
  //
  // Read EVERY page of BOTH lists before touching the database. A listing that fails
  // halfway would otherwise look like "the owner deleted the rest of his tasks" and defer
  // them all. Deduped by id: '@default' aliases a real list id, so a fake or a quirk that
  // serves the same rows twice must not import twice.
  const remote: GoogleTaskLite[] = [];
  const seen = new Set<string>();
  const listOf = new Map<string, string | null>(); // gtasks id → '@default' | null (POS list)
  for (const [tasklist, tag] of [[posList, null], [DEFAULT_TASKLIST, DEFAULT_TASKLIST]] as const) {
    let pageToken: string | undefined;
    do {
      const page = await deps.listTasks({ tasklist, pageToken });
      for (const item of page.items ?? []) {
        if (item.id && seen.has(item.id)) continue;
        if (item.id) {
          seen.add(item.id);
          listOf.set(item.id, tag);
        }
        remote.push(item);
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  }

  pullFromGoogle(db, deps, remote, listOf, result);

  // Push only after a clean pull — pushing on a failed pull would resurrect deletions.
  const pushed = await deps.pushTasks();
  result.pushed = pushed.pushed;
}

function pullFromGoogle(
  db: Db,
  deps: GoogleTasksDeps,
  remote: readonly GoogleTaskLite[],
  listOf: ReadonlyMap<string, string | null>,
  result: ReconcileResult
): void {
  const now = deps.now();
  const byId = new Map<string, GoogleTaskLite>();
  for (const g of remote) if (g.id) byId.set(g.id, g);

  // Captured BEFORE any write: deferring a task clears its gtasks_id, and an id that was
  // linked a moment ago must not then look like a brand-new Google-only task.
  const linkedIds = new Set(
    (db.prepare("SELECT gtasks_id FROM task WHERE gtasks_id IS NOT NULL").all() as { gtasks_id: string }[])
      .map((r) => r.gtasks_id)
  );

  const locals = db
    .prepare(
      `SELECT id, title, hard_deadline_at, plan_date, commitment_id, gtasks_id, updated_at
         FROM task
        WHERE gtasks_id IS NOT NULL AND status IN (${LIVE_STATUSES.map(() => "?").join(",")})`
    )
    .all(...LIVE_STATUSES) as LocalTaskRow[];

  for (const t of locals) {
    const g = byId.get(t.gtasks_id);

    // ── gone in Google ──────────────────────────────────────────────────────
    if (!g || g.deleted === true) {
      db.prepare("UPDATE task SET status = 'deferred', gtasks_id = NULL WHERE id = ?").run(t.id);
      if (t.commitment_id != null) {
        // Back to the review queue rather than silently vanishing: the obligation to a
        // person outlives the checkbox the owner binned on his phone.
        db.prepare(
          "UPDATE commitment SET status = 'open', resolved_at = NULL WHERE id = ? AND status IN ('open','scheduled')"
        ).run(t.commitment_id);
      }
      result.deletedLocally++;
      continue;
    }

    // ── completed in Google ─────────────────────────────────────────────────
    if (g.status === "completed") {
      const at = sqliteUtc(g.completed, now);
      db.prepare("UPDATE task SET status = 'done', completed_at = ? WHERE id = ?").run(at, t.id);
      // Snapshot the calendar event here too — a completion pulled FROM Google is just as
      // real as one checked off in the app, and must be just as protected. See migration 14.
      db.prepare(
        `UPDATE task SET gcal_event_id = COALESCE(gcal_event_id, (
           SELECT b.gcal_event_id FROM block b WHERE b.task_id = task.id AND b.gcal_event_id IS NOT NULL
            ORDER BY b.id DESC LIMIT 1
         )) WHERE id = ?`
      ).run(t.id);
      if (t.commitment_id != null) closeCommitment(db, t.commitment_id, at);
      result.completedLocally++;
      continue;
    }

    // ── edited in Google ────────────────────────────────────────────────────
    //
    // Google wins only when Google is NEWER. The rule used to be "Google always wins", which
    // made a local edit impossible to keep: reconcile runs before the push on every tick, so
    // a rename here was reverted from the remote before it had ever been sent there. Caught
    // when a task renamed locally silently reverted to the raw transcript fragment Google
    // still held (owner-visible, 2026-08-06).
    const remoteWins = remoteIsNewer(g.updated, t.updated_at);
    const gTitle = (g.title ?? "").trim();
    const gDue = dueDateOf(g.due);
    const localDue = dueDateOf(t.hard_deadline_at);
    let changed = false;
    if (remoteWins && gTitle && gTitle !== t.title) {
      db.prepare("UPDATE task SET title = ? WHERE id = ?").run(gTitle, t.id);
      changed = true;
    }
    // The push derives `due` from plan_date when there is no clock deadline (2026-08-06 fix),
    // so OUR OWN date coming back must not read as an edit. Missing this turned every pushed
    // task's plan_date into a MIDNIGHT hard deadline on the next pull — already in the past
    // by morning, so the solver refused to place any of them ("deadline_conflict", owner-
    // visible 2026-08-07: physics diagnostic, film/edit and three others all unplaced into
    // a wide-open day).
    const pushedFromPlanDate = t.plan_date && !t.hard_deadline_at ? t.plan_date : null;
    if (
      remoteWins &&
      gDue !== localDue &&
      gDue !== pushedDueDateOf(t.hard_deadline_at) &&
      // guard only when there IS an echo to guard against — `null !== null` must not
      // block the legitimate "owner removed the due date" clear below
      (pushedFromPlanDate === null || gDue !== pushedFromPlanDate)
    ) {
      // Google's due is DATE-only (its API discards the time part) — it names the DAY the
      // task belongs on, never a clock time. Moving a date on the phone moves plan_date; it
      // must not fabricate a midnight deadline.
      if (gDue) {
        db.prepare("UPDATE task SET plan_date = ? WHERE id = ?").run(gDue, t.id);
        if (t.hard_deadline_at) {
          // A real clock deadline follows its task to the new day, keeping its time.
          const time = t.hard_deadline_at.slice(10) || "T23:59:00";
          db.prepare("UPDATE task SET hard_deadline_at = ? WHERE id = ?").run(`${gDue}${time}`, t.id);
        }
      } else {
        db.prepare("UPDATE task SET hard_deadline_at = NULL WHERE id = ?").run(t.id);
      }
      changed = true;
    }
    if (changed) result.pulled++;
  }

  // ── Google-side rows with no local counterpart ─────────────────────────────
  for (const g of remote) {
    if (!g.id || linkedIds.has(g.id)) continue;

    const commitmentId = commitmentIdFromNotes(g.notes);
    if (commitmentId != null) {
      // A pushed commitment, ticked off or binned on the phone. Left alone it stays
      // 'open' here and pushTasks re-creates it on this very run.
      if (g.deleted === true) {
        const r = db
          .prepare(
            "UPDATE commitment SET status = 'dropped', resolved_at = ? WHERE id = ? AND status IN ('open','scheduled')"
          )
          .run(sqliteUtc(null, now), commitmentId);
        if (r.changes > 0) result.deletedLocally++;
      } else if (g.status === "completed") {
        if (closeCommitment(db, commitmentId, sqliteUtc(g.completed, now))) result.completedLocally++;
      }
      continue;
    }

    // A pos:task marker means POS itself pushed this row. An unlinked one is a stray
    // from a crash between Google's insert and the local gtasks_id write (2026-08-07:
    // "Call family" came back three times this way). Relink it to its task when that
    // task lost its id; otherwise it is a duplicate of a row we already track — never
    // an import either way.
    const pushedTaskId = taskIdFromNotes(g.notes);
    if (pushedTaskId != null) {
      const local = db
        .prepare("SELECT id, gtasks_id FROM task WHERE id = ?")
        .get(pushedTaskId) as { id: number; gtasks_id: string | null } | undefined;
      if (local && local.gtasks_id == null && g.deleted !== true) {
        db.prepare("UPDATE task SET gtasks_id = ?, gtasks_list = ? WHERE id = ?")
          .run(g.id, listOf.get(g.id) ?? null, local.id);
        result.pulled++;
      }
      continue;
    }

    // Created by the owner directly in Google Tasks (phone). Deleted or already-done
    // rows are history, not inbox items.
    if (g.deleted === true || g.status === "completed") continue;
    const title = (g.title ?? "").trim();
    if (!title) continue; // Google keeps empty draft rows; they are not tasks yet
    // POS's own tentative pushes carry this prefix. Until 2026-08-10 they went out with
    // NO pos:task marker, so neither check above can recognize them, and they arrived
    // here looking exactly like something the owner typed on his phone — which is how a
    // single commitment became 31 Google rows and 220 local "Tentative: …" duplicates,
    // one per sync. The marker is now written at the source, but the unmarked rows are
    // already in his account, so importing this prefix stays refused: he never types it.
    if (/^tentative:\s/i.test(title)) continue;
    const due = dueDateOf(g.due);
    // due is DATE-only in Google Tasks: it names the day (plan_date), never a clock time.
    // Writing `${due}T00:00:00` here used to hand the solver a deadline that was already
    // in the past the moment the day started.
    db.prepare(
      `INSERT INTO task (title, notes, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                         status, plan_date, estimate_source, gtasks_id, gtasks_list)
       VALUES (?, ?, 'admin', 2, 30, 30, 'inbox', ?, 'inferred', ?, ?)`
    ).run(title.slice(0, 200), g.notes ?? null, due, g.id, listOf.get(g.id) ?? null);
    result.pulled++;
  }
}

/**
 * The pass rollover.ts always believed in ("their Google rows are taken down by the push's
 * dropped-cleanup pass") but which never existed — found 2026-08-31 when weeks of missed
 * gym/Instagram instances turned out to be piling up in the owner's Tasks tab. When
 * rollover drops a missed habit instance locally, its Google row must go too, or the tab
 * violates the whole spec: today's three habits and nothing more. Small daily volume, so
 * unpaced; gtasks_id is nulled even when the remote delete fails (tombstoned/gone rows
 * 404 here and are already what we want).
 */
export async function cleanupDroppedTaskRows(
  db: Db,
  secrets: SecretStore,
  deps: GoogleTasksDeps = realGoogleTasksDeps(db, secrets)
): Promise<{ removed: number }> {
  if (!deps.isConnected(secrets)) return { removed: 0 };
  const rows = db.prepare(
    "SELECT id, gtasks_id, gtasks_list FROM task WHERE status = 'dropped' AND gtasks_id IS NOT NULL LIMIT 40"
  ).all() as { id: number; gtasks_id: string; gtasks_list: string | null }[];
  if (rows.length === 0) return { removed: 0 };
  let posList: string | null = null;
  try { posList = await deps.ensureTasklist(); } catch { /* fall through; per-row failures tolerated */ }
  let removed = 0;
  for (const r of rows) {
    try {
      await deps.deleteTask({ tasklist: r.gtasks_list ?? posList ?? "@default", task: r.gtasks_id });
      removed++;
    } catch { /* already gone / unreachable — either way, unlink below */ }
    db.prepare("UPDATE task SET gtasks_id = NULL, gtasks_list = NULL WHERE id = ?").run(r.id);
  }
  return { removed };
}

export interface PurgeResult {
  scanned: number;
  deleted: number;
  kept: number;
  /** Deleted titles, capped — enough for the UI to show what went without a wall of text. */
  samples: string[];
  error?: string;
}

/**
 * One-shot cleanup of the POS Google Tasks list (owner report 2026-08-11: "there are
 * literally 1200 POS entries; the only ones really needed are the ones that came from my
 * personalcrm system").
 *
 * Those 1200 are the wreckage of the tentative-push duplicate loop plus the local cleanup
 * that followed it: rows POS created whose local task no longer exists. Deleting the whole
 * list in Google would take the good ones with it AND make reconcileGoogleTasks read every
 * surviving local task as "deleted on the phone" (it defers them and clears gtasks_id), so
 * this deletes row by row instead, keeping anything still backed by POS.
 *
 * Deleted:
 *   - titles starting with "Tentative:" — POS's own prefix, which the owner never types;
 *   - pos:task rows whose local task is gone;
 *   - pos:commitment rows whose commitment is gone or already dropped.
 * Kept: everything still backed by a live local row, and everything with no POS marker at
 * all (those are his own, typed on the phone — this must never touch them).
 *
 * Dry-run by default. Nothing is deleted unless `apply` is true.
 */
export async function purgeOrphanedGoogleTasks(
  db: Db,
  secrets: SecretStore,
  opts: { apply?: boolean } = {},
  deps: GoogleTasksDeps = realGoogleTasksDeps(db, secrets)
): Promise<PurgeResult> {
  const out: PurgeResult = { scanned: 0, deleted: 0, kept: 0, samples: [] };
  if (!deps.isConnected(secrets)) return { ...out, error: "not_connected" };

  let posList: string;
  try {
    posList = await deps.ensureTasklist();
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  // Both lists POS can write to since routing landed (gcal/sync.targetTasklistFor): its own
  // list and the owner's default "Tasks" tab. Scanning the default one is safe precisely
  // because the rules below only ever delete rows carrying a POS marker or POS's own
  // "Tentative:" prefix — a task he typed on his phone has neither and is never touched.
  const lists = [posList, DEFAULT_TASKLIST_ID];

  const liveTask = db.prepare("SELECT gtasks_id FROM task WHERE id = ?");
  const liveCommitment = db.prepare(
    // pending_verify counts as alive: it is a freshly extracted row awaiting the Gemini
    // gate, and deleting its Google marker here would make the pull reconcile read the
    // tombstone as "the owner deleted this on his phone" and drop the commitment.
    "SELECT 1 FROM commitment WHERE id = ? AND status IN ('open','scheduled','pending_verify')"
  );
  // Duplicate copies of LIVE items (owner report 2026-08-17: 3,298 rows in the POS list).
  // The blind commitment push re-inserted the same live commitments for days, and this purge
  // kept every copy — "live" was the whole test. Now: a live TASK keeps only the row its
  // gtasks_id points at (or the first seen, healing gtasks_id when applying); a live
  // COMMITMENT keeps only the first row per marker. Everything else with that marker is a
  // duplicate and dies.
  const keptCommitment = new Set<number>();
  const keptTaskFirst = new Map<number, string>(); // taskId → first g.id kept (gtasks_id was NULL)

  const seenIds = new Set<string>(); // '@default' may resolve to a list already scanned
  for (const tasklist of lists) {
    let pageToken: string | undefined;
    do {
      let page;
      try {
        page = await deps.listTasks({ tasklist, pageToken });
      } catch (e) {
        // One unreadable list must not lose the other's cleanup.
        console.warn(`gtasks purge: listing ${tasklist} failed: ${(e as Error).message}`);
        break;
      }
      for (const g of page.items ?? []) {
        if (!g.id || seenIds.has(g.id)) continue;
        seenIds.add(g.id);
        out.scanned++;
        if (g.deleted === true) continue; // already gone; nothing to do

        const title = (g.title ?? "").trim();
        let doomed = false;
        if (/^tentative:\s/i.test(title)) {
          doomed = true;
        } else {
          const taskId = taskIdFromNotes(g.notes);
          const commitmentId = commitmentIdFromNotes(g.notes);
          if (taskId != null) {
            const row = liveTask.get(taskId) as { gtasks_id: string | null } | undefined;
            if (!row) {
              doomed = true; // task gone locally → orphan
            } else if (row.gtasks_id) {
              doomed = row.gtasks_id !== g.id; // live task keeps only its canonical row
            } else {
              // Task never linked (crash between insert and link). Keep the first copy and
              // heal the link; every later copy with the same marker is a duplicate.
              const first = keptTaskFirst.get(taskId);
              if (first === undefined) {
                keptTaskFirst.set(taskId, g.id);
                if (opts.apply) {
                  db.prepare("UPDATE task SET gtasks_id = ?, gtasks_list = ? WHERE id = ?").run(
                    g.id,
                    tasklist === posList ? null : tasklist,
                    taskId
                  );
                }
              } else {
                doomed = first !== g.id;
              }
            }
          } else if (commitmentId != null) {
            if (!liveCommitment.get(commitmentId)) {
              doomed = true; // commitment resolved/gone → orphan
            } else if (keptCommitment.has(commitmentId)) {
              doomed = true; // duplicate copy of a live commitment
            } else {
              keptCommitment.add(commitmentId);
            }
          }
          // no marker at all → his own row, never touched
        }

        if (!doomed) {
          out.kept++;
          continue;
        }
        if (!opts.apply) {
          out.deleted++;
          if (out.samples.length < 15) out.samples.push(title || "(untitled)");
          continue;
        }
        // Paced, with backoff. Run one fired as fast as the network allowed and lost
        // 2,593 deletes to "Quota Exceeded"; run two paced at ~3/s and was refused after
        // exactly 69 — which is the tell that the Tasks API allows ~60 requests/minute
        // per user. So: ~55/min steady, and on a refusal sleep out the rest of the
        // minute (65s) and retry, up to 5 times, before giving up on the run.
        let done = false;
        for (let attempt = 0; attempt < 5 && !done; attempt++) {
          try {
            await deps.deleteTask({ tasklist, task: g.id });
            done = true;
            out.deleted++;
            if (out.deleted % 200 === 0) console.log(`purge: ${out.deleted} deleted so far`);
            if (out.samples.length < 15) out.samples.push(title || "(untitled)");
          } catch (e) {
            const msg = (e as Error).message;
            if (/quota|rate ?limit|429/i.test(msg) && attempt < 4) {
              await new Promise((r) => setTimeout(r, 65_000));
              continue;
            }
            console.warn(`gtasks purge: ${g.id} failed: ${msg}`);
            if (/quota|rate ?limit|429/i.test(msg)) return { ...out, error: "quota exhausted — re-run later to finish" };
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 1_100));
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return out;
}

/** Close a commitment the Google side reports done. Returns true when a row changed. */
function closeCommitment(db: Db, commitmentId: number, at: string): boolean {
  const r = db
    .prepare("UPDATE commitment SET status = 'done', resolved_at = ? WHERE id = ? AND status IN ('open','scheduled')")
    .run(at, commitmentId);
  return r.changes > 0;
}
