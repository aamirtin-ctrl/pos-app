// Plans from messages — iMessage → LLM → Google Calendar.
//
// A faithful port of the production Python watcher at
// PersonalCRM2/imessage-calendar-watcher (brain.py / prefilter.py / watcher.py / store.py).
// Only two things changed:
//   1. LLM provider: Groq llama-3.3-70b → LlmClient.call(feature, 'fast', …, { json: true }).
//   2. Calendar backend: Calendar.app via AppleScript → Google Calendar, and ONLY the
//      dedicated "POS — From Messages" calendar (see gcal/sync.ensureMessagesCalendar,
//      which refuses to resolve to primary / the planner calendar / the Apple-mirror
//      calendar).
//
// Ported VERBATIM (logic-identical, TS idiom):
//   - prefilter._HINTS, _TIME_RE, is_candidate, conversation_has_signal, _clean, distill
//   - brain.SYSTEM (the decision prompt), brain._date_reference (the precomputed 11-day
//     table so the model never does weekday math), brain._user_prompt
//   - watcher._parse_dt, watcher.apply_decision's gate (confidence ≥ 0.6, concrete start
//     required, >6h-stale new events skipped, cancel always honored)
//   - watcher.process_once orchestration + store.py's per-conversation state shape
//     (state.json's {event, last_decided_rowid} → the `msg_plan` table, one row per
//     conversation, UNIQUE(conversation_key))
//
// ADAPTED (deliberate, documented):
//   - Automated-sender gate (isAutomatedThread): the Python version ran against a personal
//     thread list; here every 1:1 in chat.db is in scope, including OTP codes and
//     appointment-reminder shortcodes, which trip the (deliberately broad) keyword net.
//     Those threads are dropped BEFORE any LLM call.
//   - Titles/attribution: Python put raw phone numbers in the prompt (and so in the event
//     title). Here the counterpart is resolved through crm/identity.resolveHandle and only a
//     real display name is ever sent; unknown counterparts get a generic title, and the
//     matched person_id is stored on the plan row.
//   - Duration guard (ensureEnd): the Python version could emit start == end, which Apple
//     rejected with "start date must be before the end date". Any zero/negative duration is
//     given DEFAULT_EVENT_MINUTES (all-day → one full day).
//
// chat.db is READ-ONLY: copy db+wal+shm to a tmpdir and open the COPY read-only, exactly
// like connectors/imessage.ts and capture.ts. The live database is never opened.

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db/db.ts";
import { resolveHandle } from "./crm/identity.ts";
import { normalizeEmail, normalizePhone } from "./crm/normalize.ts";
import { extractJson } from "./llm/provider.ts";
import {
  getCursor,
  setCursor,
  type ConnectorDeps,
  type SyncReport,
} from "./connectors/common.ts";
import {
  DEFAULT_CHAT_DB,
  decodeAttributedBody,
  imessageAvailable,
  appleDateToDate,
} from "./connectors/imessage.ts";
import { deleteMessagesEvent, upsertMessagesEvent } from "./gcal/sync.ts";

