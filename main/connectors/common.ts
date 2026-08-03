// Shared connector plumbing. The NEW architecture has no staging table: every connector
// resolves identity inline (crm/identity.ts) and writes directly to `interaction`.
// UNIQUE(channel, external_id) + INSERT OR IGNORE make every connector idempotent.
// Privacy contract (ported from PersonalCRM2 Doc 2 §0): store a ≤200-char snippet in
// body_summary, NEVER the full body.

import type { Db } from "../db/db.ts";
import type { SecretStore } from "../secrets.ts";
import type { LlmClient } from "../llm/provider.ts";

export interface ConnectorDeps {
  db: Db;
  secrets: SecretStore;
  llm?: LlmClient | null;
}

export interface SyncReport {
  source: string;
  /** New interaction rows written this run (dedupe-ignored rows count as skipped). */
  ingested: number;
  /** Everything not inserted: automated senders, unmatched/ambiguous, dupes, unparseable. */
  skipped: number;
  /** New person rows created this run. */
  created: number;
  /** % of resolution attempts that matched a person (omitted when nothing to resolve). */
  resolvedPct?: number;
  error?: string;
}

export const SNIPPET_MAX = 200;

/** Collapse whitespace and cap at SNIPPET_MAX. Null when there's no usable text. */
export function snippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, SNIPPET_MAX) : null;
}

export interface NewInteraction {
  personId: number;
  channel: string;
  direction: "inbound" | "outbound" | "mutual" | null;
  occurredAt: string | null; // ISO
  subject?: string | null;
  bodySummary?: string | null;
  externalId: string;
  threadExternalId?: string | null;
}

/** INSERT OR IGNORE into interaction. Returns true when a NEW row was written. */
export function insertInteraction(db: Db, r: NewInteraction): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO interaction
         (person_id, channel, direction, occurred_at, subject, body_summary, external_id, thread_external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.personId,
      r.channel,
      r.direction,
      r.occurredAt,
      r.subject ?? null,
      r.bodySummary ?? null,
      r.externalId,
      r.threadExternalId ?? null
    );
  return res.changes > 0;
}

/** sync_state cursor for a source, or null on first run. */
export function getCursor(db: Db, source: string): string | null {
  const row = db.prepare("SELECT cursor FROM sync_state WHERE source = ?").get(source) as
    | { cursor: string | null }
    | undefined;
  return row?.cursor ?? null;
}

/** Upsert the sync_state cursor + last_sync_at for a source. */
export function setCursor(db: Db, source: string, cursor: string): void {
  db.prepare(
    `INSERT INTO sync_state (source, last_sync_at, cursor, updated_at)
     VALUES (?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(source) DO UPDATE SET
       last_sync_at = excluded.last_sync_at,
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`
  ).run(source, cursor);
}

/** Create a person row; returns its id. */
export function createPerson(
  db: Db,
  p: { displayName: string; org?: string | null; role?: string | null }
): number {
  const res = db
    .prepare("INSERT INTO person (display_name, org, role) VALUES (?, ?, ?)")
    .run(p.displayName, p.org ?? null, p.role ?? null);
  return Number(res.lastInsertRowid);
}

/** Add an alias if the (kind, value) pair isn't already claimed — never steals. */
export function addAlias(db: Db, personId: number, kind: string, value: string, source: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO alias (person_id, kind, value, source) VALUES (?, ?, ?, ?)"
  ).run(personId, kind, value, source);
}

/** Rounded match percentage, or undefined when nothing was attempted. */
export function resolvedPct(matched: number, attempted: number): number | undefined {
  if (attempted <= 0) return undefined;
  return Math.round((matched / attempted) * 100);
}
