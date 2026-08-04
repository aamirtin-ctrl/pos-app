// Global undo/redo journal (⌘Z / ⌘⇧Z from the renderer, via IPC undo.do / undo.redo).
//
// In-memory only, max 30 entries, USER actions only — automatic pipelines (the
// workers' tentative-task creation, syncs) never record here. Each entry is a pair
// of closures over prepared statements: `undo` restores the prior local state,
// `redo` re-applies the action. Google-side cleanup inside a closure is always
// best-effort and fire-and-forget (closeGoogleTask is time-boxed and swallows
// errors) — the local DB is the source of truth.
//
// The entry BUILDERS live here too (not inline in ipc.ts) so they are testable
// without electron: ipc.ts performs the action, captures the prior state, then
// records the built entry.

import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import {
  commitmentToTask,
  commitmentToEvent,
  closeGoogleTask,
  dropCommitmentCascade,
  type DeletedTaskRow,
} from "./gcal/sync.ts";

export interface UndoEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

export type UndoResult = { ok: true; label: string } | { ok: false; reason: "empty" };

export const MAX_ENTRIES = 30;

export class UndoJournal {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];

  /** Push a user action. Oldest entries fall off past MAX_ENTRIES; redo history clears. */
  record(entry: UndoEntry): void {
    this.past.push(entry);
    if (this.past.length > MAX_ENTRIES) this.past.shift();
    this.future = [];
  }

  undoLast(): UndoResult {
    const e = this.past.pop();
    if (!e) return { ok: false, reason: "empty" };
    e.undo();
    this.future.push(e);
    return { ok: true, label: e.label };
  }

  redoLast(): UndoResult {
    const e = this.future.pop();
    if (!e) return { ok: false, reason: "empty" };
    e.redo();
    this.past.push(e);
    return { ok: true, label: e.label };
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get depth(): number {
    return this.past.length;
  }
}

/** The one journal the app uses (main process singleton). */
export const journal = new UndoJournal();

// ── prior-state capture ──────────────────────────────────────────────────────

export interface CommitmentPrior {
  status: string;
  confirmed_by_user: number;
  resolved_at: string | null;
  description: string;
}

/** Snapshot a commitment before mutating it. Null when the row does not exist. */
export function commitmentPrior(db: Db, id: number): CommitmentPrior | null {
  const row = db
    .prepare("SELECT status, confirmed_by_user, resolved_at, description FROM commitment WHERE id = ?")
    .get(id) as CommitmentPrior | undefined;
  return row ?? null;
}

// ── entry builders ───────────────────────────────────────────────────────────

/**
 * Inverse of commitments.toTask. `created` = a task row was actually inserted
 * (false for the duplicate/double-click path — then undo only restores the
 * commitment). Undo re-reads the open task at undo time (redo may have created a
 * fresh row with a new id), deletes it, restores the commitment, and best-effort
 * completes the Google task if one was pushed.
 */
export function makeToTaskEntry(
  db: Db,
  secrets: SecretStore,
  commitmentId: number,
  prior: CommitmentPrior,
  created: boolean,
  dateISO?: string
): UndoEntry {
  return {
    label: "add task",
    undo: () => {
      if (created) {
        const t = db
          .prepare(
            "SELECT id, gtasks_id FROM task WHERE commitment_id = ? AND status IN ('inbox','planned','in_progress')"
          )
          .get(commitmentId) as { id: number; gtasks_id: string | null } | undefined;
        if (t) {
          db.prepare("DELETE FROM task WHERE id = ?").run(t.id);
          if (t.gtasks_id) void closeGoogleTask(db, secrets, t.gtasks_id);
        }
      }
      db.prepare("UPDATE commitment SET status = ?, confirmed_by_user = ? WHERE id = ?").run(
        prior.status,
        prior.confirmed_by_user,
        commitmentId
      );
    },
    // Local DB work in commitmentToTask is synchronous (before its first await);
    // only the Google push floats — exactly the best-effort behaviour we want.
    redo: () => {
      void commitmentToTask(db, secrets, commitmentId, dateISO).catch(() => {});
    },
  };
}

