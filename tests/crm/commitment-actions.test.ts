// "Add task" / "Add event" on the Relationships dashboard — DB-backed proof that a
// commitment actually becomes a task row (toTask) and a pinned block row (toEvent).
// These call the same helpers the IPC handlers use (main/gcal/sync.ts), with a stub
// secret store so the Google push path reports "not connected" instead of hitting
// the network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { commitmentToTask, commitmentToEvent } from "../../main/gcal/sync.ts";
import type { SecretStore } from "../../main/secrets.ts";

// isGoogleConnected() only calls .get("GOOGLE_OAUTH_TOKENS") — null = not connected.
const noGoogle = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-commit-actions-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addCommitment(desc: string, opts: { dueAt?: string | null; confirmed?: number } = {}): number {
  const r = db
    .prepare(
      "INSERT INTO commitment (description, due_at, status, confirmed_by_user) VALUES (?, ?, 'open', ?)"
    )
    .run(desc, opts.dueAt ?? null, opts.confirmed ?? 0);
  return Number(r.lastInsertRowid);
}

describe("commitmentToTask", () => {
  it("creates a task row linked to the commitment and marks it scheduled", async () => {
    const id = addCommitment("Send the deck to Sarah");
    const res = await commitmentToTask(db, noGoogle, id);

    expect(res.task).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.google).toBe(false);
    expect(res.reason).toBe("Google not connected");

    const task = db.prepare("SELECT * FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task).toBeTruthy();
    expect(task.title).toBe("Send the deck to Sarah");
    expect(task.status).toBe("inbox");
    expect(task.block_type).toBe("admin");
    // 2026-08-05: only explicit dates schedule things — an undated commitment
    // becomes an inbox item with NO plan date, never today's list.
    expect(task.plan_date).toBeNull();
    expect(task.hard_deadline_at).toBeNull();

    const c = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(id) as any;
    expect(c.status).toBe("scheduled");
    expect(c.confirmed_by_user).toBe(1); // auto-confirmed on add
  });

  it("plans on the due date when it is in the future, keeping the hard deadline", async () => {
    const id = addCommitment("Future thing", { dueAt: "2099-01-05T00:00:00", confirmed: 1 });
    await commitmentToTask(db, noGoogle, id);
    const task = db.prepare("SELECT plan_date, hard_deadline_at FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task.plan_date).toBe("2099-01-05");
    expect(task.hard_deadline_at).toBe("2099-01-05T00:00:00");
  });

  it("is idempotent — a second click reuses the open task instead of duplicating it", async () => {
    const id = addCommitment("Only once");
    const first = await commitmentToTask(db, noGoogle, id);
    const second = await commitmentToTask(db, noGoogle, id);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const n = db.prepare("SELECT COUNT(*) c FROM task WHERE commitment_id = ?").get(id) as any;
    expect(n.c).toBe(1);
  });

  it("throws (→ ok:false over IPC → visible notice) for a missing commitment", async () => {
    await expect(commitmentToTask(db, noGoogle, 9999)).rejects.toThrow("commitment not found");
  });
});

describe("commitmentToEvent", () => {
  it("pins a locked 60-min personal block on the due date at 10:00", () => {
    const id = addCommitment("Coffee with Alex", { dueAt: "2099-03-04T00:00:00" });
    const res = commitmentToEvent(db, id);
    expect(res.event).toBe(true);
    expect(res.starts_at).toBe("2099-03-04T10:00:00");

    const block = db.prepare("SELECT * FROM block WHERE title = 'Coffee with Alex'").get() as any;
    expect(block).toBeTruthy();
    expect(block.block_type).toBe("personal");
    expect(block.starts_at).toBe("2099-03-04T10:00:00");
    expect(block.ends_at).toBe("2099-03-04T11:00:00");
    expect(block.is_locked).toBe(1); // user pinned
    expect(block.is_anchor).toBe(0);
    expect(block.plan_id).toBeNull();
    expect(block.task_id).toBeNull();

    const c = db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any;
    expect(c.status).toBe("scheduled");
  });

  it("asks for a date when the commitment has none, writing nothing", () => {
    const id = addCommitment("Sometime maybe");
    const res = commitmentToEvent(db, id);
    expect(res).toEqual({ needsDate: true });
    expect((db.prepare("SELECT COUNT(*) c FROM block").get() as any).c).toBe(0);
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as any).status).toBe("open");
  });

  it("uses a supplied date + time over the due date", () => {
    const id = addCommitment("Lunch in September");
    const res = commitmentToEvent(db, id, "2099-09-10", "12:30");
    expect(res.starts_at).toBe("2099-09-10T12:30:00");
    const block = db.prepare("SELECT starts_at, ends_at FROM block").get() as any;
    expect(block.starts_at).toBe("2099-09-10T12:30:00");
    expect(block.ends_at).toBe("2099-09-10T13:30:00");
  });

  it("throws on an invalid date and on a missing commitment", () => {
    const id = addCommitment("Bad date");
    expect(() => commitmentToEvent(db, id, "not-a-date")).toThrow("invalid date/time");
    expect(() => commitmentToEvent(db, 9999)).toThrow("commitment not found");
  });
});
