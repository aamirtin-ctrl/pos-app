// Reconnect cadence. Tier thresholds decide how long a relationship can go quiet before it
// surfaces — owner rule 2026-08-04: never nag before 3 months, any tier. Dismissals (kind
// 'stale') suppress a person indefinitely (snooze_until NULL) or until the snooze expires.

import type { Db } from "../db/db.ts";

export const TIER_DAYS: Record<number, number> = { 0: 90, 1: 90, 2: 120, 3: Infinity };

/**
 * How far PAST due a relationship must be before it is worth raising.
 *
 * Owner report 2026-08-06: "it still tells me to reconnect with people that are only, like,
 * zero days over or one day over or eighteen days over. Shouldn't be doing that."
 *
 * A threshold crossing is not an event. Ninety days is his judgement about roughly how long
 * a friendship can go quiet, and treating it as an exact instant meant the list re-armed
 * every single morning with whoever happened to tick over at midnight — the least urgent
 * people it could possibly show him, presented as though something had just become due.
 *
 * A grace band makes "overdue" mean something: by the time a name appears, it is genuinely
 * past time rather than one day past arithmetic. Three weeks covers all three numbers he
 * named and is short enough that nobody gets lost. Nothing else changes — the cadence, the
 * dismissals and the group suppressions are all untouched.
 */
export const RECONNECT_GRACE_DAYS = 21;

export interface ReconnectRow {
  id: number;
  display_name: string;
  org: string | null;
  tier: number;
  last_contact_at: string | null;
  next_touch_due_at: string;
  overdue_days: number;
  /** Names of the groups this person belongs to (migrated CRM groups). */
  groups: string[];
}

/**
 * Bring person.last_contact_at up to date with the messages POS has actually ingested.
 *
 * Owner report 2026-08-06: "in the reconnect section it still tells me to reconnect with
 * people that are only, like, zero days over or one day over or eighteen days over."
 *
 * The cadence was never the bug — the tiers are 90/90/120 days and were honoring his
 * three-month rule. The DATE was. `last_contact_at` arrived with the PersonalCRM2 migration
 * and was then frozen: every iMessage, email and LinkedIn thread ingested since updated
 * `interaction` and left the person row alone. So the reconnect list was computing "90 days
 * since you spoke" from a date that stopped moving in April.
 *
 * The clearest case in his data: Ishaan last messaged him 2026-07-27 — ten days ago — while
 * his person row still said 2026-03-27, which put him twelve days "overdue" for a
 * three-month reconnect. That is exactly the barely-over-the-line noise he was seeing, and
 * several of those people were not due at all.
 *
 * MAX, never overwrite downward: a contact logged by hand (a call, a coffee) has no
 * interaction row behind it and must not be erased by this.
 */
export function refreshLastContact(db: Db): number {
  return db
    .prepare(
      `UPDATE person SET last_contact_at = (
         SELECT MAX(i.occurred_at) FROM interaction i WHERE i.person_id = person.id
       )
       WHERE EXISTS (
         SELECT 1 FROM interaction i
          WHERE i.person_id = person.id
            AND (person.last_contact_at IS NULL OR i.occurred_at > person.last_contact_at)
       )`
    )
    .run().changes;
}

/**
 * Recompute person.next_touch_due_at = last_contact_at + tier threshold. Tier 3 → NULL.
 * Refreshes last_contact_at first, so the cadence is measured from when they actually last
 * spoke rather than from whatever the migration froze in place.
 */
export function refreshNextTouch(db: Db): number {
  const run = db.transaction(() => {
    let changed = refreshLastContact(db);
    for (const [tier, days] of Object.entries(TIER_DAYS)) {
      if (!Number.isFinite(days)) {
        changed += db
          .prepare("UPDATE person SET next_touch_due_at = NULL WHERE tier = ?")
          .run(Number(tier)).changes;
        continue;
      }
      changed += db
        .prepare(
          `UPDATE person SET next_touch_due_at =
             CASE WHEN last_contact_at IS NULL THEN NULL
                  ELSE datetime(last_contact_at, '+' || ? || ' days') END
           WHERE tier = ?`
        )
        .run(days, Number(tier)).changes;
    }
    return changed;
  });
  return run();
}

// Unit separator — cannot appear in a group name, so group_concat splits safely.
const GROUP_SEP = String.fromCharCode(31);