// node:sqlite minimal surface (same approach as the imessage connector / capture.ts —
// no dependency on experimental typings).
interface SqliteStatement {
  setReadBigInts(enabled: boolean): void;
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

export const MSGPLANS_SOURCE = "msgplans";

// ── config (ported from the Python config.py) ────────────────────────────────

/** Only commit a calendar action at or above this confidence. (config.CONFIDENCE_THRESHOLD) */
export const CONFIDENCE_THRESHOLD = 0.6;
/** Recent messages of a conversation sent to the model for context. (config.RECENT_CONTEXT) */
export const RECENT_CONTEXT = 16;
/** Truncate any single message to this many chars. (config.MAX_MSG_CHARS) */
export const MAX_MSG_CHARS = 280;
/** On a FRESH install (no cursor yet), scan this many recent messages. (config.STARTUP_BACKFILL) */
export const STARTUP_BACKFILL = 60;
/** New events whose start is older than this are dropped as stale. (watcher.apply_decision) */
export const STALE_HOURS = 6;
/** Fallback duration when the model gives no end, or an end that isn't after the start. */
export const DEFAULT_EVENT_MINUTES = 60;

// ── prefilter.py (verbatim port) ─────────────────────────────────────────────

/** Broad net on purpose: recall matters here (the LLM does precision later). */
export const HINTS: readonly string[] = [
  // activities
  "dinner", "lunch", "brunch", "breakfast", "coffee", "drinks", "drink",
  "beer", "beers", "party", "game", "movie", "concert", "show", "meet",
  "meeting", "hang", "hangout", "call", "sync", "facetime", "zoom",
  "reservation", "reso", "gym", "workout", "appointment", "appt", "date",
  "happy hour", "link up", "catch up", "grab",
  // time / scheduling words
  "today", "tonight", "tn", "tonite", "2nite", "tomorrow", "tmrw", "tmr",
  "2moro", "tonigt", "weekend", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat",
  "sun", "noon", "midnight", "oclock", "o'clock", "morning", "afternoon",
  "evening", "later", "schedule", "reschedule", "resched", "free", "busy",
  "available", "wanna", "u down", "you down", "down to", "down for",
  "see you", "see u", "what time", "when", "rsvp",
  // months
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct",
  "nov", "dec",
];

/** digit-time patterns: 7pm, 7:30, 8 pm, at 8, 6:15ish */
export const TIME_RE = /(\b\d{1,2}\s*[ap]\.?m\.?\b|\b\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b)/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Python's \b around a hint is byte-identical to JS's \b for these ASCII hints
// ("o'clock" ends on a word char either side of the apostrophe, so \bo'clock\b behaves
// the same in both). Precompiled once — this gate runs on every message.
const HINT_RES: RegExp[] = HINTS.map((h) => new RegExp(`\\b${escapeRe(h)}\\b`, "i"));

/** A message the pipeline can reason about. */
export interface RawMessage {
  rowid: number;
  text: string | null;
  isFromMe: boolean;
  handle: string | null;
  chatGuid: string | null;
  chatName: string | null;
  ts: Date | null;
}

/** True if a single message shows any scheduling-ish signal. (prefilter.is_candidate) */
export function isCandidate(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (TIME_RE.test(t)) return true;
  return HINT_RES.some((re) => re.test(t));
}

// ADAPTATION — automated senders. Every 1:1 thread in chat.db is in scope here, and the
// broad keyword net above happily matches "your appointment", "code", "8:00". Threads that
// are transactional (OTP, marketing, appointment reminders from a business) must never
// reach the LLM: they cost tokens and would create junk events.
const AUTOMATED_RES: RegExp[] = [
  /\b(one[\s-]?time (pass)?code|verification code|security code|access code|login code|otp)\b/i,
  /\b(?:code|pin)\s*(?:is|:)\s*\d{4,8}\b/i,
  /\b\d{4,8}\b\s+is your\b/i,
  /\b(do not reply|don't reply|no[\s-]?reply|automated message)\b/i,
  /\breply\s+(stop|help|quit|end|y|c|1)\b/i,
  /\b(text|txt)\s+stop\b/i,
  /\bunsubscribe\b/i,
  /\b(appointment|apt)\s+reminder\b/i,
  /\breminder\b[^.!?]{0,60}\bappointment\b/i,
  /\bconfirm(?:ing)?\s+your\s+(appointment|reservation|booking|delivery)\b/i,
];

/** SMS short codes (e.g. "262966") are never a person you make plans with. */
function isShortCodeHandle(handle: string | null | undefined): boolean {
  const raw = (handle ?? "").trim();
  if (!raw || raw.includes("@")) return false;
  return /^\d{3,6}$/.test(raw.replace(/[^\d+]/g, ""));
}

/**
 * ADAPTATION (not in the Python original): true when a thread is transactional rather than
 * conversational — an OTP/2FA sender, a marketing blast, or an appointment-reminder
 * shortcode. Such threads are dropped before any LLM call.
 */
export function isAutomatedThread(msgs: readonly RawMessage[]): boolean {
  if (!msgs || msgs.length === 0) return false;
  if (msgs.some((m) => isShortCodeHandle(m.handle))) return true;
  return msgs.some((m) => {
    const t = m.text ?? "";
    return t.length > 0 && AUTOMATED_RES.some((re) => re.test(t));
  });
}

/**
 * True if any message in the recent window looks scheduling-related.
 * (prefilter.conversation_has_signal + the automated-sender gate above.)
 * A false here costs ZERO LLM tokens — that is the whole point of this function.
 */
export function conversationHasSignal(msgs: readonly RawMessage[]): boolean {
  if (!msgs || msgs.length === 0) return false;
  if (isAutomatedThread(msgs)) return false;
  return msgs.some((m) => isCandidate(m.text));
}

/** prefilter._clean — drop attachment placeholders, collapse whitespace, cap length. */
export function cleanText(text: string | null | undefined): string {
  if (!text) return "";
  // U+FFFC OBJECT REPLACEMENT CHARACTER (attachments) and U+00A0 NBSP, as in the original.
  let t = text.replace(/￼/g, "").replace(/ /g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_MSG_CHARS) t = t.slice(0, MAX_MSG_CHARS) + "…";
  return t;
}

export interface DistilledMessage {
  who: string;
  when: string;
  text: string;
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "%a %m/%d %H:%M" in LOCAL time, matching the Python distill's `when`. */
export function formatWhen(d: Date): string {
  return `${DOW_SHORT[d.getDay()]} ${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Compact a thread into [{who, when, text}] for the prompt (prefilter.distill).
 * `nameOf(handle)` → display name or null. Drops empty/attachment-only messages.
 *
 * ADAPTATION: the fallback for an unknown counterpart is "them", never the raw handle —
 * a phone number in the prompt ends up in the event title.
 */
export function distill(
  msgs: readonly RawMessage[],
  nameOf?: (handle: string | null) => string | null
): DistilledMessage[] {
  const out: DistilledMessage[] = [];
  for (const m of msgs ?? []) {
    const text = cleanText(m.text);
    if (!text) continue;
    const who = m.isFromMe ? "me" : (nameOf ? nameOf(m.handle) : null) || "them";
    const when = m.ts ? formatWhen(m.ts) : "";
    out.push({ who, when, text });
  }
  return out;
}

// ── brain.py (verbatim port) ─────────────────────────────────────────────────

/** brain.SYSTEM — the decision prompt, ported character-for-character. */
export const SYSTEM =
  "You watch a friend group's text thread and maintain ONE calendar event for " +
  "the plan they are making. You receive the recent messages, the current " +
  "date/time, and the event currently on the calendar (if any). Decide what " +
  "the calendar should do now.\n\n" +
  "Rules:\n" +
  "- Resolve relative dates ('next saturday', 'tn', 'tomorrow', 'the 14th', " +
  "'monday', 'your morning') against the current date/time you are given.\n" +
  "- Schedule as soon as a day and a time are on the table -- you do NOT need " +
  "a perfect confirmation. APPROXIMATE or HEDGED times still count: 'around " +
  "8', '~8pm', 'maybe 9', '8 or 9', 'evening' all mean: create the event. " +
  "Pick ONE best time -- use the most recent suggestion, and when they hedge " +
  "upward ('8... maybe 9') use the later one. It can be refined later.\n" +
  "- Use action \"none\" ONLY when there is genuinely no time proposed yet, " +
  "or they are still asking 'what time works?'. Brief acknowledgements like " +
  "'ok', 'yep', 'sounds good', 'talk to you then' CONFIRM the latest proposal " +
  "-- treat the plan as settled.\n" +
  "- If they call it off ('rain check', \"can't make it\", 'cancel'), choose " +
  "\"cancel\".\n" +
  "- If an event already exists and the agreed time changed, choose " +
  "\"update\" with the new time. Keep it as the SAME plan; do not invent a " +
  "second event.\n" +
  "- If a clear date but truly no time at all is given ('dinner saturday'), " +
  "set all_day=true.\n" +
  "- TIMEZONES: output must be in the USER'S LOCAL timezone (given below). If " +
  "a message states another zone ('8 pm CST', 'my evening / your morning'), " +
  "convert it to the user's local time.\n" +
  "- Confidence >= 0.7 whenever a day and an (even approximate) time exist.\n" +
  "- Output times as 24h ISO 'YYYY-MM-DDTHH:MM' with NO timezone suffix.\n" +
  "Respond ONLY with a JSON object of this exact shape:\n" +
  "{\n" +
  '  "is_plan": true/false,\n' +
  '  "action": "create" | "update" | "cancel" | "none",\n' +
  '  "title": "short event title e.g. Dinner with Sam",\n' +
  '  "start": "YYYY-MM-DDTHH:MM" or null,\n' +
  '  "end":   "YYYY-MM-DDTHH:MM" or null,\n' +
  '  "all_day": true/false,\n' +
  '  "confidence": 0.0-1.0,\n' +
  '  "reason": "one short sentence"\n' +
  "}";

/** Local-calendar day arithmetic (DST-safe: operates on date parts, not on epoch ms). */
export function addDaysLocal(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), 0, 0);
}

/** "YYYY-MM-DD" for a LOCAL date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "YYYY-MM-DDTHH:MM:SS" for a LOCAL date — the wall-clock form stored on msg_plan. */
export function localIso(d: Date): string {
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * brain._date_reference — a locally computed calendar for the next 11 days so the model
 * NEVER has to do weekday math. This is the single highest-value line of the prompt.
 */
export function buildDateReference(now: Date): string {
  const parts: string[] = [];
  for (let i = 0; i < 11; i++) {
    const d = addDaysLocal(now, i);
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    parts.push(`${DOW_SHORT[d.getDay()]} ${localDate(d)}${tag}`);
  }
  return parts.join("; ");
}

/** "America/New_York (UTC-0400)" — the Python `%Z (UTC%z)` line. */
export function timezoneLabel(now: Date): string {
  let zone = "local";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    /* environments without full ICU */
  }
  const offMin = -now.getTimezoneOffset();
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  return `${zone} (UTC${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)})`;
}

/** The event we are already tracking for a conversation (store.py's `event`). */
export interface ExistingEvent {
  title: string | null;
  start: string | null;
  end: string | null;
  all_day: boolean;
}

/** brain._user_prompt — verbatim structure. */
export function buildUserPrompt(
  distilled: readonly DistilledMessage[],
  now: Date,
  existing: ExistingEvent | null,
  convoName?: string | null
): string {
  const nowLine =
    `Current date/time: ${DOW_LONG[now.getDay()]} ${localDate(now)} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}  |  user's timezone: ${timezoneLabel(now)}`;
  const refLine =
    "Date reference (use these EXACT dates; do not compute weekdays yourself): " +
    buildDateReference(now);
  const convo = distilled.map((m) => `[${m.when}] ${m.who}: ${m.text}`).join("\n");
  const evLine = existing
    ? JSON.stringify({
        title: existing.title,
        start: existing.start,
        end: existing.end,
        all_day: existing.all_day,
      })
    : "none";
  const whoLine = convoName
    ? `This conversation is with: ${convoName}. Put their name in the title (e.g. 'Dinner with ${convoName}').\n`
    : "";
  return (
    `${nowLine}\n` +
    `${refLine}\n\n` +
    `${whoLine}` +
    `Event currently on the calendar for this conversation: ${evLine}\n\n` +
    `Recent messages (oldest first):\n${convo}\n\n` +
    "What should the calendar do now? Reply with the JSON object."
  );
}

// ── watcher.py decision gate (verbatim port + the duration guard) ────────────

export interface PlanDecision {
  is_plan?: unknown;
  action?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  all_day?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

/** watcher._parse_dt — tolerant naive-local parse; null when nothing usable. */
export function parseLocalDateTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/Z/gi, "").trim().slice(0, 19);
  const dt = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (dt) {
    const d = new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dOnly) {
    const d = new Date(Number(dOnly[1]), Number(dOnly[2]) - 1, Number(dOnly[3]), 0, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * BUG GUARD (the known failure of the Python version): an event with start == end — or an
 * all-day event with zero duration — was rejected downstream with "start date must be
 * before the end date". Any missing/zero/negative duration gets a sane one here.
 */
export function ensureEnd(start: Date, end: Date | null, allDay: boolean): Date {
  if (allDay) {
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (!end || end.getTime() <= dayStart.getTime()) return addDaysLocal(dayStart, 1);
    return end;
  }
  if (!end || end.getTime() <= start.getTime()) {
    return new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000);
  }
  return end;
}

export type PlanOutcome =
  | { kind: "cancel"; reason: string }
  | { kind: "write"; title: string; start: Date; end: Date; allDay: boolean; confidence: number; reason: string }
  | { kind: "skip"; reason: string };

/**
 * watcher.apply_decision's gate, ported exactly:
 *   - "cancel" is always honored (it removes, it never writes).
 *   - otherwise the action must be create/update AND confidence >= CONFIDENCE_THRESHOLD.
 *   - a concrete start must parse.
 *   - a NEW timed event whose start is more than STALE_HOURS in the past is dropped
 *     (backfilled "tonight" from yesterday). Updating an event we already track is allowed.
 */
export function gateDecision(
  decision: PlanDecision | null | undefined,
  ctx: { hasExisting: boolean; now?: Date }
): PlanOutcome {
  if (!decision || typeof decision !== "object") return { kind: "skip", reason: "no decision" };
  const now = ctx.now ?? new Date();
  const action = typeof decision.action === "string" ? decision.action : "none";
  const confRaw = Number(decision.confidence);
  const confidence = Number.isFinite(confRaw) ? confRaw : 0;
  const reason = typeof decision.reason === "string" ? decision.reason : "";

  if (action === "cancel") return { kind: "cancel", reason: reason || "cancelled in the thread" };
  if (action !== "create" && action !== "update") return { kind: "skip", reason: `action=${action}` };
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { kind: "skip", reason: `confidence ${confidence} < ${CONFIDENCE_THRESHOLD}` };
  }

  const start = parseLocalDateTime(decision.start);
  if (!start) return { kind: "skip", reason: "no concrete start" };

  const allDay = Boolean(decision.all_day);
  if (!ctx.hasExisting && !allDay && start.getTime() < now.getTime() - STALE_HOURS * 3_600_000) {
    return { kind: "skip", reason: "start is stale (>6h in the past)" };
  }

  const title = (typeof decision.title === "string" && decision.title.trim()) || "Plans";
  const end = ensureEnd(start, parseLocalDateTime(decision.end), allDay);
  return { kind: "write", title, start, end, allDay, confidence, reason };
}

// ── chat.db access (copy-first, read-only) ───────────────────────────────────

/** EPERM/EACCES/SQLite authorization failures → the Full Disk Access failure mode. */
function isFdaError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EPERM" || err?.code === "EACCES") return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("authorization denied") || msg.includes("operation not permitted");
}

