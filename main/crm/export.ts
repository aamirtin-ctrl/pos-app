// CSV export (gap #20) — the pos answer to PersonalCRM2's scripts/export-csv.ts +
// lib/csv-schema.ts. Pure string building, no electron and no fs: the IPC layer owns the
// save dialog and the write, so this stays unit-testable.
//
// Columns follow the pos person shape rather than the old 16-column Postgres one; multi-
// valued fields (aliases, tags, groups) are semicolon-joined so commas inside a value never
// need to be disambiguated from CSV separators.

import type { Db } from "../db/db.ts";

export const CSV_COLUMNS = [
  "name",
  "org",
  "role",
  "location",
  "tier",
  "last_contact_at",
  "next_touch_due_at",
  "emails",
  "phones",
  "linkedin",
  "tags",
  "groups",
  "bio",
  "relationship_summary",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * RFC 4180 field: quote when the value contains a comma, a double quote, CR or LF;
 * embedded quotes are doubled. Everything else is emitted bare.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join a row of already-raw values into one RFC 4180 record (no line terminator). */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/** RFC 4180 says CRLF between records; a trailing CRLF keeps POSIX tools happy too. */
const EOL = "\r\n";

function aliasValues(db: Db, personId: number, kind: string): string {
  const rows = db
    .prepare("SELECT value FROM alias WHERE person_id = ? AND kind = ? ORDER BY is_primary DESC, value")
    .all(personId, kind) as { value: string }[];
  return rows.map((r) => r.value).join("; ");
}

interface PersonCsvRow {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
  next_touch_due_at: string | null;
  bio: string | null;
  relationship_summary: string | null;
}

/** Whole address book as one CSV string, header first, name-ordered. */
export function exportContactsCsv(db: Db): string {
  const people = db
    .prepare(
      `SELECT id, display_name, org, role, location, tier, last_contact_at,
              next_touch_due_at, bio, relationship_summary
         FROM person ORDER BY display_name, id`
    )
    .all() as PersonCsvRow[];

  const tagsOf = db.prepare("SELECT tag FROM person_tag WHERE person_id = ? ORDER BY tag");
  const groupsOf = db.prepare(
    `SELECT g.name FROM person_group pg JOIN grp g ON g.id = pg.group_id
      WHERE pg.person_id = ? ORDER BY g.name`
  );

  const lines = [csvRow([...CSV_COLUMNS])];
  for (const p of people) {
    lines.push(
      csvRow([
        p.display_name,
        p.org,
        p.role,
        p.location,
        p.tier,
        p.last_contact_at,
        p.next_touch_due_at,
        aliasValues(db, p.id, "email"),
        aliasValues(db, p.id, "phone"),
        aliasValues(db, p.id, "linkedin"),
        (tagsOf.all(p.id) as { tag: string }[]).map((r) => r.tag).join("; "),
        (groupsOf.all(p.id) as { name: string }[]).map((r) => r.name).join("; "),
        p.bio,
        p.relationship_summary,
      ])
    );
  }
  return lines.join(EOL) + EOL;
}

/** `pos-contacts-2026-08-05.csv` — the save dialog's default name. */
export function defaultCsvFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `pos-contacts-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.csv`;
}
