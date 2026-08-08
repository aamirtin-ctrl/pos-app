// Personal context — what the app knows about the USER (not about their contacts).
//
// Owner report 2026-08-05: he clicked "Add task" on a commitment about a "meetup at the
// start of school" and the date picker prefilled TODAY. The app had no idea he attends
// Stanford or that the fall term starts around Sept 22, so "start of school" was just
// words. This module is that missing memory, and it pays off in three places:
//
//   1. contextBlock(db) — a short ABOUT THE USER block prepended to both extraction
//      prompts and the assistant's question context, so the MODEL can resolve colloquial
//      references on its own ("start of school" → the term-start date).
//   2. resolveNamedDate(db, phrase, now) — a deterministic cross-check over the same
//      facts, so the resolution still happens with no LLM, no key, and no network. It
//      backstops extraction (crm/commitments.ts) and drives the task/event prefill
//      (gcal/sync.ts) — the owner's exact click-path.
//   3. The "About you" card in Settings and the assistant's "remember: …" intent, which
//      are just setFact/deleteFact with a UI and a voice in front of them.
//
// Rows are seeded ONCE (only when the table is empty) with a deliberately SHORT list of
// editable defaults — a starting point the owner can correct, never a claim of truth.

import { localDateISO } from "./dates.ts";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import { parseWhen } from "./crm/when.ts";

/**
 * 'fact'        — a durable statement about the user ("Stanford University").
 * 'date_anchor' — a NAMED point in time (school-start, a birthday); the date lives in
 *                 starts_at and is what resolveNamedDate() returns.
 * 'recurring'   — something that repeats (a weekly class, an annual trip).
 */
export type FactKind = "fact" | "date_anchor" | "recurring";

export interface UserFact {
  id: number;
  key: string;
  value: string;
  kind: string;
  starts_at: string | null;
  ends_at: string | null;
  source: string;
  updated_at: string;
}

export interface SetFactInput {
  key: string;
  value: string;
  kind?: FactKind | string;
  startsAt?: string | null;
  endsAt?: string | null;
  source?: string;
}

