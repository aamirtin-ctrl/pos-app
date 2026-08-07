// Apple Calendar (Calendar.app) bridge — macOS only.
//
// READ: every event whose START falls on a given day, across ALL local calendars,
//       via AppleScript (`osascript`). These join the planner's anchors alongside
//       Google Calendar events, so the day view reflects the Mac's real calendar.
// WRITE: ONLY into a dedicated Google calendar named "POS — Apple". Never the
//        primary calendar, never "POS — Planned". Mirroring is keyed on the Apple
//        UID stored in extendedProperties.private.appleUid, so it is idempotent and
//        deletions in Apple propagate to Google.
//
// AppleScript quirks handled here (measured against Calendar.app on macOS 15):
//   • A `whose start date ≥ …` scan across every calendar (incl. subscribed Holidays /
//     Birthdays / Siri Suggestions) takes 30-65s and is highly variable. Hence the
//     generous exec timeout AND the short in-process cache below.
//   • All-day events come back as 00:00:00 → 23:59:59 of the SAME day, not 00:00 of
//     the next day. Detection allows for both shapes.
//   • Dates are emitted as explicit zero-padded ISO by the script itself; AppleScript's
//     own date-to-text coercion is locale-dependent and unusable.
//   • Titles can contain newlines/tabs, which would corrupt the line protocol, so the
//     script flattens them before joining.

import { execFile } from "node:child_process";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { google, type calendar_v3 } from "googleapis";
import { isGoogleConnected, oauthClient } from "./gcal/auth.ts";
import { googleICalUids, persistDayCache, readDayCache } from "./gcal/sync.ts";

/** Google calendar that receives the mirrored Apple events. Nothing else is written. */
export const APPLE_MIRROR_CALENDAR_NAME = "POS — Apple";
/** settings key holding the mirror calendar id (distinct from `pos_calendar_id`). */
export const APPLE_MIRROR_SETTING_KEY = "apple_mirror_calendar_id";

/**
 * Every Calendar.app calendar POS itself authored ("POS — Planned", "POS — Apple")
 * starts with this. Those calendars come back down through the user's Google account
 * into Calendar.app, so reading them would feed our own output back in as anchors and
 * re-mirror it. They are never read.
 */
export const POS_CALENDAR_PREFIX = "POS — ";
/** settings key: comma-separated Calendar.app names the user chose not to read. */
export const APPLE_EXCLUDED_SETTING_KEY = "apple_calendars_excluded";

/** ASCII unit separator — rare enough that no calendar title contains it. */
export const FIELD_SEP = "\u001f";

/**
 * Row prefix the scan script emits when ONE calendar's event query threw. Before
 * 2026-08-07 that `on error` silently coerced the calendar to "no events" — and a shared
 * iCloud calendar hiccuping during a scan is indistinguishable from a free evening. The
 * owner's family-dinner event vanished from a day's anchors exactly that way, and the
 * planner scheduled his shutdown ritual inside the dinner.
 */
export const SCAN_ERROR_MARKER = "!ERRCAL";

/** settings-table prefix for the per-day last-known-good scan snapshot. */
export const APPLE_CACHE_PREFIX = "apple_cache:";

/** How long a cached day's read stays warm. The AppleScript scan is slow (see above). */
const CACHE_TTL_MS = 5 * 60_000;
// Cold day-scans have been measured at 30-90s+ on a machine with 14 calendars; the
// budget is deliberately generous because the alternative is silently losing anchors.
const OSASCRIPT_TIMEOUT_MS = 180_000;

export interface AppleEvent {
  uid: string;
  title: string;
  /** minutes since midnight of the queried day */
  startMin: number;
  /** minutes since midnight, clamped to 1440 for events running past midnight */
  endMin: number;
  calendar: string;
  allDay: boolean;
}

export type AppleCalErrorCode =
  | "permission"   // TCC / Automation not granted (-1743, "Not authorized")
  | "unavailable"  // not macOS, Calendar.app missing, Google not connected
  | "script";      // anything else osascript reported

/** Typed failure so callers can distinguish "ask the user for permission" from noise. */
export class AppleCalError extends Error {
  readonly code: AppleCalErrorCode;
  constructor(code: AppleCalErrorCode, message: string) {
    super(message);
    this.name = "AppleCalError";
    this.code = code;
  }
}

// ── pure helpers (unit-tested; no osascript, no network) ──────────────────────

