// loadReconnect (main/crm/reconnect.ts): the panel's read must survive a failing refresh.
// Regression for 2026-09-19 — a transient write failure came back to the owner as an empty
// Reconnect panel under "Nobody is overdue. Nice." instead of the 92 people actually due.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { loadReconnect, refreshNextTouch } from "../main/crm/reconnect.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-reconnect-load-"));
  db = openDb(path.join(dir, "pos.db"));
  // Tier-2 person last heard from 400 days ago: overdue by any cadence, past every grace.
  db.prepare(
    "INSERT INTO person (display_name, tier, last_contact_at) VALUES ('Ben Mimmack', 2, datetime('now','-400 days'))"
  ).run();
  refreshNextTouch(db); // stamps next_touch_due_at the way the app's first call would
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadReconnect", () => {
  it("returns the due list when the refresh succeeds", () => {
    expect(loadReconnect(db).map((r) => r.display_name)).toEqual(["Ben Mimmack"]);
  });
  it("still returns the due list when the refresh throws (e.g. SQLITE_BUSY)", () => {
    const busy = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "transaction") return () => () => { throw new Error("database is locked"); };
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    expect(loadReconnect(busy).map((r) => r.display_name)).toEqual(["Ben Mimmack"]);
  });
});