// messages.py _BASE_SELECT — LEFT JOINs so group chats and 1:1s both come through.
const BASE_SELECT = `
  SELECT m.ROWID          AS rowid,
         m.text           AS text,
         m.attributedBody AS body,
         m.is_from_me     AS is_from_me,
         m.date           AS date,
         h.id             AS handle,
         ch.guid          AS chat_guid,
         ch.display_name  AS chat_name
  FROM message m
  LEFT JOIN handle h            ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
  LEFT JOIN chat ch             ON ch.ROWID = j.chat_id
`;

interface ChatRow {
  rowid: bigint;
  text: string | null;
  body: Uint8Array | null;
  is_from_me: bigint;
  date: bigint;
  handle: string | null;
  chat_guid: string | null;
  chat_name: string | null;
}

function toMessage(r: ChatRow): RawMessage {
  return {
    rowid: Number(r.rowid),
    text: r.text ?? decodeAttributedBody(r.body),
    isFromMe: r.is_from_me === 1n,
    handle: r.handle,
    chatGuid: r.chat_guid,
    chatName: r.chat_name,
    ts: r.date ? appleDateToDate(r.date) : null,
  };
}

/** Dedupe by ROWID — a message joined to several chats comes back more than once. */
function dedupe(rows: ChatRow[]): RawMessage[] {
  const seen = new Set<bigint>();
  const out: RawMessage[] = [];
  for (const r of rows) {
    if (seen.has(r.rowid)) continue;
    seen.add(r.rowid);
    out.push(toMessage(r));
  }
  return out;
}

