// Morning capture — ingest the user's SELF-messages (note-to-self email + the iMessage
// note-to-self thread) and route each through the unified assistant (handleCommand), which
// turns braindumps into a generated day plan, notes into contact updates, etc.
// Three exceptions: the app's OWN digests (prefix "POS — ", main/digest.ts) are skipped
// outright; confirm/drop replies to a digest route to handleDigestReply instead; and a
// morning wake report ("just woke up", "morning!") is consumed by main/wake.ts, which
// records the MESSAGE'S timestamp as that day's real wake time (see runCapture).
//
// Sources:
//   - Email: for every configured mail account, INBOX messages whose From address is the
//     account's own address (self-addressed) OR is listed in the setting
//     `capture_allowed_senders` (third-party relays — an Alexa routine or IFTTT applet
//     mailing a connected address). Cursor = sync_state `capture:mail:<user>`
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
//
// Allowlisted senders (`capture_allowed_senders`) deliberately BYPASS the automated-sender
// denylist (connectors/email-utils.isAutomatedSender): an Alexa/IFTTT relay mails from
// exactly the kind of address that denylist exists to drop (no-reply@amazon.com,
// action@ifttt.com). Nothing else about the pipeline changes for them — the "POS — " digest
// skip, the confirm/drop reply routing, content-hash dedupe and cursor advancement all still
// apply. Relay mail also gets one extra extraction rule: these senders put the spoken text
// in the SUBJECT with an empty or boilerplate-only body, so an empty/near-empty body falls
// back to the subject (see captureText).
//
// Cursors are not enough on their own (owner report 2026-08-05 (a): two self-texts landed
// about four times). The same text genuinely arrives more than once — iMessage echoes the
// note-to-self thread, and a braindump often goes out to BOTH the self-mail address and the
// self thread. So every message is also content-hashed (crm/commitments.contentHash) and
// checked against `extraction_log`: identical normalized text is routed to the assistant
// exactly once, ever. Digest replies are exempt — "confirm 2" is meant to be repeatable.

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
import { contentHash, contentSeen, logExtraction } from "./crm/commitments.ts";
import { appleDateToDate, decodeAttributedBody, imessageAvailable, DEFAULT_CHAT_DB } from "./connectors/imessage.ts";
import { isDigestMessage, isDigestReply, handleDigestReply } from "./digest.ts";
import { recordCapture, markCaptureDone } from "./capture-inbox.ts";
import { llmHealth } from "./llm/provider.ts";
import { isWakeMessage, recordWake } from "./wake.ts";

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
/**
 * HARD not-for-POS rules (owner directive 2026-08-31, after a backlog sync turned his
 * self-texted video scripts into Google tasks): the self thread is also his notepad,
 * and long-form content is storage, not instruction. Deterministic, no model:
 *   - "pos:" / "pos " prefix        -> FORCED in (never skipped, bypasses the LLM gate)
 *   - "skip:" / "ignore:" / "." lead -> explicit opt-out
 *   - > NOT_FOR_POS_MAX_CHARS chars or >= NOT_FOR_POS_MAX_LINES non-empty lines
 *     -> long-form (scripts, drafts, dumps)
 * Returns a reason string, or null when the text may proceed.
 */
export const NOT_FOR_POS_MAX_CHARS = 600;
export const NOT_FOR_POS_MAX_LINES = 6;

export function isForcedForPos(text: string): boolean {
  return /^pos[:\s]/i.test((text ?? "").trimStart());
}

export function notForPos(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (isForcedForPos(t)) return null;
  if (/^(skip:|ignore:|\.)/i.test(t)) return "opt-out";
  if (t.length > NOT_FOR_POS_MAX_CHARS) return "long-form";
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= NOT_FOR_POS_MAX_LINES) return "long-form";
  return null;
}

/**
 * FLEXIBLE rule: one batched model call per run asking, for every candidate that survived
 * the hard rules, "is this addressed to the assistant, or is the self thread just being
 * used as storage?" Batched — never per message — to conserve quota. FAIL-OPEN: with no
 * model (or an unparseable answer) everything that passed the hard rules proceeds, because
 * capture is the owner's primary input and freezing it on a quota outage is worse than
 * letting the deterministic rules stand alone. Returns approved hashes, or null on no-call.
 */
