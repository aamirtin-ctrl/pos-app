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
// Person-creation policy (owner spec 2026-08-06, supersedes the ported Contacts-only rule):
// EVERY real human handle that texts becomes a contact, so the unified inbox can never hide
// a conversation. Saved in macOS Contacts → full contact with their real name; unsaved but
// real → tier-3 contact tagged `unverified` (out of Reconnect, easy to triage). The ONLY
// handles that never become a person are automated ones: short codes / OTP senders (5–6
// digit numbers, which normalizePhone already refuses) and no-reply-style Business Chat
// email addresses — see isAutomatedImessageHandle. Contacts are removed by the user only
// (the ✕ in Messaging → people.delete); nothing in this file or crm/review.ts deletes a
// person who has ever exchanged an iMessage.
//
// Requires Full Disk Access; EPERM/EACCES/authorization failures surface as
// SyncReport.error = 'full_disk_access'.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { normalizeEmail, normalizePhone } from "../crm/normalize.ts";
import { resolveHandle } from "../crm/identity.ts";
import { recordAmbiguous } from "../crm/review.ts";
import { adoptSavedNames } from "../crm/name-infer.ts";
import { buildNameIndex, type NameIndex } from "./addressbook.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  getCursor,
  setCursor,
  createPerson,
  addAlias,
  bulkAddressReason,
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

// ── shared read-only chat.db access ──────────────────────────────────────────
// One place implements the safety contract at the top of this file, so syncImessage
// and backfillMissingSenders cannot drift apart on it.

interface ChatDbSession {
  chat: SqliteDatabase;
  /** Closes the copy and removes the temp dir. Always call in a `finally`. */
  done(): void;
}