/** Inverse of commitments.toEvent: delete the pinned block, restore the commitment. */
export function makeToEventEntry(
  db: Db,
  commitmentId: number,
  prior: CommitmentPrior,
  blockIdInit: number | null,
  dateISO?: string,
  hhmm?: string
): UndoEntry {
  let blockId = blockIdInit; // redo creates a fresh block — track the live id
  return {
    label: "add event",
    undo: () => {
      if (blockId != null) db.prepare("DELETE FROM block WHERE id = ?").run(blockId);
      db.prepare("UPDATE commitment SET status = ? WHERE id = ?").run(prior.status, commitmentId);
    },
    redo: () => {
      const r = commitmentToEvent(db, commitmentId, dateISO, hhmm);
      blockId = r.block_id ?? null;
    },
  };
}

/**
 * Inverse of commitments.drop (button and swipe-delete): restore the prior
 * status/resolved_at and re-insert the local tasks the cascade deleted.
 * Re-inserted tasks get gtasks_id NULL — their Google counterpart was completed
 * best-effort, so a later push creates a fresh one instead of resurrecting it.
 */
export function makeDropEntry(
  db: Db,
  secrets: SecretStore,
  commitmentId: number,
  prior: CommitmentPrior,
  deletedTasks: DeletedTaskRow[]
): UndoEntry {
  let rows = deletedTasks;
  return {
    label: "delete commitment",
    undo: () => {
      db.prepare("UPDATE commitment SET status = ?, resolved_at = ? WHERE id = ?").run(
        prior.status,
        prior.resolved_at,
        commitmentId
      );
      const ins = db.prepare(
        `INSERT INTO task (id, title, notes, block_type, cognitive_load, estimated_minutes,
           raw_estimate_minutes, is_mit, hard_deadline_at, project, commitment_id, status,
           splittable, estimate_source, plan_date, gtasks_id, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      );
      for (const t of rows) {
        ins.run(
          t.id, t.title, t.notes, t.block_type, t.cognitive_load, t.estimated_minutes,
          t.raw_estimate_minutes, t.is_mit, t.hard_deadline_at, t.project, t.commitment_id,
          t.status, t.splittable, t.estimate_source, t.plan_date, t.created_at, t.completed_at
        );
      }
    },
    redo: () => {
      rows = dropCommitmentCascade(db, secrets, commitmentId).deletedTasks;
    },
  };
}

/** Inverse of commitments.confirm. */
export function makeConfirmEntry(db: Db, commitmentId: number, prior: CommitmentPrior): UndoEntry {
  return {
    label: "confirm commitment",
    undo: () => {
      db.prepare("UPDATE commitment SET confirmed_by_user = ? WHERE id = ?").run(
        prior.confirmed_by_user,
        commitmentId
      );
    },
    redo: () => {
      db.prepare("UPDATE commitment SET confirmed_by_user = 1 WHERE id = ?").run(commitmentId);
    },
  };
}

/** Inverse of commitments.updateText: restore prior text AND confirmed flag. */
export function makeUpdateTextEntry(
  db: Db,
  commitmentId: number,
  prior: CommitmentPrior,
  nextText: string
): UndoEntry {
  return {
    label: "edit commitment",
    undo: () => {
      db.prepare("UPDATE commitment SET description = ?, confirmed_by_user = ? WHERE id = ?").run(
        prior.description,
        prior.confirmed_by_user,
        commitmentId
      );
    },
    redo: () => {
      db.prepare("UPDATE commitment SET description = ?, confirmed_by_user = 1 WHERE id = ?").run(
        nextText,
        commitmentId
      );
    },
  };
}

/** Inverse of tasks.setStatus: restore prior status and completed_at. */
export function makeTaskStatusEntry(
  db: Db,
  taskId: number,
  prior: { status: string; completed_at: string | null },
  nextStatus: string
): UndoEntry {
  return {
    label: nextStatus === "done" ? "complete task" : `task ${nextStatus}`,
    undo: () => {
      db.prepare("UPDATE task SET status = ?, completed_at = ? WHERE id = ?").run(
        prior.status,
        prior.completed_at,
        taskId
      );
    },
    redo: () => {
      db.prepare(
        "UPDATE task SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE completed_at END WHERE id = ?"
      ).run(nextStatus, nextStatus, taskId);
    },
  };
}

/** Inverse of drafts.setStatus. */
export function makeDraftStatusEntry(
  db: Db,
  draftId: number,
  priorStatus: string,
  nextStatus: string
): UndoEntry {
  return {
    label: `draft ${nextStatus}`,
    undo: () => {
      db.prepare("UPDATE draft SET status = ? WHERE id = ?").run(priorStatus, draftId);
    },
    redo: () => {
      db.prepare("UPDATE draft SET status = ? WHERE id = ?").run(nextStatus, draftId);
    },
  };
}