/** messages.conv_key — the per-conversation identity used as msg_plan.conversation_key. */
export function convKey(m: Pick<RawMessage, "chatGuid" | "handle">): string {
  return m.chatGuid || m.handle || "unknown";
}

interface ChatReader {
  maxRowid(): number;
  fetchNew(sinceRowid: number): RawMessage[];
  recentForConversation(chatGuid: string | null, handle: string | null, limit: number): RawMessage[];
  close(): void;
}

/**
 * Copy db+wal+shm to a private tmpdir and open THE COPY read-only. The live chat.db is
 * never opened — identical safety contract to connectors/imessage.ts.
 */
function openChatCopy(chatDbPath: string): { reader: ChatReader; dispose: () => void } {
  const workDir = mkdtempSync(join(tmpdir(), "pos-msgplans-"));
  const workPath = join(workDir, "chat.db");
  const dispose = () => rmSync(workDir, { recursive: true, force: true });
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
    chat.exec("PRAGMA query_only = ON;");

    const run = (sql: string, ...params: unknown[]): ChatRow[] => {
      const stmt = chat.prepare(sql);
      stmt.safeIntegers(true);
      return stmt.all(...params) as ChatRow[];
    };

    const reader: ChatReader = {
      maxRowid() {
        const rows = run("SELECT MAX(ROWID) AS rowid FROM message");
        return Number(rows[0]?.rowid ?? 0n);
      },
      fetchNew(since) {
        return dedupe(run(`${BASE_SELECT} WHERE m.ROWID > ? ORDER BY m.ROWID ASC`, since));
      },
      recentForConversation(chatGuid, handle, limit) {
        const rows = chatGuid
          ? run(`${BASE_SELECT} WHERE ch.guid = ? ORDER BY m.ROWID DESC LIMIT ?`, chatGuid, limit)
          : handle
            ? run(`${BASE_SELECT} WHERE h.id = ? ORDER BY m.ROWID DESC LIMIT ?`, handle, limit)
            : [];
        return dedupe(rows).reverse(); // chronological
      },
      close: () => chat.close(),
    };
    return { reader, dispose: () => { try { chat.close(); } catch { /* already closed */ } dispose(); } };
  } catch (e) {
    dispose();
    throw e;
  }
}

