// Transient failures must never mint duplicates (owner report 2026-08-19: a quota-starved day
// turned every failed update into a fresh Google copy — ~2,175 rows in one day). Only a real
// 404/410 justifies re-inserting; quota/network/5xx skip and retry next tick.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../main/db/db.ts";
import type { SecretStore } from "../main/secrets.ts";
import { pushTasks, type PushTasksApi } from "../main/gcal/sync.ts";

const secrets = {} as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-push-"));
  db = openDb(path.join(dir, "pos.db"));
  setSetting(db, "pos_tasklist_id", "POS_LIST");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeApi(behavior: { updateThrows?: unknown; deleteThrows?: unknown }) {
  const calls = { insert: 0, update: 0, delete: 0 };
  const api: PushTasksApi = {
    tasklists: {
      get: async () => ({ data: { id: "POS_LIST" } }),
      list: async () => ({ data: { items: [] } }),
      insert: async () => ({ data: { id: "POS_LIST" } }),
    },
    tasks: {
      list: async () => ({ data: { items: [], nextPageToken: undefined } }),
      insert: async () => {
        calls.insert++;
        return { data: { id: "fresh-id" } };
      },
      update: async () => {
        calls.update++;
        if (behavior.updateThrows) throw behavior.updateThrows;
        return { data: { id: "g1" } };
      },
      delete: async () => {
        calls.delete++;
        if (behavior.deleteThrows) throw behavior.deleteThrows;
        return {};
      },
    },
  };
  return { calls, deps: { tasks: () => api } };
}

function addLinkedTask(over: { gtasksList?: string | null; planDate?: string | null } = {}): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                         status, gtasks_id, gtasks_list, plan_date)
       VALUES ('Linked', 'admin', 2, 30, 30, 'planned', 'g1', ?, ?)`
    )
    .run(over.gtasksList ?? null, over.planDate ?? null);
  return Number(r.lastInsertRowid);
}

const quotaErr = () => Object.assign(new Error("Quota Exceeded"), { code: 429 });
const goneErr = () => Object.assign(new Error("Not Found"), { code: 404 });

describe("transient failures never mint duplicates", () => {
  it("quota error on update → NO insert (skip, retry next tick)", async () => {
    addLinkedTask(); // gtasks_list NULL = the POS list → same-list update path
    const { calls, deps } = fakeApi({ updateThrows: quotaErr() });
    const r = await pushTasks(db, secrets, deps);
    expect(calls.update).toBe(1);
    expect(calls.insert).toBe(0);
    expect(r.pushed).toBe(0);
  });

  it("genuine 404 on update → re-insert (the row really is gone)", async () => {
    addLinkedTask();
    const { calls, deps } = fakeApi({ updateThrows: goneErr() });
    await pushTasks(db, secrets, deps);
    expect(calls.insert).toBe(1);
  });

  it("quota error deleting during a list move → NO insert into the target list", async () => {
    // In '@default' but undated → routes to the POS list → move (delete+insert) path.
    addLinkedTask({ gtasksList: "@default", planDate: null });
    const { calls, deps } = fakeApi({ deleteThrows: quotaErr() });
    await pushTasks(db, secrets, deps);
    expect(calls.delete).toBe(1);
    expect(calls.insert).toBe(0);
  });

  it("404 deleting during a move → old copy already gone → insert proceeds", async () => {
    addLinkedTask({ gtasksList: "@default", planDate: null });
    const { calls, deps } = fakeApi({ deleteThrows: goneErr() });
    await pushTasks(db, secrets, deps);
    expect(calls.insert).toBe(1);
  });

  it("clean update → updates in place, no insert", async () => {
    addLinkedTask();
    const { calls, deps } = fakeApi({});
    const r = await pushTasks(db, secrets, deps);
    expect(calls.update).toBe(1);
    expect(calls.insert).toBe(0);
    expect(r.pushed).toBe(0);
  });
});
