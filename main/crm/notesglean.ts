// People-gleaning for the Apple Notes drop-box (spec:
// docs/superpowers/specs/2026-08-13-apple-notes-capture-design.md).
//
// A captured dump (capture_inbox source 'apple_notes') is interpreted with ONE LLM call
// returning person-chunks — every field optional, facts[] the payload that matters. Each
// chunk resolves through the identity cascade plus one deliberate relaxation the doctrine
// forbids for inbound traffic: a name that normalizes to EXACTLY ONE live person
// auto-attaches, because the owner wrote this note himself. Anything less certain — zero
// candidates without a name, several candidates, partial names — queues for the review
// modal (setting keys `notechunk:<hash>`, same schema-free trick as `ambiguous:*`).
//
// Facts append to person.bio under enrich.ts's MINED_MARKER so splitBio/composeBio and
// profile synthesis keep treating them as mined bullets; the user-authored head is never
// touched.

import type { Db } from "../db/db.ts";
import { normalizeName, normalizePhone, normalizeEmail } from "./normalize.ts";
import { splitBio, composeBio } from "./enrich.ts";
import { addAlias } from "../connectors/common.ts";

export interface NoteChunk {
  name?: string;
  org?: string;
  role?: string;
  phone?: string;
  email?: string;
  facts: string[];
}

const CHUNK_STRING_FIELDS = ["name", "org", "role", "phone", "email"] as const;

/** Validate the model's JSON array. Junk-tolerant: bad elements drop, never throw. */
export function parseGleanChunks(raw: unknown): NoteChunk[] {
  if (!Array.isArray(raw)) return [];
  const out: NoteChunk[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const chunk: NoteChunk = { facts: [] };
    for (const f of CHUNK_STRING_FIELDS) {
      const v = rec[f];
      if (typeof v === "string" && v.trim()) chunk[f] = v.trim();
    }
    if (Array.isArray(rec.facts)) {
      chunk.facts = rec.facts
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim());
    }
    const empty =
      !chunk.name && !chunk.phone && !chunk.email && !chunk.org && !chunk.role && chunk.facts.length === 0;
    if (!empty) out.push(chunk);
  }
  return out;
}

/**
 * The owner-authored relaxation: exactly one live person whose display_name normalizes to
 * the same key → that person. Same normalization + JS filter as identity.ts's sameName scan
 * so the two stay byte-identical in behavior.
 */
export function uniqueNameMatch(db: Db, name: string): number | null {
  const key = normalizeName(name);
  if (!key) return null;
  const hits = (
    db.prepare("SELECT id, display_name FROM person").all() as { id: number; display_name: string }[]
  ).filter((p) => normalizeName(p.display_name) === key);
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * File one chunk onto a person: facts as mined bio bullets (deduped, head untouched),
 * org/role fill only when empty, phone/email become aliases, and one channel-'notes'
 * interaction records the raw chunk so the person's history shows where this came from.
 */
export function applyChunk(db: Db, chunk: NoteChunk, personId: number): void {
  const row = db.prepare("SELECT bio FROM person WHERE id = ?").get(personId) as
    | { bio: string | null }
    | undefined;
  if (!row) throw new Error(`person ${personId} not found`);

  if (chunk.facts.length > 0) {
    const { head, bullets } = splitBio(row.bio);
    const seen = new Set(bullets);
    for (const f of chunk.facts) {
      if (!seen.has(f)) {
        bullets.push(f);
        seen.add(f);
      }
    }
    db.prepare("UPDATE person SET bio = ?, updated_at = datetime('now') WHERE id = ?").run(
      composeBio(head, bullets),
      personId
    );
  }
  if (chunk.org || chunk.role) {
    db.prepare(
      "UPDATE person SET org = COALESCE(org, ?), role = COALESCE(role, ?), updated_at = datetime('now') WHERE id = ?"
    ).run(chunk.org ?? null, chunk.role ?? null, personId);
  }
  const phone = normalizePhone(chunk.phone);
  if (phone) addAlias(db, personId, "phone", phone.norm, "applenotes");
  const email = normalizeEmail(chunk.email);
  if (email) addAlias(db, personId, "email", email.norm, "applenotes");

  db.prepare(
    "INSERT INTO interaction (person_id, channel, occurred_at, body_raw) VALUES (?, 'notes', datetime('now'), ?)"
  ).run(personId, chunkText(chunk));
}

/** The chunk as one readable blob for interaction history / review cards. */
export function chunkText(chunk: NoteChunk): string {
  const head = [chunk.name, chunk.role, chunk.org].filter(Boolean).join(" — ");
  return [head, ...chunk.facts].filter(Boolean).join("\n").slice(0, 2000);
}

/**
 * A brand-new person the owner wrote down: tier 2, NO 'unverified' tag — writing someone
 * into the note IS his verification (unlike connectors' auto-created unknown senders).
 */
export function createPersonFromChunk(db: Db, chunk: NoteChunk): number {
  const name = chunk.name?.trim();
  if (!name) throw new Error("cannot create a person from a nameless chunk");
  const r = db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 2)").run(name);
  const id = Number(r.lastInsertRowid);
  applyChunk(db, chunk, id);
  return id;
}
