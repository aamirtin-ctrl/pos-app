// iMessage cursor semantics. The live bug: the migrated sync_state cursor held the OLD
// CRM's date-shaped value (Apple-epoch nanoseconds, e.g. 804350114209962112) but the
// connector compared it against m.ROWID — no ROWID ever exceeds that, so every run
// matched zero rows and reported ingested=0 with no error, forever. parseImessageCursor
// now classifies the cursor (ROWID vs apple-ns vs apple-s vs ISO date) and date-shaped
// legacy cursors become an m.date floor instead.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  parseImessageCursor,
  syncImessage,
  backfillMissingSenders,
  isAutomatedImessageHandle,
} from "../../main/connectors/imessage.ts";
import { setCursor, getCursor, type ConnectorDeps } from "../../main/connectors/common.ts";
import type { SecretStore } from "../../main/secrets.ts";

const APPLE_EPOCH_MS = 978307200000;
const nsAt = (unixMs: number): bigint => BigInt(unixMs - APPLE_EPOCH_MS) * 1_000_000n;

describe("parseImessageCursor", () => {
  it("null/empty/garbage → full scan (no rowid, no floor)", () => {
    expect(parseImessageCursor(null)).toEqual({ sinceRowid: 0n, dateFloor: 0n });
    expect(parseImessageCursor("")).toEqual({ sinceRowid: 0n, dateFloor: 0n });
    expect(parseImessageCursor("garbage-cursor")).toEqual({ sinceRowid: 0n, dateFloor: 0n });
  });

  it("a plausible integer is a ROWID cursor", () => {
    expect(parseImessageCursor("253241")).toEqual({ sinceRowid: 253241n, dateFloor: 0n });
  });

  it("the live legacy cursor (apple-epoch nanoseconds) becomes a date floor, NOT a rowid", () => {
    const parsed = parseImessageCursor("804350114209962112");
    expect(parsed.sinceRowid).toBe(0n);
    expect(parsed.dateFloor).toBe(804350114209962112n);
  });

  it("apple-epoch seconds (too big for a rowid, too small for ns) scale to ns", () => {
    const parsed = parseImessageCursor("804350114");
    expect(parsed.sinceRowid).toBe(0n);
    expect(parsed.dateFloor).toBe(804350114n * 1_000_000_000n);
  });

  it("an ISO date string becomes an apple-ns date floor", () => {
    const iso = "2026-06-28T19:43:52.383Z";
    const parsed = parseImessageCursor(iso);
    expect(parsed.sinceRowid).toBe(0n);
    expect(parsed.dateFloor).toBe(nsAt(Date.parse(iso)));
  });
});

// ── fixture-DB run: a legacy date cursor must not zero out the scan ──────────

let dir: string;
let db: Db;
let chatDbPath: string;

const HANDLE = "+14155550123";

