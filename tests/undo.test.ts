// Global undo journal — DB-backed round-trips for the two richest inverses
// (commitments.toTask and commitments.updateText), plus journal mechanics.
// Uses the same entry builders ipc.ts records, with a stub secret store so the
// Google paths report "not connected" instead of touching the network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { commitmentToTask, dropCommitmentCascade } from "../main/gcal/sync.ts";
import {
  UndoJournal,
  MAX_ENTRIES,
  commitmentPrior,
  makeToTaskEntry,
  makeUpdateTextEntry,
  makeDropEntry,
} from "../main/undo.ts";
import type { SecretStore } from "../main/secrets.ts";

const noGoogle = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-undo-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addCommitment(desc: string, opts: { dueAt?: string | null; confirmed?: number } = {}): number {
  const r = db
    .prepare("INSERT INTO commitment (description, due_at, status, confirmed_by_user) VALUES (?, ?, 'open', ?)")
    .run(desc, opts.dueAt ?? null, opts.confirmed ?? 0);
  return Number(r.lastInsertRowid);
}

describe("UndoJournal mechanics", () => {
  it("returns {ok:false, reason:'empty'} when there is nothing to undo or redo", () => {
    const j = new UndoJournal();
    expect(j.undoLast()).toEqual({ ok: false, reason: "empty" });
    expect(j.redoLast()).toEqual({ ok: false, reason: "empty" });
  });

  it("caps the journal at MAX_ENTRIES and clears redo history on a new record", () => {
    const j = new UndoJournal();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      j.record({ label: `e${i}`, undo: () => {}, redo: () => {} });
    }
    expect(j.depth).toBe(MAX_ENTRIES);
    expect(j.undoLast()).toEqual({ ok: true, label: `e${MAX_ENTRIES + 4}` });
    j.record({ label: "fresh", undo: () => {}, redo: () => {} });
    expect(j.redoLast()).toEqual({ ok: false, reason: "empty" }); // redo cleared
  });
});

describe("toTask inverse (round trip)", () => {
  it("undo deletes the created task and restores the commitment; redo recreates both", async () => {
    const id = addCommitment("Send the deck to Sarah");
    const j = new UndoJournal();

    const prior = commitmentPrior(db, id)!;
    const res = await commitmentToTask(db, noGoogle, id);
    expect(res.task).toBe(true);
    j.record(makeToTaskEntry(db, noGoogle, id, prior, !res.duplicate));

    // acted state
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 1 });
    expect(db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id)).toEqual({
      status: "scheduled",
      confirmed_by_user: 1,
    });

    // undo → task gone, commitment back to open/unconfirmed
    const u = j.undoLast();
    expect(u).toEqual({ ok: true, label: "add task" });
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 0 });
    expect(db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id)).toEqual({
      status: "open",
      confirmed_by_user: 0,
    });

    // redo → the local writes in commitmentToTask happen synchronously
    const r = j.redoLast();
    expect(r).toEqual({ ok: true, label: "add task" });
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 1 });
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("scheduled");

    // undo again — the fresh task (new row id) must still be found and deleted
    j.undoLast();
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 0 });
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("open");
  });

  it("undo of the duplicate path restores the commitment without touching the pre-existing task", async () => {
    const id = addCommitment("Only once");
    await commitmentToTask(db, noGoogle, id); // creates the task
    db.prepare("UPDATE commitment SET status = 'open' WHERE id = ?").run(id); // simulate later state

    const j = new UndoJournal();
    const prior = commitmentPrior(db, id)!;
    const res = await commitmentToTask(db, noGoogle, id); // duplicate click
    expect(res.duplicate).toBe(true);
    j.record(makeToTaskEntry(db, noGoogle, id, prior, !res.duplicate));

    j.undoLast();
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 1 });
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("open");
  });

  it("respects a picked dateISO through undo/redo", async () => {
    const id = addCommitment("Picked date", { dueAt: null });
    const j = new UndoJournal();
    const prior = commitmentPrior(db, id)!;
    await commitmentToTask(db, noGoogle, id, "2099-05-05");
    j.record(makeToTaskEntry(db, noGoogle, id, prior, true, "2099-05-05"));

    expect((db.prepare("SELECT plan_date, hard_deadline_at FROM task WHERE commitment_id = ?").get(id) as any)).toEqual({
      plan_date: "2099-05-05",
      hard_deadline_at: "2099-05-05T00:00:00",
    });
    j.undoLast();
    j.redoLast();
    expect((db.prepare("SELECT plan_date FROM task WHERE commitment_id = ?").get(id) as any).plan_date).toBe("2099-05-05");
  });
});

describe("updateText inverse (round trip)", () => {
  it("undo restores the prior description AND confirmed flag; redo re-applies the edit", () => {
    const id = addCommitment("Original text", { confirmed: 0 });
    const j = new UndoJournal();

    const prior = commitmentPrior(db, id)!;
    // same statement the ipc handler runs
    db.prepare("UPDATE commitment SET description = ?, confirmed_by_user = 1 WHERE id = ?").run("Edited text", id);
    j.record(makeUpdateTextEntry(db, id, prior, "Edited text"));

    expect(db.prepare("SELECT description, confirmed_by_user FROM commitment WHERE id = ?").get(id)).toEqual({
      description: "Edited text",
      confirmed_by_user: 1,
    });

    const u = j.undoLast();
    expect(u).toEqual({ ok: true, label: "edit commitment" });
    expect(db.prepare("SELECT description, confirmed_by_user FROM commitment WHERE id = ?").get(id)).toEqual({
      description: "Original text",
      confirmed_by_user: 0,
    });

    j.redoLast();
    expect(db.prepare("SELECT description, confirmed_by_user FROM commitment WHERE id = ?").get(id)).toEqual({
      description: "Edited text",
      confirmed_by_user: 1,
    });
  });
});

describe("drop cascade inverse", () => {
  it("drop deletes the linked open task; undo restores commitment and task (gtasks_id cleared)", async () => {
    const id = addCommitment("Drop me");
    await commitmentToTask(db, noGoogle, id);
    db.prepare("UPDATE task SET gtasks_id = 'g123' WHERE commitment_id = ?").run(id);

    const j = new UndoJournal();
    const prior = commitmentPrior(db, id)!;
    const res = dropCommitmentCascade(db, noGoogle, id);
    expect(res.deletedTasks.length).toBe(1);
    j.record(makeDropEntry(db, noGoogle, id, prior, res.deletedTasks));

    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 0 });
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("dropped");

    const u = j.undoLast();
    expect(u).toEqual({ ok: true, label: "delete commitment" });
    const task = db.prepare("SELECT status, gtasks_id, title FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task).toBeTruthy();
    expect(task.status).toBe("inbox");
    expect(task.gtasks_id).toBeNull(); // Google side was completed best-effort; never resurrect
    const c = db.prepare("SELECT status, resolved_at FROM commitment WHERE id = ?").get(id) as any;
    expect(c.status).toBe("scheduled"); // prior state captured just before the drop
    expect(c.resolved_at).toBeNull();

    // redo drops again
    j.redoLast();
    expect(db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id)).toEqual({ c: 0 });
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("dropped");
  });
});
