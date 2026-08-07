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
  taskIdFromNotes,
  pushedDueDateOf,
  commitmentIdFromNotes,
  remoteIsNewer,
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

/** Fake Google surface: pages of tasks in, call log out. POS list + '@default' (phone). */
function fakeDeps(
  pages: GoogleTaskLite[][],
  opts: {
    pushResult?: { pushed: number; completed: number };
    pushThrows?: string;
    defaultListPages?: GoogleTaskLite[][];
  } = {}
): Partial<GoogleTasksDeps> & { calls: { list: number; patch: number; insert: number; push: number } } {
  const calls = { list: 0, patch: 0, insert: 0, push: 0 };
  return {
    calls,
    isConnected: () => true,
    ensureTasklist: async () => "POS_LIST",
    listTasks: async ({ tasklist, pageToken }) => {
      const source = tasklist === "@default" ? (opts.defaultListPages ?? []) : pages;
      const idx = pageToken ? Number(pageToken) : 0;
      calls.list++;
      return {
        items: source[idx] ?? [],
        nextPageToken: idx + 1 < source.length ? String(idx + 1) : undefined,
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
    // Google's due is DATE-only: it names the day, never a midnight clock deadline. The
    // old `${due}T00:00:00` here handed the solver a deadline already in the past the
    // moment the day started (owner-visible 2026-08-07).
    expect(row.hard_deadline_at).toBeNull();
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

    expect(deps.calls.list).toBe(3); // 2 POS pages + the '@default' read (empty)
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

// ── who wins when both sides changed (owner-visible bug, 2026-08-06) ─────────
//
// The title rule was unconditional — Google's title replaced ours whenever they differed —
// and reconcile runs BEFORE the push on every tick. Together that made a local rename
// impossible to keep: it was reverted from the remote before it had ever been sent there.
// Found when a task renamed locally silently reverted to the raw transcript fragment Google
// still held. Two-way sync is right; "the remote always wins" makes one side read-only
// without saying so.

describe("remoteIsNewer", () => {
  it("lets Google win when we have never edited locally", () => {
    // Every task predating migration 11 has updated_at NULL, so behaviour is unchanged.
    expect(remoteIsNewer("2026-08-06T10:00:00.000Z", null)).toBe(true);
  });

  it("lets Google win when Google's edit is the more recent one", () => {
    expect(remoteIsNewer("2026-08-06T12:00:00.000Z", "2026-08-06T10:00:00.000Z")).toBe(true);
  });

  it("keeps the local edit when ours is newer — the case that was silently lost", () => {
    expect(remoteIsNewer("2026-08-06T10:00:00.000Z", "2026-08-06T12:00:00.000Z")).toBe(false);
  });

  it("treats an identical stamp as no reason to overwrite", () => {
    const t = "2026-08-06T12:00:00.000Z";
    expect(remoteIsNewer(t, t)).toBe(false);
  });

  it("falls back to the old rule rather than dropping a phone edit on a bad local stamp", () => {
    expect(remoteIsNewer("2026-08-06T12:00:00.000Z", "not a date")).toBe(true);
  });

  it("keeps our edit when Google reports no clock at all", () => {
    expect(remoteIsNewer(null, "2026-08-06T12:00:00.000Z")).toBe(false);
    expect(remoteIsNewer(undefined, "2026-08-06T12:00:00.000Z")).toBe(false);
  });
});

describe("task.updated_at trigger", () => {
  it("stamps any local UPDATE without the caller remembering to", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pos-touch-"));
    const t = openDb(path.join(d, "pos.db"));
    const id = Number(
      t.prepare("INSERT INTO task (title, block_type, status) VALUES ('x', 'admin', 'inbox')").run()
        .lastInsertRowid
    );
    expect((t.prepare("SELECT updated_at u FROM task WHERE id = ?").get(id) as any).u).toBeNull();
    t.prepare("UPDATE task SET title = 'renamed' WHERE id = ?").run(id);
    const after = (t.prepare("SELECT title, updated_at u FROM task WHERE id = ?").get(id) as any);
    expect(after.title).toBe("renamed");
    expect(after.u).toBeTruthy();
    t.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});


// ── the phone's own "My Tasks" list ('@default') ─────────────────────────────
//
// Owner report 2026-08-07: "in my google tasks i added from much earlier i need to do my
// physics diagnostic today. yet its not scheduling for that." He types tasks into the normal
// Google Tasks app; those land in '@default', which the reconcile never read.
describe("default-list pull", () => {
  it("imports a task typed into the phone's default list, dated from its due date — his exact case", async () => {
    const deps = fakeDeps([[]], {
      defaultListPages: [[
        { id: "phys1", title: "Physics diagnostic", status: "needsAction", due: "2026-08-07T00:00:00.000Z" },
      ]],
    });
    const res = await reconcileGoogleTasks(db, connected, deps);
    expect(res.pulled).toBe(1);
    const row = db.prepare("SELECT * FROM task WHERE gtasks_id = 'phys1'").get() as any;
    expect(row.title).toBe("Physics diagnostic");
    expect(row.plan_date).toBe("2026-08-07"); // scheduled ON the day he named
    expect(row.gtasks_list).toBe("@default"); // writes back to the right list
  });

  it("a POS-list import records no list override (NULL = POS list)", async () => {
    const deps = fakeDeps([[{ id: "pos1", title: "From POS list", status: "needsAction" }]]);
    await reconcileGoogleTasks(db, connected, deps);
    const row = db.prepare("SELECT * FROM task WHERE gtasks_id = 'pos1'").get() as any;
    expect(row.gtasks_list).toBeNull();
  });

  it("the same id served by both lists imports exactly once", async () => {
    const g: GoogleTaskLite = { id: "dup1", title: "Aliased row", status: "needsAction" };
    const deps = fakeDeps([[g]], { defaultListPages: [[g]] });
    const res = await reconcileGoogleTasks(db, connected, deps);
    expect(res.pulled).toBe(1);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task WHERE gtasks_id = 'dup1'").get() as any).n;
    expect(n).toBe(1);
  });

  it("completing a default-list task in Google completes it here too", async () => {
    const id = addTask({ title: "Physics diagnostic", gtasksId: "phys1" });
    db.prepare("UPDATE task SET gtasks_list = '@default' WHERE id = ?").run(id);
    const deps = fakeDeps([[]], {
      defaultListPages: [[{ id: "phys1", title: "Physics diagnostic", status: "completed", completed: "2026-08-07T20:00:00Z" }]],
    });
    await reconcileGoogleTasks(db, connected, deps);
    expect(task(id).status).toBe("done");
  });

  it("a default-list task missing from BOTH lists defers, same as a POS-list deletion", async () => {
    const id = addTask({ title: "Deleted on phone", gtasksId: "gonex" });
    db.prepare("UPDATE task SET gtasks_list = '@default' WHERE id = ?").run(id);
    const deps = fakeDeps([[]]);
    await reconcileGoogleTasks(db, connected, deps);
    expect(task(id).status).toBe("deferred");
  });
});


// ── the midnight-deadline echo (owner-visible 2026-08-07) ────────────────────
//
// pushTasks derives `due` from plan_date; the pull then read OUR OWN date back as "the
// owner edited the due date" and wrote hard_deadline_at = plan_date at midnight — a
// deadline already in the past, so the solver refused to place every pushed task
// ("deadline_conflict" into a wide-open day: physics diagnostic, film/edit and four more).
describe("due-date echo and date-only semantics", () => {
  it("our own plan_date coming back as due is NOT an edit", async () => {
    const id = addTask({ title: "Film & edit Instagram content", gtasksId: "g1" });
    db.prepare("UPDATE task SET plan_date = '2026-08-07' WHERE id = ?").run(id);
    const deps = fakeDeps([[
      // exactly what pushTasks sent: plan_date at UTC midnight, remote clock newer
      { id: "g1", title: "Film & edit Instagram content", status: "needsAction",
        due: "2026-08-07T00:00:00.000Z", updated: "2026-08-07T14:25:00.000Z" },
    ]]);
    await reconcileGoogleTasks(db, connected, deps);
    const row = task(id);
    expect(row.hard_deadline_at).toBeNull(); // never fabricate a midnight deadline
    expect(row.plan_date).toBe("2026-08-07");
  });

  it("a genuinely moved due date moves plan_date — a day, not a midnight clock time", async () => {
    const id = addTask({ title: "Errand", gtasksId: "g2" });
    db.prepare("UPDATE task SET plan_date = '2026-08-07' WHERE id = ?").run(id);
    const deps = fakeDeps([[
      { id: "g2", title: "Errand", status: "needsAction",
        due: "2026-08-09T00:00:00.000Z", updated: "2026-08-07T15:00:00.000Z" },
    ]]);
    const res = await reconcileGoogleTasks(db, connected, deps);
    expect(res.pulled).toBe(1);
    const row = task(id);
    expect(row.plan_date).toBe("2026-08-09");
    expect(row.hard_deadline_at).toBeNull();
  });

  it("an import from Google carries plan_date only — no fabricated deadline", async () => {
    const deps = fakeDeps([[]], {
      defaultListPages: [[{ id: "phys2", title: "Physics diagnostic", status: "needsAction", due: "2026-08-07T00:00:00.000Z" }]],
    });
    await reconcileGoogleTasks(db, connected, deps);
    const row = db.prepare("SELECT * FROM task WHERE gtasks_id = 'phys2'").get() as any;
    expect(row.plan_date).toBe("2026-08-07");
    expect(row.hard_deadline_at).toBeNull();
  });
});

// ── stray pushed rows relink instead of importing (the "Call family ×3" case) ─
describe("pos:task marker", () => {
  it("parses the marker out of pushed notes", () => {
    expect(taskIdFromNotes("some note\npos:task:45")).toBe(45);
    expect(taskIdFromNotes("pos:commitment:9")).toBeNull();
    expect(taskIdFromNotes(null)).toBeNull();
  });

  it("an unlinked marker row RELINKS to its task instead of importing a duplicate", async () => {
    const id = addTask({ title: "Call family" }); // crashed mid-push: no gtasks_id locally
    const deps = fakeDeps([[
      { id: "stray1", title: "Call family", status: "needsAction", notes: `pos:task:${id}` },
    ]]);
    const res = await reconcileGoogleTasks(db, connected, deps);
    expect(task(id).gtasks_id).toBe("stray1");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Call family'").get() as any).n;
    expect(n).toBe(1); // relinked, not duplicated
    expect(res.pulled).toBe(1);
  });

  it("a marker row whose task is already linked elsewhere is skipped, never imported", async () => {
    const id = addTask({ title: "Call family", gtasksId: "real1" });
    const deps = fakeDeps([[
      { id: "real1", title: "Call family", status: "needsAction", notes: `pos:task:${id}` },
      { id: "stray2", title: "Call family", status: "needsAction", notes: `pos:task:${id}` },
    ]]);
    await reconcileGoogleTasks(db, connected, deps);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Call family'").get() as any).n;
    expect(n).toBe(1);
    expect(task(id).gtasks_id).toBe("real1"); // the real link is untouched
  });
});