// ── msg_plan row (store.py's per-conversation state) ─────────────────────────

interface PlanRow {
  id: number;
  conversation_key: string;
  person_id: number | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: number;
  gcal_event_id: string | null;
  confidence: number | null;
  status: string;
  last_decided_rowid: number | null;
}

function loadPlan(db: Db, key: string): PlanRow | null {
  return (
    (db
      .prepare(
        `SELECT id, conversation_key, person_id, title, starts_at, ends_at, all_day,
                gcal_event_id, confidence, status, last_decided_rowid
         FROM msg_plan WHERE conversation_key = ?`
      )
      .get(key) as PlanRow | undefined) ?? null
  );
}

function markDecided(db: Db, key: string, rowid: number): void {
  db.prepare(
    `INSERT INTO msg_plan (conversation_key, last_decided_rowid, status, updated_at)
     VALUES (?, ?, 'idle', datetime('now'))
     ON CONFLICT(conversation_key) DO UPDATE SET
       last_decided_rowid = MAX(COALESCE(msg_plan.last_decided_rowid, 0), excluded.last_decided_rowid),
       updated_at = datetime('now')`
  ).run(key, rowid);
}

// ── the pipeline ─────────────────────────────────────────────────────────────

export interface MsgPlanOptions {
  chatDbPath?: string;
  /** Injectable clock (tests). */
  now?: Date;
}

