// Profile enrichment (GAP_REPORT #13 + #14) — the port of PersonalCRM2's
// lib/enrich.ts (synthesizeContact) and lib/bio-mining.ts, adapted to the
// no-staging architecture (interactions live in `interaction`, profiles on
// `person`).
//
// Two passes, both LLM-optional and both budget-capped:
//   1. synthesizeProfiles — ONE smart-tier call per person whose conversation
//      moved since person.profile_synthesized_at, producing strict JSON
//      {bio, relationship_summary}. Anti-hallucination discipline is ported
//      verbatim in spirit: two factual sentences, leave a field EMPTY rather
//      than infer, repeat existing text when nothing justifies a change.
//   2. mineBios — the bio-mining pass: durable facts mined from the last
//      6 months of conversation and appended to person.bio UNDER the
//      "— From conversations —" marker, never touching the user-authored head.
//
// Ledger: every LLM attempt writes an `enrichment_attempt` row, which doubles as
//   (a) the daily budget counter and (b) the "last mined" timestamp for cadence.
// Degrade contract: no LLM key (llm === null) → zero calls, zero writes, zero counts.

import type { Db } from "../db/db.ts";
import { getSetting } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";

// ── constants ────────────────────────────────────────────────────────────────

/** enrichment_attempt.source values owned by this module. */
export const SYNTHESIS_SOURCE = "synthesis";
export const MINING_SOURCE = "bio-mining";

const DEFAULT_DAILY_BUDGET = 10;
const MIN_CONTENT_MSGS = 3; // not worth an LLM call below this
const WINDOW_MONTHS = 6;
const REMINE_DAYS = 14;
const MAX_TRANSCRIPT_MSGS = 200; // transcript size cap (the prompt also hard-caps chars)
const MAX_SCAN_PER_PASS = 60; // bound DB work per pass regardless of budget
const SYNTHESIS_CONTEXT_MSGS = 40; // interactions fed to the synthesis prompt

/** Channels that carry actual conversation (i.e. minable text). */
const CONV_CHANNELS = ["imessage", "linkedin", "gmail", "outlook", "icloud", "mailfile", "slack"];

/** Header that separates the user-authored bio from auto-mined facts. */
export const MINED_MARKER = "— From conversations —";
const MARKER_BLOCK = `\n\n${MINED_MARKER}\n`;
const BULLET = "• ";

const JULIAN_EPOCH = 2440587.5;
const MS_PER_DAY = 86_400_000;

function julian(d: Date): number {
  return d.getTime() / MS_PER_DAY + JULIAN_EPOCH;
}

// ── content filter (ported from bio-mining.ts) ───────────────────────────────

const TAPBACK_RE = /^(Liked|Loved|Laughed at|Emphasized|Questioned|Disliked|Reacted)\b/i;
const AUTOMATED_RE =
  /(verification code|one-time|\bOTP\b|do not reply|your code is|use code|confirm your|unsubscribe)/i;
const FILLER = new Set([
  "ok", "okay", "k", "kk", "lol", "lmao", "lmaoo", "haha", "hahaha", "ya", "yah", "yeah", "yes",
  "yep", "no", "nope", "nah", "bet", "word", "fr", "frfr", "np", "ty", "thanks", "thx", "ok!",
  "sounds good", "sg", "got it", "cool", "nice", "true", "facts", "same", "ok thanks", "👍", "🙏",
]);

/** Keep only content-bearing, non-duplicate messages worth spending a call on. */
export function isContent(snippet: string | null, seen: Set<string>): boolean {
  if (!snippet) return false;
  const t = snippet.trim();
  if (t.length < 12) return false;
  if (TAPBACK_RE.test(t)) return false;
  if (AUTOMATED_RE.test(t)) return false;
  const lower = t.toLowerCase();
  if (FILLER.has(lower)) return false;
  if (!/[a-z]/i.test(t)) return false; // emoji/number/punctuation only
  const key = lower.replace(/\s+/g, " ").slice(0, 80);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

// ── bio head / mined-bullet split (ported splitNotes / composeNotes) ─────────

/** Split a bio into the user-authored (or synthesized) head and mined bullets. */
export function splitBio(bio: string | null): { head: string; bullets: string[] } {
  if (!bio) return { head: "", bullets: [] };
  const idx = bio.indexOf(MINED_MARKER);
  if (idx === -1) return { head: bio.trim(), bullets: [] };
  const head = bio.slice(0, idx).trim();
  const tail = bio.slice(idx + MINED_MARKER.length);
  const bullets = tail
    .split("\n")
    .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean);
  return { head, bullets };
}

