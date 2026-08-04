// Google Calendar + Google Tasks sync (§6 + owner extension).
//
// READ: all calendars on app open + every 15 min while open → external events become
//       anchor blocks for the planner.
// WRITE: ONLY into the dedicated "POS — Planned" calendar. Never the primary. Every
//        generated block is deletable in one action; real invitations are never touched.
// Push is explicit — plan generated, reviewed, pushed on confirm. No auto-write.
// Two-way rule: if the user moves a POS event in Google Calendar, the next sync marks
// that block is_locked=1 and the planner treats it as an anchor. Do not fight the user.
// Tasks: open planner tasks + confirmed commitments push to a "POS" Google Tasks list
// so they appear on the phone.

import { google, type calendar_v3, type tasks_v1 } from "googleapis";
import type { Db } from "../db/db.ts";
import { getSetting, setSetting } from "../db/db.ts";
import type { SecretStore } from "../secrets.ts";
import { isGoogleConnected, oauthClient } from "./auth.ts";
import { confirmCommitment, dropCommitment } from "../crm/commitments.ts";

export const POS_CALENDAR_NAME = "POS — Planned";
export const POS_TASKLIST_NAME = "POS";

function calApi(secrets: SecretStore): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: oauthClient(secrets) });
}
function tasksApi(secrets: SecretStore): tasks_v1.Tasks {
  return google.tasks({ version: "v1", auth: oauthClient(secrets) });
}

