// purgeOrphanedGoogleTasks duplicate rules (owner report 2026-08-17: 3,298 rows in the POS
// list). The old purge kept EVERY copy of a live item; now a live task keeps only its
// canonical row (gtasks_id), a live commitment keeps only the first row per marker, and
// unmarked rows the owner typed himself are never touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import type { SecretStore } from "../main/secrets.ts";
import { purgeOrphanedGoogleTasks, type GoogleTaskLite, type GoogleTasksDeps } from "../main/gtasks-sync.ts";

const secrets = {} as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-purge-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(t: { title: string; gtasksId?: string | null; status?: string }): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes, status, gtasks_id)
       VALUES (?, 'admin', 2, 30, 30, ?, ?)`
    )
    .run(t.title, t.status ?? "inbox", t.gtasksId ?? null);
  return Number(r.lastInsertRowid);
}

function addCommitment(desc: string): number {
  const r = db
    .prepare(
      `INSERT INTO commitment (description, status, confirmed_by_user, direction) VALUES (?, 'open', 1, 'i_owe_them')`
    )
    .run(desc);
  return Number(r.lastInsertRowid);
}

function purgeDeps(rows: GoogleTaskLite[]): Partial<GoogleTasksDeps> & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    isConnected: () => true,
    ensureTasklist: async () => "POS_LIST",
    listTasks: async ({ tasklist }) => ({
      items: tasklist === "POS_LIST" ? rows : [],
      nextPageToken: undefined,
    }),
    deleteTask: async ({ task }) => {
      deleted.push(task);
    },
  };
}

const row = (id: string, notes: string | null, title = "X"): GoogleTaskLite => ({ id, title, notes, status: "needsAction" });

describe("purge duplicate rules", () => {
  it("live commitment: keeps the first marker row, dooms every later copy", async () => {
    const cid = addCommitment("Send deck");
    const deps = purgeDeps([
      row("g1", `pos:commitment:${cid}`),
      row("g2", `pos:commitment:${cid}`),
      row("g3", `pos:commitment:${cid}`),
    ]);
    const r = await purgeOrphanedGoogleTasks(db, secrets, { apply: true }, deps as GoogleTasksDeps);
    expect(deps.deleted).toEqual(["g2", "g3"]);
    expect(r.kept).toBe(1);
  });

  it("live task: keeps only the canonical gtasks_id row", async () => {
    const tid = addTask({ title: "Buy bedding", gtasksId: "canonical" });
    const deps = purgeDeps([
      row("stray1", `pos:task:${tid}`),
      row("canonical", `pos:task:${tid}`),
      row("stray2", `pos:task:${tid}`),
    ]);
    await purgeOrphanedGoogleTasks(db, secrets, { apply: true }, deps as GoogleTasksDeps);
    expect(deps.deleted).toEqual(["stray1", "stray2"]);
  });

  it("live task with NULL gtasks_id: keeps + heals the first row, dooms later copies", async () => {
    const tid = addTask({ title: "Unlinked", gtasksId: null });
    const deps = purgeDeps([row("first", `pos:task:${tid}`), row("second", `pos:task:${tid}`)]);
    await purgeOrphanedGoogleTasks(db, secrets, { apply: true }, deps as GoogleTasksDeps);
    expect(deps.deleted).toEqual(["second"]);
    const healed = db.prepare("SELECT gtasks_id FROM task WHERE id = ?").get(tid) as { gtasks_id: string | null };
    expect(healed.gtasks_id).toBe("first");
  });

  it("dead markers and Tentative: rows die; unmarked owner rows never do", async () => {
    const deps = purgeDeps([
      row("dead", "pos:task:99999"),
      row("tent", null, "Tentative: maybe gym"),
      row("his", null, "Buy milk"),
    ]);
    const r = await purgeOrphanedGoogleTasks(db, secrets, { apply: true }, deps as GoogleTasksDeps);
    expect(deps.deleted.sort()).toEqual(["dead", "tent"]);
    expect(r.kept).toBe(1);
  });
});
