// interaction.read_at — the whole read model. NULL = unread. Migration 22 backfills:
// outbound/mutual rows, channels with no read source, and anything older than 30 days are
// read; recent inbound mail + iMessage stay NULL until the first sync mirrors the source.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../main/db/migrations.ts";
import { openDb, type Db } from "../main/db/db.ts";
import { insertInteraction } from "../main/connectors/common.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-read-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const iso = (agoDays: number) => new Date(Date.now() - agoDays * DAY).toISOString();

/** Open a DB at version 21, seed rows, then let openDb apply migration 22 over them. */
function seedThenMigrate(seed: (raw: Database.Database) => void): Db {
  const p = path.join(dir, "pos.db");
  const raw = new Database(p);
  for (const m of MIGRATIONS.filter((m) => m.version <= 21)) {
    raw.exec(m.sql);
    raw.pragma(`user_version = ${m.version}`);
  }
  seed(raw);
  raw.close();
  return openDb(p);
}

describe("migration 22 backfill", () => {
  it("leaves recent inbound mail/iMessage unread and marks everything else read", () => {
    const db = seedThenMigrate((raw) => {
      raw.prepare("INSERT INTO person (id, display_name) VALUES (1, 'A')").run();
      const ins = raw.prepare(
        "INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id) VALUES (1, ?, ?, ?, ?)"
      );
      ins.run("gmail", "inbound", iso(2), "recent-mail");
      ins.run("imessage", "inbound", iso(2), "recent-imsg");
      ins.run("gmail", "inbound", iso(40), "old-mail");
      ins.run("gmail", "outbound", iso(2), "sent-mail");
      ins.run("linkedin", "inbound", iso(2), "recent-li");
      ins.run("notes", null, null, "note");
    });
    const rows = Object.fromEntries(
      (db.prepare("SELECT external_id, read_at FROM interaction").all() as {
        external_id: string;
        read_at: string | null;
      }[]).map((r) => [r.external_id, r.read_at])
    );
    expect(rows["recent-mail"]).toBeNull();
    expect(rows["recent-imsg"]).toBeNull();
    expect(rows["old-mail"]).not.toBeNull();
    expect(rows["sent-mail"]).not.toBeNull();
    expect(rows["recent-li"]).not.toBeNull();
    expect(rows["note"]).not.toBeNull();
    db.close();
  });
});

describe("insertInteraction read_at / body_raw", () => {
  it("inbound defaults unread, outbound defaults read, explicit readAt wins, bodyRaw is stored", () => {
    const db = openDb(path.join(dir, "pos.db"));
    db.prepare("INSERT INTO person (id, display_name) VALUES (1, 'A')").run();
    const at = "2026-09-10T10:00:00.000Z";
    insertInteraction(db, {
      personId: 1, channel: "gmail", direction: "inbound", occurredAt: at,
      externalId: "in", bodyRaw: "full text",
    });
    insertInteraction(db, {
      personId: 1, channel: "gmail", direction: "outbound", occurredAt: at, externalId: "out",
    });
    insertInteraction(db, {
      personId: 1, channel: "gmail", direction: "inbound", occurredAt: at,
      externalId: "in-read", readAt: iso(0),
    });
    const get = (id: string) =>
      db.prepare("SELECT read_at, body_raw FROM interaction WHERE external_id = ?").get(id) as {
        read_at: string | null;
        body_raw: string | null;
      };
    expect(get("in").read_at).toBeNull();
    expect(get("in").body_raw).toBe("full text");
    expect(get("out").read_at).toBe(at);
    expect(get("out").body_raw).toBeNull();
    expect(get("in-read").read_at).not.toBeNull();
    db.close();
  });
});
