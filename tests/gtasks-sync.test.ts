// Bidirectional Google Tasks sync (main/gtasks-sync.ts). No network: the Google surface
// is injected as a fake, so every case below is the reconciliation matrix exercised
// against a real SQLite file and a fake tasklist.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  reconcileGoogleTasks,
  dueDateOf,
  pushedDueDateOf,
  commitmentIdFromNotes,
  type GoogleTaskLite,
  type GoogleTasksDeps,
} from "../main/gtasks-sync.ts";
import type { SecretStore } from "../main/secrets.ts";

const connected = { get: (n: string) => (n === "GOOGLE_OAUTH_TOKENS" ? "{}" : null) } as unknown as SecretStore;
const notConnected = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-gtasks-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Fake Google surface: pages of tasks in, call log out. */
function fakeDeps(
  pages: GoogleTaskLite[][],
  opts: { pushResult?: { pushed: number; completed: number }; pushThrows?: string } = {}
): Partial<GoogleTasksDeps> & { calls: { list: number; patch: number; insert: number; push: number } } {
  const calls = { list: 0, patch: 0, insert: 0, push: 0 };
  return {
    calls,
    isConnected: () => true,
    ensureTasklist: async () => "POS_LIST",
    listTasks: async ({ pageToken }) => {
      const idx = pageToken ? Number(pageToken) : 0;
      calls.list++;
      return {
        items: pages[idx] ?? [],
        nextPageToken: idx + 1 < pages.length ? String(idx + 1) : undefined,
      };
    },
    patchTask: async () => {
      calls.patch++;
    },
    insertTask: async () => {
      calls.insert++;
      return { id: "never" };
    },
    pushTasks: async () => {
      calls.push++;
      if (opts.pushThrows) throw new Error(opts.pushThrows);
      return opts.pushResult ?? { pushed: 0, completed: 0 };
    },
    now: () => new Date("2026-08-05T12:00:00Z"),
  };
}

