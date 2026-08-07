// Google Calendar + Google Tasks sync (§6 + owner extension).
//
// READ: all calendars on app open + every 15 min while open → external events become
//       anchor blocks for the planner.
// WRITE: ONLY into the dedicated "POS — Planned" calendar. Never the primary. Every
//        generated block is deletable in one action; real invitations are never touched.
// Push is AUTOMATIC (owner directive 2026-08-06): a plan reaches Google as soon as it is
//        generated, and again whenever it changes. The button is a retry, not the gesture.
//        Blocks a re-plan removed are withdrawn from Google too — see drainTombstones.
// Two-way rule: if the user moves a POS event in Google Calendar, the next sync marks
// that block is_locked=1 and the planner treats it as an anchor. Do not fight the user.
// Tasks: open planner tasks + confirmed commitments push to a "POS" Google Tasks list
// so they appear on the phone.

import { google, type calendar_v3, type tasks_v1 } from "googleapis";
import type { Db } from "../db/db.ts";
import { getSetting, setSetting } from "../db/db.ts";
import type { SecretStore } from "../secrets.ts";
import { isGoogleConnected, needsReconsent, oauthClient, RECONSENT_REQUIRED } from "./auth.ts";
import { confirmCommitment, dropCommitment } from "../crm/commitments.ts";
import { resolveNamedDate } from "../context.ts";
import type { Flexibility } from "../engine/grid.ts";

export const POS_CALENDAR_NAME = "POS — Planned";
export const POS_TASKLIST_NAME = "POS";

function calApi(secrets: SecretStore): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: oauthClient(secrets) });
}
function tasksApi(secrets: SecretStore): tasks_v1.Tasks {
  return google.tasks({ version: "v1", auth: oauthClient(secrets) });
}

// ── the injectable push surface ──────────────────────────────────────────────
//
// Everything that WRITES to Google goes through these two narrow interfaces, so the push
// path is testable without the network (same seam as gtasks-sync.ts's GoogleTasksDeps).
// Production wires them straight to googleapis via realPushDeps.

/** The slice of Google Calendar the push path uses. */
export interface PushCalendarApi {
  calendars: {
    get(args: { calendarId: string }): Promise<{ data: { id?: string | null; summary?: string | null } }>;
    insert(args: { requestBody: { summary: string } }): Promise<{ data: { id?: string | null } }>;
  };
  calendarList: {
    list(args: { maxResults: number }): Promise<{ data: { items?: { id?: string | null; summary?: string | null }[] } }>;
  };
  events: {
    insert(args: { calendarId: string; requestBody: unknown }): Promise<{ data: { id?: string | null } }>;
    update(args: { calendarId: string; eventId: string; requestBody: unknown }): Promise<{ data: { id?: string | null } }>;
    delete(args: { calendarId: string; eventId: string }): Promise<unknown>;
    list(args: {
      calendarId: string; timeMin: string; timeMax: string; maxResults: number; singleEvents: boolean;
    }): Promise<{ data: { items?: { id?: string | null; summary?: string | null }[] } }>;
  };
}

/** The slice of Google Tasks the push path uses. */
export interface PushTasksApi {
  tasklists: {
    get(args: { tasklist: string }): Promise<{ data: { id?: string | null } }>;
    list(args: { maxResults: number }): Promise<{ data: { items?: { id?: string | null; title?: string | null }[] } }>;
    insert(args: { requestBody: { title: string } }): Promise<{ data: { id?: string | null } }>;
  };
  tasks: {
    list(args: { tasklist: string; maxResults: number; showCompleted?: boolean }): Promise<{
      data: { items?: { id?: string | null; notes?: string | null }[] };
    }>;
    insert(args: { tasklist: string; requestBody: unknown }): Promise<{ data: { id?: string | null } }>;
    update(args: { tasklist: string; task: string; requestBody: unknown }): Promise<{ data: { id?: string | null } }>;
  };
}

export interface GcalPushDeps {
  calendar(): PushCalendarApi;
  tasks(): PushTasksApi;
}

/** The production surface: plain googleapis clients behind the narrow interfaces. */
export function realPushDeps(secrets: SecretStore): GcalPushDeps {
  return {
    calendar: () => calApi(secrets) as unknown as PushCalendarApi,
    tasks: () => tasksApi(secrets) as unknown as PushTasksApi,
  };
}

const pushDeps = (secrets: SecretStore, overrides?: Partial<GcalPushDeps>): GcalPushDeps => ({
  ...realPushDeps(secrets),
  ...overrides,
});

/**
 * Map the scope-drift family of Google failures to the single typed string
 * `reconsent_required`, so no caller has to pattern-match a raw Google message and the UI
 * can render one actionable line ("re-authorize Google") instead of "Insufficient
 * Permission". Everything else propagates untouched — an already-mapped error included,
 * since `needsReconsent` does not match its own output.
 */
export async function withReconsentMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (needsReconsent(e)) throw new Error(RECONSENT_REQUIRED);
    throw e;
  }
}