interface DateParts {
  y: number; mo: number; d: number; hh: number; mm: number; ss: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Parse a wall-clock timestamp emitted by the AppleScript. Strict ISO first; falls
 * back to Date parsing for AppleScript-style strings ("Tuesday, August 4, 2026 at
 * 9:00:00 AM"). Returns null for anything unparseable so the row can be skipped.
 */
export function parseAppleDate(raw: string): DateParts | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = ISO_RE.exec(s);
  if (m) {
    const parts = {
      y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
      hh: Number(m[4]), mm: Number(m[5]), ss: Number(m[6] ?? "0"),
    };
    if (parts.mo < 1 || parts.mo > 12 || parts.d < 1 || parts.d > 31) return null;
    if (parts.hh > 23 || parts.mm > 59 || parts.ss > 59) return null;
    return parts;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return {
    y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(),
    hh: d.getHours(), mm: d.getMinutes(), ss: d.getSeconds(),
  };
}

/** Wall-clock epoch (UTC-based on purpose: durations here are wall minutes, DST-free). */
const wallEpoch = (p: DateParts) => Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, p.ss);

/**
 * All-day detection. Calendar.app reports all-day events as 00:00:00 → 23:59:59 of the
 * same day; some sources use 00:00 → 00:00 of the next day. Both are "starts at midnight
 * and covers (at least) a full day".
 */
export function isAllDay(start: DateParts, end: DateParts): boolean {
  if (start.hh !== 0 || start.mm !== 0 || start.ss !== 0) return false;
  const durationMin = (wallEpoch(end) - wallEpoch(start)) / 60_000;
  return durationMin >= 1439;
}

/**
 * Parse one `uid<US>title<US>startISO<US>endISO<US>calendar` line.
 * Returns null (→ caller skips the row) for anything malformed.
 */
export function parseAppleLine(line: string): AppleEvent | null {
  if (typeof line !== "string") return null;
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed.trim()) return null;
  const parts = trimmed.split(FIELD_SEP);
  if (parts.length < 5) return null;
  const [uid, rawTitle, rawStart, rawEnd, ...rest] = parts;
  if (!uid?.trim()) return null;
  const start = parseAppleDate(rawStart);
  const end = parseAppleDate(rawEnd);
  if (!start || !end) return null;

  const startMin = start.hh * 60 + start.mm;
  const durationMin = Math.round((wallEpoch(end) - wallEpoch(start)) / 60_000);
  // clamp: an event that runs past midnight only occupies the rest of this day
  const endMin = Math.min(1440, durationMin > 0 ? startMin + durationMin : startMin + 15);

  return {
    uid: uid.trim(),
    title: (rawTitle ?? "").trim() || "(busy)",
    startMin,
    endMin,
    calendar: (rest.join(FIELD_SEP) ?? "").trim(),
    allDay: isAllDay(start, end),
  };
}

/** Parse the full osascript stdout, skipping every unparseable row. */
export function parseAppleEvents(stdout: string): AppleEvent[] {
  return parseAppleScan(stdout).events;
}

export interface AppleScanResult {
  events: AppleEvent[];
  /** Calendars whose event query THREW during the scan — their absence proves nothing. */
  erroredCalendars: string[];
}

/** Parse scan output including `!ERRCAL<US>name` marker rows (see SCAN_ERROR_MARKER). */
export function parseAppleScan(stdout: string): AppleScanResult {
  const events: AppleEvent[] = [];
  const erroredCalendars: string[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith(SCAN_ERROR_MARKER + FIELD_SEP)) {
      const name = trimmed.slice(SCAN_ERROR_MARKER.length + FIELD_SEP.length).trim();
      if (name && !erroredCalendars.includes(name)) erroredCalendars.push(name);
      continue;
    }
    const ev = parseAppleLine(trimmed);
    if (ev) events.push(ev);
  }
  return { events, erroredCalendars };
}

/**
 * Fill the holes a partial scan left: for each calendar that ERRORED, take its events
 * from the last clean snapshot of the same day. Calendars that scanned fine contribute
 * their fresh rows only — a snapshot must never resurrect an event the owner deleted
 * from a calendar we could actually read.
 */
export function healPartialScan(
  fresh: AppleEvent[],
  erroredCalendars: readonly string[],
  snapshot: readonly AppleEvent[] | null | undefined
): AppleEvent[] {
  if (erroredCalendars.length === 0 || !snapshot?.length) return fresh;
  const errored = new Set(erroredCalendars.map(foldName));
  const patched = snapshot.filter((e) => errored.has(foldName(e.calendar)));
  return [...fresh, ...patched];
}