/** Copy chat.db (+wal/shm) to a temp dir and open the COPY read-only. Never the source. */
function openChatDbCopy(srcPath: string): ChatDbSession {
  const workDir = mkdtempSync(join(tmpdir(), "pos-chatdb-"));
  const workPath = join(workDir, "chat.db");
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  try {
    copyFileSync(srcPath, workPath);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(srcPath + ext)) copyFileSync(srcPath + ext, workPath + ext);
    }
    const BetterSqlite = req("better-sqlite3");
    // Electron's Node has no node:sqlite — better-sqlite3 (already bundled) stands in.
    const chat = new BetterSqlite(workPath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    chat.exec("PRAGMA query_only = ON;");
    return {
      chat,
      done: () => {
        try {
          chat.close();
        } finally {
          cleanup();
        }
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// 1:1 AND group chats (owner spec 2026-08-05). For 1:1 the counterpart is the chat's
// single handle; for groups it's the message SENDER, and the chat guid rides along as
// thread_external_id so Messaging threads by conversation.
const CHAT_MESSAGE_SQL = `
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
`;

// Group outbound messages have no sender handle — anchor them to the chat's first
// participant so the thread stays whole. Documented attribution choice.
const FIRST_PARTICIPANT_SQL = `
  SELECT h.id AS id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
  WHERE j.chat_id = ? ORDER BY j.handle_id LIMIT 1
`;

interface ChatMessageRow {
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
}

interface MessageScan {
  rows: ChatMessageRow[];
  /** The counterpart handle for a row, resolving group-outbound to the first participant. */
  counterpartOf(row: ChatMessageRow): string;
}

function scanMessages(chat: SqliteDatabase, sinceRowid: bigint, dateFloor: bigint): MessageScan {
  const stmt = chat.prepare(CHAT_MESSAGE_SQL);
  stmt.safeIntegers(true);
  const firstParticipant = chat.prepare(FIRST_PARTICIPANT_SQL);
  firstParticipant.safeIntegers(true);
  const rows = stmt.all(sinceRowid, dateFloor) as ChatMessageRow[];
  return {
    rows,
    counterpartOf(row) {
      const direct = (row.counterpart ?? "").trim();
      if (direct) return direct;
      if (row.participants > 1n && row.is_from_me === 1n) {
        const fp = firstParticipant.get(row.chat_rowid) as { id: string } | undefined;
        return (fp?.id ?? "").trim();
      }
      return "";
    },
  };
}

/** Apple-epoch ns floor for a lookback window in months; 0n when unbounded. */
function windowFloorNs(months: number | null): bigint {
  if (months === null) return 0n;
  const cutoffMs = Date.now() - months * 30.44 * 86_400_000;
  return BigInt(Math.max(0, Math.round((cutoffMs - APPLE_EPOCH_MS) * 1_000_000)));
}

/**
 * The ONLY handles that never become a new contact (owner spec 2026-08-06). Everything
 * else that texts is a person and gets a contact row.
 *
 *   - short codes / OTP senders: 5–6 digit "numbers" (22395, 262966). normalizePhone
 *     already refuses these, so this is a second, explicit gate.
 *   - automated email handles: Business Chat / no-reply addresses, judged by the same
 *     rules the mail connector uses (bulkAddressReason).
 *
 * NOTE: this gates CREATION only. A handle that already maps to a person keeps
 * attributing its messages to them — we never drop a known contact's history.
 */
export function isAutomatedImessageHandle(rawHandle: string, emailNorm: string | null): boolean {
  if (emailNorm) return bulkAddressReason(emailNorm) !== null;
  const digits = rawHandle.replace(/\D/g, "");
  if (digits.length > 0 && digits.length <= 6) return true;
  // US toll-free numbers are businesses' outbound SMS lines, not people — "+18779263717"
  // was sitting in the CRM as a contact (2026-09-11 audit). Same creation-only gate:
  // an already-known contact on such a number keeps its history.
  const nanp = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return nanp.length === 10 && /^(800|833|844|855|866|877|888)/.test(nanp);
}

/**
 * Create the contact for a handle nobody knows yet. macOS Contacts hit → real name;
 * otherwise a tier-3 `unverified` contact so the unified inbox still shows them.
 * Returns the new person id.
 */
function createContactForHandle(
  db: Db,
  key: string,
  kind: "email" | "imessage_handle",
  ab: NameIndex,
  canCreate: boolean
): number {
  const hit = canCreate ? ab.index.get(key) : undefined;
  if (hit) {
    const personId = createPerson(db, { displayName: hit.name, org: hit.company });
    addAlias(db, personId, kind, key, "imessage");
    return personId;
  }
  // Unsaved but REAL sender → unverified archive-tier contact so the unified inbox shows
  // everyone. Tier 3 keeps them out of Reconnect; the 'unverified' tag makes triage easy.
  const ins = db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 3)").run(key);
  const personId = Number(ins.lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, 'unverified')").run(personId);
  addAlias(db, personId, kind, key, "imessage");
  return personId;
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

  let matched = 0;
  let attempted = 0;
  let maxRowid = 0n;

  let session: ChatDbSession;
  try {
    session = openChatDbCopy(srcPath);
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  }

  try {
    // Incremental cursor = max message ROWID already ingested; legacy (migrated) cursors
    // are date-shaped and become a floor on m.date instead (see parseImessageCursor).
    // The lookback window additionally bounds the first run (modern chat.db stores
    // Apple-epoch nanoseconds in m.date).
    const { sinceRowid, dateFloor } = parseImessageCursor(getCursor(db, "imessage"));
    let windowFloor = windowFloorNs(lookbackMonths);
    if (dateFloor > windowFloor) windowFloor = dateFloor;

    const scan = scanMessages(session.chat, sinceRowid, windowFloor);

    // AddressBook name index — best-effort. sources === 0 → unreadable → no real names,
    // but a contact is STILL created (owner spec 2026-08-06): the inbox never hides anyone.
    const ab = buildNameIndex();
    const canCreate = ab.sources > 0;

    // A contact he SAVED since last sync beats any unverified/inferred name (owner ask
    // 2026-09-10). Same index, so this costs one cheap table scan per sync.
    if (canCreate) {
      const adopted = adoptSavedNames(db, ab);
      if (adopted.renamed > 0) console.log(`imessage: adopted ${adopted.renamed} saved contact name(s)`);
    }

    // Per-handle resolution cache: handle norm → person id (null = skip this handle).
    const personByHandle = new Map<string, number | null>();

    for (const row of scan.rows) {
      if (row.rowid > maxRowid) maxRowid = row.rowid;
      const counterpart = scan.counterpartOf(row);
      if (!counterpart) {
        report.skipped++;
        report.skippedUnmatched++;
        continue;
      }
      const email = counterpart.includes("@") ? normalizeEmail(counterpart) : null;
      const phone = !email ? normalizePhone(counterpart) : null;
      if (!email && !phone) {
        report.skipped++; // unparseable handle (short code, garbage) — don't guess
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
          // Never auto-pick — surface it in the review queue instead of dropping it.
          recordAmbiguous(db, {
            handleKind: email ? "email" : "imessage_handle",
            handleValue: key,
            name: null,
            candidateIds: res.candidateIds ?? [],
            sampleText: (row.text ?? "").slice(0, 140) || null,
          });
          personId = null;
        } else if (isAutomatedImessageHandle(counterpart, email?.norm ?? null)) {
          // Short code / OTP / no-reply Business Chat — the only senders that stay
          // person-less. Everything else below becomes a contact, always.
          personId = null;
        } else {
          personId = createContactForHandle(
            db,
            key,
            email ? "email" : "imessage_handle",
            ab,
            canCreate
          );
          report.created++;
          matched++;
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
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  } finally {
    session.done();
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

// ── backfill: contacts the OLD policy refused to create ──────────────────────
// Before 2026-08-05 this connector only created people who were saved in macOS
// Contacts, so every text from an unsaved-but-real number was ingested as nothing:
// no person, no interaction, no inbox row. Those messages are still sitting in
// chat.db and the cursor has long since moved past them, so a normal sync will never
// look at them again. This walks the window from scratch, creates the missing
// contacts, and ingests their history (INSERT OR IGNORE → safe to re-run).
//
// WIRING (main/workers.ts is owned by another agent — not edited here):
//
//     import { backfillMissingSenders } from "./connectors/imessage.ts";
//     import { getSetting, setSetting } from "./db/db.ts";
//     // once, after migrations + the first imessage sync of the session:
//     if (!getSetting(db, "backfill_imessage_senders_v1")) {
//       const r = await backfillMissingSenders(db);
//       if (!r.error) setSetting(db, "backfill_imessage_senders_v1", JSON.stringify(r));
//       console.log(`[backfill] imessage senders: ${JSON.stringify(r)}`);
//     }
//
// It does NOT touch the sync cursor, so the incremental path is unaffected either way.

export interface BackfillReport {
  /** Distinct counterpart handles seen in the window. */
  handles: number;
  /** Handles that had no person and got one. */
  createdPeople: number;
  /** Handles skipped as automated (short code / OTP / no-reply). */
  skippedAutomated: number;
  /** New interaction rows written for the newly-created people. */
  ingested: number;
  error?: string;
}

/**
 * Create the contacts (and backfill their interactions) for every chat.db handle in the
 * lookback window that has no alias in POS. Read-only against chat.db, idempotent
 * against pos.db, and it never deletes or renames an existing person.
 */
export async function backfillMissingSenders(
  db: Db,
  chatDbPath: string = DEFAULT_CHAT_DB,
  opts: { months?: number | null } = {}
): Promise<BackfillReport> {
  const report: BackfillReport = { handles: 0, createdPeople: 0, skippedAutomated: 0, ingested: 0 };
  const srcPath = chatDbPath;
  const lookbackMonths = opts.months === undefined ? DEFAULT_LOOKBACK_MONTHS : opts.months;
  if (!existsSync(srcPath)) return { ...report, error: "chat_db_not_found" };

  let session: ChatDbSession;
  try {
    session = openChatDbCopy(srcPath);
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  }

  try {
    // Full window, from ROWID 0 — the point is precisely the rows the cursor skipped.
    const scan = scanMessages(session.chat, 0n, windowFloorNs(lookbackMonths));
    const ab = buildNameIndex();
    const canCreate = ab.sources > 0;

    // handle norm → person id created here (null = deliberately not created).
    const created = new Map<string, number | null>();
    const seen = new Set<string>();

    for (const row of scan.rows) {
      const counterpart = scan.counterpartOf(row);
      if (!counterpart) continue;
      const email = counterpart.includes("@") ? normalizeEmail(counterpart) : null;
      const phone = !email ? normalizePhone(counterpart) : null;
      if (!email && !phone) continue; // short code / unparseable — never a contact
      const key = email?.norm ?? phone!.norm;

      if (!seen.has(key)) {
        seen.add(key);
        report.handles++;
        const res = email
          ? resolveHandle(db, { email: email.norm })
          : resolveHandle(db, { phone: phone!.norm });
        if (res.status === "matched" || res.status === "ambiguous") {
          created.set(key, null); // already known (or a human decision) — leave alone
        } else if (isAutomatedImessageHandle(counterpart, email?.norm ?? null)) {
          created.set(key, null);
          report.skippedAutomated++;
        } else {
          created.set(key, createContactForHandle(db, key, email ? "email" : "imessage_handle", ab, canCreate));
          report.createdPeople++;
        }
      }

      const personId = created.get(key) ?? null;
      if (personId === null) continue; // only the people this backfill invented

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
    }
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  } finally {
    session.done();
  }
  return report;
}