/** Find-or-create the dedicated POS calendar; id cached in settings. */
export async function ensurePosCalendar(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<string> {
  return withReconsentMapping(async () => {
    const cached = getSetting(db, "pos_calendar_id");
    const cal = pushDeps(secrets, deps).calendar();
    if (cached) {
      try {
        await cal.calendars.get({ calendarId: cached });
        return cached;
      } catch (e) {
        // A scope failure here is NOT "the calendar is gone" — falling through would call
        // calendars.insert and fail again with the same 403. Surface it as-is.
        if (needsReconsent(e)) throw e;
        /* recreate below */
      }
    }
    const list = await cal.calendarList.list({ maxResults: 250 });
    const existing = list.data.items?.find((c) => c.summary === POS_CALENDAR_NAME);
    if (existing?.id) {
      setSetting(db, "pos_calendar_id", existing.id);
      return existing.id;
    }
    const created = await cal.calendars.insert({ requestBody: { summary: POS_CALENDAR_NAME } });
    if (!created.data.id) throw new Error("Google returned no calendar id");
    setSetting(db, "pos_calendar_id", created.data.id);
    return created.data.id;
  });
}

// ── "POS — From Messages": the ONLY calendar main/msgplans.ts may touch ──────
//
// Message-derived events are guesses made from private texts. They live on their own
// calendar so the user can delete every one of them by deleting a single calendar, and so
// a bug here can never touch the primary calendar, the planner's calendar, or the
// Apple-mirror calendar. That is enforced structurally below, not by convention.

/** Dedicated calendar for events inferred from iMessage threads. */
export const MSGPLANS_CALENDAR_NAME = "POS — From Messages";
/** settings key holding its id (distinct from pos_calendar_id / apple_mirror_calendar_id). */
export const MSGPLANS_SETTING_KEY = "msgplans_calendar_id";

/**
 * Hard guard: a message-derived event must NEVER land on the primary calendar, the
 * planner's "POS — Planned" calendar, or the Apple-mirror calendar. Any resolution path
 * that would produce one of those throws instead of writing.
 */
export function assertMessagesCalendarId(db: Db, id: string | null | undefined): string {
  const candidate = (id ?? "").trim();
  if (!candidate) throw new Error("msgplans: no calendar id resolved");
  const reserved = new Map<string, string>([["primary", "the primary calendar"]]);
  const planned = getSetting(db, "pos_calendar_id");
  if (planned) reserved.set(planned, `the planner calendar (${POS_CALENDAR_NAME})`);
  const appleMirror = getSetting(db, "apple_mirror_calendar_id");
  if (appleMirror) reserved.set(appleMirror, "the Apple-mirror calendar");
  const hit = reserved.get(candidate);
  if (hit) {
    throw new Error(
      `msgplans: refusing to write message-derived events to ${hit}; only "${MSGPLANS_CALENDAR_NAME}" is allowed`
    );
  }
  return candidate;
}

/**
 * Find-or-create "POS — From Messages"; id cached in setting `msgplans_calendar_id`.
 * Every return path passes through assertMessagesCalendarId.
 */
export async function ensureMessagesCalendar(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<string> {
  return withReconsentMapping(async () => {
    const cal = pushDeps(secrets, deps).calendar();
    const cached = getSetting(db, MSGPLANS_SETTING_KEY);
    if (cached) {
      const id = assertMessagesCalendarId(db, cached);
      try {
        const got = await cal.calendars.get({ calendarId: id });
        // A cached id whose calendar was renamed/replaced is not ours — fall through.
        if (got.data.summary === MSGPLANS_CALENDAR_NAME) return id;
      } catch (e) {
        if (needsReconsent(e)) throw e; // scope failure, not a deleted calendar
        /* deleted upstream — recreate below */
      }
    }
    const list = await cal.calendarList.list({ maxResults: 250 });
    const existing = list.data.items?.find((c) => c.summary === MSGPLANS_CALENDAR_NAME);
    if (existing?.id) {
      const id = assertMessagesCalendarId(db, existing.id);
      setSetting(db, MSGPLANS_SETTING_KEY, id);
      return id;
    }
    const created = await cal.calendars.insert({ requestBody: { summary: MSGPLANS_CALENDAR_NAME } });
    const id = assertMessagesCalendarId(db, created.data.id);
    setSetting(db, MSGPLANS_SETTING_KEY, id);
    return id;
  });
}

export interface MessagesEventInput {
  /** Existing Google event id for this conversation, or null to insert a new one. */
  eventId?: string | null;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  description?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Local calendar date "YYYY-MM-DD" (all-day events are date-only in Google's API). */
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Create or update THE event for one conversation on "POS — From Messages".
 * Returns the Google event id. Resolves the calendar itself, so no caller can aim this
 * at another calendar. A stale eventId (deleted in Google) falls back to an insert.
 */
export async function upsertMessagesEvent(
  db: Db,
  secrets: SecretStore,
  ev: MessagesEventInput
): Promise<string> {
  const calendarId = await ensureMessagesCalendar(db, secrets);
  const cal = calApi(secrets);
  // Defence in depth against the "start date must be before the end date" failure the
  // Python watcher hit: msgplans.ensureEnd already fixes it, and so does this.
  const end = ev.end.getTime() > ev.start.getTime() ? ev.end : new Date(ev.start.getTime() + 60 * 60_000);
  const body: calendar_v3.Schema$Event = {
    summary: ev.title,
    description: ev.description,
    ...(ev.allDay
      ? { start: { date: localDate(ev.start) }, end: { date: localDate(end) } }
      : { start: { dateTime: ev.start.toISOString() }, end: { dateTime: end.toISOString() } }),
  };
  if (ev.eventId) {
    try {
      const updated = await cal.events.update({ calendarId, eventId: ev.eventId, requestBody: body });
      return updated.data.id ?? ev.eventId;
    } catch {
      /* deleted in Google — insert a fresh one below */
    }
  }
  const created = await cal.events.insert({ calendarId, requestBody: body });
  if (!created.data.id) throw new Error("msgplans: Google returned no event id");
  return created.data.id;
}

/** Delete one conversation's event. Resolves the calendar itself; never deletes elsewhere. */
export async function deleteMessagesEvent(db: Db, secrets: SecretStore, eventId: string): Promise<void> {
  if (!eventId) return;
  const calendarId = await ensureMessagesCalendar(db, secrets);
  const cal = calApi(secrets);
  try {
    await cal.events.delete({ calendarId, eventId });
  } catch {
    /* already gone — deleting a deleted event is success */
  }
}

// ── three-tier flexibility inference (owner ask 2026-08-05) ──────────────────
//
// "Sometimes I add Google Calendar events after the fact — typically that means it's
// something I have to go to, and my calendar should adjust around it. The app should know
// which events can be moved, which shouldn't be, and which it should try not to."
//
// One function decides the tier for EVERY external source (Google, Apple, ICS), so the
// answer cannot drift between them. The tiers are defined in engine/grid.ts.

/**
 * Obligation words. A title containing any of these describes something the owner has to
 * SHOW UP for, whoever put it on the calendar — which is exactly the after-the-fact case:
 * he types "Dentist appointment" into Google himself, with no attendees and no invitation,
 * and the day must bend around it rather than treat it as a soft intention.
 *
 * Word-bounded so "classroom", "overdue" and friends do not false-positive.
 */
export const APPOINTMENT_PATTERNS: readonly RegExp[] = [
  /\bclass(es)?\b/i,
  /\blectures?\b/i,
  /\bexams?\b/i,
  /\binterviews?\b/i,
  /\bflights?\b/i,
  /\bappointments?\b/i,
  /\bdoctor\b/i,
  /\bdentist\b/i,
  /\bmeeting with\b/i,
  /\b1:1\b/i,
  /\bcall with\b/i,
  /\bdeadlines?\b/i,
  /\bdue\b/i,
];

/**
 * Social commitments (owner ask 2026-08-06, from a real miss: a "hangout" added to Google
 * after the plan was generated left a focused_work block sitting inside it).
 *
 * These are things he has told ANOTHER PERSON he will do. That is the same category as an
 * appointment — the other person is the reason it cannot move — even though the title
 * carries none of the appointment vocabulary above and Google shows no attendees, because
 * he types the event in himself after agreeing over text.
 *
 * Deliberately NOT here: plain solo blocks. "Reading", "Errands", "Write the draft", "Gym"
 * involve nobody else and stay `preferred` — real intentions the solver may bend around
 * when the day demands it. The dividing line is a promise to a person, not busyness.
 */
export const SOCIAL_COMMITMENT_PATTERNS: readonly RegExp[] = [
  /\bhang ?outs?\b/i,
  /\bdinner with\b/i,
  /\blunch with\b/i,
  /\bcoffee with\b/i,
  /\bdrinks\b/i,
  // "third-party integration" is not a party — the lookbehind rejects a preceding hyphen.
  /(?<![\w-])part(y|ies)\b/i,
  /\bbirthdays?\b/i,
  /\bweddings?\b/i,
  // "Game plan" is a work title, not an event with a kickoff time.
  /\bgames?\b(?!\s+plan)/i,
  /\bconcerts?\b/i,
  /\bdate night\b/i,
];

/**
 * Every title pattern that makes an event `fixed`: appointments he must attend, and
 * commitments he made to someone else.
 */
export const OBLIGATION_PATTERNS: readonly RegExp[] = [
  ...APPOINTMENT_PATTERNS,
  ...SOCIAL_COMMITMENT_PATTERNS,
];

/** True when a title reads like something the owner has to attend. */
export function looksLikeObligation(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  return OBLIGATION_PATTERNS.some((re) => re.test(t));
}

/** Calendars POS itself writes. Anything living here is planner output, not an obligation. */
const POS_AUTHORED_CALENDAR_PREFIX = "POS — ";

/**
 * What `inferFlexibility` needs to know. Every field is optional: the Apple and ICS paths
 * only ever have a title, a calendar name and a block-type guess, and must still get an
 * answer. Absent evidence is read conservatively (see below).
 */
export interface FlexibilityEvent {
  title?: string | null;
  /** Attendees as Google returns them; the owner's own row carries `self: true`. */
  attendees?: readonly { self?: boolean | null; responseStatus?: string | null }[] | null;
  /** Owner's own response on the invitation, when the caller already extracted it. */
  responseStatus?: string | null;
  /** Name of the calendar the event came from ("POS — Planned", "Work", …). */
  calendarName?: string | null;
  /** Caller-resolved anchor type; "meeting" means other people are involved. */
  blockType?: "meeting" | "personal" | null;
}

/**
 * Which tier an external event belongs to.
 *
 *   fixed     — has OTHER attendees, OR is an accepted invitation, OR its title reads like
 *               an obligation, OR the source already classified it as a meeting.
 *   preferred — a solo event the owner created himself: a self-scheduled work block, a
 *               reminder, "Reading". Real, but movable under pressure.
 *   flexible  — lives on a POS-authored calendar. The planner wrote it; the planner owns it.
 *
 * NOTE (the owner's stated case): a solo event he adds AFTER THE FACT still comes back
 * `fixed` whenever its title reads like an obligation — "Dentist appointment", "Flight to
 * SFO", "CS229 lecture", "Hangout", "Dinner with Sam" — precisely because that is the
 * signal he described. Only a solo event with a NEUTRAL title, one that commits him to
 * nobody ("Reading", "Errands", "Write draft"), falls through to `preferred`.
 */
export function inferFlexibility(ev: FlexibilityEvent): Flexibility {
  const calendar = (ev.calendarName ?? "").trim();
  if (calendar === POS_CALENDAR_NAME || calendar.startsWith(POS_AUTHORED_CALENDAR_PREFIX)) {
    return "flexible";
  }
  const others = (ev.attendees ?? []).filter((a) => a?.self !== true);
  if (others.length > 0) return "fixed";
  if ((ev.responseStatus ?? "").toLowerCase() === "accepted") return "fixed";
  const selfAccepted = (ev.attendees ?? []).some(
    (a) => a?.self === true && (a.responseStatus ?? "").toLowerCase() === "accepted"
  );
  if (selfAccepted) return "fixed";
  // The Apple/ICS paths carry no attendee data at all; their meeting heuristic is the only
  // "other people are involved" signal we get, and reading it as `fixed` keeps those
  // sources at today's behavior rather than quietly making them displaceable.
  if (ev.blockType === "meeting") return "fixed";
  if (looksLikeObligation(ev.title)) return "fixed";
  return "preferred";
}

export interface ExternalAnchor {
  startMin: number;
  endMin: number;
  title: string;
  blockType: "meeting" | "personal";
  gcalEventId: string;
  /**
   * RFC 5545 UID. Unlike `gcalEventId` this survives cross-system sync, so it is the
   * join key between "the same event as Google knows it" and "the same event as
   * Calendar.app knows it". Empty string when Google did not return one.
   */
  iCalUID: string;
  /**
   * Tier from `inferFlexibility`. Absent on snapshots persisted before this shipped —
   * consumers apply the `fixed` default (grid.flexibilityOf), i.e. the old behavior.
   */
  flexibility?: Flexibility;
}

/**
 * Only ask for what we read — and crucially, ask for iCalUID. `attendees` carries the
 * self/responseStatus pair the flexibility inference needs.
 */
const EVENT_FIELDS = "items(id,status,summary,start,end,attendees,iCalUID),nextPageToken";

// ── persisted last-known day caches (setting table) ──────────────────────────
//
// The in-process caches below die with the process, so the FIRST calendar open
// after an app relaunch used to pay the full network wait (calendarList + one
// events.list per calendar; the ICS path has the same problem with a ~1s feed
// parse). Persisting each successful read as per-date JSON in the `setting`
// table lets a cold read serve last-known data instantly while a live refresh
// runs in the background. Only the ~DAY_CACHE_KEEP newest dates are kept.

export const ANCHORS_CACHE_PREFIX = "anchors_cache:";
export const DAY_CACHE_KEEP = 14;

/**
 * Pure: given every setting key under one prefix (`<prefix><YYYY-MM-DD>`),
 * return the keys to DELETE so only the `keep` newest dates remain. ISO dates
 * sort lexicographically, so plain string sort is date order.
 */
export function pruneDayCacheKeys(keys: readonly string[], keep = DAY_CACHE_KEEP): string[] {
  return [...keys].sort().reverse().slice(keep);
}

/** Persist one date's JSON under `<prefix><dateISO>` and prune old dates. */
export function persistDayCache(db: Db, prefix: string, dateISO: string, json: string): void {
  setSetting(db, `${prefix}${dateISO}`, json);
  const rows = db.prepare("SELECT key FROM setting WHERE key LIKE ?").all(`${prefix}%`) as { key: string }[];
  const doomed = pruneDayCacheKeys(rows.map((r) => r.key));
  if (doomed.length) {
    const del = db.prepare("DELETE FROM setting WHERE key = ?");
    for (const k of doomed) del.run(k);
  }
}

/** Read one date's persisted JSON back; null when absent or unparseable. */
export function readDayCache<T>(db: Db, prefix: string, dateISO: string): T | null {
  const raw = getSetting(db, `${prefix}${dateISO}`);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Last successfully read anchors for a date, from the setting table (may be stale). */
export function cachedAnchors(db: Db, dateISO: string): ExternalAnchor[] | null {
  const parsed = readDayCache<unknown>(db, ANCHORS_CACHE_PREFIX, dateISO);
  return Array.isArray(parsed) ? (parsed as ExternalAnchor[]) : null;
}

// Day-flipping in the planner calls readAnchors once per flip; without a cache every
// flip is a live round-trip to Google (calendarList + one events.list per calendar).
// Mirrors the googleICalUids cache below: per-date, in-process, short TTL.
const ANCHORS_TTL_MS = 60_000;
const anchorsCache = new Map<string, { at: number; anchors: ExternalAnchor[] }>();
// Dates with a background live refresh already in flight (persisted-data fast path).
const anchorsRefreshing = new Set<string>();
// After a write (pushPlan/reconcile) the persisted snapshots are suspect too — reads
// inside this window must be live, not served from the setting table.
let anchorsLiveOnlyUntil = 0;

/** Drop the in-process anchors cache — called after any write (pushPlan/reconcile) so reads stay fresh. */
export function clearAnchorsCache(): void {
  anchorsCache.clear();
  anchorsLiveOnlyUntil = Date.now() + ANCHORS_TTL_MS;
}

/**
 * Read anchors for a date from ALL calendars except the POS calendar.
 * External events are immovable by definition. Cached per-date for 60s;
 * pushPlan/reconcileMovedEvents clear the cache so pushes read back fresh.
 *
 * COLD in-process cache + persisted snapshot present → the snapshot is returned
 * immediately and a live refresh runs fire-and-forget (updating both caches), so
 * an app relaunch never pays the network wait on the first calendar open.
 */
export async function readAnchors(db: Db, secrets: SecretStore, dateISO: string): Promise<ExternalAnchor[]> {
  if (!isGoogleConnected(secrets)) return [];
  const hit = anchorsCache.get(dateISO);
  if (hit && Date.now() - hit.at < ANCHORS_TTL_MS) return hit.anchors;
  if (Date.now() >= anchorsLiveOnlyUntil) {
    const persisted = cachedAnchors(db, dateISO);
    if (persisted) {
      if (!anchorsRefreshing.has(dateISO)) {
        anchorsRefreshing.add(dateISO);
        void readAnchorsLive(db, secrets, dateISO)
          .catch((e) => console.warn(`gcal: background anchors refresh failed: ${(e as Error).message}`))
          .finally(() => anchorsRefreshing.delete(dateISO));
      }
      return persisted;
    }
  }
  return readAnchorsLive(db, secrets, dateISO);
}

/** The actual Google round-trip; updates the in-process cache AND the persisted snapshot. */
async function readAnchorsLive(db: Db, secrets: SecretStore, dateISO: string): Promise<ExternalAnchor[]> {
  const cal = calApi(secrets);
  const posId = getSetting(db, "pos_calendar_id");
  const dayStart = new Date(`${dateISO}T00:00:00`);
  const dayEnd = new Date(`${dateISO}T23:59:59`);
  const list = await cal.calendarList.list({ maxResults: 250 });
  const anchors: ExternalAnchor[] = [];
  for (const c of list.data.items ?? []) {
    if (!c.id || c.id === posId) continue;
    const events = await cal.events.list({
      calendarId: c.id,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      fields: EVENT_FIELDS,
    });
    for (const e of events.data.items ?? []) {
      if (e.status === "cancelled" || !e.start?.dateTime || !e.end?.dateTime) continue; // skip all-day
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      const blockType: "meeting" | "personal" = (e.attendees?.length ?? 0) > 0 ? "meeting" : "personal";
      anchors.push({
        startMin: s.getHours() * 60 + s.getMinutes(),
        endMin: en.getHours() * 60 + en.getMinutes(),
        title: e.summary ?? "(busy)",
        blockType,
        gcalEventId: e.id!,
        iCalUID: e.iCalUID ?? "",
        flexibility: inferFlexibility({
          title: e.summary,
          attendees: e.attendees,
          calendarName: c.summary,
          blockType,
        }),
      });
    }
  }
  anchorsCache.set(dateISO, { at: Date.now(), anchors });
  try {
    persistDayCache(db, ANCHORS_CACHE_PREFIX, dateISO, JSON.stringify(anchors));
  } catch (e) {
    console.warn(`gcal: persisting anchors snapshot failed: ${(e as Error).message}`);
  }
  return anchors;
}

// ── cross-calendar identity ──────────────────────────────────────────────────
//
// The anchor path and the Apple-mirror path both want "what does Google already
// know about this day?" within seconds of each other, and the answer costs one
// events.list per calendar. One warm read serves both.
const ICAL_UID_TTL_MS = 2 * 60_000;
const icalUidCache = new Map<string, { at: number; uids: Set<string> }>();

/** Testing/refresh hook — drops the in-process iCalUID cache. */
export function clearICalUidCache(): void {
  icalUidCache.clear();
}

/**
 * Every iCalUID Google holds for `dateISO`, across ALL calendars — the POS ones
 * included, deliberately: this set answers "does Google already have this event?",
 * and an event we mirrored last week is still an event Google has.
 */
export async function googleICalUids(db: Db, secrets: SecretStore, dateISO: string): Promise<Set<string>> {
  if (!isGoogleConnected(secrets)) return new Set();
  const hit = icalUidCache.get(dateISO);
  if (hit && Date.now() - hit.at < ICAL_UID_TTL_MS) return hit.uids;

  const cal = calApi(secrets);
  const dayStart = new Date(`${dateISO}T00:00:00`);
  const dayEnd = new Date(`${dateISO}T23:59:59`);
  const list = await cal.calendarList.list({ maxResults: 250 });
  const uids = new Set<string>();
  for (const c of list.data.items ?? []) {
    if (!c.id) continue;
    const events = await cal.events.list({
      calendarId: c.id,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      maxResults: 250,
      fields: "items(iCalUID,status)",
    });
    for (const e of events.data.items ?? []) {
      if (e.status === "cancelled") continue;
      const uid = (e.iCalUID ?? "").trim();
      if (uid) uids.add(uid);
    }
  }
  icalUidCache.set(dateISO, { at: Date.now(), uids });
  return uids;
}

// ── merging Google + Apple into one anchor set (pure) ────────────────────────

/** Minimal shape of a Google anchor the merge cares about. */
export interface MergeableGoogleAnchor {
  startMin: number;
  endMin: number;
  title: string;
  blockType: "meeting" | "personal";
  iCalUID?: string | null;
  /** Tier from inferFlexibility; absent → the engine's `fixed` default. */
  flexibility?: Flexibility;
}

/**
 * Minimal shape of an Apple event the merge cares about. `blockType` is resolved by
 * the caller (applecal.appleBlockType) so this module stays free of Apple imports.
 */
export interface MergeableAppleEvent {
  uid?: string | null;
  title: string;
  startMin: number;
  endMin: number;
  blockType?: "meeting" | "personal";
  /** Tier from inferFlexibility; absent → the merge infers it from title + blockType. */
  flexibility?: Flexibility;
}

export interface MergedAnchor {
  startMin: number;
  endMin: number;
  title: string;
  blockType: "meeting" | "personal";
  source: "google" | "apple";
  /** iCalUID (Google) or Apple UID; empty when the source gave us none. */
  uid: string;
  /**
   * Which tier the surviving side of the join belongs to — and, as everywhere else in the
   * flexibility model (Anchor, ExternalAnchor, PlacedBlock), ABSENT MEANS `fixed`. The
   * merge therefore emits this key only when the answer is not the default, so a merged
   * anchor says something new or says nothing at all.
   */
  flexibility?: Flexibility;
}

/** Spread helper: emit `flexibility` only when it is not the implied `fixed` default. */
const tier = (f: Flexibility): { flexibility?: Flexibility } => (f === "fixed" ? {} : { flexibility: f });

export interface SkippedAppleEvent {
  uid: string;
  reason: "same-uid" | "same-time-title";
}

export interface MergeResult {
  anchors: MergedAnchor[];
  skipped: SkippedAppleEvent[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim();

/**
 * Join Google anchors and Apple events into one anchor set, UID-first.
 *
 * An event that lives in both systems (a Google account subscribed inside
 * Calendar.app, or a POS block synced back down) carries the SAME RFC 5545 UID on
 * both sides, so matching on it is exact and survives renames and reschedules.
 * The old (startMin, endMin, title) check is kept only as the fallback for events
 * where one side has no UID at all.
 */
export function mergeCalendarSources(
  googleAnchors: readonly MergeableGoogleAnchor[],
  appleEvents: readonly MergeableAppleEvent[]
): MergeResult {
  const anchors: MergedAnchor[] = [];
  const skipped: SkippedAppleEvent[] = [];

  const googleUids = new Set<string>();
  for (const g of googleAnchors ?? []) {
    const uid = norm(g.iCalUID);
    if (uid) googleUids.add(uid);
    anchors.push({
      startMin: g.startMin,
      endMin: g.endMin,
      title: g.title,
      blockType: g.blockType,
      source: "google",
      uid,
      // Google anchors are tiered at read time (readAnchorsLive), where the attendee list
      // is still in hand. A snapshot persisted before flexibility shipped has none — infer
      // from what survived, which lands on the same conservative answer.
      ...tier(g.flexibility ?? inferFlexibility({ title: g.title, blockType: g.blockType })),
    });
  }

  for (const ev of appleEvents ?? []) {
    const uid = norm(ev.uid);
    if (uid && googleUids.has(uid)) {
      skipped.push({ uid, reason: "same-uid" });
      continue;
    }
    // Fallback, reached only when the UIDs could not decide it (no match above, or
    // one side carries no UID at all): the old exact time+title check. Two entries at
    // the same minute with the same title are one busy block as far as the day goes.
    const clash = anchors.some(
      (a) => a.startMin === ev.startMin && a.endMin === ev.endMin && norm(a.title) === norm(ev.title)
    );
    if (clash) {
      skipped.push({ uid, reason: "same-time-title" });
      continue;
    }
    const blockType = ev.blockType ?? "personal";
    anchors.push({
      startMin: ev.startMin,
      endMin: ev.endMin,
      title: ev.title,
      blockType,
      source: "apple",
      uid,
      // Apple/ICS carry no attendee data, so the title and the meeting heuristic are the
      // whole evidence set.
      ...tier(ev.flexibility ?? inferFlexibility({ title: ev.title, blockType })),
    });
  }

  return { anchors, skipped };
}

/**
 * Push: write every non-anchor block of a plan into the POS calendar.
 *
 * `pushed_at` is stamped ONLY on a clean run. A scope failure (mapped to
 * `reconsent_required`) leaves it NULL, so the plan stays in the worker's auto-push sweep
 * and the UI keeps offering the retry — the old code could never distinguish "pushed" from
 * "tried and was refused".
 */
// ── withdrawing events the plan no longer contains ───────────────────────────
//
// Pushing became automatic (owner directive 2026-08-06: "it should automatically populate to
// my Google Calendar, it shouldn't require me to press a button"), and that turned a latent
// leak into a real one. A re-plan DELETES the superseded blocks locally — cascade, so nothing
// in TypeScript even sees it happen — and their Google events used to survive as orphans
// nobody could ever match back to a block. Push once by hand and you never notice; push on
// every re-plan and the calendar fills with ghosts of abandoned schedules.
//
// So the DELETE itself records the event id (migration 10's trigger, which cascades catch
// too), and the next push withdraws them from Google. A block whose id is REUSED by the new
// plan clears its own tombstone at insert time, so carrying a block across a re-plan updates
// the event in place instead of deleting and recreating it.

/** How many stale events one push may withdraw, so a huge backlog can't stall the day's push. */
export const TOMBSTONE_DRAIN_LIMIT = 200;

/**
 * Events that must never be deleted by any automated process, regardless of what the plan or
 * block tables currently look like.
 *
 * Owner report 2026-08-06: a completed task's calendar event was removed by the orphan
 * cleanup after an unrelated DB operation (outside this app) orphaned its block. The cleanup
 * was doing exactly its job — nothing claimed that event anymore — which is precisely why
 * "claimed" cannot be defined ONLY by a live plan/block join. Completed work is protected
 * independently, via the snapshot task.gcal_event_id (migration 14) taken the moment a task
 * is marked done and never cleared afterward.
 */
export function protectedEventIds(db: Db): Set<string> {
  return new Set(
    (
      db.prepare("SELECT gcal_event_id AS id FROM task WHERE status = 'done' AND gcal_event_id IS NOT NULL").all() as {
        id: string;
      }[]
    ).map((r) => r.id)
  );
}

/**
 * Delete every event the local plan no longer has a block for. Best-effort per event: an
 * event already gone from Google (404/410) is a SUCCESS — the goal is that it not be there.
 * Anything else leaves the row for the next push rather than losing track of it.
 */
export async function drainTombstones(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<{ deleted: number }> {
  const rows = db
    .prepare("SELECT id, event_id, calendar_id FROM gcal_tombstone ORDER BY id LIMIT ?")
    .all(TOMBSTONE_DRAIN_LIMIT) as { id: number; event_id: string; calendar_id: string | null }[];
  if (rows.length === 0) return { deleted: 0 };

  const posCal = getSetting(db, "pos_calendar_id");
  const cal = pushDeps(secrets, deps).calendar();
  const forget = db.prepare("DELETE FROM gcal_tombstone WHERE id = ?");
  const protectedIds = protectedEventIds(db);
  let deleted = 0;
  for (const r of rows) {
    // A tombstone can be QUEUED for a block that belonged to work marked done in the
    // meantime (e.g. supersession during an accepted-day re-solve). Discard the debt rather
    // than act on it — this event is now protected history.
    if (protectedIds.has(r.event_id)) { forget.run(r.id); continue; }
    const calendarId = r.calendar_id ?? posCal;
    // No POS calendar has ever existed, so neither has the event. Drop the row.
    if (!calendarId) { forget.run(r.id); continue; }
    try {
      await cal.events.delete({ calendarId, eventId: r.event_id });
      forget.run(r.id);
      deleted++;
    } catch (e) {
      if (needsReconsent(e)) throw e; // a scope problem, not a missing event — let the caller map it
      const status = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
      if (status === 404 || status === 410) { forget.run(r.id); continue; } // already gone = done
      console.warn(`gcal: could not withdraw event ${r.event_id}: ${(e as Error).message}`);
    }
  }
  if (deleted > 0) clearAnchorsCache();
  return { deleted };
}

export async function pushPlan(
  db: Db,
  secrets: SecretStore,
  planId: number,
  deps?: Partial<GcalPushDeps>
): Promise<{ pushed: number; withdrawn: number }> {
  const plan = db.prepare("SELECT plan_date FROM plan WHERE id = ?").get(planId) as { plan_date: string } | undefined;
  if (!plan) throw new Error(`plan ${planId} not found`);
  return withReconsentMapping(async () => {
    const calId = await ensurePosCalendar(db, secrets, deps);
    const cal = pushDeps(secrets, deps).calendar();
    // Withdraw BEFORE writing: the owner should never see the old block and its replacement
    // sitting on top of each other, even for the length of one push.
    const { deleted: withdrawn } = await drainTombstones(db, secrets, deps);
    const blocks = db
      // is_anchor = 0 means "the solver placed it". is_locked = 1 means "he pinned it, or it
      // already happened" — both are HIS blocks and belong on his calendar. Only an anchor he
      // did not pin is an external event, and that one is already on the calendar it came from.
      .prepare(
        `SELECT id, block_type, title, starts_at, ends_at, gcal_event_id FROM block
          WHERE plan_id = ? AND (is_anchor = 0 OR is_locked = 1)`
      )
      .all(planId) as { id: number; block_type: string; title: string; starts_at: string; ends_at: string; gcal_event_id: string | null }[];
    let pushed = 0;
    for (const b of blocks) {
      const body = {
        summary: b.title || b.block_type,
        description: `POS ${b.block_type} block`,
        start: { dateTime: new Date(b.starts_at).toISOString() },
        end: { dateTime: new Date(b.ends_at).toISOString() },
      };
      if (b.gcal_event_id) {
        await cal.events.update({ calendarId: calId, eventId: b.gcal_event_id, requestBody: body });
      } else {
        const created = await cal.events.insert({ calendarId: calId, requestBody: body });
        db.prepare("UPDATE block SET gcal_event_id = ? WHERE id = ?").run(created.data.id ?? null, b.id);
      }
      pushed++;
    }
    db.prepare("UPDATE plan SET pushed_at = datetime('now') WHERE id = ?").run(planId);
    // Every block now carries its event, so anything else on this day's POS calendar is an
    // orphan no bookkeeping accounted for. Sweeping here is what keeps the calendar equal to
    // the plan rather than an accumulation of every plan the day ever had.
    try {
      const orphans = await reconcileDayEvents(db, secrets, plan.plan_date, deps);
      if (orphans.removed > 0) console.log(`gcal: removed ${orphans.removed} orphaned event(s) on ${plan.plan_date}`);
    } catch (e) {
      console.warn(`gcal: orphan sweep failed for ${plan.plan_date}: ${(e as Error).message}`);
    }
    clearAnchorsCache(); // the day just changed in Google — next read must be live
    return { pushed, withdrawn };
  });
}

/**
 * Two-way rule: detect POS events the user moved in Google Calendar and lock them.
 * Deleted-in-GCal events mark the block dropped (gcal_event_id cleared).
 */
export async function reconcileMovedEvents(db: Db, secrets: SecretStore): Promise<{ locked: number }> {
  if (!isGoogleConnected(secrets)) return { locked: 0 };
  const calId = getSetting(db, "pos_calendar_id");
  if (!calId) return { locked: 0 };
  const cal = calApi(secrets);
  const rows = db
    .prepare("SELECT id, starts_at, ends_at, gcal_event_id FROM block WHERE gcal_event_id IS NOT NULL AND is_locked = 0")
    .all() as { id: number; starts_at: string; ends_at: string; gcal_event_id: string }[];
  let locked = 0;
  for (const b of rows) {
    try {
      const e = await cal.events.get({ calendarId: calId, eventId: b.gcal_event_id });
      const gs = e.data.start?.dateTime ? new Date(e.data.start.dateTime).getTime() : null;
      const ge = e.data.end?.dateTime ? new Date(e.data.end.dateTime).getTime() : null;
      if (gs === null || ge === null) continue;
      const ls = new Date(b.starts_at).getTime();
      const le = new Date(b.ends_at).getTime();
      if (gs !== ls || ge !== le) {
        db.prepare(
          "UPDATE block SET is_locked = 1, starts_at = ?, ends_at = ? WHERE id = ?"
        ).run(new Date(gs).toISOString().slice(0, 19), new Date(ge).toISOString().slice(0, 19), b.id);
        locked++;
      }
    } catch {
      // event deleted in GCal → forget the link; the block is no longer synced
      db.prepare("UPDATE block SET gcal_event_id = NULL WHERE id = ?").run(b.id);
    }
  }
  clearAnchorsCache(); // reconcile may have moved/dropped events — invalidate cached reads
  return { locked };
}

/** Find-or-create the POS Google Tasks list. */
export async function ensurePosTasklist(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<string> {
  return withReconsentMapping(async () => {
    const cached = getSetting(db, "pos_tasklist_id");
    const api = pushDeps(secrets, deps).tasks();
    if (cached) {
      try {
        await api.tasklists.get({ tasklist: cached });
        return cached;
      } catch (e) {
        if (needsReconsent(e)) throw e; // scope failure, not a deleted list
        /* recreate */
      }
    }
    const lists = await api.tasklists.list({ maxResults: 100 });
    const existing = lists.data.items?.find((l) => l.title === POS_TASKLIST_NAME);
    if (existing?.id) {
      setSetting(db, "pos_tasklist_id", existing.id);
      return existing.id;
    }
    const created = await api.tasklists.insert({ requestBody: { title: POS_TASKLIST_NAME } });
    if (!created.data.id) throw new Error("Google returned no tasklist id");
    setSetting(db, "pos_tasklist_id", created.data.id);
    return created.data.id;
  });
}

/**
 * Push open planner tasks + open confirmed commitments to Google Tasks (phone sync).
 * Completed/dropped local items complete their Google counterpart.
 */
export async function pushTasks(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<{ pushed: number; completed: number }> {
  return withReconsentMapping(() => pushTasksInner(db, secrets, deps));
}

async function pushTasksInner(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<{ pushed: number; completed: number }> {
  const listId = await ensurePosTasklist(db, secrets, deps);
  const api = pushDeps(secrets, deps).tasks();
  let pushed = 0;
  let completed = 0;

  // Owner report 2026-08-06: "the google tasks populated by the app are not dated. everything
  // needs to be on a certain day." The push used hard_deadline_at — a CLOCK-TIME deadline,
  // stated on maybe one task in twenty — and ignored plan_date, the day POS actually put the
  // work on for every other task. So a task fully scheduled inside the app still reached
  // Google Tasks with no due date at all, which is what he saw.
  const open = db
    .prepare(
      `SELECT id, title, notes, plan_date, hard_deadline_at, gtasks_id
         FROM task WHERE status IN ('inbox','planned','in_progress')`
    )
    .all() as {
    id: number; title: string; notes: string | null;
    plan_date: string | null; hard_deadline_at: string | null; gtasks_id: string | null;
  }[];
  for (const t of open) {
    // A clock-time deadline is more specific than a plain day, so it wins when both exist.
    const due = t.hard_deadline_at
      ? new Date(t.hard_deadline_at).toISOString()
      : t.plan_date
        ? new Date(`${t.plan_date}T00:00:00Z`).toISOString()
        : undefined;
    const body = { title: t.title, notes: t.notes ?? undefined, due };
    if (t.gtasks_id) {
      try {
        await api.tasks.update({ tasklist: listId, task: t.gtasks_id, requestBody: { ...body, id: t.gtasks_id } });
        continue;
      } catch (e) {
        // Only a MISSING task justifies re-inserting. A scope refusal would fail the
        // insert identically, so surface it instead of doubling the failed calls.
        if (needsReconsent(e)) throw e;
        /* fall through to insert */
      }
    }
    const created = await api.tasks.insert({ tasklist: listId, requestBody: body });
    db.prepare("UPDATE task SET gtasks_id = ? WHERE id = ?").run(created.data.id ?? null, t.id);
    pushed++;
  }

  // commitments (i_owe_them, open, confirmed) also surface on the phone
  const commitments = db
    .prepare(
      `SELECT c.id, c.description, c.due_at, p.display_name AS who
       FROM commitment c LEFT JOIN person p ON p.id = c.person_id
       WHERE c.status = 'open' AND c.confirmed_by_user = 1 AND c.direction = 'i_owe_them'`
    )
    .all() as { id: number; description: string; due_at: string | null; who: string | null }[];
  const existing = await api.tasks.list({ tasklist: listId, maxResults: 100, showCompleted: false });
  const have = new Set((existing.data.items ?? []).map((t) => t.notes ?? ""));
  for (const c of commitments) {
    const marker = `pos:commitment:${c.id}`;
    if (have.has(marker)) continue;
    await api.tasks.insert({
      tasklist: listId,
      requestBody: {
        title: c.who ? `${c.description} (${c.who})` : c.description,
        notes: marker,
        due: c.due_at ? new Date(c.due_at).toISOString() : undefined,
      },
    });
    pushed++;
  }

  // complete Google tasks whose local task is done
  const done = db
    .prepare("SELECT gtasks_id FROM task WHERE status = 'done' AND gtasks_id IS NOT NULL")
    .all() as { gtasks_id: string }[];
  for (const d of done) {
    try {
      await api.tasks.update({
        tasklist: listId,
        task: d.gtasks_id,
        requestBody: { id: d.gtasks_id, status: "completed" },
      });
      completed++;
    } catch (e) {
      if (needsReconsent(e)) throw e; // scope failure, not an already-deleted task
      /* already gone */
    }
  }
  return { pushed, completed };
}

// ── commitment → task / event (extracted from ipc.ts so they are testable) ───
//
// These are the bodies of the "Add task" / "Add event" buttons on the Relationships
// dashboard. All LOCAL database work happens first and unconditionally; the Google
// push is best-effort, time-boxed, and reported — it can never block or lose the
// local write. (The old inline handler awaited a full un-timed Google Tasks push
// before returning, so a slow/stale-token network call made the button look dead.)

/** Reject-after-timeout wrapper. Does not cancel `p`; the local DB state is already consistent. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const GOOGLE_PUSH_TIMEOUT_MS = 15_000;

export interface CommitmentToTaskResult {
  task: boolean;
  /** True when an open task for this commitment already existed (double-click guard). */
  duplicate: boolean;
  google: boolean;
  reason?: string;
  pushed?: number;
  completed?: number;
}

/**
 * Confirm (if needed) + create a local task for a commitment, then push to Google
 * Tasks. Idempotent: an existing open task for the same commitment is reused, not
 * duplicated. Throws only when the commitment does not exist.
 *
 * `dateISO` ("YYYY-MM-DD", from the always-prompt picker) overrides the plan date AND
 * the Google Tasks due date. `tentative` (automatic pipeline only) prefixes the GOOGLE
 * title with "Tentative: " — the local task title stays clean — and pushes only this
 * one task instead of running a full pushTasks.
 */
export async function commitmentToTask(
  db: Db,
  secrets: SecretStore,
  id: number,
  dateISO?: string,
  opts: { tentative?: boolean } = {}
): Promise<CommitmentToTaskResult> {
  const c = db.prepare("SELECT id, description, due_at, confirmed_by_user FROM commitment WHERE id = ?").get(id) as
    | { id: number; description: string; due_at: string | null; confirmed_by_user: number } | undefined;
  if (!c) throw new Error("commitment not found");
  if (c.confirmed_by_user === 0) confirmCommitment(db, id);

  const pickedDate = dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : null;

  // Double-click guard: the observed failure mode was two identical tasks created
  // seconds apart because the button gave no feedback while Google was slow.
  const existing = db
    .prepare("SELECT id FROM task WHERE commitment_id = ? AND status IN ('inbox','planned','in_progress')")
    .get(id) as { id: number } | undefined;
  let duplicate = false;
  let taskId: number | null = existing?.id ?? null;
  if (existing) {
    duplicate = true;
  } else {
    // Only explicit dates schedule things (owner directive 2026-08-05): a commitment
    // with no due date and no picked date becomes an INBOX item — plan_date NULL,
    // hard_deadline_at NULL, Google task with no due date. Never default to today.
    // A due date that has already PASSED is overdue, not dead. Left as-is it becomes a
    // plan_date the solver will never look at again (it only plans today forward), so the
    // task exists and is silently unschedulable — which is what happened to "Provide Papa
    // with Europe trip credit card charges", dated 2026-07-01 by extraction and therefore
    // invisible from the moment it was created. Overdue work belongs on today.
    const rawDue = c.due_at ? c.due_at.slice(0, 10) : null;
    const todayISO = new Date().toISOString().slice(0, 10);
    const due = rawDue && rawDue < todayISO ? todayISO : rawDue;
    // …unless the description names a date the app actually knows (main/context.ts):
    // "meetup at the start of school" lands on the user's term-start anchor. This is the
    // owner's exact click-path — the picker used to prefill TODAY for exactly this row.
    const named = !pickedDate && !due ? resolveNamedDate(db, c.description) : null;
    const planDate = pickedDate ?? due ?? named; // may be NULL → inbox, not on today's list
    const deadline = pickedDate
      ? `${pickedDate}T00:00:00`
      : c.due_at ?? (named ? `${named}T00:00:00` : null);
    const r = db.prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
        commitment_id, status, plan_date, hard_deadline_at, estimate_source)
       VALUES (?, 'admin', 2, 30, 30, ?, 'inbox', ?, ?, 'inferred')`
    ).run(c.description.slice(0, 120), c.id, planDate, deadline);
    taskId = Number(r.lastInsertRowid);
  }
  db.prepare("UPDATE commitment SET status = 'scheduled' WHERE id = ?").run(id);

  if (!isGoogleConnected(secrets)) return { task: true, duplicate, google: false, reason: "Google not connected" };
  try {
    if (opts.tentative) {
      // Targeted single-task push (never a full pushTasks from an automatic run).
      if (duplicate || taskId == null) return { task: true, duplicate, google: false, reason: "duplicate" };
      const t = db.prepare("SELECT title, hard_deadline_at FROM task WHERE id = ?").get(taskId) as
        | { title: string; hard_deadline_at: string | null } | undefined;
      if (!t) return { task: true, duplicate, google: false, reason: "task vanished" };
      const listId = await withTimeout(ensurePosTasklist(db, secrets), GOOGLE_PUSH_TIMEOUT_MS, "Google Tasks push timed out");
      const created = await withReconsentMapping(() =>
        withTimeout(
          tasksApi(secrets).tasks.insert({
            tasklist: listId,
            requestBody: {
              title: `Tentative: ${t.title}`,
              due: t.hard_deadline_at ? new Date(t.hard_deadline_at).toISOString() : undefined,
            },
          }),
          GOOGLE_PUSH_TIMEOUT_MS,
          "Google Tasks push timed out"
        )
      );
      db.prepare("UPDATE task SET gtasks_id = ? WHERE id = ?").run(created.data.id, taskId);
      return { task: true, duplicate, google: true, pushed: 1, completed: 0 };
    }
    const res = await withTimeout(pushTasks(db, secrets), GOOGLE_PUSH_TIMEOUT_MS, "Google Tasks push timed out");
    return { task: true, duplicate, google: true, ...res };
  } catch (err) {
    return { task: true, duplicate, google: false, reason: (err as Error).message };
  }
}

/**
 * Best-effort, time-boxed cleanup: mark a pushed Google task completed (used by
 * undo and by dropping a commitment). Swallows every error — the local DB is the
 * source of truth and is already consistent.
 */
export async function closeGoogleTask(db: Db, secrets: SecretStore, gtasksId: string): Promise<void> {
  if (!gtasksId || !isGoogleConnected(secrets)) return;
  try {
    const listId = getSetting(db, "pos_tasklist_id");
    if (!listId) return;
    await withTimeout(
      tasksApi(secrets).tasks.update({
        tasklist: listId,
        task: gtasksId,
        requestBody: { id: gtasksId, status: "completed" },
      }),
      GOOGLE_PUSH_TIMEOUT_MS,
      "Google Tasks cleanup timed out"
    );
  } catch {
    /* best-effort */
  }
}

/** Full task row as deleted by dropCommitmentCascade (for undo re-insertion). */
export interface DeletedTaskRow {
  id: number;
  title: string;
  notes: string | null;
  block_type: string;
  cognitive_load: number | null;
  estimated_minutes: number | null;
  raw_estimate_minutes: number | null;
  is_mit: number;
  hard_deadline_at: string | null;
  project: string | null;
  commitment_id: number | null;
  status: string;
  splittable: number;
  estimate_source: string | null;
  plan_date: string | null;
  gtasks_id: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * Drop a commitment AND clean up what it spawned: delete still-open local tasks
 * linked to it and best-effort complete their Google counterparts (time-boxed,
 * fire-and-forget). Returns the deleted rows so undo can re-insert them.
 */
export function dropCommitmentCascade(
  db: Db,
  secrets: SecretStore,
  id: number
): { dropped: boolean; deletedTasks: DeletedTaskRow[] } {
  dropCommitment(db, id);
  const tasks = db
    .prepare("SELECT * FROM task WHERE commitment_id = ? AND status IN ('inbox','planned','in_progress')")
    .all(id) as DeletedTaskRow[];
  for (const t of tasks) {
    db.prepare("DELETE FROM task WHERE id = ?").run(t.id);
    if (t.gtasks_id) void closeGoogleTask(db, secrets, t.gtasks_id);
  }
  return { dropped: true, deletedTasks: tasks };
}

export interface CommitmentToEventResult {
  event?: boolean;
  needsDate?: boolean;
  starts_at?: string;
  /** Local block row id (for undo). */
  block_id?: number;
}

/**
 * Pin a 60-min personal block for a commitment on its due date (or the supplied
 * date/time). No due date and no supplied date → { needsDate: true } so the UI can
 * ask. Throws when the commitment does not exist or the date/time is invalid.
 */
export function commitmentToEvent(db: Db, id: number, dateISO?: string, hhmm?: string): CommitmentToEventResult {
  const c = db.prepare("SELECT id, description, due_at FROM commitment WHERE id = ?").get(id) as
    | { id: number; description: string; due_at: string | null } | undefined;
  if (!c) throw new Error("commitment not found");
  // Named-date fallback before giving up: "dinner at the start of school" resolves against
  // the user's date anchors (main/context.ts) rather than forcing the UI to ask.
  const date =
    dateISO || (c.due_at ? c.due_at.slice(0, 10) : null) || resolveNamedDate(db, c.description);
  if (!date) return { needsDate: true };
  const time = hhmm && /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : "10:00";
  const startsAt = `${date}T${time}:00`;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new Error("invalid date/time");
  const end = new Date(start.getTime() + 60 * 60_000);
  const endsAt = `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}T${pad2(end.getHours())}:${pad2(end.getMinutes())}:00`;
  const r = db.prepare(
    `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, is_locked, plan_id)
     VALUES (NULL, 'personal', ?, ?, ?, 0, 1, NULL)`
  ).run(c.description.slice(0, 120), startsAt, endsAt);
  db.prepare("UPDATE commitment SET status = 'scheduled' WHERE id = ?").run(id);
  return { event: true, starts_at: startsAt, block_id: Number(r.lastInsertRowid) };
}


// ── the calendar must match the plan, not accumulate it ──────────────────────
//
// Owner report 2026-08-06, with a screenshot: two Lunches, two Comms window 2s, two math
// tests, two Breaks, two Shutdown rituals — each pair fifteen minutes apart. Local blocks
// carry the event they own, and the tombstone drain withdraws what a re-plan removed, but
// neither can clean up an event whose block is gone WITHOUT having been tombstoned: a plan
// row deleted outside the app, a push that half-landed, a crash between insert and stamp.
//
// So this is the backstop that needs no bookkeeping to be correct: ask Google what it has on
// the POS calendar for a date, and delete anything no live block claims. It cannot touch
// another calendar (it only ever reads and deletes within the POS calendar id) and it cannot
// touch an event a block still points at.

export interface ReconcileDayResult {
  /** Events on the POS calendar for that date. */
  seen: number;
  /** Orphans deleted — on the calendar, claimed by no block. */
  removed: number;
}

/** Delete POS-calendar events for `dateISO` that no live block references. */
export async function reconcileDayEvents(
  db: Db,
  secrets: SecretStore,
  dateISO: string,
  deps?: Partial<GcalPushDeps>
): Promise<ReconcileDayResult> {
  const out: ReconcileDayResult = { seen: 0, removed: 0 };
  const calId = getSetting(db, "pos_calendar_id");
  if (!calId) return out;
  return withReconsentMapping(async () => {
    const cal = pushDeps(secrets, deps).calendar();
    const res = await cal.events.list({
      calendarId: calId,
      timeMin: new Date(`${dateISO}T00:00:00`).toISOString(),
      timeMax: new Date(`${dateISO}T23:59:59`).toISOString(),
      maxResults: 250,
      singleEvents: true,
    });
    const items = (res.data.items ?? []).filter((e) => e.id);
    out.seen = items.length;

    const claimed = new Set(
      (
        db
          .prepare(
            `SELECT b.gcal_event_id AS id FROM block b JOIN plan p ON p.id = b.plan_id
              WHERE p.plan_date = ? AND b.gcal_event_id IS NOT NULL`
          )
          .all(dateISO) as { id: string }[]
      ).map((r) => r.id)
    );
    for (const id of protectedEventIds(db)) claimed.add(id);

    for (const e of items) {
      if (claimed.has(e.id!)) continue;
      try {
        await cal.events.delete({ calendarId: calId, eventId: e.id! });
        out.removed++;
      } catch (err) {
        const status = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
        if (status === 404 || status === 410) continue; // already gone is the goal
        console.warn(`gcal: could not remove orphan ${e.id}: ${(err as Error).message}`);
      }
    }
    if (out.removed > 0) clearAnchorsCache();
    return out;
  });
}