// ── calendar filtering (pure) ────────────────────────────────────────────────

/** A calendar POS wrote itself — mirrors of our own output, never an input. */
export function isPosAuthoredCalendar(name: string): boolean {
  return (name ?? "").trim().startsWith(POS_CALENDAR_PREFIX);
}

/** Parse the `apple_calendars_excluded` setting. Empty/absent → nothing excluded. */
export function parseExcludedCalendars(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const foldName = (s: string) => (s ?? "").trim().toLocaleLowerCase();

/**
 * Drop rows POS must not read: its own mirror calendars, plus anything the user
 * excluded in Settings. The AppleScript already skips both (that is where the 30-90s
 * scan time goes), but the parsed rows are filtered again — a stale cache entry or a
 * calendar renamed mid-scan must never leak POS's own output back in.
 */
export function filterAppleEvents(events: AppleEvent[], excluded: readonly string[] = []): AppleEvent[] {
  const drop = new Set(excluded.map(foldName).filter(Boolean));
  return (events ?? []).filter(
    (e) => !isPosAuthoredCalendar(e.calendar) && !drop.has(foldName(e.calendar))
  );
}

const MEETING_TITLE_RE =
  /\b(meeting|meet|call|calling|sync|stand-?up|1:1|1-1|one[- ]on[- ]one|interview|review|catch[- ]?up|demo|huddle|zoom|hangout|teams|webinar|workshop|session|kick[- ]?off|check[- ]?in|retro|standup|conference|briefing|consult|appt|appointment|coffee with|lunch with|dinner with|intro)\b/i;

const WORK_CALENDAR_RE =
  /\b(work|office|team|company|business|corp|corporate|staff|job|client|school|university|college|classes?)\b/i;

/** Heuristic anchor type for an Apple event: meeting-ish title or work-ish calendar. */
export function appleBlockType(title: string, calendar: string): "meeting" | "personal" {
  if (MEETING_TITLE_RE.test(title ?? "")) return "meeting";
  if (WORK_CALENDAR_RE.test(calendar ?? "")) return "meeting";
  return "personal";
}

/** Classify osascript stderr into a typed error. */
export function classifyOsaError(stderr: string, fallback: string): AppleCalError {
  const s = `${stderr ?? ""}`;
  if (/-1743|Not authorized|not authorised|not allowed to send Apple events/i.test(s)) {
    return new AppleCalError(
      "permission",
      "POS is not allowed to control Calendar. Approve it under System Settings → Privacy & Security → Automation."
    );
  }
  if (/-1728|-600|Application isn.t running|Can.t get application/i.test(s)) {
    return new AppleCalError("unavailable", "Calendar.app could not be reached.");
  }
  // never surface the raw exec message: node embeds the whole (huge) script in it
  const msg = (s.trim().split("\n").pop() || fallback).slice(0, 300);
  return new AppleCalError("script", msg);
}

// ── osascript plumbing ───────────────────────────────────────────────────────

type OsaResult = { ok: true; stdout: string } | { ok: false; error: AppleCalError };

/** Run an AppleScript. Never throws — always resolves to a typed result. */
export function runOsascript(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<OsaResult> {
  if (process.platform !== "darwin") {
    return Promise.resolve({
      ok: false,
      error: new AppleCalError("unavailable", "Apple Calendar is only available on macOS."),
    });
  }
  return new Promise<OsaResult>((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // execFile's timeout kills the child; err.message would otherwise contain the
          // entire script, so give the caller something a human can read instead.
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve({
              ok: false,
              error: new AppleCalError(
                "script",
                `Calendar.app did not answer within ${Math.round(timeoutMs / 1000)}s. It is busy indexing — try again in a minute.`
              ),
            });
            return;
          }
          resolve({ ok: false, error: classifyOsaError(stderr, err.message) });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? "" });
      }
    );
  });
}

const DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Quote a string for AppleScript source. Backslash and double quote are the only escapes. */
function asString(s: string): string {
  return `"${(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `{"a", "b"}` — an AppleScript list literal, or `{}` when empty. */
function asList(items: readonly string[]): string {
  return items.length === 0 ? "{}" : `{${items.map(asString).join(", ")}}`;
}

/**
 * The day-scan script. `current date` arithmetic builds the range (day is reset to 1
 * BEFORE the month is set, otherwise e.g. Jan 31 → month 2 overflows into March).
 *
 * Calendars are filtered before the (expensive) `whose` scan: POS's own mirror
 * calendars always, plus `excluded`. Skipping Holidays / Birthdays / Siri Suggestions
 * is what takes a cold scan from 30-90s down to a few seconds.
 *
 * The em dash in the POS prefix is built with `character id 8212` rather than written
 * literally — osascript's source encoding is not guaranteed to be UTF-8.
 */
export function buildEventsScript(dateISO: string, excluded: readonly string[] = []): string {
  const m = DATE_ISO_RE.exec(dateISO);
  if (!m) throw new AppleCalError("script", `bad date: ${dateISO}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const excludedList = asList(excluded.map((s) => s.trim()).filter(Boolean));
  return `
on pad(n, w)
	set s to (n as integer) as text
	repeat while (length of s) < w
		set s to "0" & s
	end repeat
	return s
end pad

on isoOf(dt)
	return (my pad(year of dt, 4)) & "-" & (my pad((month of dt) as integer, 2)) & "-" & (my pad(day of dt, 2)) & "T" & (my pad(hours of dt, 2)) & ":" & (my pad(minutes of dt, 2)) & ":" & (my pad(seconds of dt, 2))
end isoOf

on oneLine(t)
	set prev to AppleScript's text item delimiters
	set AppleScript's text item delimiters to {return, linefeed, tab, (character id 31)}
	set parts to text items of (t as text)
	set AppleScript's text item delimiters to " "
	set r to parts as text
	set AppleScript's text item delimiters to prev
	return r
end oneLine

set dayStart to current date
set day of dayStart to 1
set year of dayStart to ${y}
set month of dayStart to ${mo}
set day of dayStart to ${d}
set time of dayStart to 0
set dayEnd to dayStart + (1 * days)

set sep to (character id 31)
set posPrefix to "POS " & (character id 8212) & " "
set skipNames to ${excludedList}
set rows to {}
tell application "Calendar"
	repeat with c in calendars
		set cname to my oneLine(name of c)
		if cname starts with posPrefix then
			set skipThis to true
		else
			set skipThis to false
			repeat with sn in skipNames
				if cname is (sn as text) then set skipThis to true
			end repeat
		end if
		if skipThis is false then
			try
				set evs to (every event of c whose start date is greater than or equal to dayStart and start date is less than dayEnd)
			on error
				-- A failed calendar must be DISTINGUISHABLE from an empty one: shared iCloud
				-- calendars flake, and "no events" here once cost a real family dinner its
				-- anchor. The marker row lets the reader fall back to the last good scan.
				set evs to {}
				set end of rows to ("!ERRCAL" & sep & cname)
			end try
			repeat with e in evs
				try
					set t to my oneLine(summary of e)
				on error
					set t to "(busy)"
				end try
				try
					set end of rows to ((uid of e) & sep & t & sep & my isoOf(start date of e) & sep & my isoOf(end date of e) & sep & cname)
				end try
			end repeat
		end if
	end repeat
end tell

set prev to AppleScript's text item delimiters
set AppleScript's text item delimiters to linefeed
set outText to rows as text
set AppleScript's text item delimiters to prev
return outText
`.trim();
}

// The scan costs 30-65s; the planner, the day view and the mirror all want the same
// day within seconds of each other. One warm read serves all three.
const cache = new Map<string, { at: number; events: AppleEvent[] }>();

/** The calendar names the user switched off in Settings. */
export function excludedCalendarNames(db: Db): string[] {
  return parseExcludedCalendars(getSetting(db, APPLE_EXCLUDED_SETTING_KEY));
}

/**
 * All Calendar.app events whose START falls on `dateISO`, across every calendar the
 * user has not excluded and that POS did not author itself. Empty array when there are
 * no events. Throws a typed {@link AppleCalError} when automation permission is denied
 * or Calendar cannot be reached.
 */