function buildChatDb(messages: { rowid: number; guid: string; text: string; atMs: number; fromMe?: boolean }[]) {
  const chat = new Database(chatDbPath);
  chat.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
      attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
  `);
  chat.prepare("INSERT INTO handle (ROWID, id) VALUES (1, ?)").run(HANDLE);
  chat.prepare("INSERT INTO chat (ROWID, guid) VALUES (1, 'iMessage;-;+14155550123')").run();
  chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
  for (const m of messages) {
    chat
      .prepare("INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(m.rowid, m.guid, m.text, nsAt(m.atMs), m.fromMe ? 1 : 0);
    chat.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(m.rowid);
  }
  chat.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-imsg-cursor-"));
  db = openDb(path.join(dir, "pos.db"));
  chatDbPath = path.join(dir, "chat.db");
  // The counterpart is ALREADY KNOWN: resolveHandle matches the alias before any
  // AddressBook gate, so no person creation (and no real AddressBook) is needed.
  const pid = Number(db.prepare("INSERT INTO person (display_name) VALUES ('Known Friend')").run().lastInsertRowid);
  db.prepare("INSERT INTO alias (person_id, kind, value, source) VALUES (?, 'imessage_handle', ?, 'test')").run(pid, HANDLE);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (): ConnectorDeps => ({ db, secrets: null as unknown as SecretStore });

describe("syncImessage with a migrated date-shaped cursor", () => {
  it("ingests messages newer than the legacy date floor and advances to a ROWID cursor", async () => {
    const DAY = 86_400_000;
    buildChatDb([
      { rowid: 101, guid: "g-old", text: "before the cursor", atMs: Date.now() - 20 * DAY },
      { rowid: 102, guid: "g-new-1", text: "after the cursor", atMs: Date.now() - 5 * DAY },
      { rowid: 103, guid: "g-new-2", text: "also after", atMs: Date.now() - 2 * DAY, fromMe: true },
    ]);
    // Legacy cursor: the old CRM stored the last message's apple-epoch ns timestamp.
    setCursor(db, "imessage", nsAt(Date.now() - 10 * DAY).toString());

    const report = await syncImessage(deps(), { chatDbPath });

    expect(report.error).toBeUndefined();
    // Pre-fix this was 0: "m.ROWID > <ns timestamp>" matches nothing, silently.
    expect(report.ingested).toBe(2);
    expect(report.created).toBe(0); // matched via alias, nothing invented
    const rows = db
      .prepare("SELECT external_id, direction FROM interaction WHERE channel = 'imessage' ORDER BY external_id")
      .all() as { external_id: string; direction: string }[];
    expect(rows.map((r) => r.external_id)).toEqual(["g-new-1", "g-new-2"]);
    expect(rows[1].direction).toBe("outbound");
    // Cursor is now the max ROWID — future runs are properly incremental.
    expect(getCursor(db, "imessage")).toBe("103");
  });

  it("a follow-up run with the new ROWID cursor ingests nothing and keeps the cursor", async () => {
    const DAY = 86_400_000;
    buildChatDb([{ rowid: 7, guid: "g-1", text: "hello", atMs: Date.now() - 1 * DAY }]);
    const first = await syncImessage(deps(), { chatDbPath });
    expect(first.ingested).toBe(1);
    expect(getCursor(db, "imessage")).toBe("7");

    const second = await syncImessage(deps(), { chatDbPath });
    expect(second.ingested).toBe(0);
    expect(second.error).toBeUndefined();
    expect(getCursor(db, "imessage")).toBe("7");
  });

  it("auto-creates unverified archive-tier contacts for unknown real senders (owner spec 2026-08-05)", async () => {
    const DAY = 86_400_000;
    buildChatDb([{ rowid: 1, guid: "g-known", text: "hi", atMs: Date.now() - 1 * DAY }]);
    // Second 1:1 chat with a counterpart nobody knows. Old policy skipped these;
    // new policy: real unsaved senders become tier-3 'unverified' contacts so the
    // unified inbox shows everyone.
    const chat = new Database(chatDbPath);
    chat.prepare("INSERT INTO handle (ROWID, id) VALUES (2, '+19995550100')").run();
    chat.prepare("INSERT INTO chat (ROWID, guid) VALUES (2, 'iMessage;-;+19995550100')").run();
    chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2)").run();
    chat
      .prepare("INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me) VALUES (2, 'g-unknown', 'spam', NULL, ?, 0)")
      .run(nsAt(Date.now() - 1 * DAY));
    chat.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 2)").run();
    chat.close();

    const d = deps();
    const report = await syncImessage(d, { chatDbPath });
    expect(report.ingested).toBe(2); // both messages land — unknown sender included
    expect(report.created).toBeGreaterThanOrEqual(1);
    const p = d.db
      .prepare(
        `SELECT p.tier, (SELECT COUNT(*) FROM person_tag t WHERE t.person_id = p.id AND t.tag = 'unverified') AS unv
         FROM person p JOIN alias a ON a.person_id = p.id WHERE a.value = '+19995550100'`
      )
      .get() as { tier: number; unv: number };
    expect(p.tier).toBe(3);       // archive tier — never surfaces in Reconnect
    expect(p.unv).toBe(1);        // tagged for easy triage/delete
  });

  it("never invents a contact for a short code / OTP or no-reply sender", async () => {
    const DAY = 86_400_000;
    buildChatDb([{ rowid: 1, guid: "g-known", text: "hi", atMs: Date.now() - 1 * DAY }]);
    const chat = new Database(chatDbPath);
    // 262966 = an Amazon-style short code; noreply@ = Business Chat automation.
    const junk: [number, string, string][] = [
      [2, "262966", "g-shortcode"],
      [3, "noreply@bigco.com", "g-noreply"],
    ] as [number, string, string][];
    for (const [id, handle, guid] of junk) {
      chat.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(id, handle);
      chat.prepare("INSERT INTO chat (ROWID, guid) VALUES (?, ?)").run(id, `iMessage;-;${handle}`);
      chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(id, id);
      chat
        .prepare("INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me) VALUES (?, ?, 'your code is 123456', NULL, ?, 0)")
        .run(id, guid, nsAt(Date.now() - 1 * DAY));
      chat.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(id, id);
    }
    chat.close();

    const report = await syncImessage(deps(), { chatDbPath });
    expect(report.error).toBeUndefined();
    expect(report.ingested).toBe(1); // only the known friend's message
    expect(report.created).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM alias WHERE value LIKE '%262966%' OR value LIKE 'noreply%'").get()
    ).toEqual({ n: 0 });
  });
});

describe("isAutomatedImessageHandle", () => {
  it("rejects short codes and automated addresses, keeps real humans", () => {
    expect(isAutomatedImessageHandle("262966", null)).toBe(true);
    expect(isAutomatedImessageHandle("22395", null)).toBe(true);
    expect(isAutomatedImessageHandle("noreply@bigco.com", "noreply@bigco.com")).toBe(true);
    expect(isAutomatedImessageHandle("notifications@x.com", "notifications@x.com")).toBe(true);
    expect(isAutomatedImessageHandle("+14155550123", null)).toBe(false);
    expect(isAutomatedImessageHandle("sam@icloud.com", "sam@icloud.com")).toBe(false);
  });
});

// Every real sender becomes a contact (owner spec 2026-08-06). Messages skipped under the
// old Contacts-only policy are long past the ROWID cursor, so a normal sync will never see
// them again — backfillMissingSenders walks the window from scratch and repairs them.
describe("backfillMissingSenders", () => {
  const DAY = 86_400_000;
  const UNKNOWN = "+19995550100";

  function seedWithAnUnknownSender() {
    buildChatDb([{ rowid: 1, guid: "g-known", text: "hi", atMs: Date.now() - 1 * DAY }]);
    const chat = new Database(chatDbPath);
    chat.prepare("INSERT INTO handle (ROWID, id) VALUES (2, ?)").run(UNKNOWN);
    chat.prepare("INSERT INTO chat (ROWID, guid) VALUES (2, ?)").run(`iMessage;-;${UNKNOWN}`);
    chat.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2)").run();
    for (const [rowid, guid, text, fromMe] of [
      [2, "g-missed-1", "you never saw this", 0],
      [3, "g-missed-2", "or this", 0],
      [4, "g-missed-3", "and my reply", 1],
    ] as [number, string, string, number][]) {
      chat
        .prepare("INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me) VALUES (?, ?, ?, NULL, ?, ?)")
        .run(rowid, guid, text, nsAt(Date.now() - 2 * DAY), fromMe);
      chat.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, ?)").run(rowid);
    }
    chat.close();
  }

  it("creates the missing contact and ingests the history the cursor already skipped", async () => {
    seedWithAnUnknownSender();
    // The cursor is already past every row — a normal sync is now blind to them.
    setCursor(db, "imessage", "999");
    expect((await syncImessage(deps(), { chatDbPath })).ingested).toBe(0);

    const report = await backfillMissingSenders(db, chatDbPath);
    expect(report.error).toBeUndefined();
    expect(report.createdPeople).toBe(1);
    expect(report.ingested).toBe(3);

    const person = db
      .prepare(
        `SELECT p.id, p.tier, (SELECT COUNT(*) FROM person_tag t WHERE t.person_id = p.id AND t.tag = 'unverified') AS unv
           FROM person p JOIN alias a ON a.person_id = p.id WHERE a.value = ?`
      )
      .get(UNKNOWN) as { id: number; tier: number; unv: number };
    expect(person.tier).toBe(3);
    expect(person.unv).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM interaction WHERE person_id = ?").get(person.id)
    ).toEqual({ n: 3 });

    // the cursor is untouched — the incremental path is unaffected
    expect(getCursor(db, "imessage")).toBe("999");
  });

  it("is idempotent and never re-creates or duplicates a person already on file", async () => {
    seedWithAnUnknownSender();
    setCursor(db, "imessage", "999");
    await backfillMissingSenders(db, chatDbPath);
    const second = await backfillMissingSenders(db, chatDbPath);
    expect(second.createdPeople).toBe(0);
    expect(second.ingested).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM person p JOIN alias a ON a.person_id = p.id WHERE a.value = ?").get(UNKNOWN)
    ).toEqual({ n: 1 });
  });

  it("leaves people who already resolve alone (no duplicate for the known friend)", async () => {
    seedWithAnUnknownSender();
    setCursor(db, "imessage", "999");
    await backfillMissingSenders(db, chatDbPath);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM person WHERE display_name = 'Known Friend'").get()
    ).toEqual({ n: 1 });
    // its message was NOT ingested here — the backfill only writes for people it created
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM interaction WHERE external_id = 'g-known'").get()
    ).toEqual({ n: 0 });
  });

  it("reports chat_db_not_found instead of throwing when there is no chat.db", async () => {
    const report = await backfillMissingSenders(db, path.join(dir, "nope.db"));
    expect(report.error).toBe("chat_db_not_found");
  });
});
