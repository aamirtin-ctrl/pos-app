// Morning capture — ingest the user's SELF-messages (note-to-self email + the iMessage
// note-to-self thread) and route each through the unified assistant (handleCommand), which
// turns braindumps into a generated day plan, notes into contact updates, etc.
// Two exceptions (main/digest.ts): the app's OWN digests (prefix "POS — ") are skipped
// outright, and confirm/drop replies to a digest route to handleDigestReply instead.
//
// Sources:
//   - Email: for every configured mail account, INBOX messages whose From address is the
//     account's own address (self-addressed). Cursor = sync_state `capture:mail:<user>`
//     (ISO of the newest processed message). First run looks back 24h only.
//   - iMessage: setting `capture_self_handles` (comma-separated phones/emails the user says
//     are his own). Copy-first read of chat.db (same safety pattern as the imessage
//     connector — never open the live DB, read a private copy read-only). 1:1 chats whose
//     counterpart handle normalizes to a self handle, is_from_me = 1. Cursor =
//     sync_state `capture:imessage` (message ROWID); first run = last 24h via date filter.
//
// Cursors advance ONLY after handleCommand succeeds for a message, so a failed run retries
// the unprocessed tail next time and nothing is ever processed twice (strict > comparisons
// on both cursors).

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { imapTlsOptions } from "./connectors/tls-ca.ts";
import { simpleParser } from "mailparser";
import type { Db } from "./db/db.ts";
import { getSetting } from "./db/db.ts";
import { normalizeEmail, normalizePhone } from "./crm/normalize.ts";
import { handleCommand } from "./assistant.ts";
import { listMailAccounts, type MailAccount } from "./connectors/gmail.ts";
import { getCursor, setCursor, type ConnectorDeps, type SyncReport } from "./connectors/common.ts";
import { decodeAttributedBody, imessageAvailable, DEFAULT_CHAT_DB } from "./connectors/imessage.ts";
import { isDigestMessage, isDigestReply, handleDigestReply } from "./digest.ts";

const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

// node:sqlite minimal surface (same approach as the imessage connector — no experimental typings).
interface SqliteStatement {
  safeIntegers(enabled: boolean): void;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

// ── pure helpers (unit-tested; no network / no DB) ───────────────────────────

/** Max chars of a self-message fed to the assistant. */
export const CAPTURE_MAX_CHARS = 1500;
/** First-run lookback: last 24 hours only. */
export const FIRST_RUN_MS = 24 * 60 * 60 * 1000;

const APPLE_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z in Unix ms

/**
 * True when `addr` is the account's own address. Case-insensitive; +tag aliases
 * normalize away (aamir+notes@gmail.com == aamir@gmail.com).
 */
export function isSelfAddress(addr: string | null | undefined, own: string | null | undefined): boolean {
  const a = normalizeEmail(addr);
  const b = normalizeEmail(own);
  return !!a && !!b && a.norm === b.norm;
}

/** Comma-separated self handles → set of normalized forms (emails + E.164 phones). */
export function parseSelfHandles(csv: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (csv ?? "").split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    const norm = raw.includes("@") ? normalizeEmail(raw)?.norm : normalizePhone(raw)?.norm;
    if (norm) out.add(norm);
  }
  return out;
}

/** True when an iMessage handle (phone or email) normalizes into the self-handle set. */
export function matchesSelfHandle(handle: string | null | undefined, selfSet: Set<string>): boolean {
  const raw = (handle ?? "").trim();
  if (!raw || selfSet.size === 0) return false;
  const norm = raw.includes("@") ? normalizeEmail(raw)?.norm : normalizePhone(raw)?.norm;
  return !!norm && selfSet.has(norm);
}

/** Window start: the cursor when parseable, else first run = now − 24h. */
export function captureWindowStart(cursor: string | null | undefined, nowMs: number = Date.now()): Date {
  if (cursor && !Number.isNaN(Date.parse(cursor))) return new Date(cursor);
  return new Date(nowMs - FIRST_RUN_MS);
}

/** Unix ms → Apple-epoch nanoseconds (chat.db `message.date` on modern macOS). */
export function unixMsToAppleNs(unixMs: number): bigint {
  return BigInt(Math.max(0, Math.round(unixMs - APPLE_EPOCH_MS))) * 1_000_000n;
}

/**
 * Subject + body → the text handed to the assistant, capped at CAPTURE_MAX_CHARS.
 * Null when the body is empty (empty self-messages are skipped).
 */
export function captureText(
  subject: string | null | undefined,
  body: string | null | undefined
): string | null {
  const b = (body ?? "").trim();
  if (!b) return null;
  const s = (subject ?? "").trim();
  return (s ? `${s}\n${b}` : b).slice(0, CAPTURE_MAX_CHARS);
}

// ── collection ───────────────────────────────────────────────────────────────