export interface MsgPlansReport extends SyncReport {
  summary?: string;
}

/** The active plan rows, joined to person, as the Settings list shows them. */
export interface MsgPlanView {
  id: number;
  conversationKey: string;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  confidence: number | null;
  personId: number | null;
  personName: string | null;
  updatedAt: string | null;
}

export function listMsgPlans(db: Db): MsgPlanView[] {
  const rows = db
    .prepare(
      `SELECT mp.id, mp.conversation_key, mp.title, mp.starts_at, mp.ends_at, mp.all_day,
              mp.confidence, mp.person_id, mp.updated_at, p.display_name AS person_name
       FROM msg_plan mp
       LEFT JOIN person p ON p.id = mp.person_id
       WHERE mp.status = 'active' AND mp.starts_at IS NOT NULL
       ORDER BY mp.starts_at ASC`
    )
    .all() as {
    id: number;
    conversation_key: string;
    title: string | null;
    starts_at: string | null;
    ends_at: string | null;
    all_day: number;
    confidence: number | null;
    person_id: number | null;
    updated_at: string | null;
    person_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    conversationKey: r.conversation_key,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: r.all_day === 1,
    confidence: r.confidence,
    personId: r.person_id,
    personName: r.person_name,
    updatedAt: r.updated_at,
  }));
}

