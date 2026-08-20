// Owner spec 2026-08-20: the Google Tasks tab shows TODAY's habit instances + his own work —
// never the whole planning horizon, never stale rows for days that passed un-done.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../main/db/db.ts";
import type { SecretStore } from "../main/secrets.ts";
import { pushTasks, type PushTasksApi } from "../main/gcal/sync.ts";
import { todayISO } from "../main/dates.ts";

const secrets = {} as unknown as SecretStore;
const TODAY = todayISO();
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-habits-"));
  db = openDb(path.join(dir, "pos.db"));
  setSetting(db, "pos_tasklist_id", "POS_LIST");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeApi() {
  const calls = { insert: [] as string[], deleted: [] as string[], update: 0 };
  const api: PushTasksApi = {
    tasklists: {
      get: async () => ({ data: { id: "POS_LIST" } }),
      list: async () => ({ data: { items: [] } }),
      insert: async () => ({ data: { id: "POS_LIST" } }),
    },
    tasks: {
      list: async () => ({ data: { items: [], nextPageToken: undefined } }),
      insert: async (a: { tasklist: string; requestBody: unknown }) => {
        calls.insert.push((a.requestBody as { title: string }).title);
        return { data: { id: `new-${calls.insert.length}` } };
      },
      update: async () => {
        calls.update++;
        return { data: { id: "x" } };
      },
      delete: async (a: { tasklist: string; task: string }) => {
        calls.deleted.push(a.task);
        return {};
      },
    },
  };
  return { calls, deps: { tasks: () => api } };
}

function addInstance(over: { title?: string; planDate?: string; gtasksId?: string | null; status?: string } = {}): number {
  const tmpl = db
    .prepare("INSERT INTO task (title, block_type, status, recurrence) VALUES ('Gym / workout', 'gym', 'inbox', 'daily')")
    .run();
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                         status, plan_date, gtasks_id, recurrence_parent_id)
       VALUES (?, 'gym', 2, 45, 45, ?, ?, ?, ?)`
    )
    .run(over.title ?? "Gym / workout", over.status ?? "planned", over.planDate ?? TODAY, over.gtasksId ?? null, Number(tmpl.lastInsertRowid));
  return Number(r.lastInsertRowid);
}

describe("habit instances on Google Tasks", () => {
  it("today's instance is pushed; tomorrow's is not", async () => {
    addInstance({ planDate: TODAY, title: "Gym today" });
    addInstance({ planDate: TOMORROW, title: "Gym tomorrow" });
    const { calls, deps } = fakeApi();
    await pushTasks(db, secrets, deps);
    expect(calls.insert).toContain("Gym today");
    expect(calls.insert).not.toContain("Gym tomorrow");
  });

  it("a future instance an old build already pushed gets its remote row taken down", async () => {
    const id = addInstance({ planDate: TOMORROW, gtasksId: "stale-future" });
    const { calls, deps } = fakeApi();
    await pushTasks(db, secrets, deps);
    expect(calls.deleted).toContain("stale-future");
    const row = db.prepare("SELECT gtasks_id FROM task WHERE id = ?").get(id) as { gtasks_id: string | null };
    expect(row.gtasks_id).toBeNull();
  });

  it("a dropped instance's remote row is deleted, not completed", async () => {
    const id = addInstance({ status: "dropped", gtasksId: "missed-day" });
    const { calls, deps } = fakeApi();
    await pushTasks(db, secrets, deps);
    expect(calls.deleted).toContain("missed-day");
    expect(calls.update).toBe(0); // never marked completed
    const row = db.prepare("SELECT gtasks_id FROM task WHERE id = ?").get(id) as { gtasks_id: string | null };
    expect(row.gtasks_id).toBeNull();
  });
});
