// People query layer — thin, prepared-statement reads/writes for the IPC surface. No LLM.

import type { Db } from "../db/db.ts";

const DAY = 86_400_000;

export interface PersonListItem {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
  next_touch_due_at: string | null;
  tags: string[];
  groups: string[];
  /** Days since last contact, or null when never contacted. */
  freshness_days: number | null;
}

export interface PersonDetail extends PersonListItem {
  given_name: string | null;
  family_name: string | null;
  bio: string | null;
  relationship_summary: string | null;
  created_at: string;
  updated_at: string;
  aliases: { id: number; kind: string; value: string; is_primary: number }[];
  interactions: {
    id: number;
    channel: string;
    direction: string | null;
    occurred_at: string | null;
    subject: string | null;
    body_summary: string | null;
  }[];
  open_commitments: {
    id: number;
    direction: string;
    description: string;
    due_at: string | null;
    confidence: number;
    confirmed_by_user: number;
  }[];
}

const PATCH_WHITELIST = new Set([
  "display_name",
  "org",
  "role",
  "location",
  "bio",
  "relationship_summary",
  "tier",
]);

function freshnessDays(lastContactAt: string | null, now: Date): number | null {
  if (!lastContactAt) return null;
  // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC (no T/zone); normalize to ISO.
  let s = lastContactAt.trim().replace(" ", "T");
  if (!s.includes("T")) s += "T00:00:00";
  if (!/Z$|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - t.getTime()) / DAY));
}

function tagsFor(db: Db, personId: number): string[] {
  return (db.prepare("SELECT tag FROM person_tag WHERE person_id = ? ORDER BY tag").all(personId) as {
    tag: string;
  }[]).map((r) => r.tag);
}

function groupsFor(db: Db, personId: number): string[] {
  return (
    db
      .prepare(
        `SELECT g.name FROM person_group pg JOIN grp g ON g.id = pg.group_id
         WHERE pg.person_id = ? ORDER BY g.name`
      )
      .all(personId) as { name: string }[]
  ).map((r) => r.name);
}

/** List people, optionally filtered by a LIKE query on name/org/role. */
export function listPeople(db: Db, q?: string, now: Date = new Date()): PersonListItem[] {
  const base = `SELECT id, display_name, org, role, location, tier, last_contact_at, next_touch_due_at FROM person`;
  const rows = (
    q && q.trim()
      ? db
          .prepare(
            `${base} WHERE display_name LIKE ? OR org LIKE ? OR role LIKE ? ORDER BY display_name`
          )
          .all(...Array(3).fill(`%${q.trim()}%`))
      : db.prepare(`${base} ORDER BY display_name`).all()
  ) as Omit<PersonListItem, "tags" | "groups" | "freshness_days">[];

  return rows.map((p) => ({
    ...p,
    tags: tagsFor(db, p.id),
    groups: groupsFor(db, p.id),
    freshness_days: freshnessDays(p.last_contact_at, now),
  }));
}

/** Full person detail: aliases, tags, groups, last 50 interactions, open commitments. */
export function getPerson(db: Db, id: number, now: Date = new Date()): PersonDetail | null {
  const p = db.prepare("SELECT * FROM person WHERE id = ?").get(id) as
    | (Omit<PersonDetail, "tags" | "groups" | "freshness_days" | "aliases" | "interactions" | "open_commitments"> & {
        last_contact_at: string | null;
      })
    | undefined;
  if (!p) return null;

  return {
    ...p,
    tags: tagsFor(db, id),
    groups: groupsFor(db, id),
    freshness_days: freshnessDays(p.last_contact_at, now),
    aliases: db
      .prepare("SELECT id, kind, value, is_primary FROM alias WHERE person_id = ? ORDER BY kind, value")
      .all(id) as PersonDetail["aliases"],
    interactions: db
      .prepare(
        `SELECT id, channel, direction, occurred_at, subject, body_summary
         FROM interaction WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 50`
      )
      .all(id) as PersonDetail["interactions"],
    open_commitments: db
      .prepare(
        `SELECT id, direction, description, due_at, confidence, confirmed_by_user
         FROM commitment WHERE person_id = ? AND status = 'open'
         ORDER BY due_at IS NULL, due_at ASC`
      )
      .all(id) as PersonDetail["open_commitments"],
  };
}

/** Whitelist-patch a person; bumps updated_at. Returns true if a row changed. */
export function patchPerson(db: Db, id: number, fields: Record<string, unknown>): boolean {
  const keys = Object.keys(fields).filter((k) => PATCH_WHITELIST.has(k));
  if (keys.length === 0) return false;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as string | number | null);
  const res = db
    .prepare(`UPDATE person SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...values, id);
  return res.changes > 0;
}

/**
 * Merge people: keep the lowest id, move aliases/interactions/commitments/tags/groups onto it
 * (skipping rows that would collide with UNIQUE/PK constraints), delete the rest — one
 * transaction. Returns the surviving id, or null when fewer than 2 valid ids were given.
 */
export function mergePeople(db: Db, ids: number[]): number | null {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  const [keep, ...rest] = unique;

  const run = db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM person WHERE id = ?");
    if (!exists.get(keep)) throw new Error(`mergePeople: person ${keep} not found`);

    for (const id of rest) {
      if (!exists.get(id)) throw new Error(`mergePeople: person ${id} not found`);
      // UNIQUE(kind, value): drop duplicate aliases rather than fail the merge.
      db.prepare(
        `DELETE FROM alias WHERE person_id = ?
         AND EXISTS (SELECT 1 FROM alias a2 WHERE a2.person_id = ? AND a2.kind = alias.kind AND a2.value = alias.value)`
      ).run(id, keep);
      db.prepare("UPDATE alias SET person_id = ? WHERE person_id = ?").run(keep, id);
      // UNIQUE(channel, external_id) is per-row, unaffected by person_id moves.
      db.prepare("UPDATE interaction SET person_id = ? WHERE person_id = ?").run(keep, id);
      db.prepare("UPDATE commitment SET person_id = ? WHERE person_id = ?").run(keep, id);
      db.prepare("UPDATE person_tag SET person_id = ? WHERE person_id = ? AND tag NOT IN (SELECT tag FROM person_tag WHERE person_id = ?)").run(keep, id, keep);
      db.prepare("UPDATE person_group SET person_id = ? WHERE person_id = ? AND group_id NOT IN (SELECT group_id FROM person_group WHERE person_id = ?)").run(keep, id, keep);
      db.prepare("DELETE FROM person WHERE id = ?").run(id); // cascades leftover sidecars
    }
    db.prepare("UPDATE person SET updated_at = datetime('now') WHERE id = ?").run(keep);
  });
  run();
  return keep;
}

/**
 * Hard delete a person and everything that hangs off them. Aliases, interactions
 * (and their drafts), tags, and group rows cascade via the schema; commitments and
 * tasks keep their rows with person refs nulled (SET NULL) — history of obligations
 * survives even if the contact goes. Used by the Messaging/Contacts quick-delete.
 */
export function deletePerson(db: Db, id: number): boolean {
  const res = db.prepare("DELETE FROM person WHERE id = ?").run(id);
  return res.changes > 0;
}
