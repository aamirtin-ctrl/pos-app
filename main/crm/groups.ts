// Groups (Clay-style static lists) — the pos port of PersonalCRM2's lib/groups.ts.
// Membership is normalized (person_group), the grp row holds display metadata plus the
// three flags: hidden (chip disappears from filter rows), hide_contacts (members drop out
// of contact lists entirely — the old app's Contact.hiddenAt archive), and
// suppress_follow_ups (honored by crm/reconnect.ts).
//
// Hide model, mirroring the old three-mode HideMode:
//   visible               → hidden=0, hide_contacts=0
//   hidden                → hidden=1, hide_contacts=0
//   hidden_with_contacts  → hidden=1, hide_contacts=1
// so hiding *with* contacts always implies hiding the chip, and unhiding clears both.
//
// The person table has NO hidden_at column and migrations are append-only, so the archive
// is computed on the fly by hiddenPersonIds() instead of being reconciled onto person rows
// (the old reconcileHiddenContacts). The exclusion is applied at the IPC boundary
// (main/ipc.ts people.list) rather than inside crm/people.ts listPeople, which keeps this
// module dependency-free and the people query layer unaware of group policy.

import type { Db } from "../db/db.ts";

export interface GroupRow {
  id: number;
  name: string;
  hidden: number;
  hide_contacts: number;
  suppress_follow_ups: number;
  /** Live member count. */
  members: number;
}

function clean(name: string): string {
  const n = (name ?? "").trim();
  if (!n) throw new Error("group name is empty");
  return n;
}

/** Every group with its live member count, name-ordered. */
export function listGroups(db: Db): GroupRow[] {
  return db
    .prepare(
      `SELECT g.id, g.name, g.hidden, g.hide_contacts, g.suppress_follow_ups,
              COUNT(pg.person_id) AS members
         FROM grp g
         LEFT JOIN person_group pg ON pg.group_id = g.id
        GROUP BY g.id
        ORDER BY g.name`
    )
    .all() as GroupRow[];
}

/** Idempotent create. Returns the group id (existing or new). */
export function createGroup(db: Db, name: string): { id: number; created: boolean } {
  const n = clean(name);
  const res = db.prepare("INSERT OR IGNORE INTO grp (name) VALUES (?)").run(n);
  const row = db.prepare("SELECT id FROM grp WHERE name = ?").get(n) as { id: number };
  return { id: row.id, created: res.changes > 0 };
}

/** Rename in place. Throws when the target name is already taken (grp.name is UNIQUE). */
export function renameGroup(db: Db, from: string, to: string): boolean {
  const a = clean(from);
  const b = clean(to);
  if (a === b) return false;
  const clash = db.prepare("SELECT 1 FROM grp WHERE name = ?").get(b);
  if (clash) throw new Error(`a group named "${b}" already exists`);
  return db.prepare("UPDATE grp SET name = ? WHERE name = ?").run(b, a).changes > 0;
}

/** Drop the group; memberships cascade. People themselves are never touched. */
export function deleteGroup(db: Db, name: string): boolean {
  return db.prepare("DELETE FROM grp WHERE name = ?").run(clean(name)).changes > 0;
}

/**
 * Hide/unhide the chip. Hiding here never archives members; unhiding clears
 * hide_contacts too, so "Unhide" is always the full way back to visible.
 */
export function setHidden(db: Db, name: string, hidden: boolean): boolean {
  const n = clean(name);
  return (
    db.prepare("UPDATE grp SET hidden = ?, hide_contacts = 0 WHERE name = ?").run(hidden ? 1 : 0, n)
      .changes > 0
  );
}

/** Hide the group AND archive its members out of contact lists (implies hidden). */
export function setHideContacts(db: Db, name: string, on: boolean): boolean {
  const n = clean(name);
  return (
    db
      .prepare("UPDATE grp SET hide_contacts = ?, hidden = ? WHERE name = ?")
      .run(on ? 1 : 0, on ? 1 : 0, n).changes > 0
  );
}

/** Per-group follow-up suppression (honored by crm/reconnect.ts). */
export function setSuppressFollowUps(db: Db, name: string, on: boolean): boolean {
  return (
    db.prepare("UPDATE grp SET suppress_follow_ups = ? WHERE name = ?").run(on ? 1 : 0, clean(name))
      .changes > 0
  );
}

/** Add people to a group, creating it when new. Returns the number of new memberships. */
export function assignToGroup(db: Db, personIds: number[], name: string): number {
  const ids = [...new Set(personIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return 0;
  const { id: groupId } = createGroup(db, name);
  const ins = db.prepare("INSERT OR IGNORE INTO person_group (person_id, group_id) VALUES (?, ?)");
  const run = db.transaction(() => {
    let n = 0;
    for (const pid of ids) n += ins.run(pid, groupId).changes;
    return n;
  });
  return run();
}

/** Remove people from a group. Returns the number of memberships dropped. */
export function removeFromGroup(db: Db, personIds: number[], name: string): number {
  const ids = [...new Set(personIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return 0;
  const del = db.prepare(
    "DELETE FROM person_group WHERE person_id = ? AND group_id = (SELECT id FROM grp WHERE name = ?)"
  );
  const n = clean(name);
  const run = db.transaction(() => {
    let c = 0;
    for (const pid of ids) c += del.run(pid, n).changes;
    return c;
  });
  return run();
}

/**
 * Ids of people archived by group policy: anybody in at least one group with
 * hide_contacts = 1. The old app's `Contact.hiddenAt`, computed instead of stored.
 * Callers (ipc people.list) exclude these from contact lists.
 */
export function hiddenPersonIds(db: Db): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT pg.person_id AS person_id
         FROM person_group pg
         JOIN grp g ON g.id = pg.group_id
        WHERE g.hide_contacts = 1`
    )
    .all() as { person_id: number }[];
  return new Set(rows.map((r) => r.person_id));
}
