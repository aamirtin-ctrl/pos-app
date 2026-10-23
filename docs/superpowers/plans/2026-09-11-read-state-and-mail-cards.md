# Messaging read state + mail cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messaging shows a real unread dot mirrored from chat.db and IMAP (with `\Seen` write-back on open), and mail rows render as mail cards with the full stored body and a "previous emails" toggle.

**Architecture:** One nullable `interaction.read_at` column is the whole read model (NULL = unread). Connectors set it at ingest and run an unread→read mirror pass on every tick; `markConversationRead` sets it from the UI and hands mail Message-IDs to a fire-and-forget IMAP `\Seen` write. The mail connector starts storing plain-text bodies in the existing `body_raw` column; the renderer splits quoted history off at display time.

**Tech Stack:** Electron main (TypeScript, better-sqlite3, imapflow, mailparser), React 19 renderer, vitest.

Spec: `docs/superpowers/specs/2026-09-11-read-state-and-mail-cards-design.md`.

## Global Constraints

- Migrations are forward-only; append version 22, never edit earlier ones.
- `EMAIL_CHANNELS = ["gmail", "outlook", "icloud", "mailfile"]` (messaging.ts) is the mail set everywhere.
- Mirror passes only ever set `read_at`; nothing clears it.
- `MAIL_BODY_MAX = 64_000` chars; `BODY_FILL_BATCH = 150` rows per tick; mirror window = 30 days.
- No new badges/pills/icons in the UI; the needs-reply dot is removed, the dot means unread.
- Tests: `npm test` (vitest). Build: `npm run build`.

---

### Task 1: `read_at` column + `insertInteraction` fields

**Files:**
- Modify: `main/db/migrations.ts` (append version 22)
- Modify: `main/connectors/common.ts:1-95` (NewInteraction, insertInteraction, header comment)
- Modify: `main/connectors/linkedin-email.ts:261`, `main/connectors/mailfile.ts:179`, `main/connectors/linkedin.ts:297` (pass `readAt`)
- Test: `tests/read-state.test.ts`

**Interfaces:**
- Produces: `NewInteraction.readAt?: string | null`, `NewInteraction.bodyRaw?: string | null`. Default when `readAt` is omitted: inbound → `null`, anything else → `occurredAt ?? now`.

- [ ] Step 1: test — migration backfill and insert defaults

```ts
// tests/read-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../main/db/migrations.ts";
import { openDb, type Db } from "../main/db/db.ts";
import { insertInteraction } from "../main/connectors/common.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-read-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const DAY = 86_400_000;
const iso = (agoDays: number) => new Date(Date.now() - agoDays * DAY).toISOString();

/** Open a DB at version 21, seed rows, then let openDb apply 22. */
function seedThenMigrate(seed: (raw: Database.Database) => void): Db {
  const p = path.join(dir, "pos.db");
  const raw = new Database(p);
  for (const m of MIGRATIONS.filter((m) => m.version <= 21)) { raw.exec(m.sql); raw.pragma(`user_version = ${m.version}`); }
  seed(raw); raw.close();
  return openDb(p);
}

describe("migration 22 backfill", () => {
  it("leaves recent inbound mail/iMessage unread, marks everything else read", () => {
    const db = seedThenMigrate((raw) => {
      raw.prepare("INSERT INTO person (id, display_name) VALUES (1, 'A')").run();
      const ins = raw.prepare("INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id) VALUES (1, ?, ?, ?, ?)");
      ins.run("gmail", "inbound", iso(2), "recent-mail");
      ins.run("imessage", "inbound", iso(2), "recent-imsg");
      ins.run("gmail", "inbound", iso(40), "old-mail");
      ins.run("gmail", "outbound", iso(2), "sent-mail");
      ins.run("linkedin", "inbound", iso(2), "recent-li");
      ins.run("notes", null, null, "note");
    });
    const rows = Object.fromEntries((db.prepare("SELECT external_id, read_at FROM interaction").all() as { external_id: string; read_at: string | null }[]).map((r) => [r.external_id, r.read_at]));
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
  it("inbound defaults unread, outbound defaults read, explicit values win, bodyRaw stored", () => {
    const db = openDb(path.join(dir, "pos.db"));
    db.prepare("INSERT INTO person (id, display_name) VALUES (1, 'A')").run();
    insertInteraction(db, { personId: 1, channel: "gmail", direction: "inbound", occurredAt: iso(1), externalId: "in", bodyRaw: "full text" });
    insertInteraction(db, { personId: 1, channel: "gmail", direction: "outbound", occurredAt: iso(1), externalId: "out" });
    insertInteraction(db, { personId: 1, channel: "gmail", direction: "inbound", occurredAt: iso(1), externalId: "in-read", readAt: iso(0) });
    const get = (id: string) => db.prepare("SELECT read_at, body_raw FROM interaction WHERE external_id = ?").get(id) as { read_at: string | null; body_raw: string | null };
    expect(get("in").read_at).toBeNull();
    expect(get("in").body_raw).toBe("full text");
    expect(get("out").read_at).toBe(iso(1));
    expect(get("in-read").read_at).not.toBeNull();
    db.close();
  });
});
```