/** Find-or-create the dedicated POS calendar; id cached in settings. */
export async function ensurePosCalendar(db: Db, secrets: SecretStore): Promise<string> {
  const cached = getSetting(db, "pos_calendar_id");
  const cal = calApi(secrets);
  if (cached) {
    try {
      await cal.calendars.get({ calendarId: cached });
      return cached;
    } catch {
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
  setSetting(db, "pos_calendar_id", created.data.id!);
  return created.data.id!;
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
export async function ensureMessagesCalendar(db: Db, secrets: SecretStore): Promise<string> {
  const cal = calApi(secrets);
  const cached = getSetting(db, MSGPLANS_SETTING_KEY);
  if (cached) {
    const id = assertMessagesCalendarId(db, cached);
    try {
      const got = await cal.calendars.get({ calendarId: id });
      // A cached id whose calendar was renamed/replaced is not ours — fall through.
      if (got.data.summary === MSGPLANS_CALENDAR_NAME) return id;
    } catch {
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
}

/** Only ask for what we read — and crucially, ask for iCalUID. */
const EVENT_FIELDS = "items(id,status,summary,start,end,attendees,iCalUID),nextPageToken";

// Day-flipping in the planner calls readAnchors once per flip; without a cache every
// flip is a live round-trip to Google (calendarList + one events.list per calendar).
// Mirrors the googleICalUids cache below: per-date, in-process, short TTL.
const ANCHORS_TTL_MS = 60_000;
const anchorsCache = new Map<string, { at: number; anchors: ExternalAnchor[] }>();

/** Drop the in-process anchors cache — called after any write (pushPlan/reconcile) so reads stay fresh. */
export function clearAnchorsCache(): void {
  anchorsCache.clear();
}

/**
 * Read anchors for a date from ALL calendars except the POS calendar.
 * External events are immovable by definition. Cached per-date for 60s;
 * pushPlan/reconcileMovedEvents clear the cache so pushes read back fresh.
 */
export async function readAnchors(db: Db, secrets: SecretStore, dateISO: string): Promise<ExternalAnchor[]> {
  if (!isGoogleConnected(secrets)) return [];
  const hit = anchorsCache.get(dateISO);
  if (hit && Date.now() - hit.at < ANCHORS_TTL_MS) return hit.anchors;
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
      anchors.push({
        startMin: s.getHours() * 60 + s.getMinutes(),
        endMin: en.getHours() * 60 + en.getMinutes(),
        title: e.summary ?? "(busy)",
        blockType: (e.attendees?.length ?? 0) > 0 ? "meeting" : "personal",
        gcalEventId: e.id!,
        iCalUID: e.iCalUID ?? "",
      });
    }
  }
  anchorsCache.set(dateISO, { at: Date.now(), anchors });
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
}

export interface MergedAnchor {
  startMin: number;
  endMin: number;
  title: string;
  blockType: "meeting" | "personal";
  source: "google" | "apple";
  /** iCalUID (Google) or Apple UID; empty when the source gave us none. */
  uid: string;
}

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
    anchors.push({
      startMin: ev.startMin,
      endMin: ev.endMin,
      title: ev.title,
      blockType: ev.blockType ?? "personal",
      source: "apple",
      uid,
    });
  }

  return { anchors, skipped };
}

/** Explicit push: write every non-anchor block of a plan into the POS calendar. */
export async function pushPlan(db: Db, secrets: SecretStore, planId: number): Promise<{ pushed: number }> {
  const calId = await ensurePosCalendar(db, secrets);
  const cal = calApi(secrets);
  const plan = db.prepare("SELECT plan_date FROM plan WHERE id = ?").get(planId) as { plan_date: string } | undefined;
  if (!plan) throw new Error(`plan ${planId} not found`);
  const blocks = db
    .prepare("SELECT id, block_type, title, starts_at, ends_at, gcal_event_id FROM block WHERE plan_id = ? AND is_anchor = 0")
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
      db.prepare("UPDATE block SET gcal_event_id = ? WHERE id = ?").run(created.data.id, b.id);
    }
    pushed++;
  }
  db.prepare("UPDATE plan SET pushed_at = datetime('now') WHERE id = ?").run(planId);
  clearAnchorsCache(); // the day just changed in Google — next read must be live
  return { pushed };
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
export async function ensurePosTasklist(db: Db, secrets: SecretStore): Promise<string> {
  const cached = getSetting(db, "pos_tasklist_id");
  const api = tasksApi(secrets);
  if (cached) {
    try {
      await api.tasklists.get({ tasklist: cached });
      return cached;
    } catch {
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
  setSetting(db, "pos_tasklist_id", created.data.id!);
  return created.data.id!;
}

/**
 * Push open planner tasks + open confirmed commitments to Google Tasks (phone sync).
 * Completed/dropped local items complete their Google counterpart.
 */
export async function pushTasks(db: Db, secrets: SecretStore): Promise<{ pushed: number; completed: number }> {
  const listId = await ensurePosTasklist(db, secrets);
  const api = tasksApi(secrets);
  let pushed = 0;
  let completed = 0;

  const open = db
    .prepare("SELECT id, title, notes, hard_deadline_at, gtasks_id FROM task WHERE status IN ('inbox','planned','in_progress')")
    .all() as { id: number; title: string; notes: string | null; hard_deadline_at: string | null; gtasks_id: string | null }[];
  for (const t of open) {
    const body = {
      title: t.title,
      notes: t.notes ?? undefined,
      due: t.hard_deadline_at ? new Date(t.hard_deadline_at).toISOString() : undefined,
    };
    if (t.gtasks_id) {
      try {
        await api.tasks.update({ tasklist: listId, task: t.gtasks_id, requestBody: { ...body, id: t.gtasks_id } });
        continue;
      } catch {
        /* fall through to insert */
      }
    }
    const created = await api.tasks.insert({ tasklist: listId, requestBody: body });
    db.prepare("UPDATE task SET gtasks_id = ? WHERE id = ?").run(created.data.id, t.id);
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
    } catch {
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
    const today = new Date().toISOString().slice(0, 10);
    const due = c.due_at ? c.due_at.slice(0, 10) : null;
    const planDate = pickedDate ?? (due && due > today ? due : today);
    const deadline = pickedDate ? `${pickedDate}T00:00:00` : c.due_at;
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
      const created = await withTimeout(
        tasksApi(secrets).tasks.insert({
          tasklist: listId,
          requestBody: {
            title: `Tentative: ${t.title}`,
            due: t.hard_deadline_at ? new Date(t.hard_deadline_at).toISOString() : undefined,
          },
        }),
        GOOGLE_PUSH_TIMEOUT_MS,
        "Google Tasks push timed out"
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
  const date = dateISO || (c.due_at ? c.due_at.slice(0, 10) : null);
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
