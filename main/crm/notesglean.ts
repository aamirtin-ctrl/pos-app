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
import { getSetting, setSetting } from "../db/db.ts";
import { resolveHandle } from "./identity.ts";
import { normalizeName, normalizePhone, normalizeEmail } from "./normalize.ts";
import { splitBio, composeBio } from "./enrich.ts";
import { contentHash } from "./commitments.ts";
import { addAlias } from "../connectors/common.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";

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

// ── the glean ────────────────────────────────────────────────────────────────

const GLEAN_PROMPT_HEAD = `You are filing the owner's raw personal note about people into his CRM.
Split the note into one JSON object per person mentioned.
Return ONLY a JSON array, no prose. Each object:
  {"name": "...", "org": "...", "role": "...", "phone": "...", "email": "...", "facts": ["..."]}
Rules:
- Every field is optional. OMIT a field rather than guess or infer it. Never invent.
- "facts" matter most: keep EVERY substantive statement about the person as one short
  fact, close to the owner's own words. Do not summarize facts away.
- Text clearly not about a specific person: one object with only "facts".
- Names: use exactly what the owner wrote (do not expand or correct spellings).

NOTE:
`;

export interface GleanResult {
  chunks: number;
  applied: number;
  created: number;
  queued: number;
}

/**
 * ONE smart-tier call for the whole dump (quota discipline — never per-chunk calls), then
 * route every chunk: identifier/corroborated match → apply; unique-name → apply; fresh
 * name → new tier-2 person; anything ambiguous or nameless → the review queue. Throws when
 * the model is unavailable so the capture drain keeps the row and retries.
 */
export async function gleanNotes(db: Db, llm: LlmClient, rawText: string): Promise<GleanResult> {
  const res = await llm.call("notesglean", "smart", GLEAN_PROMPT_HEAD + rawText.slice(0, 8000), {
    json: true,
    maxTokens: 2048,
  });
  if (!res) throw new Error("llm unavailable for notesglean");
  const chunks = parseGleanChunks(extractJson(res.text));
  const out: GleanResult = { chunks: chunks.length, applied: 0, created: 0, queued: 0 };

  for (const chunk of chunks) {
    const r = resolveHandle(db, {
      name: chunk.name,
      phone: chunk.phone,
      email: chunk.email,
      org: chunk.org,
    });
    if (r.status === "matched" && r.personId) {
      applyChunk(db, chunk, r.personId);
      out.applied++;
      continue;
    }
    if (r.status === "unmatched" && chunk.name) {
      const unique = uniqueNameMatch(db, chunk.name);
      if (unique) {
        applyChunk(db, chunk, unique);
        out.applied++;
      } else {
        createPersonFromChunk(db, chunk);
        out.created++;
        out.applied++;
      }
      continue;
    }
    // ambiguous, or nameless with no identifier — the user decides, nothing is dropped.
    queueNoteChunk(db, chunk, r.candidateIds ?? []);
    out.queued++;
  }
  return out;
}

// ── review queue for undecidable chunks (setting-table keys, like ambiguous:*) ──

export const NOTECHUNK_PREFIX = "notechunk:";

interface NoteChunkStored {
  chunk: NoteChunk;
  candidateIds: number[];
  firstSeenAt: string;
}

export interface NoteChunkItem {
  key: string;
  chunk: NoteChunk;
  /** chunkText() of the chunk — what the review card shows. */
  text: string;
  firstSeenAt: string;
  candidates: { id: number; display_name: string; org: string | null; role: string | null }[];
}

export function queueNoteChunk(db: Db, chunk: NoteChunk, candidateIds: number[]): string {
  const key = `${NOTECHUNK_PREFIX}${contentHash(JSON.stringify(chunk))}`;
  if (!getSetting(db, key)) {
    const stored: NoteChunkStored = { chunk, candidateIds, firstSeenAt: new Date().toISOString() };
    setSetting(db, key, JSON.stringify(stored));
  }
  return key;
}

export function pendingNoteChunks(db: Db): NoteChunkItem[] {
  const rows = db
    .prepare("SELECT key, value FROM setting WHERE key LIKE ? ORDER BY key")
    .all(`${NOTECHUNK_PREFIX}%`) as { key: string; value: string }[];
  const person = db.prepare("SELECT id, display_name, org, role FROM person WHERE id = ?");
  const out: NoteChunkItem[] = [];
  for (const r of rows) {
    let stored: NoteChunkStored;
    try {
      stored = JSON.parse(r.value) as NoteChunkStored;
    } catch {
      continue; // corrupt JSON: skip rather than blow up the queue
    }
    if (!stored?.chunk) continue;
    const chunk = parseGleanChunks([stored.chunk])[0];
    if (!chunk) continue;
    const candidates = (stored.candidateIds ?? [])
      .map((id) => person.get(id) as NoteChunkItem["candidates"][number] | undefined)
      .filter((p): p is NoteChunkItem["candidates"][number] => !!p);
    out.push({ key: r.key, chunk, text: chunkText(chunk), firstSeenAt: stored.firstSeenAt ?? "", candidates });
  }
  return out;
}

/** Apply the held chunk to the chosen person ("new" = create from it) and clear the entry. */
export function resolveNoteChunk(
  db: Db,
  key: string,
  personId: number | "new"
): { resolved: boolean; personId?: number } {
  if (!key.startsWith(NOTECHUNK_PREFIX)) throw new Error("not a note-chunk queue key");
  const raw = getSetting(db, key);
  if (!raw) return { resolved: false };
  const stored = JSON.parse(raw) as NoteChunkStored;
  const chunk = parseGleanChunks([stored.chunk])[0];
  if (!chunk) {
    dismissNoteChunk(db, key);
    return { resolved: false };
  }
  const id = personId === "new" ? createPersonFromChunk(db, chunk) : (applyChunk(db, chunk, personId), personId);
  dismissNoteChunk(db, key);
  return { resolved: true, personId: id };
}

export function dismissNoteChunk(db: Db, key: string): boolean {
  if (!key.startsWith(NOTECHUNK_PREFIX)) throw new Error("not a note-chunk queue key");
  return db.prepare("DELETE FROM setting WHERE key = ?").run(key).changes > 0;
}