/** Recompose a bio from its head + mined bullets (idempotent). */
export function composeBio(head: string, bullets: string[]): string | null {
  const h = head.trim();
  const body = bullets.map((b) => BULLET + b).join("\n");
  if (!body) return h || null;
  return h ? `${h}${MARKER_BLOCK}${body}` : `${MINED_MARKER}\n${body}`;
}

// ── ledger / budget ──────────────────────────────────────────────────────────

function logAttempt(
  db: Db,
  personId: number,
  source: string,
  status: "success" | "fail",
  detail: string | null
): void {
  db.prepare(
    "INSERT INTO enrichment_attempt (person_id, source, status, detail) VALUES (?, ?, ?, ?)"
  ).run(personId, source, status, detail);
}

/** Configured daily cap: explicit override → `enrich_daily_budget` setting → 10. */
export function dailyBudget(db: Db, override?: number): number {
  if (typeof override === "number" && override >= 0) return override;
  const raw = parseInt(getSetting(db, "enrich_daily_budget") ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

/** LLM calls already spent today on `source` (the enrichment_attempt ledger). */
export function usedToday(db: Db, source: string, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM enrichment_attempt WHERE source = ? AND attempted_at >= ?")
      .get(source, day) as { n: number }
  ).n;
}

// ── pass 1: profile synthesis ────────────────────────────────────────────────

export interface EnrichOptions {
  limit?: number;
  /** Daily LLM-call cap for this source (defaults to the `enrich_daily_budget` setting or 10). */
  budget?: number;
  now?: Date;
}

export interface SynthesisSummary {
  /** LLM calls made (each consumed a unit of budget and wrote a ledger row). */
  attempted: number;
  /** People whose bio and/or relationship_summary actually changed. */
  updated: number;
  failed: number;
  /** Candidates dropped before spending a call (too little content-bearing text). */
  skippedThin: number;
  budgetLeft: number;
}

interface PersonRow {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  bio: string | null;
  relationship_summary: string | null;
}

interface ContextRow {
  channel: string;
  direction: string | null;
  occurred_at: string | null;
  subject: string | null;
  body_summary: string | null;
}

/**
 * People whose conversation moved since their last synthesis (or who have never
 * been synthesized), with at least MIN_CONTENT_MSGS text-bearing interactions.
 * Never-synthesized first, then most recently active.
 */
export function synthesisCandidates(db: Db, limit: number): PersonRow[] {
  return db
    .prepare(
      `SELECT p.id, p.display_name, p.org, p.role, p.location, p.bio, p.relationship_summary
       FROM person p JOIN interaction i ON i.person_id = p.id
       WHERE i.body_summary IS NOT NULL AND TRIM(i.body_summary) <> ''
       GROUP BY p.id
       HAVING COUNT(*) >= ${MIN_CONTENT_MSGS}
          AND (p.profile_synthesized_at IS NULL
               OR MAX(julianday(i.occurred_at)) > julianday(p.profile_synthesized_at))
       ORDER BY (p.profile_synthesized_at IS NULL) DESC, MAX(julianday(i.occurred_at)) DESC
       LIMIT ?`
    )
    .all(limit) as PersonRow[];
}

function synthesisContext(db: Db, personId: number): ContextRow[] {
  const rows = db
    .prepare(
      `SELECT channel, direction, occurred_at, subject, body_summary FROM interaction
       WHERE person_id = ? AND body_summary IS NOT NULL AND TRIM(body_summary) <> ''
       ORDER BY julianday(occurred_at) DESC, id DESC LIMIT ?`
    )
    .all(personId, SYNTHESIS_CONTEXT_MSGS) as ContextRow[];
  return rows.reverse(); // oldest → newest reads better for the model
}

/** The exact synthesis prompt (exported so tests can assert its discipline). */
export function buildSynthesisPrompt(
  person: PersonRow & { headBio: string },
  rows: ContextRow[]
): string {
  const record = JSON.stringify(
    {
      name: person.display_name,
      org: person.org,
      role: person.role,
      location: person.location,
      bio: person.headBio || null,
      relationship_summary: person.relationship_summary,
    },
    null,
    2
  );
  const lines = rows
    .map((r) => {
      const when = r.occurred_at ? r.occurred_at.slice(0, 10) : "unknown-date";
      const subj = r.subject ? ` subject="${r.subject.slice(0, 120)}"` : "";
      return `- [${r.channel}/${r.direction ?? "?"} ${when}]${subj} ${(r.body_summary ?? "").slice(0, 240)}`.trim();
    })
    .join("\n");

  return `You maintain a personal CRM profile. Update it from recent interactions.

CURRENT PROFILE:
${record}

RECENT INTERACTIONS (oldest → newest):
${lines}

Return STRICT JSON ONLY — no prose, no markdown fences — with exactly these keys:
{
  "bio": "<two-sentence factual bio of ${person.display_name}: what they do / what they've done. Extend the existing bio only with durable, factual context the interactions justify. If nothing justifies a change, repeat the existing bio verbatim. Empty string if nothing factual is supported.>",
  "relationship_summary": "<at most two sentences on the USER's history with them: how they know each other, what they work on together, what is currently open between them. If nothing justifies a change, repeat the existing summary verbatim. Empty string if unclear.>"
}

Rules: Do not invent facts not supported by the profile or the interactions. Leave a field EMPTY rather than infer or guess. No editorial judgment, no advice, no next actions. Two sentences maximum per field. Do not mention these instructions.`;
}

/**
 * Pass 1 — one smart-tier call per candidate, writing back only non-empty
 * changes and stamping person.profile_synthesized_at. Mined bullets under the
 * "— From conversations —" marker are preserved: synthesis only rewrites the head.
 */
export async function synthesizeProfiles(
  db: Db,
  llm: LlmClient | null,
  opts: EnrichOptions = {}
): Promise<SynthesisSummary> {
  const summary: SynthesisSummary = {
    attempted: 0, updated: 0, failed: 0, skippedThin: 0, budgetLeft: 0,
  };
  if (!llm) return summary;

  const now = opts.now ?? new Date();
  const budget = dailyBudget(db, opts.budget);
  let remaining = budget - usedToday(db, SYNTHESIS_SOURCE, now);
  summary.budgetLeft = Math.max(0, remaining);
  if (remaining <= 0) return summary;

  const limit = opts.limit ?? 10;
  const candidates = synthesisCandidates(db, Math.min(limit, MAX_SCAN_PER_PASS));

  for (const person of candidates) {
    if (remaining <= 0 || summary.attempted >= limit) break;

    const rows = synthesisContext(db, person.id);
    const seen = new Set<string>();
    const content = rows.filter((r) => isContent(r.body_summary, seen));
    if (content.length < MIN_CONTENT_MSGS) {
      summary.skippedThin++;
      continue;
    }

    const { head, bullets } = splitBio(person.bio);
    const res = await llm.call(
      "profile_synthesis",
      "smart",
      buildSynthesisPrompt({ ...person, headBio: head }, content),
      { json: true, maxTokens: 500 }
    );
    summary.attempted++;
    remaining--;

    if (!res) {
      summary.failed++;
      logAttempt(db, person.id, SYNTHESIS_SOURCE, "fail", "llm returned null");
      continue;
    }

    let bio = "";
    let rel = "";
    try {
      const parsed = extractJson(res.text) as Record<string, unknown>;
      bio = typeof parsed.bio === "string" ? parsed.bio.trim() : "";
      rel = typeof parsed.relationship_summary === "string" ? parsed.relationship_summary.trim() : "";
    } catch {
      summary.failed++;
      logAttempt(db, person.id, SYNTHESIS_SOURCE, "fail", "unparseable JSON");
      continue;
    }

    // Fail-safe: empty output never overwrites a good record.
    const sets: string[] = [];
    const vals: unknown[] = [];
    const newBio = bio ? composeBio(bio, bullets) : null;
    if (newBio && newBio !== person.bio) {
      sets.push("bio = ?");
      vals.push(newBio);
    }
    if (rel && rel !== person.relationship_summary) {
      sets.push("relationship_summary = ?");
      vals.push(rel);
    }
    const changed = sets.length > 0;
    sets.push("profile_synthesized_at = datetime('now')", "updated_at = datetime('now')");
    db.prepare(`UPDATE person SET ${sets.join(", ")} WHERE id = ?`).run(...vals, person.id);
    if (changed) summary.updated++;
    logAttempt(
      db,
      person.id,
      SYNTHESIS_SOURCE,
      "success",
      changed ? `updated ${vals.length} field${vals.length === 1 ? "" : "s"}` : "no change"
    );
  }

  summary.budgetLeft = Math.max(0, remaining);
  return summary;
}

// ── pass 2: bio mining ───────────────────────────────────────────────────────

export interface MiningSummary {
  attempted: number;
  /** People whose bio gained/changed mined facts. */
  mined: number;
  noChange: number;
  failed: number;
  skippedThin: number;
  budgetLeft: number;
}

interface MineCandidate {
  id: number;
  display_name: string;
  bio: string | null;
  latest_j: number | null;
  last_mine_j: number | null;
}

export interface Conversation {
  transcript: string;
  contentCount: number;
  trimmed: boolean;
}

/** Compact, filtered transcript for a person over the last WINDOW_MONTHS. */
export function gatherConversation(db: Db, personId: number, now: Date): Conversation {
  const floor = new Date(now.getTime() - WINDOW_MONTHS * 30.44 * MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `SELECT direction, occurred_at, body_summary FROM interaction
       WHERE person_id = ? AND channel IN (${CONV_CHANNELS.map(() => "?").join(",")})
         AND body_summary IS NOT NULL AND julianday(occurred_at) > julianday(?)
       ORDER BY julianday(occurred_at) ASC, id ASC`
    )
    .all(personId, ...CONV_CHANNELS, floor) as {
    direction: string | null;
    occurred_at: string | null;
    body_summary: string | null;
  }[];

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    if (!isContent(r.body_summary, seen)) continue;
    const when = r.occurred_at ? r.occurred_at.slice(0, 10) : "??";
    const who = r.direction === "outbound" ? "me" : "them";
    lines.push(`[${when}] ${who}: ${r.body_summary!.trim()}`);
  }
  const trimmed = lines.length > MAX_TRANSCRIPT_MSGS;
  const kept = trimmed ? lines.slice(-MAX_TRANSCRIPT_MSGS) : lines; // keep the most recent
  return { transcript: kept.join("\n"), contentCount: lines.length, trimmed };
}

