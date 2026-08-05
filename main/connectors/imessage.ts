// iMessage connector — Mac-only, LOCAL, READ-ONLY. Ported from PersonalCRM2
// connectors/imessage.ts; adapted to the no-staging architecture (resolve inline, write
// directly to `interaction`).
//
// Safety contract (non-negotiable, ported exactly):
//   - Never open the live ~/Library/Messages/chat.db writable, never write to it.
//   - SHA-256 the source, copy db+wal+shm to a tmpdir, open the COPY read-only
//     (node:sqlite DatabaseSync, readOnly + PRAGMA query_only), verify the source's
//     hash after — a changed hash is Messages writing to its own DB, not us.
//   - Store only recency + a ≤200-char snippet (privacy: the user's private history).
//
// Person-creation policy (ported): only counterparts SAVED in macOS Contacts become new
// people. If the AddressBook is unreadable (no Full Disk Access for it), resolve-only —
// create nothing. Unsaved numbers (businesses, 2FA, one-offs) are skipped; their texts
// still attribute to an existing person when an alias matches.
//
// Requires Full Disk Access; EPERM/EACCES/authorization failures surface as
// SyncReport.error = 'full_disk_access'.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEmail, normalizePhone } from "../crm/normalize.ts";
import { resolveHandle } from "../crm/identity.ts";
import { buildNameIndex } from "./addressbook.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  getCursor,
  setCursor,
  createPerson,
  addAlias,
  resolvedPct,
  SNIPPET_MAX,
} from "./common.ts";

// node:sqlite is built into Node 22+; use a minimal local surface so compilation doesn't
// depend on experimental typings (same approach as the source connector).
interface SqliteStatement {
  safeIntegers(enabled: boolean): void;
  get(...params: unknown[]): unknown;
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
const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

const APPLE_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z in Unix ms
const NS_THRESHOLD = 1_000_000_000_000n; // values above this are nanoseconds, else seconds
const DEFAULT_LOOKBACK_MONTHS = 12;

export const DEFAULT_CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");

/** Apple-epoch (ns or s) → JS Date in UTC. */
export function appleDateToDate(raw: bigint): Date {
  const ms =
    raw > NS_THRESHOLD ? APPLE_EPOCH_MS + Number(raw / 1_000_000n) : APPLE_EPOCH_MS + Number(raw) * 1000;
  return new Date(ms);
}

/**
 * Best-effort text recovery from the attributedBody typedstream when `text` is NULL.
 * Layout after the "NSString" class name: ... 0x2b (length marker) then the length
 * (1 byte if < 0x80; or 0x81 + 2-byte LE; or 0x82 + 4-byte LE) then UTF-8 text.
 */
export function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.from(blob);
  const marker = buf.indexOf("NSString");
  if (marker === -1) return null;
  const plus = buf.indexOf(0x2b, marker);
  if (plus === -1 || plus + 1 >= buf.length) return null;

  let i = plus + 1;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i);
    i += 4;
  } else if (len >= 0x80) {
    return null; // unrecognized length encoding — don't guess
  }
  if (len <= 0 || i + len > buf.length) return null;
  const text = buf.subarray(i, i + len).toString("utf8").trim();
  return text.length >= 1 ? text : null;
}

/** EPERM/EACCES/SQLite "authorization denied" → the Full Disk Access failure mode. */
function isFdaError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EPERM" || err?.code === "EACCES") return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("authorization denied") || msg.includes("operation not permitted");
}