/** Resolve a handle to a person id (exact identifier match only; never guesses). */
function personForHandle(db: Db, handle: string | null): number | null {
  const raw = (handle ?? "").trim();
  if (!raw) return null;
  const email = raw.includes("@") ? normalizeEmail(raw) : null;
  const phone = !email ? normalizePhone(raw) : null;
  if (!email && !phone) return null;
  const res = email ? resolveHandle(db, { email: email.norm }) : resolveHandle(db, { phone: phone!.norm });
  return res.status === "matched" && res.personId ? res.personId : null;
}

function displayName(db: Db, personId: number | null): string | null {
  if (!personId) return null;
  const row = db.prepare("SELECT display_name FROM person WHERE id = ?").get(personId) as
    | { display_name: string }
    | undefined;
  return row?.display_name ?? null;
}

/**
 * watcher.process_once, ported. One pass:
 *   new rows since the cursor → group by conversation → prefilter (free) → distill →
 *   ONE fast-tier LLM call per signalling thread → gate → Google Calendar create/update/
 *   delete on "POS — From Messages" only.
 */
export async function runMsgPlans(deps: ConnectorDeps, opts: MsgPlanOptions = {}): Promise<SyncReport> {
  const { db, secrets, llm } = deps;
  const report: MsgPlansReport = { source: MSGPLANS_SOURCE, ingested: 0, skipped: 0, created: 0 };
  const chatDbPath = opts.chatDbPath ?? DEFAULT_CHAT_DB;
  const now = opts.now ?? new Date();

  if (!existsSync(chatDbPath)) return { ...report, error: "chat_db_not_found" };
  if (!imessageAvailable(chatDbPath)) return { ...report, error: "full_disk_access" };
  if (!llm) {
    report.summary = "no LLM key configured — nothing decided";
    return report;
  }

  let opened: { reader: ChatReader; dispose: () => void };
  try {
    opened = openChatCopy(chatDbPath);
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  }
  const { reader, dispose } = opened;

  const errors: string[] = [];
  let decided = 0;

  try {
    const cursorRaw = getCursor(db, MSGPLANS_SOURCE);
    const parsed = cursorRaw ? Number(cursorRaw) : NaN;
    // Fresh install: start STARTUP_BACKFILL messages back so a new install catches plans
    // from the last little while instead of starting blank (config.STARTUP_BACKFILL).
    const since = Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(0, reader.maxRowid() - STARTUP_BACKFILL);

    const fresh = reader.fetchNew(since);
    if (fresh.length === 0) {
      setCursor(db, MSGPLANS_SOURCE, String(since));
      report.summary = "no new messages";
      return report;
    }
    const highWater = fresh.reduce((mx, m) => Math.max(mx, m.rowid), since);

    // Group new messages by conversation; remember the newest rowid per conversation.
    const convs = new Map<string, { newest: number; sample: RawMessage }>();
    for (const m of fresh) {
      const k = convKey(m);
      const cur = convs.get(k);
      if (!cur || m.rowid >= cur.newest) convs.set(k, { newest: m.rowid, sample: m });
    }

    for (const [key, info] of convs) {
      const plan = loadPlan(db, key);
      // Per-conversation staleness rule: never re-decide a thread we already decided on.
      if (plan && (plan.last_decided_rowid ?? 0) >= info.newest) {
        report.skipped++;
        continue;
      }

      const recent = reader.recentForConversation(info.sample.chatGuid, info.sample.handle, RECENT_CONTEXT);
      if (!conversationHasSignal(recent)) {
        markDecided(db, key, info.newest); // ZERO tokens spent on this thread
        report.skipped++;
        continue;
      }

      // Counterpart: only unambiguous when exactly one non-me handle appears in the thread.
      const handles = new Set(recent.filter((m) => !m.isFromMe && m.handle).map((m) => m.handle!));
      const counterpart = handles.size === 1 ? [...handles][0] : info.sample.handle;
      const personId = handles.size === 1 ? personForHandle(db, counterpart) : null;
      const personName = displayName(db, personId);
      const nameOf = (h: string | null) => (h && h === counterpart ? personName : null);

      const distilled = distill(recent, nameOf);
      if (distilled.length === 0) {
        markDecided(db, key, info.newest);
        report.skipped++;
        continue;
      }

      // Never send a raw phone number as the "name" — a group name or a resolved person only.
      const convoName = info.sample.chatName || personName || null;
      const existing: ExistingEvent | null =
        plan && plan.status === "active" && plan.gcal_event_id
          ? { title: plan.title, start: plan.starts_at, end: plan.ends_at, all_day: plan.all_day === 1 }
          : null;

      const prompt = buildUserPrompt(distilled, now, existing, convoName);
      const res = await llm.call(MSGPLANS_SOURCE, "fast", prompt, { json: true, system: SYSTEM });
      if (!res) {
        // No key / ceiling reached / API error — do NOT advance, retry next run.
        errors.push("llm unavailable");
        continue;
      }
      let decision: PlanDecision;
      try {
        decision = extractJson(res.text) as PlanDecision;
      } catch (e) {
        errors.push(`bad JSON from model: ${(e as Error).message}`);
        continue; // don't advance → retry next poll (ported behavior)
      }

      decided++;
      markDecided(db, key, info.newest);

      const outcome = gateDecision(decision, { hasExisting: !!existing, now });
      try {
        await applyOutcome({ db, secrets }, key, plan, personId, personName, outcome);
        if (outcome.kind === "write") {
          report.ingested++;
          if (!existing) report.created++;
        } else if (outcome.kind === "cancel") {
          if (existing) report.ingested++;
        } else {
          report.skipped++;
        }
      } catch (e) {
        errors.push(`${key}: ${(e as Error).message}`);
      }
    }

    setCursor(db, MSGPLANS_SOURCE, String(highWater));
  } catch (e) {
    return { ...report, error: isFdaError(e) ? "full_disk_access" : (e as Error).message };
  } finally {
    dispose();
  }

  report.summary =
    report.ingested > 0
      ? `${decided} thread${decided === 1 ? "" : "s"} decided, ${report.ingested} calendar change${report.ingested === 1 ? "" : "s"}`
      : `${decided} thread${decided === 1 ? "" : "s"} decided, no calendar change`;
  if (errors.length) report.error = errors.join("; ");
  return report;
}

