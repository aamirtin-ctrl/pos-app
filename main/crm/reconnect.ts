// Reconnect cadence. Tier thresholds decide how long a relationship can go quiet before it
// surfaces — owner rule 2026-08-04: never nag before 3 months, any tier. Dismissals (kind
// 'stale') suppress a person indefinitely (snooze_until NULL) or until the snooze expires.

import type { Db } from "../db/db.ts";

export const TIER_DAYS: Record<number, number> = { 0: 90, 1: 90, 2: 120, 3: Infinity };

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

/** Recompute person.next_touch_due_at = last_contact_at + tier threshold. Tier 3 → NULL. */
export function refreshNextTouch(db: Db): number {
  const run = db.transaction(() => {
    let changed = 0;
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
export function reconnectDue(db: Db, now: Date = new Date()): ReconnectRow[] {
  const nowIso = now.toISOString().replace("T", " ").slice(0, 19);
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.org, p.tier, p.last_contact_at, p.next_touch_due_at,
              CAST(julianday(?) - julianday(p.next_touch_due_at) AS INTEGER) AS overdue_days,
              (SELECT group_concat(g.name, char(31)) FROM person_group pg
                 JOIN grp g ON g.id = pg.group_id WHERE pg.person_id = p.id) AS group_names
       FROM person p
       WHERE p.next_touch_due_at IS NOT NULL
         AND p.next_touch_due_at <= ?
         AND p.tier < 3
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
    .all(nowIso, nowIso, nowIso) as (Omit<ReconnectRow, "groups"> & { group_names: string | null })[];
  return rows.map(({ group_names, ...r }) => ({
    ...r,
    groups: group_names ? group_names.split(GROUP_SEP).sort() : [],
  }));
}