export interface SelfMessage {
  channel: "mail" | "imessage";
  text: string;
  /** Commit this message's cursor position — call ONLY after successful processing. */
  advance: () => void;
}

export interface CaptureBatch {
  /** Ascending per cursor within each source — process in order. */
  messages: SelfMessage[];
  skipped: number;
  /** Non-error reasons a source contributed nothing (e.g. handles not configured). */
  notes: string[];
  errors: string[];
}

const emptyBatch = (): CaptureBatch => ({ messages: [], skipped: 0, notes: [], errors: [] });

/** One account's INBOX: self-addressed mail newer than the cursor. Appends into `batch`. */
async function captureFromAccount(db: Db, account: MailAccount, batch: CaptureBatch): Promise<void> {
  const user = account.user.trim();
  if (!user || !account.password) return;

  const cursorSource = `capture:mail:${user}`;
  const cursor = getCursor(db, cursorSource);
  const since = captureWindowStart(cursor);
  const cursorMs = cursor && !Number.isNaN(Date.parse(cursor)) ? Date.parse(cursor) : null;

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: account.password },
    logger: false,
    tls: imapTlsOptions(),
  });

  const collected: { text: string; timeMs: number }[] = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP FROM is a substring match and SINCE is day-granular — both are re-checked
      // precisely per message below.
      const uids = (await client.search({ since, from: user }, { uid: true })) || [];
      if (uids.length) {
        for await (const msg of client.fetch(
          uids,
          { uid: true, source: true, internalDate: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = Array.isArray(parsed.from)
            ? parsed.from[0]?.value?.[0]
            : parsed.from?.value?.[0];
          if (!isSelfAddress(fromAddr?.address, user)) {
            batch.skipped++;
            continue;
          }
          const timeMs = (msg.internalDate ? new Date(msg.internalDate) : parsed.date ?? new Date()).getTime();
          // Strictly newer than the cursor (never process the same message twice) and
          // inside the first-run window.
          if ((cursorMs != null && timeMs <= cursorMs) || timeMs < since.getTime()) {
            batch.skipped++;
            continue;
          }
          const body =
            parsed.text ||
            (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          const text = captureText(parsed.subject, body);
          if (!text) {
            batch.skipped++; // empty body — nothing to route
            continue;
          }
          collected.push({ text, timeMs });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  collected.sort((a, b) => a.timeMs - b.timeMs);
  for (const m of collected) {
    batch.messages.push({
      channel: "mail",
      text: m.text,
      advance: () => setCursor(db, cursorSource, new Date(m.timeMs).toISOString()),
    });
  }
}

/** Self-addressed INBOX mail across every configured account (per-account failures noted). */
export async function captureFromEmail(deps: Pick<ConnectorDeps, "db" | "secrets">): Promise<CaptureBatch> {
  const batch = emptyBatch();
  const accounts = listMailAccounts(deps.secrets);
  if (accounts.length === 0) {
    batch.notes.push("mail: no accounts configured");
    return batch;
  }
  for (const account of accounts) {
    try {
      await captureFromAccount(deps.db, account, batch);
    } catch (e) {
      batch.errors.push(`mail ${account.user}: ${(e as Error).message}`);
    }
  }
  return batch;
}

/** EPERM/EACCES/SQLite authorization failures → the Full Disk Access failure mode. */
function isFdaError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EPERM" || err?.code === "EACCES") return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("authorization denied") || msg.includes("operation not permitted");
}

/**
 * The note-to-self iMessage thread: 1:1 chats whose counterpart handle is one of the
 * user's OWN handles (setting `capture_self_handles`), is_from_me = 1. Copy-first
 * read-only read of chat.db — the live DB is never opened.
 */
export async function captureFromIMessage(
  deps: Pick<ConnectorDeps, "db">,
  chatDbPath: string = DEFAULT_CHAT_DB
): Promise<CaptureBatch> {
  const batch = emptyBatch();
  const { db } = deps;

  const selfSet = parseSelfHandles(getSetting(db, "capture_self_handles"));
  if (selfSet.size === 0) {
    batch.notes.push("imessage: capture_self_handles not set");
    return batch;
  }
  if (!imessageAvailable(chatDbPath)) {
    batch.notes.push("imessage: chat.db unavailable (needs Full Disk Access)");
    return batch;
  }

  const cursorRaw = getCursor(db, "capture:imessage");
  let cursor = 0n;
  try {
    cursor = cursorRaw ? BigInt(cursorRaw) : 0n;
  } catch {
    cursor = 0n;
  }
  // First run only: bound by the last 24h (Apple-epoch ns); afterwards the ROWID cursor rules.
  const windowFloor = cursor === 0n ? unixMsToAppleNs(Date.now() - FIRST_RUN_MS) : 0n;

  // Copy db+wal+shm to a tmpdir, open the COPY read-only — never the live file.
  const workDir = mkdtempSync(join(tmpdir(), "pos-capture-"));
  const workPath = join(workDir, "chat.db");
  try {
    copyFileSync(chatDbPath, workPath);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(chatDbPath + ext)) copyFileSync(chatDbPath + ext, workPath + ext);
    }

    const BetterSqlite = req("better-sqlite3");
    const DatabaseSync = (function (p: string, o?: { readOnly?: boolean }) {
      // Electron's Node has no node:sqlite — better-sqlite3 (already bundled) stands in.
      return new BetterSqlite(p, { readonly: !!o?.readOnly, fileMustExist: true });
    }) as unknown as SqliteModule["DatabaseSync"];
    const chat = new DatabaseSync(workPath, { readOnly: true });
    try {
      chat.exec("PRAGMA query_only = ON;");
      const stmt = chat.prepare(`
        SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body, ch.id AS counterpart
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
        JOIN handle ch ON ch.ROWID = chj.handle_id
        WHERE c.ROWID IN (
          SELECT chat_id FROM chat_handle_join GROUP BY chat_id HAVING COUNT(*) = 1
        )
        AND m.is_from_me = 1
        AND m.ROWID > ?
        AND m.date > ?
        ORDER BY m.ROWID ASC
      `);
      stmt.safeIntegers(true);
      const rows = stmt.all(cursor, windowFloor) as Array<{
        rowid: bigint;
        text: string | null;
        body: Uint8Array | null;
        counterpart: string | null;
      }>;

      for (const row of rows) {
        if (!matchesSelfHandle(row.counterpart, selfSet)) {
          batch.skipped++;
          continue;
        }
        const text = captureText(null, row.text ?? decodeAttributedBody(row.body));
        if (!text) {
          batch.skipped++;
          continue;
        }
        const rowid = row.rowid;
        batch.messages.push({
          channel: "imessage",
          text,
          advance: () => setCursor(db, "capture:imessage", rowid.toString()),
        });
      }
    } finally {
      chat.close();
    }
  } catch (e) {
    batch.errors.push(`imessage: ${isFdaError(e) ? "full_disk_access" : (e as Error).message}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return batch;
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * handleCommand needs doctrineDir. Inside Electron that's userData (pinned to
 * ~/Library/Application Support/pos in main/index.ts); outside Electron (tests) fall
 * back to the same path via os.homedir.
 */
export function resolveDoctrineDir(): string {
  try {
    const electron = req("electron") as { app?: { getPath(name: string): string } };
    const p = electron.app?.getPath("userData");
    if (p) return p;
  } catch {
    /* not running inside Electron */
  }
  return join(homedir(), "Library", "Application Support", "pos");
}

export interface CaptureReport extends SyncReport {
  /** e.g. "2 captures → 1 plan, 1 note" */
  summary?: string;
}

/**
 * Gather all new self-messages (email + iMessage) and route each through the unified
 * assistant sequentially. `ingested` = messages processed. Each message's cursor advances
 * only after its handleCommand resolves; a throw stops the run so the unprocessed tail is
 * retried next time — nothing is ever processed twice.
 */
export async function runCapture(deps: ConnectorDeps): Promise<SyncReport> {
  const report: CaptureReport = { source: "capture", ingested: 0, skipped: 0, created: 0 };
  const doctrineDir = resolveDoctrineDir();

  const batches = [await captureFromEmail(deps), await captureFromIMessage(deps)];
  const errors = batches.flatMap((b) => b.errors);
  const notes = batches.flatMap((b) => b.notes);
  const kinds = new Map<string, number>();

  const cmdDeps = { db: deps.db, secrets: deps.secrets, doctrineDir, llm: deps.llm ?? null };
  outer: for (const batch of batches) {
    report.skipped += batch.skipped;
    for (const m of batch.messages) {
      // The app's own morning digests land in the same self thread — never re-ingest them.
      if (isDigestMessage(m.text)) {
        report.skipped++;
        m.advance();
        continue;
      }
      try {
        // Confirm/drop replies to the digest go to the reply handler, not the assistant.
        if (isDigestReply(m.text)) {
          await handleDigestReply(deps.db, deps.secrets, m.text);
          kinds.set("digest-reply", (kinds.get("digest-reply") ?? 0) + 1);
        } else {
          const res = await handleCommand(cmdDeps, m.text);
          kinds.set(res.kind, (kinds.get(res.kind) ?? 0) + 1);
        }
        report.ingested++;
        m.advance(); // cursor moves only after successful processing
      } catch (e) {
        errors.push(`capture: ${(e as Error).message}`);
        break outer; // unadvanced messages retry next run
      }
    }
  }

  const parts: string[] = [];
  if (report.ingested > 0) {
    const kindStr = [...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
    parts.push(`${report.ingested} capture${report.ingested === 1 ? "" : "s"} → ${kindStr}`);
  } else {
    parts.push("no new self-messages");
  }
  parts.push(...notes);
  report.summary = parts.join("; ");
  if (errors.length) report.error = errors.join("; ");
  return report;
}