/** Persist + mirror one decision. Every calendar write goes through gcal/sync.ts, which
 *  hard-refuses any calendar other than "POS — From Messages". */
async function applyOutcome(
  ctx: { db: Db; secrets: ConnectorDeps["secrets"] },
  key: string,
  plan: PlanRow | null,
  personId: number | null,
  personName: string | null,
  outcome: PlanOutcome
): Promise<void> {
  const { db, secrets } = ctx;

  if (outcome.kind === "skip") return;

  if (outcome.kind === "cancel") {
    if (plan?.gcal_event_id) {
      try {
        await deleteMessagesEvent(db, secrets, plan.gcal_event_id);
      } catch (e) {
        console.warn(`msgplans: cancel delete failed: ${(e as Error).message}`);
      }
    }
    db.prepare(
      `UPDATE msg_plan SET status = 'cancelled', gcal_event_id = NULL, updated_at = datetime('now')
       WHERE conversation_key = ?`
    ).run(key);
    return;
  }

  // create / update — ONE event per conversation, keyed by gcal_event_id (the Python UID
  // state machine): update in place when we already have one, otherwise insert.
  const who = personName ?? "this conversation";
  const eventId = await upsertMessagesEvent(db, secrets, {
    eventId: plan?.status === "active" ? plan.gcal_event_id : null,
    title: outcome.title,
    start: outcome.start,
    end: outcome.end,
    allDay: outcome.allDay,
    description: `Auto-managed by POS from your Messages with ${who}.\nWhy: ${outcome.reason}`,
  });

  db.prepare(
    `INSERT INTO msg_plan
       (conversation_key, person_id, title, starts_at, ends_at, all_day, gcal_event_id,
        confidence, status, last_decided_rowid, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
     ON CONFLICT(conversation_key) DO UPDATE SET
       person_id     = COALESCE(excluded.person_id, msg_plan.person_id),
       title         = excluded.title,
       starts_at     = excluded.starts_at,
       ends_at       = excluded.ends_at,
       all_day       = excluded.all_day,
       gcal_event_id = excluded.gcal_event_id,
       confidence    = excluded.confidence,
       status        = 'active',
       updated_at    = datetime('now')`
  ).run(
    key,
    personId,
    outcome.title,
    localIso(outcome.start),
    localIso(outcome.end),
    outcome.allDay ? 1 : 0,
    eventId,
    outcome.confidence,
    plan?.last_decided_rowid ?? 0
  );
}