async function classifyForPos(
  llm: { call(f: string, t: "fast" | "smart", p: string, o?: object): Promise<{ text: string } | null> } | null,
  items: { hash: string; text: string }[]
): Promise<Set<string> | null> {
  if (!llm || items.length === 0) return null;
  const listing = items.map((it, i) => `${i + 1}. ${it.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  const prompt = `The owner texts his own number for two different reasons: (a) to tell his assistant something — a task, an event, a fact to remember, a command; (b) to use the thread as personal storage — video scripts, drafts, links, notes to copy elsewhere. For EACH numbered message decide which it is.

${listing}

Return STRICT JSON ONLY: [{ "n": <number>, "for_pos": true | false }]. When genuinely unsure, use true.`;
  const res = await llm.call("capture-gate", "fast", prompt, { json: true }).catch(() => null);
  if (!res) return null;
  try {
    const parsed = JSON.parse(res.text.replace(/^```(?:json)?|```$/gm, "").trim());
    if (!Array.isArray(parsed)) return null;
    const ok = new Set<string>();
    for (const it of parsed) {
      const n = Number((it as any)?.n);
      if (Number.isFinite(n) && n >= 1 && n <= items.length && (it as any).for_pos === true) ok.add(items[n - 1].hash);
    }
    return ok;
  } catch {
    return null;
  }
}

/** First-run lookback: last 24 hours only. */
export const FIRST_RUN_MS = 24 * 60 * 60 * 1000;
/** Setting key: comma-separated third-party senders allowed to feed capture. Empty by default. */
export const ALLOWED_SENDERS_KEY = "capture_allowed_senders";
/** Relay mail with a body shorter than this falls back to the subject line. */
export const RELAY_BODY_MIN_CHARS = 5;
/** Discovery helper lookback. */
export const RECENT_SENDERS_DAYS = 3;

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

/**
 * Comma-separated `capture_allowed_senders` → set of normalized email addresses.
 * Non-addresses are dropped silently (the field is free text in Settings).
 */
export function parseAllowedSenders(csv: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (csv ?? "").split(/[,\n]/)) {
    const norm = normalizeEmail(part.trim())?.norm;
    if (norm) out.add(norm);
  }
  return out;
}

/** How a message earned its way into capture — "allowed" senders get the relay treatment. */
export type CaptureSenderKind = "self" | "allowed";

/**
 * Does this FROM address qualify the message as a capture, and how?
 * "self" = the account's own address (the original rule). "allowed" = a third-party relay
 * listed in `capture_allowed_senders`; that list intentionally OUTRANKS the automated-sender
 * denylist, because Alexa/IFTTT mail is automated by design. null = ignore the message.
 */
export function captureSenderKind(
  addr: string | null | undefined,
  own: string | null | undefined,
  allowed: Set<string>
): CaptureSenderKind | null {
  if (isSelfAddress(addr, own)) return "self";
  const norm = normalizeEmail(addr)?.norm;
  if (norm && allowed.has(norm)) return "allowed";
  return null;
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

// Relay/signature boilerplate, matched against a TRIMMED line. Deliberately anchored and
// narrow: dropping a line of the owner's actual braindump is far worse than leaving a
// footer in, so only unambiguous machine-written lines are listed.
const RELAY_BOILERPLATE: RegExp[] = [
  /^sent from\b/i, // "Sent from my iPhone" / "Sent from your Alexa device"
  /^sent (via|with|using)\b/i,
  /^this (e-?mail|message) was sent by ifttt\b/i,
  /^ifttt$/i,
  /^https?:\/\/ifttt\.com\b/i,
  /^this (e-?mail|message) was sent (from|to) an? (unmonitored|notification-only|no-?reply)/i,
  /^(please )?do ?not ?reply\b/i,
  /^(you are|you're) receiving this (e-?mail|message)\b/i,
  /^to (unsubscribe|stop receiving|manage)\b/i,
  /^unsubscribe\b/i,
  /^amazon\.com,?\s+inc\b/i,
  /^©/,
  /^\(c\)\s*\d{4}/i,
];

/**
 * Drop relay/signature boilerplate lines from a mail body. A line of only dashes is the
 * conventional signature delimiter — it and everything after it go. Returns "" when nothing
 * of substance survives.
 */
export function stripRelayBoilerplate(body: string | null | undefined): string {
  const kept: string[] = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (/^-{2,}$/.test(t)) break; // "-- " signature delimiter
    if (RELAY_BOILERPLATE.some((re) => re.test(t))) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Subject + body → the text handed to the assistant, capped at CAPTURE_MAX_CHARS.
 * Boilerplate lines are stripped first. Null when nothing usable is left.
 *
 * `subjectFallback` (relay mail only — see captureSenderKind "allowed"): Alexa routines and
 * IFTTT applets carry the spoken text in the SUBJECT and leave the body empty or pure
 * boilerplate, so a body under RELAY_BODY_MIN_CHARS yields the subject alone. Self-addressed
 * mail keeps the original rule: an empty body means an empty message, which is skipped.
 */
export function captureText(
  subject: string | null | undefined,
  body: string | null | undefined,
  opts: { subjectFallback?: boolean } = {}
): string | null {
  const b = stripRelayBoilerplate(body);
  const s = (subject ?? "").trim();
  if (opts.subjectFallback && b.length < RELAY_BODY_MIN_CHARS) {
    return s ? s.slice(0, CAPTURE_MAX_CHARS) : null;
  }
  if (!b) return null;
  return (s ? `${s}\n${b}` : b).slice(0, CAPTURE_MAX_CHARS);
}

// ── collection ───────────────────────────────────────────────────────────────

export interface SelfMessage {
  channel: "mail" | "imessage";
  text: string;
  /**
   * When the message was SENT, ISO — mail internalDate, iMessage message.date. Not the
   * moment capture read it: capture runs on a worker tick, so a 06:40 text is routinely
   * processed at 07:15. Anything that cares about when the owner did something (the wake
   * report in main/wake.ts) must use this, never Date.now().
   */
  sentAt: string;
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

/** An INBOX message reduced to what capture needs. */
export interface RawMailMessage {
  /** FROM address, unnormalized. */
  from: string | null;
  subject: string | null;
  body: string | null;
  /** internalDate (or the Date header) in Unix ms. */
  timeMs: number;
}

export interface CaptureMailOpts {
  /**
   * Test seam (no network): return this account's INBOX messages at/after `since` sent by
   * any of `senders`. Defaults to the IMAP reader below.
   */
  readInbox?: (account: MailAccount, since: Date, senders: string[]) => Promise<RawMailMessage[]>;
}

/** The real reader: one IMAP session per account, one SEARCH per candidate sender. */
async function readInboxViaImap(
  account: MailAccount,
  since: Date,
  senders: string[]
): Promise<RawMailMessage[]> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user.trim(), pass: account.password },
    logger: false,
    tls: imapTlsOptions(),
  });

  const out: RawMailMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP FROM is a substring match and SINCE is day-granular — both are re-checked
      // precisely per message by the caller. One SEARCH per sender (instead of fetching the
      // whole window) keeps an allowlist from turning this into a full-inbox scan.
      const uids = new Set<number>();
      for (const from of senders) {
        for (const uid of (await client.search({ since, from }, { uid: true })) || []) uids.add(uid);
      }
      if (uids.size) {
        for await (const msg of client.fetch(
          [...uids],
          { uid: true, source: true, internalDate: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = Array.isArray(parsed.from)
            ? parsed.from[0]?.value?.[0]
            : parsed.from?.value?.[0];
          out.push({
            from: fromAddr?.address ?? null,
            subject: parsed.subject ?? null,
            body:
              parsed.text ||
              (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : ""),
            timeMs: (msg.internalDate ? new Date(msg.internalDate) : parsed.date ?? new Date()).getTime(),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out;
}

/**
 * One account's INBOX: self-addressed mail plus allowlisted relay mail, newer than the
 * cursor. Appends into `batch`.
 */
async function captureFromAccount(
  db: Db,
  account: MailAccount,
  allowed: Set<string>,
  batch: CaptureBatch,
  opts: CaptureMailOpts
): Promise<void> {
  const user = account.user.trim();
  if (!user || !account.password) return;

  const cursorSource = `capture:mail:${user}`;
  const cursor = getCursor(db, cursorSource);
  const since = captureWindowStart(cursor);
  const cursorMs = cursor && !Number.isNaN(Date.parse(cursor)) ? Date.parse(cursor) : null;

  const messages = await (opts.readInbox ?? readInboxViaImap)(account, since, [user, ...allowed]);

  const collected: { text: string; timeMs: number }[] = [];
  for (const msg of messages) {
    const kind = captureSenderKind(msg.from, user, allowed);
    if (!kind) {
      batch.skipped++; // neither self-addressed nor allowlisted
      continue;
    }
    // Strictly newer than the cursor (never process the same message twice) and
    // inside the first-run window.
    if ((cursorMs != null && msg.timeMs <= cursorMs) || msg.timeMs < since.getTime()) {
      batch.skipped++;
      continue;
    }
    const text = captureText(msg.subject, msg.body, { subjectFallback: kind === "allowed" });
    if (!text) {
      batch.skipped++; // nothing to route
      continue;
    }
    collected.push({ text, timeMs: msg.timeMs });
  }

  collected.sort((a, b) => a.timeMs - b.timeMs);
  for (const m of collected) {
    batch.messages.push({
      channel: "mail",
      text: m.text,
      sentAt: new Date(m.timeMs).toISOString(),
      advance: () => setCursor(db, cursorSource, new Date(m.timeMs).toISOString()),
    });
  }
}

/**
 * Self-addressed + allowlisted INBOX mail across every configured account (per-account
 * failures noted).
 */
export async function captureFromEmail(
  deps: Pick<ConnectorDeps, "db" | "secrets">,
  opts: CaptureMailOpts = {}
): Promise<CaptureBatch> {
  const batch = emptyBatch();
  const accounts = listMailAccounts(deps.secrets);
  if (accounts.length === 0) {
    batch.notes.push("mail: no accounts configured");
    return batch;
  }
  const allowed = parseAllowedSenders(getSetting(deps.db, ALLOWED_SENDERS_KEY));
  for (const account of accounts) {
    try {
      await captureFromAccount(deps.db, account, allowed, batch, opts);
    } catch (e) {
      batch.errors.push(`mail ${account.user}: ${(e as Error).message}`);
    }
  }
  return batch;
}

// ── discovery: who has been mailing this inbox lately ────────────────────────

/** A distinct FROM address seen in a connected account's INBOX, for the Settings picker. */
export interface InboxSender {
  /** Normalized (lowercased, +tag stripped) — this is what goes in the allowlist. */
  address: string;
  /** Display name from the From header, when the sender set one. */
  name: string | null;
  /** One subject line from that sender, so the owner can recognize it. */
  subject: string | null;
  /** Messages seen from this address in the window. */
  count: number;
  /** Which connected account received them. */
  account: string;
}

/** The whole scan runs on a UI click — it must never wedge the window. */
const RECENT_SENDERS_TIMEOUT_MS = 15_000;
/** Envelope fetches are cheap, but a busy inbox is still bounded. */
const RECENT_SENDERS_MAX_SCAN = 300;

/** Reject-after-timeout wrapper (the IMAP session is abandoned, nothing is written). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** One account's recent INBOX envelopes → one entry per message (aggregated by the caller). */
async function accountInboxSenders(account: MailAccount, since: Date): Promise<InboxSender[]> {
  const user = account.user.trim();
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: account.password },
    logger: false,
    tls: imapTlsOptions(),
  });

  const out: InboxSender[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ since }, { uid: true })) || [];
      const recent = uids.slice(-RECENT_SENDERS_MAX_SCAN);
      if (recent.length) {
        // Envelopes only — the discovery list never needs (or reads) message bodies.
        for await (const msg of client.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
          const from = msg.envelope?.from?.[0];
          const address = normalizeEmail(from?.address)?.norm;
          if (!address) continue;
          out.push({
            address,
            name: from?.name?.trim() || null,
            subject: msg.envelope?.subject?.trim() || null,
            count: 1,
            account: user,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return out;
}

/**
 * Distinct FROM addresses seen in the connected accounts' INBOX over the last
 * RECENT_SENDERS_DAYS days, most frequent first — the "which address does my Alexa routine
 * actually mail from?" answer, so Settings can offer a one-click add.
 *
 * Addresses that are already handled are left out: an account's own address (self-capture
 * covers it) and anything already in `capture_allowed_senders`. Each account is time-boxed
 * and its failures are skipped, so one unreachable mailbox can't blank the list.
 */
export async function recentInboxSenders(
  db: Db,
  secrets: ConnectorDeps["secrets"],
  limit = 15
): Promise<InboxSender[]> {
  const accounts = listMailAccounts(secrets).filter((a) => a.user.trim() && a.password);
  if (accounts.length === 0) return [];

  const since = new Date(Date.now() - RECENT_SENDERS_DAYS * 24 * 60 * 60 * 1000);
  const own = new Set(
    accounts.map((a) => normalizeEmail(a.user)?.norm).filter((x): x is string => !!x)
  );
  const already = parseAllowedSenders(getSetting(db, ALLOWED_SENDERS_KEY));

  const byAddress = new Map<string, InboxSender>();
  for (const account of accounts) {
    let rows: InboxSender[];
    try {
      rows = await withTimeout(
        accountInboxSenders(account, since),
        RECENT_SENDERS_TIMEOUT_MS,
        `mail ${account.user}: timed out`
      );
    } catch {
      continue; // one unreachable/slow account must not blank the whole list
    }
    for (const row of rows) {
      if (own.has(row.address) || already.has(row.address)) continue;
      const prior = byAddress.get(row.address);
      if (prior) {
        prior.count++;
        prior.name ??= row.name;
        prior.subject ??= row.subject;
      } else {
        byAddress.set(row.address, { ...row });
      }
    }
  }

  return [...byAddress.values()]
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, Math.max(1, limit));
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
        SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body, m.date AS date,
               ch.id AS counterpart
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
        date: bigint;
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
          // chat.db keeps Apple-epoch ns (older rows: seconds) — appleDateToDate handles both.
          sentAt: appleDateToDate(row.date ?? 0n).toISOString(),
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

  const batches: { source: "self_email" | "imessage"; batch: Awaited<ReturnType<typeof captureFromEmail>> }[] = [
    { source: "self_email", batch: await captureFromEmail(deps) },
    { source: "imessage", batch: await captureFromIMessage(deps) },
  ];
  const errors = batches.flatMap((b) => b.batch.errors);
  const notes = batches.flatMap((b) => b.batch.notes);
  const kinds = new Map<string, number>();

  const cmdDeps = { db: deps.db, secrets: deps.secrets, doctrineDir, llm: deps.llm ?? null };

  // One batched relevance call for everything this run will consider (flexible rule).
  const gateCandidates: { hash: string; text: string }[] = [];
  const gateSeen = new Set<string>();
  for (const { batch } of batches) {
    for (const m of batch.messages) {
      if (!m.text?.trim() || isDigestMessage(m.text) || isDigestReply(m.text)) continue;
      if (isForcedForPos(m.text) || notForPos(m.text) !== null) continue;
      const h = contentHash(m.text);
      if (gateSeen.has(h) || contentSeen(deps.db, h)) continue;
      gateSeen.add(h);
      gateCandidates.push({ hash: h, text: m.text });
      if (gateCandidates.length >= 30) break;
    }
  }
  const approvedHashes = await classifyForPos(deps.llm ?? null, gateCandidates);

  outer: for (const { source, batch } of batches) {
    report.skipped += batch.skipped;
    for (const m of batch.messages) {
      // The app's own morning digests land in the same self thread — never re-ingest them.
      if (isDigestMessage(m.text)) {
        report.skipped++;
        m.advance();
        continue;
      }
      // "just woke up" / "morning!" is a WAKE REPORT, not a task (owner request
      // 2026-08-05): he texts his own number or has Alexa mail him when he gets up, and the
      // day is then planned against the real wake instead of the doctrine's 07:30.
      //
      // The MESSAGE'S OWN timestamp is recorded, never now() — capture runs on a worker
      // tick, so a 06:40 text is routinely read at 07:15 and now() would log the wrong hour.
      // The morning cutoff lives in isWakeMessage, so an afternoon "awake" stays a normal
      // capture and reaches the assistant.
      //
      // This sits BEFORE the content-hash dedupe on purpose: wake pings are the most
      // repetitive text the owner ever sends ("morning!" every single day), and the hash is
      // global and permanent — deduping them would record a wake exactly once, ever, and
      // silently ignore every morning after. It is consumed either way (no assistant call,
      // no extraction_log entry), so nothing downstream can double-process it.
      if (isWakeMessage(m.text, m.sentAt)) {
        const rec = recordWake(deps.db, m.sentAt);
        if (rec) {
          report.ingested++;
          kinds.set("wake", (kinds.get("wake") ?? 0) + 1);
        } else {
          report.skipped++;
        }
        m.advance();
        continue;
      }
      // Content-hash dedupe (owner report 2026-08-05 (a): "2 items landed ~4 times").
      // A self-text reaches capture more than once — iMessage echoes the note-to-self
      // thread, and the same braindump often arrives by BOTH mail and iMessage. Identical
      // normalized text is routed exactly once, ever; the repeats advance the cursor and
      // are counted as skipped. Digest replies are exempt: "confirm 2" is deliberately
      // repeatable text.
      const hash = contentHash(m.text);
      const replyToDigest = isDigestReply(m.text);
      if (!replyToDigest && contentSeen(deps.db, hash)) {
        report.skipped++;
        m.advance();
        continue;
      }
      try {
        // Confirm/drop replies to the digest go to the reply handler, not the assistant.
        if (replyToDigest) {
          await handleDigestReply(deps.db, deps.secrets, m.text);
          kinds.set("digest-reply", (kinds.get("digest-reply") ?? 0) + 1);
        } else {
          // Recorded before interpretation (owner ask 2026-08-06, extending the sparkle box's
          // durable inbox to this surface — the known gap named when that shipped). A THROW
          // here already retried via the unadvanced cursor below; what neither this nor the
          // sparkle path could see before is a DEGRADED SUCCESS — the fallback parser ran
          // during an outage and returned a real but low-quality answer (his film/gym text
          // fragmented into three garbled tasks) with nothing marking it as such.
          // Not-for-POS veto: hard rules first, then the batched model verdict. Skips are
          // recorded in the capture inbox (auditable, not vanished) and their hash logged
          // so the same script is never re-judged on a later run.
          const hardReason = notForPos(m.text);
          const softVeto =
            hardReason === null &&
            !isForcedForPos(m.text) &&
            approvedHashes !== null &&
            gateSeen.has(hash) &&
            !approvedHashes.has(hash);
          if (hardReason !== null || softVeto) {
            const skipId = recordCapture(deps.db, source, m.text);
            if (skipId !== null) markCaptureDone(deps.db, skipId, { kind: `not-for-pos:${hardReason ?? "model"}`, degraded: false });
            logExtraction(deps.db, null, hash, "capture");
            kinds.set("not-for-pos", (kinds.get("not-for-pos") ?? 0) + 1);
            report.skipped++;
            m.advance();
            continue;
          }
          const captureId = recordCapture(deps.db, source, m.text);
          const healthy = deps.llm ? llmHealth(deps.db, deps.secrets).ok : false;
          const res = await handleCommand(cmdDeps, m.text);
          kinds.set(res.kind, (kinds.get(res.kind) ?? 0) + 1);
          if (captureId !== null) markCaptureDone(deps.db, captureId, { kind: res.kind, degraded: !healthy });
          // Logged only after the assistant succeeded, so a failed run retries the text.
          logExtraction(deps.db, null, hash, "capture");
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
