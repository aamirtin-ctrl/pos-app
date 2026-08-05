// People query layer — thin, prepared-statement reads/writes for the IPC surface.
//
// Mostly LLM-free. The one exception is the About/bio save path
// (patchPersonWithExtract → extractFromAbout, ported from PersonalCRM2
// lib/llm.ts + app/api/contact/[id]/route.ts): saving a bio runs a fast-tier
// extraction for role / next action / tags, and degrades to the deterministic
// cue scan (detectNoteFollowUp, built on crm/followups.ts CUES + crm/when.ts)
// whenever there is no key, no budget, or the model errors.

import type { Db } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { CUES } from "./followups.ts";
import { parseWhen } from "./when.ts";
import { formatPhoneDisplay } from "./normalize.ts";
import { refreshNextTouch } from "./reconnect.ts";

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
  /** One-click reach-out targets derived from the aliases (gap #17). */
  reachout: ReachLink[];
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

  const aliases = db
    .prepare("SELECT id, kind, value, is_primary FROM alias WHERE person_id = ? ORDER BY kind, value")
    .all(id) as PersonDetail["aliases"];

  return {
    ...p,
    tags: tagsFor(db, id),
    groups: groupsFor(db, id),
    freshness_days: freshnessDays(p.last_contact_at, now),
    aliases,
    reachout: reachoutLinks(aliases),
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

// ── merge (gap #1: parity with PersonalCRM2 lib/merge.ts) ──────────────────────

/** Fields whose presence makes a record "rich" — the survivor-selection score. */
const RICHNESS_FIELDS = ["org", "role", "location", "bio", "relationship_summary"] as const;

/** Short scalar fields backfilled onto the survivor from the losers when blank. */
const BACKFILL_FIELDS = ["org", "role", "location", "given_name", "family_name"] as const;

/** Long prose fields whose paragraphs are concatenated rather than picked. */
const PROSE_FIELDS = ["bio", "relationship_summary"] as const;

interface MergeRow {
  id: number;
  org: string | null;
  role: string | null;
  location: string | null;
  bio: string | null;
  relationship_summary: string | null;
  given_name: string | null;
  family_name: string | null;
  last_contact_at: string | null;
  next_touch_due_at: string | null;
}

const blank = (v: string | null | undefined): boolean => !v || v.trim() === "";

/**
 * Survivor = the RICHEST record (most non-blank org/role/location/bio/relationship_summary),
 * tiebroken by most aliases, then by lowest id. The old app let the caller nominate a
 * survivor from the review UI; pos merges N at once, so richness decides.
 */
export function pickSurvivor(rows: MergeRow[], aliasCounts: Map<number, number>): MergeRow {
  return [...rows].sort((a, b) => {
    const score = (r: MergeRow) => RICHNESS_FIELDS.filter((f) => !blank(r[f])).length;
    return (
      score(b) - score(a) ||
      (aliasCounts.get(b.id) ?? 0) - (aliasCounts.get(a.id) ?? 0) ||
      a.id - b.id
    );
  })[0];
}

/**
 * Concatenate prose across records: paragraphs (blank-line separated) in survivor-then-loser
 * order, identical paragraphs dropped (whitespace/case-insensitive comparison), rejoined with
 * a blank line. Returns null when nothing survives.
 */
export function concatProse(parts: (string | null)[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (blank(part)) continue;
    for (const para of (part as string).split(/\n[ \t]*\n/)) {
      const text = para.trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out.length ? out.join("\n\n") : null;
}

/** Latest of two SQLite timestamps (lexicographic works for the ISO-ish format we store). */
function laterOf(a: string | null, b: string | null): string | null {
  if (blank(a)) return blank(b) ? null : b;
  if (blank(b)) return a;
  return (a as string) > (b as string) ? a : b;
}

/**
 * Merge people into the richest record — one transaction. The survivor keeps its own values,
 * fills its blanks from the losers (lowest id first), concatenates distinct bio /
 * relationship_summary paragraphs, takes the most recent last_contact_at, then absorbs
 * aliases / interactions / commitments / tags / groups / drafts / msg_plans (skipping rows
 * that would collide with UNIQUE or PK constraints) before the losers are deleted.
 * Returns the surviving id, or null when fewer than 2 valid ids were given.
 */
export function mergePeople(db: Db, ids: number[]): number | null {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length < 2) return null;

  const run = db.transaction(() => {
    const placeholders = unique.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, org, role, location, bio, relationship_summary, given_name, family_name,
                last_contact_at, next_touch_due_at
           FROM person WHERE id IN (${placeholders}) ORDER BY id`
      )
      .all(...unique) as MergeRow[];
    for (const id of unique) {
      if (!rows.some((r) => r.id === id)) throw new Error(`mergePeople: person ${id} not found`);
    }

    const aliasCounts = new Map<number, number>(
      (
        db
          .prepare(
            `SELECT person_id, COUNT(*) AS n FROM alias WHERE person_id IN (${placeholders}) GROUP BY person_id`
          )
          .all(...unique) as { person_id: number; n: number }[]
      ).map((r) => [r.person_id, r.n])
    );

    const survivor = pickSurvivor(rows, aliasCounts);
    const keep = survivor.id;
    const losers = rows.filter((r) => r.id !== keep); // already ordered by id

    // ── field-level merge onto the survivor ──
    const patch: Record<string, string | null> = {};
    for (const f of BACKFILL_FIELDS) {
      if (!blank(survivor[f])) continue;
      const donor = losers.find((l) => !blank(l[f]));
      if (donor) patch[f] = (donor[f] as string).trim();
    }
    for (const f of PROSE_FIELDS) {
      const merged = concatProse([survivor[f], ...losers.map((l) => l[f])]);
      if (merged !== null && merged !== survivor[f]) patch[f] = merged;
    }
    let lastContact = survivor.last_contact_at;
    for (const l of losers) lastContact = laterOf(lastContact, l.last_contact_at);
    if (lastContact !== survivor.last_contact_at) patch.last_contact_at = lastContact;
    if (blank(survivor.next_touch_due_at)) {
      const donor = losers.find((l) => !blank(l.next_touch_due_at));
      if (donor) patch.next_touch_due_at = donor.next_touch_due_at;
    }

    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = datetime('now')"];
    db.prepare(`UPDATE person SET ${sets.join(", ")} WHERE id = ?`).run(
      ...keys.map((k) => patch[k]),
      keep
    );

    // ── sidecar moves, then delete the losers ──
    for (const { id } of losers) {
      // UNIQUE(kind, value): drop duplicate aliases rather than fail the merge.
      db.prepare(
        `DELETE FROM alias WHERE person_id = ?
         AND EXISTS (SELECT 1 FROM alias a2 WHERE a2.person_id = ? AND a2.kind = alias.kind AND a2.value = alias.value)`
      ).run(id, keep);
      db.prepare("UPDATE alias SET person_id = ? WHERE person_id = ?").run(keep, id);
      // UNIQUE(channel, external_id) is per-row, unaffected by person_id moves.
      db.prepare("UPDATE interaction SET person_id = ? WHERE person_id = ?").run(keep, id);
      db.prepare("UPDATE commitment SET person_id = ? WHERE person_id = ?").run(keep, id);
      // Drafts hang off interactions that just moved — follow them, or the loser's
      // ON DELETE CASCADE would take them with it.
      db.prepare("UPDATE draft SET person_id = ? WHERE person_id = ?").run(keep, id);
      db.prepare("UPDATE msg_plan SET person_id = ? WHERE person_id = ?").run(keep, id);
      db.prepare(
        "UPDATE person_tag SET person_id = ? WHERE person_id = ? AND tag NOT IN (SELECT tag FROM person_tag WHERE person_id = ?)"
      ).run(keep, id, keep);
      db.prepare(
        "UPDATE person_group SET person_id = ? WHERE person_id = ? AND group_id NOT IN (SELECT group_id FROM person_group WHERE person_id = ?)"
      ).run(keep, id, keep);
      db.prepare("DELETE FROM person WHERE id = ?").run(id); // cascades leftover sidecars
    }
    return keep;
  });
  return run();
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

// ── Reach-out links (gap #17) ─────────────────────────────────────────────────
// Ported from PersonalCRM2 lib/reachout.ts. The app SUGGESTS how to reach someone;
// it never composes or sends from here. Pure — no DB, no LLM.

export interface ReachLink {
  kind: "email" | "call" | "sms" | "linkedin";
  /** Button label. */
  label: string;
  /** Human-readable target (tooltip): the address, the formatted number, the profile. */
  value: string;
  href: string;
}

export interface AliasLike {
  kind: string;
  value: string;
  is_primary?: number;
}

const isEmailish = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhoneish = (v: string) => /^\+?\d[\d\s().-]{5,}$/.test(v);

/**
 * mailto / tel / sms / LinkedIn-profile links for one person's aliases. Primary aliases
 * come first within each kind; duplicate hrefs collapse (the same address stored as both
 * `email` and `imessage_handle` yields one button). Output order is email, call, sms,
 * linkedin so the row reads the same on every contact.
 */
export function reachoutLinks(aliases: AliasLike[]): ReachLink[] {
  const out: ReachLink[] = [];
  const seen = new Set<string>();
  const push = (l: ReachLink) => {
    if (seen.has(l.href)) return;
    seen.add(l.href);
    out.push(l);
  };

  const ordered = [...(aliases ?? [])].sort((a, b) => (b.is_primary ?? 0) - (a.is_primary ?? 0));
  for (const a of ordered) {
    const value = (a?.value ?? "").trim();
    if (!value) continue;
    const kind = (a?.kind ?? "").toLowerCase();

    if (kind === "email" || (kind === "imessage_handle" && isEmailish(value))) {
      if (isEmailish(value)) push({ kind: "email", label: "Email", value, href: `mailto:${value}` });
      continue;
    }
    if (kind === "phone" || (kind === "imessage_handle" && isPhoneish(value))) {
      const dial = value.replace(/[^\d+]/g, "");
      if (!dial) continue;
      const display = formatPhoneDisplay(dial) || value;
      push({ kind: "call", label: "Call", value: display, href: `tel:${dial}` });
      push({ kind: "sms", label: "Text", value: display, href: `sms:${dial}` });
      continue;
    }
    if (kind === "linkedin") {
      const href = /^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
      push({ kind: "linkedin", label: "LinkedIn", value, href });
    }
  }

  const rank = { email: 0, call: 1, sms: 2, linkedin: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]); // stable: primaries stay first
}

// ── About-save extraction + "I just met them" (gaps #10, #11) ─────────────────

/** Structured fields mined from a freeform About/bio note (PersonalCRM2 lib/llm.ts). */
export interface AboutExtract {
  role: string | null;
  follow_up: string | null;
  last_discussed: string | null;
  tags_to_add: string[];
}

/** Fast-tier extraction over an About note. Returns null on no key / no budget / error. */
export async function extractFromAbout(
  llm: LlmClient | null,
  name: string,
  about: string
): Promise<AboutExtract | null> {
  if (!llm || !about.trim()) return null;
  const res = await llm.call(
    "about_extract",
    "fast",
    `You maintain a personal CRM. From this freeform "about" note for the contact "${name}", extract a few structured fields.

NOTE:
"""${about.slice(0, 1500)}"""

Return STRICT JSON ONLY — no prose, no markdown fences — exactly these keys:
{
  "role": "<short phrase for what they do, e.g. 'Founder at Acme' or 'Berkeley student'; null if unclear>",
  "follow_up": "<the single next action the note implies you should take, e.g. 'Lunch in September' or 'Send the deck'; null if there is no follow-up>",
  "last_discussed": "<the most recent topic discussed or mentioned, as a short phrase; null if unclear>",
  "tags_to_add": ["<a few new lowercase-hyphenated topical tags from the note; [] if none>"]
}

Rules: Do not invent facts not in the note. Keep every value short. follow_up is the NEXT ACTION only (no editorial).`,
    { json: true }
  );
  if (!res) return null;
  try {
    const parsed = extractJson(res.text) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const tagsRaw = Array.isArray(parsed.tags_to_add) ? parsed.tags_to_add : [];
    return {
      role: s(parsed.role),
      follow_up: s(parsed.follow_up),
      last_discussed: s(parsed.last_discussed),
      tags_to_add: tagsRaw.filter((t): t is string => typeof t === "string" && !!t.trim()),
    };
  } catch {
    return null; // malformed JSON → deterministic path
  }
}

export interface NoteFollowUp {
  text: string;
  dueDate: Date | null;
  isDue: boolean;
}

/**
 * Deterministic follow-up detection over a NOTE (PersonalCRM2 lib/action-items.ts
 * detectFollowUp): score each sentence by action cues, a parsed date breaks ties, the
 * best sentence wins. Cue vocabulary is reused from crm/followups.ts (CUES) and dates
 * from crm/when.ts (parseWhen) — nothing is duplicated here.
 */
export function detectNoteFollowUp(
  note: string | null | undefined,
  now: Date = new Date()
): NoteFollowUp | null {
  if (!note || !note.trim()) return null;
  const sentences = note
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let best: { sentence: string; score: number } | null = null;
  for (const s of sentences) {
    const low = s.toLowerCase();
    let score = 0;
    for (const cue of CUES) if (low.includes(cue)) score++;
    if (score === 0) continue; // a bare date is not an action item
    if (parseWhen(s, now)) score++; // a date makes it a stronger candidate
    if (!best || score > best.score) best = { sentence: s, score };
  }
  if (!best) return null;

  const dueDate = parseWhen(best.sentence, now);
  const text =
    best.sentence.length > 140 ? best.sentence.slice(0, 140).replace(/\s+\S*$/, "") + "…" : best.sentence;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { text, dueDate, isDue: !!dueDate && dueDate.getTime() === today };
}

/** Most-recent topic from a note = its last sentence (truncated) — the "last discussed" line. */
export function topicFromNote(note: string): string {
  const parts = note.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = (parts.length ? parts[parts.length - 1] : note.trim()).replace(/\s+/g, " ");
  return last.length > 120 ? last.slice(0, 120).replace(/\s+\S*$/, "") + "…" : last;
}

const normalizeTag = (t: string) =>
  t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");

const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export interface PatchExtractOpts {
  /** "I just met them" — bumps last_contact_at to now and refreshes the touch cadence. */
  metToday?: boolean;
  now?: Date;
}

export interface DetectedFollowUp {
  commitment_id: number;
  description: string;
  due_at: string | null;
  source: "llm" | "deterministic";
  /** False when an identical open commitment already existed (no duplicate was created). */
  created: boolean;
}

export interface PatchExtractResult {
  patched: boolean;
  metToday: boolean;
  /** Role written from the extraction (only when the person had none). */
  roleFilled: string | null;
  tagsAdded: string[];
  lastDiscussed: string | null;
  detectedFollowUp: DetectedFollowUp | null;
}

/**
 * patchPerson + the About-save intelligence the old app had (PersonalCRM2
 * app/api/contact/[id]/route.ts PATCH):
 *   • opts.metToday → a REAL bump of last_contact_at to now (not COALESCE) and a
 *     refreshNextTouch so Reconnect stops nagging immediately.
 *   • a changed, non-empty bio → fast-tier extractFromAbout. Role is filled only when
 *     the person has none and the caller didn't set one; tags are added to person_tag;
 *     a detected next action becomes an OPEN commitment (confirmed_by_user = 1,
 *     confidence 1.0) and comes back as detectedFollowUp for the UI banner.
 *   • no LLM (no key / over ceiling / bad JSON) → detectNoteFollowUp, same outcome.
 * Never throws on the LLM path; the patch itself always lands.
 */
export async function patchPersonWithExtract(
  db: Db,
  llm: LlmClient | null,
  id: number,
  fields: Record<string, unknown>,
  opts: PatchExtractOpts = {}
): Promise<PatchExtractResult> {
  const now = opts.now ?? new Date();
  const result: PatchExtractResult = {
    patched: false,
    metToday: false,
    roleFilled: null,
    tagsAdded: [],
    lastDiscussed: null,
    detectedFollowUp: null,
  };

  const prior = db
    .prepare("SELECT id, display_name, role, bio FROM person WHERE id = ?")
    .get(id) as { id: number; display_name: string; role: string | null; bio: string | null } | undefined;
  if (!prior) return result;

  const bioIn = "bio" in fields ? (fields.bio == null ? "" : String(fields.bio)) : null;
  const bioChanged = bioIn !== null && bioIn.trim() !== (prior.bio ?? "").trim();

  result.patched = patchPerson(db, id, fields);

  if (opts.metToday) {
    db.prepare("UPDATE person SET last_contact_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sqlTime(now), id);
    refreshNextTouch(db);
    result.metToday = true;
    result.patched = true;
  }

  if (!bioChanged || !bioIn!.trim()) return result;

  const about = bioIn as string;
  let followUpText: string | null = null;
  let dueAt: string | null = null;
  let source: DetectedFollowUp["source"] = "deterministic";

  const ex = await extractFromAbout(llm, prior.display_name, about);
  if (ex) {
    source = "llm";
    result.lastDiscussed = ex.last_discussed ?? topicFromNote(about);
    if (ex.role && !("role" in fields) && !(prior.role ?? "").trim()) {
      patchPerson(db, id, { role: ex.role });
      result.roleFilled = ex.role;
    }
    for (const raw of ex.tags_to_add) {
      const tag = normalizeTag(raw);
      if (!tag) continue;
      const r = db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, ?)").run(id, tag);
      if (r.changes > 0) result.tagsAdded.push(tag);
    }
    followUpText = ex.follow_up;
    // Deterministic cross-check: give the model's next action a real due date when it names one.
    const when = followUpText ? parseWhen(followUpText, now) : null;
    dueAt = when ? isoDate(when) : null;
  } else {
    result.lastDiscussed = topicFromNote(about);
    const d = detectNoteFollowUp(about, now);
    if (d) {
      followUpText = d.text;
      dueAt = d.dueDate ? isoDate(d.dueDate) : null;
    }
  }

  if (!followUpText) return result;

  // The user typed this note, so the obligation is theirs and already confirmed.
  const existing = db
    .prepare(
      "SELECT id FROM commitment WHERE person_id = ? AND status = 'open' AND LOWER(description) = LOWER(?)"
    )
    .get(id, followUpText) as { id: number } | undefined;
  if (existing) {
    result.detectedFollowUp = {
      commitment_id: existing.id,
      description: followUpText,
      due_at: dueAt,
      source,
      created: false,
    };
    return result;
  }

  const ins = db
    .prepare(
      `INSERT INTO commitment (person_id, direction, description, due_at, status, confidence, confirmed_by_user)
       VALUES (?, 'i_owe_them', ?, ?, 'open', 1.0, 1)`
    )
    .run(id, followUpText, dueAt);
  result.detectedFollowUp = {
    commitment_id: Number(ins.lastInsertRowid),
    description: followUpText,
    due_at: dueAt,
    source,
    created: true,
  };
  return result;
}
