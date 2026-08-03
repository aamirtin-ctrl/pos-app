// Query ranking — ported from PersonalCRM2 lib/ranking.ts (Doc 3 §2.2). Stages:
//   1. Retrieval: sqlite-vec cosine over profile embeddings when available (top 15), else the
//      deterministic token-overlap prefilter (tags x3 > role/org x2 > bio x1, top 25). Pure.
//   2. LLM rerank (smart tier, scoped): rank candidates down to 1–3 with a one-line reason
//      each, strict JSON. On any failure fall back to retrieval order so the feature works.

import type { Db } from "../db/db.ts";
import { hasVec } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";

const PREFILTER_TOP = 25;
const VEC_TOP = 15;
const RESULT_TOP = 3;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "who", "are", "you", "your", "our", "need", "needs",
  "want", "looking", "find", "intro", "intros", "introduction", "introductions",
  "someone", "people", "person", "that", "this", "have", "has", "about", "into",
  "from", "can", "any", "anyone", "help", "would", "should", "could", "talk", "contact",
]);

export interface RankPerson {
  id: number;
  display_name: string;
  role: string | null;
  org: string | null;
  bio: string | null;
  relationship_summary: string | null;
  tags: string[];
}

export interface PrefilterHit {
  person: RankPerson;
  score: number;
  matchedTags: string[];
}

export interface RankedResult {
  person: RankPerson;
  reason: string;
}

