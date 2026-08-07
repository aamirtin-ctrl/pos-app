// The Apple → Google mirror must run itself (owner ask 2026-08-07: an iCloud event
// "should also have that reflect in the google calendar which doesnt have it yet").
// mirrorToGoogle existed but only behind a manual per-day button — so it had never run:
// the "POS — Apple" calendar did not exist on his Google account at all.
//
// The mirror itself talks to googleapis and Calendar.app; here the sweep's ORCHESTRATION
// is what's under test, with both injected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { mirrorAppleSweep } from "../main/workers.ts";
import type { SecretStore } from "../main/secrets.ts";

const connected = { get: (n: string) => (n === "GOOGLE_OAUTH_TOKENS" ? "{}" : null) } as unknown as SecretStore;
const notConnected = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-mirror-sweep-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const appleOk = async () => ({ ok: true });

describe("mirrorAppleSweep", () => {
  it("mirrors today plus the replan horizon, without forcing fresh scans", async () => {
    const calls: { dateISO: string; force: boolean }[] = [];
    const res = await mirrorAppleSweep(db, connected, {
      today: "2026-08-07",
      available: appleOk,
      mirror: async (_db, _s, dateISO, o) => {
        calls.push({ dateISO, force: o.force });
        return { created: 1, updated: 0, deleted: 0 };
      },
    });
    expect(calls.map((c) => c.dateISO)).toEqual(["2026-08-07", "2026-08-08", "2026-08-09"]);
    expect(calls.every((c) => c.force === false)).toBe(true); // tick reuses the warm cache
    expect(res.created).toBe(3);
    expect(res.skipped).toBeUndefined();
  });

  it("one bad day is logged and skipped; the rest still mirror", async () => {
    const res = await mirrorAppleSweep(db, connected, {
      today: "2026-08-07",
      available: appleOk,
      mirror: async (_db, _s, dateISO) => {
        if (dateISO === "2026-08-08") throw new Error("scan hiccup");
        return { created: 0, updated: 1, deleted: 0 };
      },
    });
    expect(res.days).toEqual(["2026-08-07", "2026-08-09"]);
    expect(res.updated).toBe(2);
  });

  it("stays quiet with no Google connection — never a crash in the tick", async () => {
    const res = await mirrorAppleSweep(db, notConnected, { available: appleOk });
    expect(res.skipped).toBe("not_connected");
    expect(res.days).toEqual([]);
  });

  it("stays quiet when Calendar.app is unavailable (permission not granted, not macOS)", async () => {
    const res = await mirrorAppleSweep(db, connected, {
      available: async () => ({ ok: false }),
      mirror: async () => {
        throw new Error("must not be called");
      },
    });
    expect(res.skipped).toBe("apple_unavailable");
  });
});