export async function readAppleEvents(
  dateISO: string,
  opts?: { force?: boolean; exclude?: readonly string[]; db?: Db }
): Promise<AppleEvent[]> {
  const exclude = [...(opts?.exclude ?? [])].map((s) => s.trim()).filter(Boolean);
  // the exclusion set changes what the scan returns, so it is part of the cache key
  const key = `${dateISO}|${[...exclude].sort().join(",")}`;
  const hit = cache.get(key);
  if (!opts?.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.events;

  // Last clean scan of this day, when a db is in hand to keep one. This is what stands in
  // for a calendar (or the whole scan) that fails: absence of evidence from a FAILED read
  // is not evidence of a free evening (owner report 2026-08-07 — a shutdown ritual was
  // scheduled inside a family dinner the scan had silently dropped).
  const snapshot = opts?.db ? readDayCache<AppleEvent[]>(opts.db, APPLE_CACHE_PREFIX, dateISO) : null;

  const res = await runOsascript(buildEventsScript(dateISO, exclude));
  if (!res.ok) {
    if (Array.isArray(snapshot)) {
      console.warn(`applecal: scan failed for ${dateISO} (${res.error.message}); serving last-known snapshot`);
      return filterAppleEvents(snapshot, exclude);
    }
    throw res.error;
  }
  const scan = parseAppleScan(res.stdout);
  const fresh = filterAppleEvents(scan.events, exclude);
  if (scan.erroredCalendars.length > 0) {
    console.warn(`applecal: calendars failed mid-scan for ${dateISO}: ${scan.erroredCalendars.join(", ")}`);
  }
  const events = filterAppleEvents(healPartialScan(fresh, scan.erroredCalendars, snapshot), exclude);
  // Only a FULLY clean scan may become the new last-known-good — persisting a healed
  // result would launder a failure into future "truth".
  if (opts?.db && scan.erroredCalendars.length === 0) {
    try {
      persistDayCache(opts.db, APPLE_CACHE_PREFIX, dateISO, JSON.stringify(fresh));
    } catch (err) {
      console.warn(`applecal: persisting scan snapshot failed: ${(err as Error).message}`);
    }
  }
  cache.set(key, { at: Date.now(), events });
  return events;
}

/** Split the linefeed-joined name list the calendars script returns. */
export function parseCalendarNames(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (stdout ?? "").split("\n")) {
    const name = raw.replace(/\r$/, "").trim();
    if (!name || isPosAuthoredCalendar(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Names are joined with linefeed rather than read from AppleScript's default
// comma-space list coercion, because calendar names may themselves contain commas.
const CALENDAR_NAMES_SCRIPT = `
set prev to AppleScript's text item delimiters
tell application "Calendar" to set ns to name of calendars
set AppleScript's text item delimiters to linefeed
set outText to ns as text
set AppleScript's text item delimiters to prev
return outText
`.trim();

/**
 * Every Calendar.app calendar the user could read, for the Settings picker. POS's own
 * mirror calendars are omitted — they are never readable inputs.
 */
export async function listAppleCalendars(): Promise<string[]> {
  const res = await runOsascript(CALENDAR_NAMES_SCRIPT, 30_000);
  if (!res.ok) throw res.error;
  return parseCalendarNames(res.stdout);
}

/**
 * Cheap probe used by the Settings status chip. Also the call that triggers macOS's
 * Automation permission prompt, so "Check access" is a real, useful button.
 */
export async function appleCalendarAvailable(): Promise<{ ok: boolean; error?: string; calendars?: number }> {
  const res = await runOsascript(CALENDAR_NAMES_SCRIPT, 30_000);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, calendars: parseCalendarNames(res.stdout).length };
}

// ── mirror into Google ───────────────────────────────────────────────────────

function calApi(secrets: SecretStore): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: oauthClient(secrets) });
}

/**
 * Find-or-create the dedicated "POS — Apple" Google calendar; id cached in settings
 * under its own key. Same shape as ensurePosCalendar, deliberately a separate calendar
 * so the Apple mirror can never collide with pushed plan blocks.
 */
export async function ensureAppleMirrorCalendar(db: Db, secrets: SecretStore): Promise<string> {
  const cached = getSetting(db, APPLE_MIRROR_SETTING_KEY);
  const cal = calApi(secrets);
  if (cached) {
    try {
      await cal.calendars.get({ calendarId: cached });
      return cached;
    } catch {
      /* fall through and recreate */
    }
  }
  const list = await cal.calendarList.list({ maxResults: 250 });
  const existing = list.data.items?.find((c) => c.summary === APPLE_MIRROR_CALENDAR_NAME);
  if (existing?.id) {
    setSetting(db, APPLE_MIRROR_SETTING_KEY, existing.id);
    return existing.id;
  }
  const created = await cal.calendars.insert({
    requestBody: { summary: APPLE_MIRROR_CALENDAR_NAME, description: "Mirror of your Mac's Calendar.app events. Managed by POS." },
  });
  setSetting(db, APPLE_MIRROR_SETTING_KEY, created.data.id!);
  return created.data.id!;
}