function tokenize(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Unique, meaningful query tokens (>=3 chars, no stopwords). */
export function inquiryTokens(inquiry: string): string[] {
  return [...new Set(tokenize(inquiry).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

/** Stage 1 — score by token overlap (tags x3 > role/org x2 > bio x1), top N. Pure. */
export function prefilter(inquiry: string, people: RankPerson[]): PrefilterHit[] {
  const qTokens = inquiryTokens(inquiry);
  if (qTokens.length === 0) return [];

  const hits: PrefilterHit[] = [];
  for (const p of people) {
    const tagSet = new Set(tokenize(p.tags.join(" ")));
    const roleOrgSet = new Set(tokenize(`${p.role ?? ""} ${p.org ?? ""}`));
    const bioSet = new Set(tokenize(`${p.bio ?? ""} ${p.relationship_summary ?? ""}`));

    let score = 0;
    for (const t of qTokens) {
      if (tagSet.has(t)) score += 3;
      else if (roleOrgSet.has(t)) score += 2;
      else if (bioSet.has(t)) score += 1;
    }
    if (score <= 0) continue;

    const matchedTags = p.tags.filter((tag) => tokenize(tag).some((t) => qTokens.includes(t)));
    hits.push({ person: p, score, matchedTags });
  }

  hits.sort((a, b) => b.score - a.score || a.person.display_name.localeCompare(b.person.display_name));
  return hits.slice(0, PREFILTER_TOP);
}

/** Load all persons with their tags (small personal-CRM scale). */
export function loadRankPeople(db: Db): RankPerson[] {
  const people = db
    .prepare("SELECT id, display_name, role, org, bio, relationship_summary FROM person")
    .all() as Omit<RankPerson, "tags">[];
  const tagRows = db.prepare("SELECT person_id, tag FROM person_tag").all() as {
    person_id: number;
    tag: string;
  }[];
  const tagsByPerson = new Map<number, string[]>();
  for (const t of tagRows) {
    const arr = tagsByPerson.get(t.person_id) ?? [];
    arr.push(t.tag);
    tagsByPerson.set(t.person_id, arr);
  }
  return people.map((p) => ({ ...p, tags: tagsByPerson.get(p.id) ?? [] }));
}

/** Vector retrieval via vec_profile MATCH. Returns hits in cosine order, or null if unusable. */
function vecRetrieve(db: Db, queryEmbedding: number[], people: RankPerson[]): PrefilterHit[] | null {
  try {
    const count = db.prepare("SELECT COUNT(*) c FROM vec_profile").get() as { c: number };
    if (!count.c) return null;
    const rows = db
      .prepare(
        `SELECT person_id, distance FROM vec_profile WHERE embedding MATCH ? AND k = ? ORDER BY distance`
      )
      .all(JSON.stringify(queryEmbedding), VEC_TOP) as { person_id: number; distance: number }[];
    if (rows.length === 0) return null;
    const byId = new Map(people.map((p) => [p.id, p]));
    const hits: PrefilterHit[] = [];
    for (const r of rows) {
      const person = byId.get(r.person_id);
      if (person) hits.push({ person, score: -r.distance, matchedTags: [] });
    }
    return hits.length ? hits : null;
  } catch (e) {
    console.warn(`vec retrieval failed: ${(e as Error).message}`);
    return null;
  }
}

/** Build the retrieval-order fallback results (used when the LLM is absent or fails). */
function fallbackResults(hits: PrefilterHit[]): RankedResult[] {
  return hits.slice(0, RESULT_TOP).map((h) => ({
    person: h.person,
    reason: h.matchedTags.length
      ? `Matches your tags: ${h.matchedTags.slice(0, 4).join(", ")}`
      : "Keyword match in their profile",
  }));
}

function buildRerankPrompt(inquiry: string, hits: PrefilterHit[]): string {
  const records = hits.map((h) => ({
    person_id: h.person.id,
    name: h.person.display_name,
    role: h.person.role,
    org: h.person.org,
    tags: h.person.tags.join(", "),
    bio: h.person.bio,
    relationship: h.person.relationship_summary,
  }));
  return `You rank a user's personal CRM contacts for a specific need. Pick the most relevant.

USER INQUIRY:
${inquiry}

CANDIDATE CONTACTS (JSON):
${JSON.stringify(records, null, 2)}

Return STRICT JSON ONLY — no prose, no markdown fences — an array of up to ${RESULT_TOP}, best first:
[{ "person_id": <id from the list>, "reason": "<one line: why THIS person fits THIS inquiry, grounded only in their record>" }]

Rules: Only use person_ids from the list. Do not invent facts. Omit contacts that don't genuinely fit rather than padding to ${RESULT_TOP}. Keep each reason to one sentence.`;
}

/** Stage 2 — LLM rerank via the smart tier. Returns ordered results, or null on any failure. */
async function rerank(llm: LlmClient, inquiry: string, hits: PrefilterHit[]): Promise<RankedResult[] | null> {
  if (hits.length === 0) return null;
  const res = await llm.call("ranking", "smart", buildRerankPrompt(inquiry, hits), { json: true });
  if (!res) return null;
  try {
    const parsed = extractJson(res.text);
    if (!Array.isArray(parsed)) return null;

    const byId = new Map(hits.map((h) => [h.person.id, h.person]));
    const out: RankedResult[] = [];
    const seen = new Set<number>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const id = Number((item as Record<string, unknown>).person_id);
      const reason = (item as Record<string, unknown>).reason;
      const person = byId.get(id);
      if (!person || seen.has(id) || typeof reason !== "string") continue;
      seen.add(id);
      out.push({ person, reason: reason.trim() });
      if (out.length >= RESULT_TOP) break;
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn(`rerank failed: ${(e as Error).message}`);
    return null;
  }
}

export interface RankOutcome {
  results: RankedResult[];
  usedLlm: boolean;
  usedVec: boolean;
}

/**
 * Full pipeline: vec retrieval (when sqlite-vec is loaded, embeddings exist, and the caller
 * supplied an `embedQuery`) else keyword prefilter → smart-tier rerank to 1–3 with reasons →
 * graceful fallback to retrieval order with keyword reasons.
 */
export async function rank(
  db: Db,
  llm: LlmClient | null,
  inquiry: string,
  opts: { embedQuery?: (text: string) => Promise<number[] | null> } = {}
): Promise<RankOutcome> {
  const people = loadRankPeople(db);

  let hits: PrefilterHit[] | null = null;
  let usedVec = false;
  if (hasVec() && opts.embedQuery) {
    const qVec = await opts.embedQuery(inquiry);
    if (qVec) {
      hits = vecRetrieve(db, qVec, people);
      usedVec = hits !== null;
    }
  }
  if (!hits) hits = prefilter(inquiry, people);
  if (hits.length === 0) return { results: [], usedLlm: false, usedVec };

  if (llm) {
    const reranked = await rerank(llm, inquiry, hits);
    if (reranked) return { results: reranked, usedLlm: true, usedVec };
  }
  return { results: fallbackResults(hits), usedLlm: false, usedVec };
}