const FACT_KINDS = new Set<string>(["fact", "date_anchor", "recurring"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-22T00:00:00Z" / "2026-09-22" → "2026-09-22"; anything else → null. */
function isoDay(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}

// ── seed: SHORT, and clearly marked as editable defaults ─────────────────────
//
// Every one of these is a guess the owner is expected to correct in Settings → About
// you (or by saying "remember: …"). They exist so the very first "start of school"
// resolves to something sensible instead of to today. Keep this list tiny: anything
// the app can learn from the user's own words belongs in `source = 'assistant'`, not here.

export const SEED_FACTS: SetFactInput[] = [
  { key: "school", value: "Stanford University", kind: "fact", source: "seed" },
  {
    key: "school_term_start",
    value: "2026-09-22",
    kind: "date_anchor",
    startsAt: "2026-09-22",
    source: "seed",
  },
  { key: "home_city", value: "Dallas, TX", kind: "fact", source: "seed" },
];

/** Marks that the defaults have been laid down once, ever. */
const SEEDED_KEY = "user_facts_seeded";

/**
 * Seed the editable defaults on the first read of an empty table — and ONLY then. The
 * settings flag is what keeps a user who deletes every fact from having them silently
 * reappear: an empty About-you card is a legitimate state, not a fresh install.
 */
function seedIfNeeded(db: Db): void {
  if (getSetting(db, SEEDED_KEY)) return;
  const empty = (db.prepare("SELECT COUNT(*) AS n FROM user_fact").get() as { n: number }).n === 0;
  const run = db.transaction(() => {
    if (empty) for (const f of SEED_FACTS) writeFact(db, f);
    setSetting(db, SEEDED_KEY, new Date().toISOString());
  });
  run();
}

const selectAll = `SELECT id, key, value, kind, starts_at, ends_at, source, updated_at FROM user_fact`;

/**
 * Every fact, date anchors first (they are the ones that do work), then alphabetically.
 * Seeds the editable defaults on the FIRST read of an empty table — so a fresh install
 * resolves "start of school" without the user configuring anything.
 */
export function listFacts(db: Db): UserFact[] {
  seedIfNeeded(db);
  return db
    .prepare(`${selectAll} ORDER BY (kind = 'date_anchor') DESC, key ASC`)
    .all() as UserFact[];
}

/** One fact by key, or null. Does NOT seed (callers that need seeding use listFacts). */
export function getFact(db: Db, key: string): UserFact | null {
  const row = db.prepare(`${selectAll} WHERE key = ?`).get((key ?? "").trim()) as UserFact | undefined;
  return row ?? null;
}

/** Normalize a user-typed key into the storage form: lower_snake_case. */
export function normalizeKey(key: string | null | undefined): string {
  return (key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** The write itself — shared by setFact and the seeder. Throws on an empty key/value. */
function writeFact(db: Db, input: SetFactInput): UserFact {
  const key = normalizeKey(input.key);
  const value = (input.value ?? "").replace(/\s+/g, " ").trim();
  if (!key) throw new Error("fact key required");
  if (!value) throw new Error("fact value required");
  const kind = FACT_KINDS.has(String(input.kind)) ? String(input.kind) : "fact";
  // A date_anchor with no explicit starts_at falls back to its own value ("2026-09-22"),
  // which is how "remember: school starts Sept 22" stores a single string and still resolves.
  const startsAt = isoDay(input.startsAt) ?? (kind === "date_anchor" ? isoDay(value) : null);
  const endsAt = isoDay(input.endsAt);
  const source = (input.source ?? "manual").trim() || "manual";
  db.prepare(
    `INSERT INTO user_fact (key, value, kind, starts_at, ends_at, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value      = excluded.value,
       kind       = excluded.kind,
       starts_at  = excluded.starts_at,
       ends_at    = excluded.ends_at,
       source     = excluded.source,
       updated_at = datetime('now')`
  ).run(key, value, kind, startsAt, endsAt, source);
  return getFact(db, key)!;
}

/**
 * Upsert a fact on its key. Correcting a seeded default is the same call as adding a new
 * fact — there is no separate "edit" path, and the row keeps ONE identity per key.
 */
export function setFact(db: Db, input: SetFactInput): UserFact {
  return writeFact(db, input);
}

/** Remove a fact. Returns true when a row was actually deleted. */
export function deleteFact(db: Db, key: string): boolean {
  const r = db.prepare("DELETE FROM user_fact WHERE key = ?").run(normalizeKey(key));
  return r.changes > 0;
}

// ── prompt rendering ─────────────────────────────────────────────────────────

/**
 * Known keys get natural phrasing so the block reads like a person wrote it; everything
 * else falls back to "Key: value". Kept small on purpose — an unknown key still renders
 * usefully, so nothing has to be registered here to work.
 */
const PHRASINGS: Record<string, (v: string) => string> = {
  school: (v) => `Attends ${v}`,
  school_term_start: (v) => `Fall term starts ${v}`,
  school_term_end: (v) => `Term ends ${v}`,
  home_city: (v) => `Based in ${v}`,
  work_city: (v) => `Works out of ${v}`,
  employer: (v) => `Works at ${v}`,
  birthday: (v) => `Birthday ${v}`,
};

const humanize = (key: string) =>
  key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** One "- …" line for a fact: its natural phrasing, dated when it is an anchor. */
export function factLine(f: UserFact): string {
  const anchored = f.kind === "date_anchor" ? isoDay(f.starts_at) ?? isoDay(f.value) : null;
  const phrase = PHRASINGS[f.key];
  if (phrase) return `- ${phrase(anchored ?? f.value)}`;
  const suffix = anchored && anchored !== f.value ? ` (${anchored})` : "";
  return `- ${humanize(f.key)}: ${f.value}${suffix}`;
}

/**
 * The compact plain-text block prepended to prompts:
 *
 *   ABOUT THE USER:
 *   - Attends Stanford University
 *   - Fall term starts 2026-09-22
 *   - Based in Dallas, TX
 *
 * Empty string when the user has deleted every fact, so callers can append it
 * unconditionally without leaving a dangling header in the prompt.
 */
export function contextBlock(db: Db): string {
  const facts = listFacts(db);
  if (facts.length === 0) return "";
  return `ABOUT THE USER:\n${facts.map(factLine).join("\n")}`;
}

// ── named-date resolution ────────────────────────────────────────────────────
//
// The deterministic half of the fix. These patterns are intentionally tolerant of
// surrounding words ("meetup at the start of school", "let's do it when school starts")
// and case, because they run against real message text and task titles.

/** The school-ish nouns every term pattern hangs off. */
const TERM_NOUN = "(?:school\\s+year|school|term|semester|quarter|classes)";
/** Optional determiners between "of" and the noun ("the", "my", "this", "next"). */
const DET = "(?:the\\s+|my\\s+|this\\s+|next\\s+)?";

/** "end of school", "end of the term", "school ends", "last day of the semester". */
const END_OF_TERM = new RegExp(
  `\\b(?:end|last\\s+day)\\s+of\\s+${DET}${TERM_NOUN}\\b|\\b${TERM_NOUN}\\s+(?:ends?|ending|finishes?|wraps?)\\b`,
  "i"
);

/**
 * "start of school", "school starts", "when school starts", "beginning of the term",
 * "first day of classes", "move-in", "move in day", "back to school".
 */
const START_OF_TERM = new RegExp(
  `\\b(?:start|beginning|first\\s+day)\\s+of\\s+${DET}${TERM_NOUN}\\b` +
    `|\\b${TERM_NOUN}\\s+(?:starts?|starting|begins?|beginning|resumes?|kicks?\\s+off)\\b` +
    `|\\bmove-in\\b|\\bmove\\s+in\\s+(?:day|weekend|date)\\b|\\bback\\s+to\\s+school\\b`,
  "i"
);

/**
 * Vaguer gestures at the upcoming term. These resolve ONLY while the anchor is still in
 * the future — "in the fall" said after the term already began means something else.
 */
const UPCOMING_TERM =
  /\bnext\s+(?:semester|term|quarter|school\s+year)\b|\b(?:in|during)\s+the\s+fall\b|\bthis\s+fall\b|\bonce\s+(?:i'?m\s+)?(?:back\s+)?(?:at|on)\s+campus\b/i;

/** The ISO day a date_anchor row points at (starts_at, else its own value). */
function anchorDay(f: UserFact | null): string | null {
  if (!f || f.kind !== "date_anchor") return null;
  return isoDay(f.starts_at) ?? isoDay(f.value);
}

const byKey = (facts: UserFact[], key: string): UserFact | null =>
  facts.find((f) => f.key === key) ?? null;

/**
 * Pure core of resolveNamedDate: map a colloquial phrase onto one of the user's date
 * anchors. Exported so it can be exercised (and reused) without a database.
 *
 * Returns "YYYY-MM-DD" or null. Null is the correct and common answer — an unmatched
 * phrase, or a matched phrase with no anchor recorded, must never invent a date.
 */
export function resolveNamedDateFromFacts(
  facts: UserFact[],
  phrase: string,
  now: Date = new Date()
): string | null {
  const text = (phrase ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  // End-of-term first: "end of school" must never be read as a start-of-school phrase.
  if (END_OF_TERM.test(text)) return anchorDay(byKey(facts, "school_term_end"));
  if (START_OF_TERM.test(text)) return anchorDay(byKey(facts, "school_term_start"));

  if (UPCOMING_TERM.test(text)) {
    const start = anchorDay(byKey(facts, "school_term_start"));
    if (!start) return null;
    const today = localDateISO(now);
    return start > today ? start : null; // a term already under way is not "next semester"
  }
  return null;
}

/**
 * DB-backed named-date resolution: "meetup at the start of school" → the school_term_start
 * anchor ("2026-09-22"). Case-insensitive, tolerant of surrounding words, and null
 * whenever nothing matches or the matching anchor was never recorded.
 *
 * Reads facts (seeding the editable defaults on a first-ever read) and is otherwise pure.
 */
export function resolveNamedDate(db: Db, phrase: string, now: Date = new Date()): string | null {
  if (!(phrase ?? "").trim()) return null;
  return resolveNamedDateFromFacts(listFacts(db), phrase, now);
}

// ── "remember: …" parsing (assistant.ts) ─────────────────────────────────────

/** One parsed fact, ready for setFact. */
export interface FactRequest {
  key: string;
  value: string;
  kind: FactKind;
  /** ISO day for a date_anchor, else null. */
  date: string | null;
}

/** "remember: " / "remember " prefix — the deterministic entry point. */
export const REMEMBER_PREFIX = /^remember[:\s]+/i;

/**
 * Statement patterns, in priority order. Each names the key it fills and whether the
 * captured text is a DATE (parsed with crm/when.ts, stored as a date_anchor) or a value.
 */
const FACT_PATTERNS: { re: RegExp; key: string; kind: FactKind }[] = [
  { re: /\b(?:school|term|semester|quarter|classes)\s+(?:starts?|start|begins?|resumes?)\s+(?:on\s+)?(.+)$/i, key: "school_term_start", kind: "date_anchor" },
  { re: /\b(?:start|beginning|first\s+day)\s+of\s+(?:the\s+)?(?:school|term|semester|quarter)(?:\s+year)?\s+(?:is|=)\s+(.+)$/i, key: "school_term_start", kind: "date_anchor" },
  { re: /\b(?:school|term|semester|quarter|classes)\s+ends?\s+(?:on\s+)?(.+)$/i, key: "school_term_end", kind: "date_anchor" },
  { re: /\bmy\s+birthday\s+is\s+(?:on\s+)?(.+)$/i, key: "birthday", kind: "date_anchor" },
  { re: /\bi\s+(?:go\s+to|attend|study\s+at|am\s+at|'m\s+at)\s+(.+)$/i, key: "school", kind: "fact" },
  { re: /\bi\s+(?:live\s+in|am\s+based\s+in|'m\s+based\s+in)\s+(.+)$/i, key: "home_city", kind: "fact" },
  { re: /\bi\s+work\s+at\s+(.+)$/i, key: "employer", kind: "fact" },
];

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/[.!,;]+$/, "").trim();

/**
 * Deterministic parse of a "remember: …" line (the prefix is optional — the patterns also
 * read a bare "I go to Stanford"). Returns null when nothing recognizable is in the text,
 * which is the signal for assistant.ts to try the LLM.
 *
 * Dates go through crm/when.ts anchored on `now`, so "Sept 22" becomes the next upcoming
 * September 22 rather than a date in the past.
 */
export function parseFactDeterministic(text: string, now: Date = new Date()): FactRequest | null {
  const body = tidy((text ?? "").replace(REMEMBER_PREFIX, ""));
  if (!body) return null;

  for (const { re, key, kind } of FACT_PATTERNS) {
    const m = body.match(re);
    if (!m) continue;
    const captured = tidy(m[1] ?? "");
    if (!captured) continue;
    if (kind === "date_anchor") {
      const when = parseWhen(captured, now);
      if (!when) continue; // "school starts soon" carries no date — let the LLM try
      const date = when.toISOString().slice(0, 10);
      return { key, value: date, kind, date };
    }
    return { key, value: captured.slice(0, 120), kind, date: null };
  }

  // Generic "<subject> is <value>" ("my gym is Equinox Palo Alto") — only with an explicit
  // "remember" prefix, so ordinary chatter never becomes a stored fact.
  if (REMEMBER_PREFIX.test(text ?? "")) {
    const kv = body.match(/^(?:my\s+|the\s+)?([a-z][a-z0-9 _-]{1,40}?)\s+(?:is|are|=)\s+(.+)$/i);
    if (kv) {
      const key = normalizeKey(kv[1]);
      const value = tidy(kv[2]).slice(0, 120);
      if (key && value) return { key, value, kind: "fact", date: null };
    }
  }
  return null;
}
