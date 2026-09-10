// Apple Reminders (Reminders.app) bridge — macOS only.
//
// Owner directive 2026-08-10: iOS already detects "let's meet Tuesday at 4" in Messages and
// offers a one-tap reminder. That native detection is better than anything POS can infer from
// the same text, and it has the property POS's own extraction never will: HE chose it. So the
// pipeline inverts — Reminders becomes an INPUT, and POS stops guessing tasks out of message
// text. What POS keeps doing with messages is the CRM half: contacts, bios, commitments.
//
// Shape mirrors applecal.ts deliberately: same osascript plumbing (runOsascript, asString),
// same unit-separator row format, same "never throw, return a typed result" contract, and the
// same rule that one unreadable list must not take the whole read down.

import type { Db } from "../db/db.ts";
import { runOsascript, asString, FIELD_SEP, AppleCalError } from "../applecal.ts";

/** Lists POS refuses to read: its own write-back target, so a push can't be re-imported. */
export const POS_REMINDER_LIST = "POS";

export interface AppleReminder {
  /** Reminders.app id — stable, and what a later complete/delete addresses. */
  id: string;
  name: string;
  body: string | null;
  /** ISO local wall-clock, or null for an undated reminder (→ POS inbox, never "today"). */
  dueISO: string | null;
  completed: boolean;
  list: string;
  /** Reminders priority: 0 none, 1-4 high, 5 medium, 6-9 low. */
  priority: number;
}

/**
 * Parse one `id<US>name<US>body<US>dueISO<US>completed<US>priority<US>list` row.
 * Returns null for anything malformed so a single bad row is skipped, not fatal.
 */
export function parseReminderLine(line: string): AppleReminder | null {
  if (typeof line !== "string") return null;
  const parts = line.replace(/\r$/, "").split(FIELD_SEP);
  if (parts.length < 7) return null;
  const [id, name, body, due, completed, priority, ...rest] = parts;
  if (!id?.trim() || !name?.trim()) return null;
  return {
    id: id.trim(),
    name: name.trim(),
    body: body?.trim() ? body.trim() : null,
    dueISO: due?.trim() ? due.trim() : null,
    completed: completed === "1",
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    list: (rest.join(FIELD_SEP) || "").trim() || "Reminders",
  };
}

export function parseReminders(stdout: string): AppleReminder[] {
  return (stdout ?? "")
    .split("\n")
    .map(parseReminderLine)
    .filter((r): r is AppleReminder => r !== null);
}

/**
 * Read reminders. `includeCompleted` stays false for the import path — a reminder he already
 * ticked off is history, not an inbox item (same rule gtasks-sync applies to Google rows).
 *
 * The script emits ISO via a manual date build rather than `due date as string`, because the
 * latter is locale-formatted and unparseable ("Tuesday, August 11, 2026 at 4:00:00 PM" —
 * Date.parse rejects the " at "; applecal.ts has the same note).
 */
export function buildRemindersScript(includeCompleted = false): string {
  const filter = includeCompleted ? "every reminder" : "(every reminder whose completed is false)";
  return [
    'on isoOf(d)',
    '  if d is missing value then return ""',
    '  set y to year of d as integer',
    '  set m to (month of d as integer)',
    '  set dd to day of d as integer',
    '  set hh to hours of d',
    '  set mi to minutes of d',
    '  set t to (y as string) & "-"',
    '  if m < 10 then set t to t & "0"',
    '  set t to t & (m as string) & "-"',
    '  if dd < 10 then set t to t & "0"',
    '  set t to t & (dd as string) & "T"',
    '  if hh < 10 then set t to t & "0"',
    '  set t to t & (hh as string) & ":"',
    '  if mi < 10 then set t to t & "0"',
    '  set t to t & (mi as string) & ":00"',
    '  return t',
    'end isoOf',
    'set SEP to (ASCII character 31)',
    'set out to ""',
    'tell application "Reminders"',
    '  repeat with L in lists',
    '    set lname to name of L',
    `    if lname is not ${asString(POS_REMINDER_LIST)} then`,
    '      try',
    `        repeat with r in (${filter} of L)`,
    '          set dstr to my isoOf(due date of r)',
    '          set cflag to "0"',
    '          if completed of r then set cflag to "1"',
    '          set bod to ""',
    '          try',
    '            if body of r is not missing value then set bod to body of r',
    '          end try',
    '          set pri to 0',
    '          try',
    '            set pri to priority of r',
    '          end try',
    '          set out to out & (id of r) & SEP & (name of r) & SEP & bod & SEP & dstr & SEP & cflag & SEP & (pri as string) & SEP & lname & linefeed',
    '        end repeat',
    '      end try',
    '    end if',
    '  end repeat',
    'end tell',
    'return out',
  ].join("\n");
}

