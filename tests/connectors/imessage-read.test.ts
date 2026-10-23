// iMessage read state (owner ask 2026-09-11): chat.db's is_read / date_read set read_at at
// ingest, and mirrorImessageReadState catches up rows he read on his phone AFTER POS
// ingested them. Unread → read only; nothing here ever clears read_at.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../../main/db/db.ts";
import { syncImessage, mirrorImessageReadState } from "../../main/connectors/imessage.ts";
import { getCursor, type ConnectorDeps } from "../../main/connectors/common.ts";
import type { SecretStore } from "../../main/secrets.ts";

const APPLE_EPOCH_MS = 978307200000;
const nsAt = (unixMs: number): bigint => BigInt(unixMs - APPLE_EPOCH_MS) * 1_000_000n;
const DAY = 86_400_000;
const HANDLE = "+14155550123";

let dir: string;
let db: Db;
let chatDbPath: string;

type Msg = { rowid: number; guid: string; text: string; atMs: number; fromMe?: boolean; read?: boolean; readAtMs?: number };

function buildChatDb(messages: Msg[]) {
  const chat = new Database(chatDbPath);
  chat.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
      attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER,
      is_read INTEGER DEFAULT 0, date_read INTEGER DEFAULT 0);
  `);
  chat.prepare("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run(HANDLE);
  chat.prepare("INSERT INTO chat (ROWID, guid) VALUES (1, 'iMessage;-;+14155550123')").run();
  chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
  for (const m of messages) setMessage(chat, m);
  chat.close();
}
function setMessage(chat: Database.Database, m: Msg) {
  chat
    .prepare(
      `INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, is_read, date_read)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(ROWID) DO UPDATE SET is_read = excluded.is_read, date_read = excluded.date_read`
    )
    .run(m.rowid, m.guid, m.text, nsAt(m.atMs), m.fromMe ? 1 : 0, m.read ? 1 : 0, m.readAtMs ? nsAt(m.readAtMs) : 0);
  chat.prepare("INSERT OR IGNORE INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(m.rowid);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-imsg-read-"));
  db = openDb(path.join(dir, "pos.db"));
  chatDbPath = path.join(dir, "chat.db");
  const pid = Number(db.prepare("INSERT INTO person (display_name) VALUES ('Known Friend')").run().lastInsertRowid);
  db.prepare("INSERT INTO alias (person_id, kind, value, source) VALUES (?, 'imessage_handle', ?, 'test')").run(pid, HANDLE);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (): ConnectorDeps => ({ db, secrets: null as unknown as SecretStore });
const readAt = (guid: string) =>
  (db.prepare("SELECT read_at FROM interaction WHERE channel = 'imessage' AND external_id = ?").get(guid) as { read_at: string | null }).read_at;

describe("ingest carries chat.db read state", () => {
  it("inbound read → read_at = date_read; inbound unread → NULL; outbound → read", async () => {
    const now = Date.now();
    buildChatDb([
      { rowid: 1, guid: "g-read", text: "seen it", atMs: now - 2 * DAY, read: true, readAtMs: now - 1 * DAY },
      { rowid: 2, guid: "g-unread", text: "not yet", atMs: now - 1 * DAY },
      { rowid: 3, guid: "g-mine", text: "my reply", atMs: now - 0.5 * DAY, fromMe: true },
    ]);
    const r = await syncImessage(deps(), { chatDbPath });
    expect(r.error).toBeUndefined();
    expect(r.ingested).toBe(3);
    expect(readAt("g-read")).toBe(new Date(now - 1 * DAY).toISOString());
    expect(readAt("g-unread")).toBeNull();
    expect(readAt("g-mine")).not.toBeNull();
  });
});

describe("mirrorImessageReadState", () => {
  it("marks rows read on the phone after ingest, advances the cursor, and is idempotent", async () => {
    const now = Date.now();
    buildChatDb([
      { rowid: 1, guid: "g-a", text: "a", atMs: now - 2 * DAY },
      { rowid: 2, guid: "g-b", text: "b", atMs: now - 1 * DAY },
    ]);
    await syncImessage(deps(), { chatDbPath });
    expect(readAt("g-a")).toBeNull();
    expect(readAt("g-b")).toBeNull();

    // He reads "a" on his phone.
    const chat = new Database(chatDbPath);
    setMessage(chat, { rowid: 1, guid: "g-a", text: "a", atMs: now - 2 * DAY, read: true, readAtMs: now - 3600_000 });
    const first = mirrorImessageReadState(db, chat);
    expect(first.marked).toBe(1);
    expect(readAt("g-a")).toBe(new Date(now - 3600_000).toISOString());
    expect(readAt("g-b")).toBeNull();
    expect(getCursor(db, "imessage_read")).toBe(nsAt(now - 3600_000).toString());

    // Nothing new → nothing marked, cursor untouched.
    expect(mirrorImessageReadState(db, chat).marked).toBe(0);
    expect(getCursor(db, "imessage_read")).toBe(nsAt(now - 3600_000).toString());

    // Then "b" — only receipts newer than the cursor are scanned.
    setMessage(chat, { rowid: 2, guid: "g-b", text: "b", atMs: now - 1 * DAY, read: true, readAtMs: now - 60_000 });
    expect(mirrorImessageReadState(db, chat).marked).toBe(1);
    expect(readAt("g-b")).not.toBeNull();
    chat.close();
  });

  it("catches a message read on another device that carries is_read = 1 but no date_read", async () => {
    const now = Date.now();
    buildChatDb([{ rowid: 1, guid: "g-a", text: "a", atMs: now - 2 * DAY }]);
    await syncImessage(deps(), { chatDbPath });
    expect(readAt("g-a")).toBeNull();

    const chat = new Database(chatDbPath);
    chat.prepare("UPDATE message SET is_read = 1, date_read = 0 WHERE ROWID = 1").run();
    expect(mirrorImessageReadState(db, chat).marked).toBe(1);
    expect(readAt("g-a")).not.toBeNull();
    expect(getCursor(db, "imessage_read")).toBeNull(); // no receipt time → cursor untouched
    expect(mirrorImessageReadState(db, chat).marked).toBe(0); // idempotent
    chat.close();
  });

  it("never touches a row POS already marked read, and the sync itself runs the mirror", async () => {
    const now = Date.now();
    buildChatDb([{ rowid: 1, guid: "g-a", text: "a", atMs: now - 2 * DAY }]);
    await syncImessage(deps(), { chatDbPath });
    db.prepare("UPDATE interaction SET read_at = '2026-09-01T00:00:00.000Z' WHERE external_id = 'g-a'").run();

    const chat = new Database(chatDbPath);
    setMessage(chat, { rowid: 1, guid: "g-a", text: "a", atMs: now - 2 * DAY, read: true, readAtMs: now - 1000 });
    setMessage(chat, { rowid: 2, guid: "g-c", text: "c", atMs: now - 500, read: true, readAtMs: now - 100 });
    chat.close();

    // A second sync ingests g-c (already read on the phone) AND mirrors g-a's receipt —
    // which must not overwrite the earlier POS-side read_at.
    const r = await syncImessage(deps(), { chatDbPath });
    expect(r.ingested).toBe(1);
    expect(readAt("g-a")).toBe("2026-09-01T00:00:00.000Z");
    expect(readAt("g-c")).not.toBeNull();
    expect(getCursor(db, "imessage_read")).toBe(nsAt(now - 100).toString());
  });
});
