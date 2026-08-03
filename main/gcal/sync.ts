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

export interface ExternalAnchor {
  startMin: number;
  endMin: number;
  title: string;
  blockType: "meeting" | "personal";
  gcalEventId: string;
}

/**
 * Read anchors for a date from ALL calendars except the POS calendar.
 * External events are immovable by definition.
 */
export async function readAnchors(db: Db, secrets: SecretStore, dateISO: string): Promise<ExternalAnchor[]> {
  if (!isGoogleConnected(secrets)) return [];
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
      });
    }
  }
  return anchors;
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
