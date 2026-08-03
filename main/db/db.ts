// SQLite spine. better-sqlite3, WAL mode, sqlite-vec loaded per-connection.
// The DB self-creates on first run — the .app must never require an external install.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "./migrations.ts";

export type Db = Database.Database;

let vecAvailable = false;

/** True if sqlite-vec loaded on the most recent openDb() connection. */
export function hasVec(): boolean {
  return vecAvailable;
}

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // sqlite-vec: best-effort. Vector retrieval degrades to keyword prefilter without it.
  vecAvailable = false;
  try {
    // In the packaged app the dylib lives in app.asar.unpacked — dlopen can't read asar.
    const vecPath = sqliteVec.getLoadablePath().replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    db.loadExtension(vecPath.replace(/\.dylib$/, "")); // sqlite re-appends the suffix
    vecAvailable = true;
  } catch (e) {
    console.warn(`sqlite-vec unavailable (${(e as Error).message}); vector search disabled`);
  }

  migrate(db);

  if (vecAvailable) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_profile USING vec0(person_id INTEGER PRIMARY KEY, embedding FLOAT[768])`
    );
  }
  return db;
}

/** Forward-only migration runner keyed on PRAGMA user_version. Idempotent. */
export function migrate(db: Db): number {
  let applied = 0;
  const current = () => db.pragma("user_version", { simple: true }) as number;
  for (const m of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (m.version <= current()) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
    applied++;
  }
  return applied;
}

// ── tiny settings helpers (used by meter, gcal, workers) ──
export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