- [ ] Step 2: run `npx vitest run tests/read-state.test.ts` — expect FAIL (no column `read_at`).
- [ ] Step 3: append migration 22 to `MIGRATIONS`:

```ts
  {
    version: 22,
    name: "interaction_read_at",
    sql: `
-- Owner ask 2026-09-11: Messaging's dot must mean UNREAD, mirrored from the sources
-- (chat.db is_read, IMAP \\Seen), not "nobody replied yet". NULL = unread.
-- Backfill: outbound/mutual rows, rows from channels with no read source, and anything
-- older than 30 days are read. Recent inbound mail + iMessage stay NULL until the first
-- sync mirrors their true state from the source (the mirror only ever sets read_at).
ALTER TABLE interaction ADD COLUMN read_at TEXT;
UPDATE interaction
   SET read_at = COALESCE(occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE direction IS NOT 'inbound'
    OR channel NOT IN ('gmail', 'outlook', 'icloud', 'imessage')
    OR occurred_at IS NULL
    OR occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days');
CREATE INDEX IF NOT EXISTS idx_interaction_unread ON interaction(channel, occurred_at) WHERE read_at IS NULL;
`,
  },
```

- [ ] Step 4: `common.ts` — extend `NewInteraction` with `readAt?: string | null; bodyRaw?: string | null;`, insert both columns, default `readAt` as in Interfaces; update the header comment (lines 4-5) to record the 2026-09-11 reversal for mail bodies.
- [ ] Step 5: pass `readAt` explicitly at the three "always read" inbound sites: linkedin-email (`readAt: when.toISOString()`), mailfile (`readAt: row.occurredAt ? row.occurredAt.toISOString() : new Date().toISOString()`), linkedin.ts:297 (`readAt: row.occurredAt ? row.occurredAt.toISOString() : new Date().toISOString()`).
- [ ] Step 6: run the test file — PASS. Run `npm test` — all green.

### Task 2: `listInbox.unread`, thread fields, `markConversationRead`

**Files:**
- Modify: `main/messaging.ts`
- Test: `tests/messaging.test.ts` (extend `addInteraction` helper with `readAt?`, `body?`)

**Interfaces:**
- Produces: `InboxItem.unread: 0 | 1`; `ThreadMessage.read_at: string | null`; `ThreadMessage.body: string | null`;
  `markConversationRead(db: Db, threadKey: string): { marked: number; mailIds: string[] }`.

- [ ] Step 1: tests

```ts
describe("read state", () => {
  it("unread is 1 when any inbound row in the conversation has read_at NULL, thread rows carry read_at + body", () => {
    const a = addPerson("A");
    addInteraction(a, { direction: "inbound", occurredAt: "2026-09-01T10:00:00Z", body: "hi", readAt: "2026-09-01T11:00:00Z" });
    addInteraction(a, { channel: "gmail", direction: "inbound", occurredAt: "2026-09-02T10:00:00Z", body: "mail", bodyRaw: "full mail body" });
    const [it0] = listInbox(db);
    expect(it0.unread).toBe(1);
    expect(it0.thread.map((m) => m.read_at === null)).toEqual([false, true]);
    expect(it0.thread[1].body).toBe("full mail body");
  });
  it("markConversationRead scopes a 1:1 by person (mail rows with a thread id included, group rows excluded) and returns mail ids", () => {
    const a = addPerson("A");
    addInteraction(a, { channel: "gmail", direction: "inbound", occurredAt: "2026-09-02T10:00:00Z", externalId: "<m1@x.com>", threadExternalId: "<root@x.com>" });
    addInteraction(a, { direction: "inbound", occurredAt: "2026-09-02T11:00:00Z", externalId: "g1" });
    addInteraction(a, { direction: "inbound", occurredAt: "2026-09-02T12:00:00Z", externalId: "g2", threadExternalId: "chat-guid" });
    const r = markConversationRead(db, `person:${a}`);
    expect(r).toEqual({ marked: 2, mailIds: ["<m1@x.com>"] });
    expect(db.prepare("SELECT read_at FROM interaction WHERE external_id = 'g2'").get()).toEqual({ read_at: null });
    expect(markConversationRead(db, `person:${a}`)).toEqual({ marked: 0, mailIds: [] }); // idempotent
    expect(markConversationRead(db, "chat:chat-guid").marked).toBe(1);
  });
});
```

(`addInteraction` gains `externalId?`, `readAt?`, `bodyRaw?` and inserts `read_at`, `body_raw`; existing calls keep working because inbound rows default to NULL read_at in the helper.)

- [ ] Step 2: run → FAIL (`unread` undefined / `markConversationRead` not exported).
- [ ] Step 3: implement — select `i.read_at` in the scan; bucket `unread` = any row with `read_at IS NULL`; thread statements add `i.read_at, i.body_raw AS body`; add the function:

```ts
export function markConversationRead(db: Db, threadKey: string): { marked: number; mailIds: string[] } {
  type Row = { id: number; channel: string; external_id: string | null };
  let rows: Row[];
  if (threadKey.startsWith("chat:")) {
    rows = db.prepare(`SELECT id, channel, external_id FROM interaction
       WHERE thread_external_id = ? AND direction = 'inbound' AND read_at IS NULL`).all(threadKey.slice(5)) as Row[];
  } else if (threadKey.startsWith("person:")) {
    rows = db.prepare(`SELECT id, channel, external_id FROM interaction
       WHERE person_id = ? AND direction = 'inbound' AND read_at IS NULL
         AND (thread_external_id IS NULL OR channel IN (${EMAIL_CHANNELS.map(() => "?").join(",")}))`)
      .all(Number(threadKey.slice(7)), ...EMAIL_CHANNELS) as Row[];
  } else return { marked: 0, mailIds: [] };
  if (rows.length === 0) return { marked: 0, mailIds: [] };
  const now = new Date().toISOString();
  const upd = db.prepare("UPDATE interaction SET read_at = ? WHERE id = ? AND read_at IS NULL");
  db.transaction(() => { for (const r of rows) upd.run(now, r.id); })();
  const mail = new Set<string>(EMAIL_CHANNELS);
  const mailIds = rows.filter((r) => mail.has(r.channel)).map((r) => normalizeMessageId(r.external_id)).filter((x): x is string => !!x);
  return { marked: rows.length, mailIds };
}
```

- [ ] Step 4: run messaging tests → PASS.

### Task 3: mail — body storage, `\Seen` at ingest, mirror pass, write-back

**Files:**
- Create: `main/connectors/mail-read.ts`
- Modify: `main/connectors/gmail.ts` (extract `openImapClient`, add `flags: true`, pass `readAt`/`bodyRaw`, call mirror inside the INBOX lock, update header comment)
- Test: `tests/connectors/mail-read.test.ts`

**Interfaces:**
- Produces:
  - `MAIL_BODY_MAX = 64_000`, `BODY_FILL_BATCH = 150`, `MIRROR_WINDOW_DAYS = 30`
  - `mailBodyText(parsed: { text?: string; html?: string | false }): string | null`
  - `interface ImapReadClient { search(q, opts): Promise<number[] | false>; fetch(range, q, opts): AsyncIterable<{ uid: number; flags?: Set<string>; envelope?: { messageId?: string }; source?: Buffer }>; messageFlagsAdd(range: number[], flags: string[], opts): Promise<boolean> }`
  - `mirrorMailReadState(db, client: ImapReadClient, opts?: { now?: Date; bodyBatch?: number }): Promise<{ markedRead: number; bodiesFilled: number }>` — caller holds the INBOX lock.
  - `markSeenOnServer(secrets, mailIds: string[], openClient?: (a: MailAccount) => Promise<ImapSession>): Promise<{ flagged: number }>` where `ImapSession = ImapReadClient & { connect(): Promise<void>; getMailboxLock(p: string): Promise<{ release(): void }>; logout(): Promise<void> }`.
  - `openImapClient(secrets, account): Promise<ImapFlow>` exported from gmail.ts (constructed, not connected; throws `oauth_expired` / `not-configured`).

- [ ] Step 1: tests with a fake client (search returns fixed uids; fetch yields envelopes/flags/sources built with a tiny RFC822 string; messageFlagsAdd records calls). Cases: seen row → read_at set; unseen row stays NULL; body filled for rows lacking body_raw, capped by `bodyBatch`; already-read row with body untouched (no fetch at all when nothing to do); `markSeenOnServer` searches `{ header: { "message-id": id } }` and adds `\\Seen` once per found id, skipping accounts once all ids are found; `mailBodyText` prefers text, strips html, caps length.
- [ ] Step 2: run → FAIL (module missing).
- [ ] Step 3: implement `mail-read.ts` (code in Interfaces; body of mirror: query candidates `SELECT id, external_id, read_at, (body_raw IS NULL) AS needs_body FROM interaction WHERE direction='inbound' AND channel IN (email) AND occurred_at >= ? AND (read_at IS NULL OR body_raw IS NULL)`; map by `normalizeMessageId(external_id)`; `search({ since })`; envelope+flags fetch; `UPDATE … SET read_at = ? WHERE id = ? AND read_at IS NULL` for seen; collect body uids, slice to batch, `fetch(uids, { uid: true, source: true }, { uid: true })`, `simpleParser`, `UPDATE … SET body_raw = ? WHERE id = ? AND body_raw IS NULL`).
- [ ] Step 4: gmail.ts — extract lines 218-256 into `openImapClient`; in the fetch add `flags: true`; insert passes `readAt: outbound ? when.toISOString() : msg.flags?.has("\\Seen") ? new Date().toISOString() : null` and `bodyRaw: mailBodyText(parsed)`; after the ingest loop for `box === "INBOX"` (still locked) `try { await mirrorMailReadState(db, client) } catch (e) { console.warn(...) }`.
- [ ] Step 5: run tests → PASS; `npm run build:main` → OK.

### Task 4: iMessage — `is_read` at ingest + mirror pass

**Files:**
- Modify: `main/connectors/imessage.ts` (CHAT_MESSAGE_SQL, ChatMessageRow, both insert sites, new `mirrorImessageReadState`, call from `syncImessage`)
- Modify: `tests/connectors/imessage-cursor.test.ts`, `tests/llm-batching.test.ts` (fixture `message` table gains `is_read INTEGER DEFAULT 0, date_read INTEGER DEFAULT 0`)
- Test: `tests/connectors/imessage-read.test.ts`

**Interfaces:**
- Produces: `mirrorImessageReadState(db: Db, chat: SqliteDatabase, opts?: { now?: Date }): { marked: number }`; cursor `sync_state.source = 'imessage_read'` (Apple-epoch ns of the newest `date_read` seen).

- [ ] Step 1: tests — fixture with `is_read`/`date_read`: (a) `syncImessage` ingests an inbound read row with `read_at` set and an unread one NULL, outbound read; (b) a row ingested unread, then fixture updated to `is_read=1, date_read=now` → `mirrorImessageReadState` marks it, cursor advances, second call marks 0; (c) a row POS already marked read (read_at set) is untouched (value unchanged).
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement:

```ts
const READ_CURSOR = "imessage_read";
const READ_SQL = `SELECT m.ROWID AS rowid, m.guid AS guid, m.date_read AS date_read
  FROM message m WHERE m.is_from_me = 0 AND m.is_read = 1 AND m.date_read > ? ORDER BY m.date_read ASC`;
export function mirrorImessageReadState(db: Db, chat: SqliteDatabase, opts: { now?: Date } = {}): { marked: number } {
  const cursor = getCursor(db, READ_CURSOR);
  let floor = cursor && /^\d+$/.test(cursor) ? BigInt(cursor) : windowFloorNs(1);
  const stmt = chat.prepare(READ_SQL); stmt.safeIntegers(true);
  const rows = stmt.all(floor) as { rowid: bigint; guid: string | null; date_read: bigint }[];
  const upd = db.prepare(`UPDATE interaction SET read_at = ? WHERE channel = 'imessage' AND read_at IS NULL AND external_id IN (?, ?)`);
  let marked = 0; let max = floor;
  for (const r of rows) {
    const at = r.date_read > 0n ? appleDateToDate(r.date_read) : (opts.now ?? new Date());
    marked += upd.run(at.toISOString(), r.guid ?? "", `imessage:${r.rowid}`).changes;
    if (r.date_read > max) max = r.date_read;
  }
  if (max > floor) setCursor(db, READ_CURSOR, max.toString());
  return { marked };
}
```

  Ingest: `readAt: row.is_from_me === 1n ? occurredAt : row.is_read === 1n ? appleDateToDate(row.date_read > 0n ? row.date_read : row.date).toISOString() : null` at both insert sites. Call the mirror right after the ingest loop in `syncImessage` (inside the try, before `finally`), logging `imessage: mirrored N read receipt(s)` when N > 0.

- [ ] Step 4: run → PASS; whole suite green.

### Task 5: IPC + preload + types

**Files:**
- Modify: `main/ipc.ts:790-796`, `preload/index.ts:183-189`, `renderer/src/pos.d.ts:164`

- [ ] Step 1: `h("inbox.markRead", (args: { threadKey: string }) => { const r = markConversationRead(db, args.threadKey); if (r.mailIds.length) void markSeenOnServer(secrets, r.mailIds).catch((e) => console.warn(\`mail: \\Seen write-back failed: ${(e as Error).message}\`)); return r; })`; preload `markRead: call("inbox.markRead")`; d.ts `markRead: Call`.
- [ ] Step 2: `npm run build:main && npm run build:preload` → OK.

### Task 6: quoted-text splitter

**Files:**
- Create: `renderer/src/inbox/quoted.ts`
- Test: `tests/quoted.test.ts`

**Interfaces:**
- Produces: `splitQuoted(text: string): { visible: string; quoted: string | null }`.

- [ ] Step 1: tests — Gmail single-line "On Tue, Sep 9, 2026 at 3:12 PM Jane <j@x.com> wrote:", the wrapped two-line form, Outlook `From:` + `Sent:` block, `-----Original Message-----`, `---------- Forwarded message ---------`, a run of `>` lines, a single `>` line (NOT split), plain text (quoted null), all-quoted text (visible = whole text, quoted null).
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement per spec rules; cut at the first matching line index.
- [ ] Step 4: run → PASS.

### Task 7: renderer — unread dot, mark-read on click, mail cards

**Files:**
- Modify: `renderer/src/inbox/Stub.tsx`

- [ ] Step 1: types: `ThreadMessage` + `read_at`, `body`; `InboxItem` + `unread`; `Conversation` + `unread`.
- [ ] Step 2: `choose(c)` replaces both `setSelected(c.key)` call sites in the row: sets selected and, when `c.unread`, optimistically marks the item read in `items` state and calls `window.pos.inbox.markRead({ threadKey: c.key })`. The auto-select effect still calls `setSelected` only.
- [ ] Step 3: list row: dot + `font-semibold` name only when `c.unread`; remove the needs-reply dot.
- [ ] Step 4: `MailCard` component (subject bold, meta line, `whitespace-pre-wrap` body from `splitQuoted(m.body)` or the snippet, toggle "Show previous emails"/"Hide previous emails", quoted block muted with a left border). Thread map renders `MailCard` for `EMAIL_CHANNELS.has(m.channel)`, else the existing bubble.
- [ ] Step 5: `npm run build:renderer` → OK. Launch the app and check the Messaging tab.

### Task 8: verify

- [ ] `npm test` green; `npm run build` OK; app screenshot of Messaging with a mail thread and an iMessage thread.