/** Cheap scheduler precheck: chat.db exists and is readable (i.e. FDA granted). */
export function imessageAvailable(chatDbPath: string = DEFAULT_CHAT_DB): boolean {
  try {
    if (!existsSync(chatDbPath)) return false;
    accessSync(chatDbPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ImessageOptions {
  chatDbPath?: string;
  /** Lookback window in months for the FIRST run; null = no limit. Default 12. */
  months?: number | null;
}

/** SyncReport plus a skip breakdown, so a 0-ingested run is explainable at a glance. */
export interface ImessageSyncReport extends SyncReport {
  /** Counterparts that resolved to nobody (unknown number, ambiguous, or not in Contacts). */
  skippedUnmatched: number;
  /** Rows already ingested on a previous run (idempotent dedupe). */
  skippedDuplicates: number;
}

export interface ImessageCursor {
  /** Only messages with ROWID above this are read (the normal incremental cursor). */
  sinceRowid: bigint;
  /** Apple-epoch NANOSECOND floor on m.date (legacy date-based cursors land here). */
  dateFloor: bigint;
}

// A chat.db message ROWID is a small counter (thousands–millions). Anything above this
// cannot be a ROWID and must be a date-shaped cursor left behind by the old CRM.
const MAX_PLAUSIBLE_ROWID = 100_000_000n;

/**
 * Interpret the sync_state cursor for 'imessage'. This code writes max-ROWID cursors, but
 * migrated databases carry the OLD CRM's cursor formats: an Apple-epoch timestamp (ns or s)
 * of the last message, or an ISO date string. Comparing those against m.ROWID silently
 * matches zero rows forever (the observed "ingested 0, no error" failure — the live DB held
 * 804350114209962112, an Apple-ns timestamp, as the ROWID cursor). Legacy cursors become a
 * date floor instead; unparseable cursors fall back to a full (window-bounded) scan.
 */
export function parseImessageCursor(raw: string | null): ImessageCursor {
  const none: ImessageCursor = { sinceRowid: 0n, dateFloor: 0n };
  const t = raw?.trim();
  if (!t) return none;
  let n: bigint | null = null;
  try {
    n = BigInt(t);
  } catch {
    n = null;
  }
  if (n !== null) {
    if (n <= 0n) return none;
    if (n > NS_THRESHOLD) return { sinceRowid: 0n, dateFloor: n }; // apple-epoch ns
    if (n > MAX_PLAUSIBLE_ROWID) return { sinceRowid: 0n, dateFloor: n * 1_000_000_000n }; // apple-epoch s
    return { sinceRowid: n, dateFloor: 0n }; // a real ROWID cursor
  }
  const ms = Date.parse(t); // e.g. an ISO date string from the old CRM
  if (!Number.isNaN(ms)) {
    return { sinceRowid: 0n, dateFloor: BigInt(Math.max(0, ms - APPLE_EPOCH_MS)) * 1_000_000n };
  }
  return none; // unrecognized — rescan; INSERT OR IGNORE keeps it idempotent
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function syncImessage(deps: ConnectorDeps, opts: ImessageOptions = {}): Promise<ImessageSyncReport> {
  const { db } = deps;
  const report: ImessageSyncReport = {
    source: "imessage", ingested: 0, skipped: 0, created: 0, skippedUnmatched: 0, skippedDuplicates: 0,
  };
  const srcPath = opts.chatDbPath ?? DEFAULT_CHAT_DB;
  const lookbackMonths = opts.months === undefined ? DEFAULT_LOOKBACK_MONTHS : opts.months;

  if (!existsSync(srcPath)) return { ...report, error: "chat_db_not_found" };

  let sumBefore: string;
  try {
    sumBefore = sha256(srcPath);
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  }

  // Copy the DB (plus WAL/SHM for a consistent read) to a temp dir; open the copy R/O.
  const workDir = mkdtempSync(join(tmpdir(), "pos-chatdb-"));
  const workPath = join(workDir, "chat.db");

  let matched = 0;
  let attempted = 0;
  let maxRowid = 0n;

  try {
    copyFileSync(srcPath, workPath);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(srcPath + ext)) copyFileSync(srcPath + ext, workPath + ext);
    }

    const BetterSqlite = req("better-sqlite3");
    const DatabaseSync = (function (p: string, o?: { readOnly?: boolean }) {
      // Electron's Node has no node:sqlite — better-sqlite3 (already bundled) stands in.
      return new BetterSqlite(p, { readonly: !!o?.readOnly, fileMustExist: true });
    }) as unknown as SqliteModule["DatabaseSync"];
    const chat = new DatabaseSync(workPath, { readOnly: true });
    try {
      chat.exec("PRAGMA query_only = ON;");

      // Incremental cursor = max message ROWID already ingested; legacy (migrated) cursors
      // are date-shaped and become a floor on m.date instead (see parseImessageCursor).
      // The lookback window additionally bounds the first run (modern chat.db stores
      // Apple-epoch nanoseconds in m.date).
      const { sinceRowid, dateFloor } = parseImessageCursor(getCursor(db, "imessage"));
      let windowFloor = 0n;
      if (lookbackMonths !== null) {
        const cutoffMs = Date.now() - lookbackMonths * 30.44 * 86_400_000;
        windowFloor = BigInt(Math.max(0, Math.round((cutoffMs - APPLE_EPOCH_MS) * 1_000_000)));
      }
      if (dateFloor > windowFloor) windowFloor = dateFloor;

      // 1:1 AND group chats (owner spec 2026-08-05). For 1:1 the counterpart is the
      // chat's single handle; for groups it's the message SENDER, and the chat guid
      // rides along as thread_external_id so Messaging threads by conversation.
      const stmt = chat.prepare(`
        SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS body,
               m.date AS date, m.is_from_me AS is_from_me,
               CASE WHEN pc.n = 1 THEN ch1.id ELSE sh.id END AS counterpart,
               CASE WHEN pc.n > 1 THEN c.guid END AS chat_guid,
               CASE WHEN pc.n > 1 THEN NULLIF(c.display_name, '') END AS chat_name,
               c.ROWID AS chat_rowid, pc.n AS participants
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        JOIN (SELECT chat_id, COUNT(*) AS n FROM chat_handle_join GROUP BY chat_id) pc
          ON pc.chat_id = c.ROWID
        LEFT JOIN chat_handle_join chj1 ON chj1.chat_id = c.ROWID AND pc.n = 1
        LEFT JOIN handle ch1 ON ch1.ROWID = chj1.handle_id
        LEFT JOIN handle sh ON sh.ROWID = m.handle_id
        WHERE m.ROWID > ?
        AND m.date > ?
        ORDER BY m.ROWID ASC
      `);
      // Group outbound messages have no sender handle — anchor them to the chat's
      // first participant so the thread stays whole. Documented attribution choice.
      const firstParticipant = chat.prepare(`
        SELECT h.id AS id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
        WHERE j.chat_id = ? ORDER BY j.handle_id LIMIT 1
      `);
      firstParticipant.safeIntegers(true);
      stmt.safeIntegers(true);
      const rows = stmt.all(sinceRowid, windowFloor) as Array<{
        rowid: bigint;
        guid: string | null;
        text: string | null;
        body: Uint8Array | null;
        date: bigint;
        is_from_me: bigint;
        counterpart: string | null;
        chat_guid: string | null;
        chat_name: string | null;
        chat_rowid: bigint;
        participants: bigint;
      }>;

      // AddressBook name index — best-effort. sources === 0 → unreadable → create nothing.
      const ab = buildNameIndex();
      const canCreate = ab.sources > 0;

      // Per-handle resolution cache: handle norm → person id (null = skip this handle).
      const personByHandle = new Map<string, number | null>();

      for (const row of rows) {
        if (row.rowid > maxRowid) maxRowid = row.rowid;
        let counterpart = (row.counterpart ?? "").trim();
        if (!counterpart && row.participants > 1n && row.is_from_me === 1n) {
          const fp = firstParticipant.get(row.chat_rowid) as { id: string } | undefined;
          counterpart = (fp?.id ?? "").trim();
        }
        if (!counterpart) {
          report.skipped++;
          report.skippedUnmatched++;
          continue;
        }
        const email = counterpart.includes("@") ? normalizeEmail(counterpart) : null;
        const phone = !email ? normalizePhone(counterpart) : null;
        if (!email && !phone) {
          report.skipped++; // unparseable handle — don't guess
          report.skippedUnmatched++;
          continue;
        }
        const key = email?.norm ?? phone!.norm;

        let personId: number | null;
        if (personByHandle.has(key)) {
          personId = personByHandle.get(key)!;
        } else {
          attempted++;
          const res = email
            ? resolveHandle(db, { email: email.norm })
            : resolveHandle(db, { phone: phone!.norm });
          if (res.status === "matched" && res.personId) {
            personId = res.personId;
            matched++;
          } else if (res.status === "ambiguous") {
            personId = null; // never auto-pick
          } else {
            // Saved in macOS Contacts → full contact with their real name.
            const hit = canCreate ? ab.index.get(key) : undefined;
            if (hit) {
              personId = createPerson(db, { displayName: hit.name, org: hit.company });
              if (email) addAlias(db, personId, "email", email.norm, "imessage");
              else addAlias(db, personId, "imessage_handle", phone!.norm, "imessage");
              report.created++;
              matched++;
            } else {
              // Unsaved but REAL sender → unverified archive-tier contact so the
              // unified inbox shows everyone (owner spec 2026-08-05). Tier 3 keeps
              // them out of Reconnect; the 'unverified' tag makes triage/delete easy.
              const displayName = email ? email.norm : phone!.norm;
              const ins = db.prepare(
                "INSERT INTO person (display_name, tier) VALUES (?, 3)"
              ).run(displayName);
              personId = Number(ins.lastInsertRowid);
              db.prepare(
                "INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, 'unverified')"
              ).run(personId);
              if (email) addAlias(db, personId, "email", email.norm, "imessage");
              else addAlias(db, personId, "imessage_handle", phone!.norm, "imessage");
              report.created++;
              matched++;
            }
          }
          personByHandle.set(key, personId);
        }

        if (personId === null) {
          report.skipped++;
          report.skippedUnmatched++;
          continue;
        }

        const rawText = row.text ?? decodeAttributedBody(row.body);
        const inserted = insertInteraction(db, {
          personId,
          channel: "imessage",
          direction: row.is_from_me === 1n ? "outbound" : "inbound",
          occurredAt: appleDateToDate(row.date).toISOString(),
          bodySummary: rawText ? rawText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX) || null : null,
          externalId: row.guid ?? `imessage:${row.rowid}`,
          threadExternalId: row.chat_guid ?? undefined,
          subject: row.chat_name ?? undefined,
        });
        if (inserted) report.ingested++;
        else {
          report.skipped++; // already ingested — idempotent
          report.skippedDuplicates++;
        }
      }
    } finally {
      chat.close();
    }
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // We never open the source writable — we read a private copy. A changed hash means
  // macOS/Messages wrote to its own live DB meanwhile (new texts, read receipts) — noted,
  // not fatal (the snapshot we ingested is still valid).
  try {
    const sumAfter = sha256(srcPath);
    if (sumBefore !== sumAfter) {
      console.log("imessage: chat.db changed during read (Messages writing to its own DB) — snapshot still valid");
    }
  } catch {
    /* best-effort verification only */
  }

  if (maxRowid > 0n) setCursor(db, "imessage", maxRowid.toString());
  report.resolvedPct = resolvedPct(matched, attempted);
  return report;
}