/**
 * Persons past their next touch, excluding active 'stale' dismissals (snooze_until NULL =
 * dismissed indefinitely; a future snooze_until also suppresses) and excluding anyone who
 * belongs to a group with suppress_follow_ups = 1 (e.g. the migrated "family group").
 * Each row carries the person's group names. Ordered by tier (inner circle first), then
 * most-overdue first.
 */
export function reconnectDue(
  db: Db,
  now: Date = new Date(),
  graceDays: number = RECONNECT_GRACE_DAYS
): ReconnectRow[] {
  const nowIso = now.toISOString().replace("T", " ").slice(0, 19);
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.org, p.tier, p.last_contact_at, p.next_touch_due_at,
              CAST(julianday(?) - julianday(p.next_touch_due_at) AS INTEGER) AS overdue_days,
              (SELECT group_concat(g.name, char(31)) FROM person_group pg
                 JOIN grp g ON g.id = pg.group_id WHERE pg.person_id = p.id) AS group_names
       FROM person p
       WHERE p.next_touch_due_at IS NOT NULL
         AND p.next_touch_due_at <= datetime(?, '-' || ? || ' days')
         AND p.tier < 3
         -- Hard floor (owner directive 2026-09-10): never suggest anyone touched in the
         -- last 90 days, whatever the cadence math says. Normally redundant with
         -- refreshLastContact, but it holds even when a person row's stamp is stale or
         -- a tier change shortens the threshold under someone.
         AND NOT EXISTS (
           SELECT 1 FROM interaction i
           WHERE i.person_id = p.id AND i.occurred_at > datetime(?, '-90 days')
         )
         AND NOT EXISTS (
           SELECT 1 FROM dismissal d
           WHERE d.person_id = p.id AND d.kind = 'stale'
             AND (d.snooze_until IS NULL OR d.snooze_until > ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM person_group pg JOIN grp g ON g.id = pg.group_id
           WHERE pg.person_id = p.id AND g.suppress_follow_ups = 1
         )
       ORDER BY p.tier ASC, overdue_days DESC`
    )
    .all(nowIso, nowIso, graceDays, nowIso, nowIso) as (Omit<ReconnectRow, "groups"> & { group_names: string | null })[];
  return rows.map(({ group_names, ...r }) => ({
    ...r,
    groups: group_names ? group_names.split(GROUP_SEP).sort() : [],
  }));
}

// ── Dismiss / snooze (gap #22; PersonalCRM2 app/api/dismiss + lib/dashboard addDismissal) ──

export type DismissKind = "stale" | "followup" | "linkedin" | "datagap";

export interface Dismissal {
  id: number;
  person_id: number;
  kind: DismissKind;
  /** NULL = dismissed indefinitely; otherwise the moment the row stops suppressing. */
  snooze_until: string | null;
}

/**
 * Hide one person from a suggestion list. `snoozeDays` omitted/null → dismissed
 * indefinitely; a positive number snoozes until now + N days, after which
 * reconnectDue surfaces them again. One live dismissal per (person, kind): an
 * earlier one is replaced, so "Snooze 30d" after "Dismiss" really does un-bury them.
 */
export function dismissPerson(
  db: Db,
  personId: number,
  kind: DismissKind = "stale",
  snoozeDays?: number | null,
  now: Date = new Date()
): Dismissal {
  const days = typeof snoozeDays === "number" && snoozeDays > 0 ? snoozeDays : null;
  const snoozeUntil =
    days === null
      ? null
      : new Date(now.getTime() + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

  const run = db.transaction(() => {
    db.prepare("DELETE FROM dismissal WHERE person_id = ? AND kind = ?").run(personId, kind);
    const res = db
      .prepare("INSERT INTO dismissal (person_id, kind, snooze_until) VALUES (?, ?, ?)")
      .run(personId, kind, snoozeUntil);
    return Number(res.lastInsertRowid);
  });
  const id = run();
  return { id, person_id: personId, kind, snooze_until: snoozeUntil };
}

/** Clear any dismissal of this kind — the "un-snooze" path. Returns rows removed. */
export function undismissPerson(db: Db, personId: number, kind: DismissKind = "stale"): number {
  return db.prepare("DELETE FROM dismissal WHERE person_id = ? AND kind = ?").run(personId, kind).changes;
}