/** Read reminders across every list except POS's own. Throws AppleCalError on failure. */
export async function readReminders(includeCompleted = false): Promise<AppleReminder[]> {
  const res = await runOsascript(buildRemindersScript(includeCompleted), 60_000);
  if (!res.ok) throw res.error;
  return parseReminders(res.stdout);
}

/** List names, for the Settings picker. */
export async function listReminderLists(): Promise<string[]> {
  const res = await runOsascript('tell application "Reminders" to return name of every list', 30_000);
  if (!res.ok) throw res.error;
  return (res.stdout ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Probe used by the Settings status chip — and the call that triggers macOS's Automation
 * prompt for Reminders, so "Check access" is a real button here too.
 */
export async function remindersAvailable(): Promise<{ ok: boolean; error?: string; lists?: number }> {
  try {
    const lists = await listReminderLists();
    return { ok: true, lists: lists.length };
  } catch (e) {
    return { ok: false, error: e instanceof AppleCalError ? e.message : (e as Error).message };
  }
}

export interface ReminderImportResult {
  imported: number;
  skipped: number;
  error?: string;
}

/**
 * Import incomplete reminders as POS inbox tasks. Idempotent through task.reminder_id and
 * its UNIQUE index (migration 19) — re-running imports nothing new, and a race cannot
 * insert a second copy because the storage layer refuses it, not because we checked first.
 *
 * Dating follows the rule the rest of the app already enforces (owner directive 2026-08-05):
 * only an explicit date schedules anything. A reminder with no due date becomes an INBOX
 * task with plan_date NULL — it never defaults to today. A due date already in the past is
 * overdue, not dead, so it lands on today the same way commitmentToTask handles it.
 */
export function importReminders(db: Db, reminders: readonly AppleReminder[], todayISO: string): ReminderImportResult {
  const insert = db.prepare(
    `INSERT INTO task (title, notes, block_type, cognitive_load, estimated_minutes,
                       raw_estimate_minutes, status, plan_date, hard_deadline_at,
                       estimate_source, reminder_id)
     VALUES (?, ?, 'admin', 2, 30, 30, 'inbox', ?, ?, 'inferred', ?)
     ON CONFLICT(reminder_id) DO NOTHING`
  );
  let imported = 0;
  let skipped = 0;
  for (const r of reminders) {
    if (r.completed) { skipped++; continue; } // already done is history, not an inbox item
    const title = r.name.trim().slice(0, 200);
    if (!title) { skipped++; continue; }
    const rawDay = r.dueISO ? r.dueISO.slice(0, 10) : null;
    const planDate = rawDay && rawDay < todayISO ? todayISO : rawDay;
    const deadline = r.dueISO ?? null;
    try {
      const res = insert.run(title, r.body, planDate, deadline, r.id);
      if (res.changes > 0) imported++;
      else skipped++; // already imported (unique index held)
    } catch (e) {
      skipped++;
      console.warn(`reminders: import of ${r.id} failed: ${(e as Error).message}`);
    }
  }
  return { imported, skipped };
}

/** Read Reminders.app and import in one step. Never throws — errors land on the result. */
export async function syncReminders(db: Db, todayISO: string): Promise<ReminderImportResult> {
  try {
    const reminders = await readReminders(false);
    return importReminders(db, reminders, todayISO);
  } catch (e) {
    return { imported: 0, skipped: 0, error: (e as Error).message };
  }
}

/** Tick a reminder off in Reminders.app (POS completing it locally syncs back). */
export async function completeReminder(id: string): Promise<boolean> {
  const script = [
    'tell application "Reminders"',
    '  repeat with L in lists',
    '    try',
    `      set r to (first reminder of L whose id is ${asString(id)})`,
    '      set completed of r to true',
    '      return "OK"',
    '    end try',
    '  end repeat',
    'end tell',
    'return "NOTFOUND"',
  ].join("\n");
  const res = await runOsascript(script, 30_000);
  return res.ok && res.stdout.trim() === "OK";
}