/**
 * People with ≥3 text-bearing conversation messages in the window who were never
 * mined, or are due (>REMINE_DAYS) AND have new messages since the last mine.
 */
export function miningCandidates(db: Db, now: Date, limit: number): MineCandidate[] {
  const floor = new Date(now.getTime() - WINDOW_MONTHS * 30.44 * MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.bio,
              MAX(julianday(i.occurred_at)) AS latest_j,
              julianday((SELECT MAX(e.attempted_at) FROM enrichment_attempt e
                         WHERE e.person_id = p.id AND e.source = '${MINING_SOURCE}')) AS last_mine_j
       FROM person p JOIN interaction i ON i.person_id = p.id
       WHERE i.channel IN (${CONV_CHANNELS.map(() => "?").join(",")})
         AND i.body_summary IS NOT NULL AND TRIM(i.body_summary) <> ''
         AND julianday(i.occurred_at) > julianday(?)
       GROUP BY p.id
       HAVING COUNT(*) >= ${MIN_CONTENT_MSGS}
       ORDER BY (last_mine_j IS NULL) DESC, latest_j DESC
       LIMIT ${MAX_SCAN_PER_PASS}`
    )
    .all(...CONV_CHANNELS, floor) as MineCandidate[];

  const nowJ = julian(now);
  return rows
    .filter(
      (r) =>
        r.last_mine_j == null ||
        (nowJ - r.last_mine_j >= REMINE_DAYS && (r.latest_j ?? 0) > r.last_mine_j)
    )
    .slice(0, limit);
}

/** The exact bio-mining prompt (ported from PersonalCRM2 lib/llm.ts). */
export function buildMiningPrompt(
  name: string,
  head: string,
  existingBullets: string[],
  transcript: string
): string {
  return `You maintain a personal CRM. Below is a recent message/email history between the user and "${name}".
Pull out only the few MOST NOTABLE, durable facts about ${name} — real ventures/companies, roles, research, concrete achievements, school, and major life events. Quality over quantity: a sparse, high-signal list is the goal.

HARD RULES — follow all of them:
1. BE SELECTIVE. Aim for 1–4 facts; only output a 5th if it's genuinely significant. If nothing rises to that bar, return very few or none.
2. DROP the vague/speculative: ideas they merely "want" or are "interested in" or "thinking about", and anything not actually happening yet.
3. DROP the generic/low-value: "is a student", "lives in a dorm", "has a cofounder", "plays video games" — facts that are unremarkable or true of most people.
4. MERGE related facts about the same thing into ONE bullet (e.g. "sourcing funding" + "company sells to solar farms" → "Sourcing funding for a company that sells to solar farms").
5. BE TERSE. Each fact is a short phrase, NOT a sentence. Do NOT begin with the person's name or a pronoun (He/She/They) — start with a verb or noun. Cut filler ("secured a position" → "research at…", "is researching" → "researching").

STRICTLY IGNORE: logistics/scheduling, smalltalk, greetings, the USER's own life, opinions about third parties, ephemeral chatter, and anything not clearly about ${name}.

The user's existing bio (for context — do NOT repeat what's already there):
"""${head.slice(0, 800)}"""

Already-extracted facts (KEEP the still-valid ones, MERGE in new ones, DROP duplicates and anything that now violates the rules above):
${existingBullets.length ? existingBullets.map((b) => `- ${b}`).join("\n") : "(none yet)"}

Conversation (most recent last):
"""${transcript.slice(0, 12000)}"""

Return STRICT JSON ONLY — no prose, no markdown fences — exactly:
{ "facts": ["terse phrase, no leading pronoun", "..."] }
Do not invent anything not supported by the text. If there is nothing notable, return {"facts": ${JSON.stringify(existingBullets)}}.`;
}

/**
 * Pass 2 — mine durable facts from recent conversation and append them to
 * person.bio under the "— From conversations —" marker. The user-authored head
 * is never touched.
 */
export async function mineBios(
  db: Db,
  llm: LlmClient | null,
  opts: EnrichOptions = {}
): Promise<MiningSummary> {
  const summary: MiningSummary = {
    attempted: 0, mined: 0, noChange: 0, failed: 0, skippedThin: 0, budgetLeft: 0,
  };
  if (!llm) return summary;

  const now = opts.now ?? new Date();
  const budget = dailyBudget(db, opts.budget);
  let remaining = budget - usedToday(db, MINING_SOURCE, now);
  summary.budgetLeft = Math.max(0, remaining);
  if (remaining <= 0) return summary;

  const limit = opts.limit ?? 5;
  const candidates = miningCandidates(db, now, MAX_SCAN_PER_PASS);

  for (const person of candidates) {
    if (remaining <= 0 || summary.attempted >= limit) break;

    // Filler/tapbacks/automated messages are dropped BEFORE spending a call.
    const conv = gatherConversation(db, person.id, now);
    if (conv.contentCount < MIN_CONTENT_MSGS) {
      summary.skippedThin++;
      continue;
    }

    const { head, bullets } = splitBio(person.bio);
    const res = await llm.call(
      "bio_mining",
      "smart",
      buildMiningPrompt(person.display_name, head, bullets, conv.transcript),
      { json: true, maxTokens: 500 }
    );
    summary.attempted++;
    remaining--;

    if (!res) {
      summary.failed++;
      logAttempt(db, person.id, MINING_SOURCE, "fail", "llm returned null");
      continue;
    }

    let facts: string[];
    try {
      const parsed = extractJson(res.text) as Record<string, unknown>;
      const raw = Array.isArray(parsed.facts) ? parsed.facts : [];
      facts = raw
        .filter((f): f is string => typeof f === "string" && !!f.trim())
        .map((f) => f.trim())
        .slice(0, 5);
    } catch {
      summary.failed++;
      logAttempt(db, person.id, MINING_SOURCE, "fail", "unparseable JSON");
      continue;
    }

    const newBio = composeBio(head, facts);
    const changed = newBio !== person.bio;
    if (changed) {
      db.prepare("UPDATE person SET bio = ?, updated_at = datetime('now') WHERE id = ?").run(
        newBio,
        person.id
      );
      summary.mined++;
    } else {
      summary.noChange++;
    }
    logAttempt(
      db,
      person.id,
      MINING_SOURCE,
      "success",
      `${facts.length} fact${facts.length === 1 ? "" : "s"}${conv.trimmed ? " (transcript trimmed)" : ""}`
    );
  }

  summary.budgetLeft = Math.max(0, remaining);
  return summary;
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface EnrichmentSummary {
  /** Profiles whose bio / relationship_summary changed. */
  synthesized: number;
  /** People whose mined-facts section changed. */
  mined: number;
  /** Total LLM calls spent across both passes. */
  calls: number;
  synthesis: SynthesisSummary;
  mining: MiningSummary;
}

/**
 * Single entry point for cron wiring: profile synthesis, then bio-mining.
 * Without an LLM this returns zeros and writes nothing.
 */
export async function runEnrichment(
  db: Db,
  llm: LlmClient | null,
  opts: { synthesis?: EnrichOptions; mining?: EnrichOptions } = {}
): Promise<EnrichmentSummary> {
  const synthesis = await synthesizeProfiles(db, llm, opts.synthesis ?? {});
  const mining = await mineBios(db, llm, opts.mining ?? {});
  return {
    synthesized: synthesis.updated,
    mined: mining.mined,
    calls: synthesis.attempted + mining.attempted,
    synthesis,
    mining,
  };
}