const nextDayISO = (dateISO: string) => {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface MirrorResult {
  created: number;
  updated: number;
  deleted: number;
  /** Apple events Google already had under the same iCalUID — mirroring would duplicate. */
  skipped: number;
  events: number;
  calendarId: string;
}

/**
 * Mirror one day of Apple Calendar into the dedicated "POS — Apple" Google calendar.
 * Idempotent: the Apple UID lives in extendedProperties.private.appleUid, so a second
 * run updates instead of duplicating, and events removed in Apple are deleted here.
 *
 * Never mirrors an event Google already knows. If the user's Google account is
 * subscribed inside Calendar.app, every Google event is ALSO an Apple event; copying
 * it back into Google would create a genuine duplicate there. Apple UIDs are RFC 5545
 * UIDs and survive that sync unchanged, so they match Google's iCalUID exactly.
 */
export async function mirrorToGoogle(db: Db, secrets: SecretStore, dateISO: string): Promise<MirrorResult> {
  if (!DATE_ISO_RE.test(dateISO)) throw new AppleCalError("script", `bad date: ${dateISO}`);
  if (!isGoogleConnected(secrets)) {
    throw new AppleCalError("unavailable", "Connect Google Calendar first — the mirror needs somewhere to write.");
  }

  const appleEvents = await readAppleEvents(dateISO, { force: true, exclude: excludedCalendarNames(db) });
  const knownToGoogle = await googleICalUids(db, secrets, dateISO);
  const calId = await ensureAppleMirrorCalendar(db, secrets);

  // Hard guard: only ever the dedicated mirror calendar. Never primary, never POS — Planned.
  const posId = getSetting(db, "pos_calendar_id");
  if (!calId || calId === "primary" || (posId && calId === posId)) {
    throw new AppleCalError("unavailable", `refusing to write outside "${APPLE_MIRROR_CALENDAR_NAME}"`);
  }

  const cal = calApi(secrets);
  const base = new Date(`${dateISO}T00:00:00`);
  const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString();

  // existing mirror rows for the day → uid -> google event id
  const existing = await cal.events.list({
    calendarId: calId,
    timeMin: at(0),
    timeMax: at(1440),
    singleEvents: true,
    maxResults: 250,
  });
  const byUid = new Map<string, string>();
  for (const e of existing.data.items ?? []) {
    const uid = e.extendedProperties?.private?.appleUid;
    if (uid && e.id && e.status !== "cancelled") byUid.set(uid, e.id);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const ev of appleEvents) {
    // This event came FROM Google (or POS) — Google already has it under this UID.
    // Mirroring it would be a second copy of the same event in the same account.
    if (knownToGoogle.has(ev.uid)) {
      skipped++;
      continue;
    }
    seen.add(ev.uid);
    const endMin = ev.endMin > ev.startMin ? ev.endMin : ev.startMin + 15;
    const body: calendar_v3.Schema$Event = {
      summary: ev.title,
      description: `Mirrored from Apple Calendar — ${ev.calendar || "unnamed calendar"}`,
      start: ev.allDay ? { date: dateISO } : { dateTime: at(ev.startMin) },
      end: ev.allDay ? { date: nextDayISO(dateISO) } : { dateTime: at(endMin) },
      extendedProperties: { private: { appleUid: ev.uid, appleCalendar: ev.calendar, posMirror: "apple" } },
    };
    const googleId = byUid.get(ev.uid);
    if (googleId) {
      await cal.events.update({ calendarId: calId, eventId: googleId, requestBody: body });
      updated++;
    } else {
      await cal.events.insert({ calendarId: calId, requestBody: body });
      created++;
    }
  }

  // Deletions propagate: anything we previously mirrored that the (filtered) Apple set
  // no longer contains. That covers events deleted in Apple, calendars the user
  // excluded, and stale duplicates an earlier run mirrored before the UID check existed.
  let deleted = 0;
  for (const [uid, googleId] of byUid) {
    if (seen.has(uid)) continue;
    try {
      await cal.events.delete({ calendarId: calId, eventId: googleId });
      deleted++;
    } catch {
      /* already gone */
    }
  }

  return { created, updated, deleted, skipped, events: appleEvents.length, calendarId: calId };
}
