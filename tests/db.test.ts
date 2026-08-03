import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate, getSetting, setSetting, type Db } from "../main/db/db.ts";

let dir: string;
let db: Db | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-db-"));
});
afterEach(() => {
  db?.close();
  db = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the DB file (and parent dirs) on first run", () => {
    const p = path.join(dir, "nested", "pos.db");
    db = openDb(p);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("enables WAL mode and foreign keys", () => {
    db = openDb(path.join(dir, "pos.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("applies all migrations; re-running is a no-op", () => {
    db = openDb(path.join(dir, "pos.db"));
    expect(migrate(db)).toBe(0); // already applied inside openDb
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const t of [
      "person", "alias", "interaction", "commitment", "task", "block", "plan",
      "block_outcome", "llm_call", "sync_run", "sync_state", "setting",
      "grp", "person_group", "person_tag", "dismissal", "enrichment_attempt",
      "profile_embedding_meta",
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it("enforces the alias UNIQUE(kind, value) constraint", () => {
    db = openDb(path.join(dir, "pos.db"));
    db.prepare("INSERT INTO person (display_name) VALUES ('A')").run();
    const ins = db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'a@b.c')");
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/);
  });

  it("open enums: slack channel + slack_id alias insert with no schema change", () => {
    db = openDb(path.join(dir, "pos.db"));
    db.prepare("INSERT INTO person (display_name) VALUES ('A')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'slack_id', 'U123')").run();
    db.prepare(
      "INSERT INTO interaction (person_id, channel, external_id) VALUES (1, 'slack', 'msg1')"
    ).run();
    expect(db.prepare("SELECT COUNT(*) c FROM interaction").get()).toEqual({ c: 1 });
  });

  it("settings helpers round-trip", () => {
    db = openDb(path.join(dir, "pos.db"));
    expect(getSetting(db, "ceiling")).toBeNull();
    setSetting(db, "ceiling", "10");
    setSetting(db, "ceiling", "25");
    expect(getSetting(db, "ceiling")).toBe("25");
  });
});