function addTask(t: {
  title: string;
  gtasksId?: string | null;
  status?: string;
  deadline?: string | null;
  commitmentId?: number | null;
}): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                         status, hard_deadline_at, gtasks_id, commitment_id)
       VALUES (?, 'admin', 2, 30, 30, ?, ?, ?, ?)`
    )
    .run(t.title, t.status ?? "inbox", t.deadline ?? null, t.gtasksId ?? null, t.commitmentId ?? null);
  return Number(r.lastInsertRowid);
}

function addCommitment(desc: string, status = "scheduled"): number {
  const r = db
    .prepare("INSERT INTO commitment (description, status, confirmed_by_user) VALUES (?, ?, 1)")
    .run(desc, status);
  return Number(r.lastInsertRowid);
}

const task = (id: number) => db.prepare("SELECT * FROM task WHERE id = ?").get(id) as any;
const commitment = (id: number) => db.prepare("SELECT * FROM commitment WHERE id = ?").get(id) as any;

describe("pure helpers", () => {
  it("reduces Google's RFC 3339 due timestamp to a plain date", () => {
    expect(dueDateOf("2026-09-01T00:00:00.000Z")).toBe("2026-09-01");
    expect(dueDateOf("2026-09-01T00:00:00")).toBe("2026-09-01");
    expect(dueDateOf(null)).toBeNull();
    expect(dueDateOf("  ")).toBeNull();
  });

  it("pushedDueDateOf reproduces what pushTasks sent, so our own push is not read as an edit", () => {
    expect(pushedDueDateOf(null)).toBeNull();
    expect(pushedDueDateOf("not a date")).toBeNull();
    expect(pushedDueDateOf("2026-09-01T00:00:00")).toBe(new Date("2026-09-01T00:00:00").toISOString().slice(0, 10));
  });

  it("recognises the commitment marker note", () => {
    expect(commitmentIdFromNotes("pos:commitment:42")).toBe(42);
    expect(commitmentIdFromNotes("some user note")).toBeNull();
    expect(commitmentIdFromNotes(null)).toBeNull();
  });
});

describe("not connected", () => {
  it("no-ops with zeros and error 'not_connected'", async () => {
    const id = addTask({ title: "Untouched", gtasksId: "g1" });
    const res = await reconcileGoogleTasks(db, notConnected);
    expect(res).toEqual({ pulled: 0, completedLocally: 0, deletedLocally: 0, pushed: 0, error: "not_connected" });
    expect(task(id).status).toBe("inbox"); // nothing was written
  });
});

describe("deleted in Google", () => {
  it("defers the local task, clears gtasks_id and reopens the commitment (deleted:true)", async () => {
    const cid = addCommitment("Send Sarah the deck");
    const tid = addTask({ title: "Send Sarah the deck", gtasksId: "g1", commitmentId: cid });

    const deps = fakeDeps([[{ id: "g1", title: "Send Sarah the deck", status: "needsAction", deleted: true }]]);
    const res = await reconcileGoogleTasks(db, connected, deps);

    expect(res.deletedLocally).toBe(1);
    expect(res.error).toBeUndefined();
    expect(task(tid).status).toBe("deferred");
    expect(task(tid).gtasks_id).toBeNull();
    expect(commitment(cid).status).toBe("open"); // back to review, never silently gone
    expect(commitment(cid).resolved_at).toBeNull();
    // the pull pass performs no Google writes
    expect(deps.calls.patch).toBe(0);
    expect(deps.calls.insert).toBe(0);
  });

  it("treats an id that vanished from the listing as deleted too", async () => {
    const tid = addTask({ title: "Purged upstream", gtasksId: "gone" });
    const res = await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "other", title: "Other", status: "needsAction" }]]));
    expect(res.deletedLocally).toBe(1);
    expect(task(tid).status).toBe("deferred");
    expect(task(tid).gtasks_id).toBeNull();
  });

  it("drops a commitment whose pushed marker task was deleted on the phone", async () => {
    const cid = addCommitment("Call the landlord", "open");
    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([[{ id: "m1", title: "Call the landlord", notes: `pos:commitment:${cid}`, deleted: true }]])
    );
    expect(res.deletedLocally).toBe(1);
    expect(commitment(cid).status).toBe("dropped");
    expect(commitment(cid).resolved_at).toBeTruthy();
  });
});

describe("completed in Google", () => {
  it("marks the local task done with Google's completion time and resolves the commitment", async () => {
    const cid = addCommitment("Pay the invoice");
    const tid = addTask({ title: "Pay the invoice", gtasksId: "g1", commitmentId: cid, status: "planned" });

    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([[{ id: "g1", title: "Pay the invoice", status: "completed", completed: "2026-08-04T09:30:00.000Z" }]])
    );

    expect(res.completedLocally).toBe(1);
    expect(task(tid).status).toBe("done");
    expect(task(tid).completed_at).toBe("2026-08-04 09:30:00");
    expect(commitment(cid).status).toBe("done");
    expect(commitment(cid).resolved_at).toBe("2026-08-04 09:30:00");
  });

  it("falls back to now() when Google gives no completion timestamp", async () => {
    const tid = addTask({ title: "No timestamp", gtasksId: "g1" });
    await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "g1", title: "No timestamp", status: "completed" }]]));
    expect(task(tid).completed_at).toBe("2026-08-05 12:00:00");
  });

  it("resolves a commitment whose pushed marker task was ticked off on the phone", async () => {
    const cid = addCommitment("Book the flights", "open");
    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([
        [{ id: "m1", title: "Book the flights", notes: `pos:commitment:${cid}`, status: "completed", completed: "2026-08-04T09:30:00.000Z" }],
      ])
    );
    expect(res.completedLocally).toBe(1);
    expect(commitment(cid).status).toBe("done");
  });
});

describe("edited in Google", () => {
  it("adopts a changed title and a changed due date", async () => {
    const tid = addTask({ title: "Old title", gtasksId: "g1", deadline: "2026-09-01T00:00:00" });
    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([[{ id: "g1", title: "New title", status: "needsAction", due: "2026-09-04T00:00:00.000Z" }]])
    );
    expect(res.pulled).toBe(1);
    expect(task(tid).title).toBe("New title");
    expect(task(tid).hard_deadline_at).toBe("2026-09-04T00:00:00");
  });

  it("clears the local deadline when the owner removed the due date in Google", async () => {
    const tid = addTask({ title: "Dated", gtasksId: "g1", deadline: "2026-09-01T00:00:00" });
    const res = await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "g1", title: "Dated", status: "needsAction" }]]));
    expect(res.pulled).toBe(1);
    expect(task(tid).hard_deadline_at).toBeNull();
  });

  it("counts nothing when Google echoes exactly what pushTasks sent", async () => {
    const tid = addTask({ title: "Same", gtasksId: "g1", deadline: "2026-09-01T00:00:00" });
    const echoed = new Date("2026-09-01T00:00:00").toISOString(); // what pushTasks put on the wire
    const res = await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "g1", title: "Same", status: "needsAction", due: echoed }]]));
    expect(res).toMatchObject({ pulled: 0, completedLocally: 0, deletedLocally: 0 });
    expect(task(tid).hard_deadline_at).toBe("2026-09-01T00:00:00");
  });
});

describe("Google-only tasks", () => {
  it("creates a local inbox task for something added on the phone", async () => {
    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([[{ id: "phone1", title: "Buy cables", notes: "from the phone", status: "needsAction", due: "2026-08-09T00:00:00.000Z" }]])
    );
    expect(res.pulled).toBe(1);
    const row = db.prepare("SELECT * FROM task WHERE gtasks_id = 'phone1'").get() as any;
    expect(row.title).toBe("Buy cables");
    expect(row.notes).toBe("from the phone");
    expect(row.status).toBe("inbox");
    expect(row.plan_date).toBe("2026-08-09");
    expect(row.hard_deadline_at).toBe("2026-08-09T00:00:00");
  });

  it("leaves an undated phone task undated (no plan_date, so it lands in the inbox)", async () => {
    await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "phone2", title: "Someday thing", status: "needsAction" }]]));
    const row = db.prepare("SELECT * FROM task WHERE gtasks_id = 'phone2'").get() as any;
    expect(row.plan_date).toBeNull();
    expect(row.hard_deadline_at).toBeNull();
  });

  it("ignores deleted, completed, untitled and commitment-marker rows", async () => {
    const cid = addCommitment("Marker only", "done"); // already resolved → untouched
    const res = await reconcileGoogleTasks(
      db,
      connected,
      fakeDeps([
        [
          { id: "d1", title: "Binned", status: "needsAction", deleted: true },
          { id: "c1", title: "Already done", status: "completed" },
          { id: "e1", title: "   ", status: "needsAction" },
          { id: "m1", title: "Marker only", notes: `pos:commitment:${cid}`, status: "needsAction" },
        ],
      ])
    );
    expect(res.pulled).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM task").get()).toEqual({ c: 0 });
    expect(commitment(cid).status).toBe("done");
  });

  it("does not re-import a Google task that a local done task still points at", async () => {
    addTask({ title: "Finished", gtasksId: "g1", status: "done" });
    const res = await reconcileGoogleTasks(db, connected, fakeDeps([[{ id: "g1", title: "Finished", status: "completed" }]]));
    expect(res.pulled).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM task").get()).toEqual({ c: 1 });
  });
});

describe("pagination and push", () => {
  it("walks every page before deciding what is missing, then pushes once", async () => {
    const t1 = addTask({ title: "On page one", gtasksId: "p1" });
    const t2 = addTask({ title: "On page two", gtasksId: "p2" });
    const t3 = addTask({ title: "On neither page", gtasksId: "p3" });

    const deps = fakeDeps(
      [
        [{ id: "p1", title: "On page one", status: "needsAction" }],
        [{ id: "p2", title: "Renamed on page two", status: "needsAction" }],
      ],
      { pushResult: { pushed: 7, completed: 2 } }
    );
    const res = await reconcileGoogleTasks(db, connected, deps);

    expect(deps.calls.list).toBe(2);
    expect(deps.calls.push).toBe(1);
    expect(res.pushed).toBe(7);
    expect(task(t1).status).toBe("inbox"); // page one saved it
    expect(task(t2).title).toBe("Renamed on page two"); // page two was read
    expect(task(t3).status).toBe("deferred"); // genuinely absent from both pages
    expect(res).toMatchObject({ pulled: 1, deletedLocally: 1, completedLocally: 0 });
  });

  it("reports a push failure in error while keeping the pulled counts", async () => {
    const tid = addTask({ title: "Gone", gtasksId: "g1" });
    const res = await reconcileGoogleTasks(db, connected, fakeDeps([[]], { pushThrows: "token expired" }));
    expect(res.error).toBe("token expired");
    expect(res.deletedLocally).toBe(1);
    expect(task(tid).status).toBe("deferred");
  });

  it("survives a listing failure without deferring anything, and never pushes", async () => {
    const tid = addTask({ title: "Safe", gtasksId: "g1" });
    let pushes = 0;
    const res = await reconcileGoogleTasks(db, connected, {
      isConnected: () => true,
      ensureTasklist: async () => "POS_LIST",
      listTasks: async () => {
        throw new Error("network down");
      },
      pushTasks: async () => {
        pushes++;
        return { pushed: 0, completed: 0 };
      },
    });
    expect(res.error).toBe("network down");
    expect(res.deletedLocally).toBe(0);
    expect(task(tid).status).toBe("inbox");
    expect(pushes).toBe(0);
  });

  it("time-boxes a hung Google call instead of hanging the cron", async () => {
    const res = await reconcileGoogleTasks(db, connected, {
      isConnected: () => true,
      timeoutMs: 20,
      ensureTasklist: async () => "POS_LIST",
      listTasks: () => new Promise(() => {}), // never settles
      pushTasks: async () => ({ pushed: 0, completed: 0 }),
    });
    expect(res.error).toBe("google tasks reconcile timed out");
    expect(res.pushed).toBe(0);
  });
});
