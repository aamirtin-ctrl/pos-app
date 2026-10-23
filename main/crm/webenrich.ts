// Outbound enrichment — POS goes OUT to fetch who a contact is in the world (owner ask
// 2026-10-20: "adding information for all my contacts (linkedin scrape etc.)"). Ported from
// PersonalCRM2's waterfall (lib/web-enrich*.ts), which never made it across.
//
// Waterfall, per person:
//   1. People Data Labs — keyed off a LinkedIn URL or email the person already has. An
//      identifier match is certain; PDL's free tier is ~100 lookups a month, so it is
//      reserved for exactly these people.
//   2. Firecrawl web search — `"Name" org`. Results include LinkedIn's public headline
//      snippets (search-engine data — linkedin.com itself is never scraped), school
//      directories, rosters. A name hit is NOT a match on its own.
// Then ONE batched fast-tier LLM call judges every person's evidence against what POS
// already knows (org, bio, mined facts) and writes the world-identity fields.
//
// Write-back is fill-only: org / role / location only when empty, the bio HEAD only when
// empty (mined "From conversations" bullets and anything he typed are never touched), plus
// the LinkedIn URL as an alias when one is found. Profile synthesis sees these fields on
// its next pass and folds them into the two-sentence bio.

import type { Db } from "../db/db.ts";
import { getSetting } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { normalizeLinkedin, normalizeEmail } from "./normalize.ts";
import { splitBio, composeBio } from "./enrich.ts";
import { addAlias } from "../connectors/common.ts";

export const WEB_SOURCE = "web";
const DEFAULT_DAILY_PEOPLE = 20;
/** PDL free tier is 100/month; leave headroom. */
const PDL_MONTHLY_CAP = 90;
/** Firecrawl free tier is 1000 credits/month at 2 credits per search. */
const SEARCH_MONTHLY_CAP = 400;
const SUCCESS_COOLDOWN_DAYS = 180;
const FAIL_COOLDOWN_DAYS = 30;
const JUDGE_BATCH = 8;

export interface WebKeys {
  pdl: string | null;
  firecrawl: string | null;
}

export interface Candidate {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  bio: string | null;
  linkedin: string | null;
  email: string | null;
}

export type PdlFetch = (params: URLSearchParams, key: string) => Promise<unknown | null>;
export type SearchFetch = (query: string, key: string) => Promise<SearchHit[] | null>;

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

// ── live clients (null on any failure — a down vendor costs a day, never a crash) ──

export const pdlFetch: PdlFetch = async (params, key) => {
  try {
    const r = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
    });
    if (!r.ok) return null; // 404 = no match; 402/429 = quota
    return await r.json();
  } catch {
    return null;
  }
};

export const searchFetch: SearchFetch = async (query, key) => {
  try {
    const r = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 5 }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
    return (j.data ?? []).map((d) => ({
      url: String(d.url ?? ""),
      title: String(d.title ?? ""),
      description: String(d.description ?? "").slice(0, 300),
    }));
  } catch {
    return null;
  }
};

// ── candidates + budget ──────────────────────────────────────────────────────

function countThisMonth(db: Db, like: string, now: Date): number {
  const month = now.toISOString().slice(0, 7);
  return (
    db
      .prepare(
        "SELECT COUNT(*) n FROM enrichment_attempt WHERE source = ? AND detail LIKE ? AND substr(attempted_at, 1, 7) = ?"
      )
      .get(WEB_SOURCE, like, month) as { n: number }
  ).n;
}

/**
 * People worth a lookup: a real first+last name (or an identifier), not an LLM-guessed
 * name, not archived, not looked up recently. Identifier-holders first (certain matches),
 * then the closest tiers.
 */
export function webCandidates(db: Db, limit: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.org, p.role, p.location, p.bio,
              (SELECT value FROM alias WHERE person_id = p.id AND kind = 'linkedin' LIMIT 1) linkedin,
              (SELECT value FROM alias WHERE person_id = p.id AND kind = 'email' LIMIT 1) email
       FROM person p
       WHERE p.tier < 3 AND p.name_inferred_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM person_tag t WHERE t.person_id = p.id AND t.tag = 'unverified')
         AND NOT EXISTS (
           SELECT 1 FROM enrichment_attempt a WHERE a.person_id = p.id AND a.source = '${WEB_SOURCE}'
             AND ((a.status = 'success' AND julianday(a.attempted_at) > julianday('now', '-${SUCCESS_COOLDOWN_DAYS} days'))
               OR (a.status = 'fail' AND a.detail NOT LIKE 'llm%'
                   AND julianday(a.attempted_at) > julianday('now', '-${FAIL_COOLDOWN_DAYS} days'))))
       ORDER BY (linkedin IS NOT NULL) DESC, (email IS NOT NULL) DESC, p.tier ASC,
                julianday(p.last_contact_at) DESC
       LIMIT 400`
    )
    .all() as Candidate[];
  return rows.filter((c) => c.linkedin || c.email || isFullName(c.display_name)).slice(0, limit);
}

/** "Miles Bliey" yes; "Wyatt", "+14155550100", "mom" no. */
export function isFullName(name: string): boolean {
  const words = name.trim().split(/\s+/).filter((w) => /^[\p{L}][\p{L}'’.-]*$/u.test(w));
  return words.length >= 2 && words.length === name.trim().split(/\s+/).length;
}

// ── evidence ─────────────────────────────────────────────────────────────────

/** PDL's person record → a compact evidence line. Free-tier redacted fields arrive as `true`. */
export function pdlEvidence(raw: unknown): string | null {
  const j = raw as { status?: number; data?: Record<string, any> } | null;
  const d = j?.data;
  if (!d || (j?.status && j.status !== 200)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const parts: string[] = [];
  const title = str(d.job_title);
  const co = str(d.job_company_name);
  if (title || co) parts.push(`current: ${[title, co].filter(Boolean).join(" at ")}`);
  if (str(d.location_name)) parts.push(`location: ${d.location_name}`);
  if (str(d.industry)) parts.push(`industry: ${d.industry}`);
  if (str(d.headline)) parts.push(`headline: ${d.headline}`);
  const exp = (Array.isArray(d.experience) ? d.experience : [])
    .slice(0, 5)
    .map((e: any) => [str(e?.title?.name), str(e?.company?.name)].filter(Boolean).join(" at "))
    .filter(Boolean);
  if (exp.length) parts.push(`experience: ${exp.join("; ")}`);
  const edu = (Array.isArray(d.education) ? d.education : [])
    .slice(0, 4)
    .map((e: any) => [str(e?.school?.name), ...(Array.isArray(e?.majors) ? e.majors : [])].filter(Boolean).join(", "))
    .filter(Boolean);
  if (edu.length) parts.push(`education: ${[...new Set(edu)].join("; ")}`);
  if (str(d.linkedin_url)) parts.push(`linkedin: ${d.linkedin_url}`);
  return parts.length ? parts.join(" | ") : null;
}

export function searchQuery(c: Candidate): string {
  return [`"${c.display_name.trim()}"`, c.org?.trim()].filter(Boolean).join(" ");
}

interface Evidence {
  candidate: Candidate;
  via: string; // "pdl" | "search" | "pdl+search"
  identifierMatch: boolean;
  text: string;
}

async function gather(
  c: Candidate,
  keys: WebKeys,
  io: { pdl: PdlFetch; search: SearchFetch },
  budget: { pdl: number; search: number }
): Promise<Evidence | null> {
  const vias: string[] = [];
  const lines: string[] = [];
  let identifierMatch = false;

  if (keys.pdl && budget.pdl > 0 && (c.linkedin || c.email)) {
    const params = new URLSearchParams({ min_likelihood: "6", pretty: "false" });
    const li = normalizeLinkedin(c.linkedin);
    if (li) params.set("profile", li.norm);
    else params.set("email", normalizeEmail(c.email)?.norm ?? c.email!);
    budget.pdl--;
    vias.push("pdl");
    const ev = pdlEvidence(await io.pdl(params, keys.pdl));
    if (ev) {
      identifierMatch = true;
      lines.push(`PEOPLE DATA LABS (matched by ${li ? "their LinkedIn URL" : "their email"}): ${ev}`);
    }
  }
  if (!identifierMatch && keys.firecrawl && budget.search > 0) {
    budget.search--;
    vias.push("search");
    const hits = await io.search(searchQuery(c), keys.firecrawl);
    for (const h of hits ?? []) lines.push(`WEB: ${h.url} | ${h.title} | ${h.description}`);
  }
  if (vias.length === 0) return null;
  return { candidate: c, via: vias.join("+"), identifierMatch, text: lines.join("\n") };
}

// ── judge + write ────────────────────────────────────────────────────────────

export function buildJudgePrompt(items: Evidence[]): string {
  const blocks = items.map((e, i) => {
    const c = e.candidate;
    const { head, bullets } = splitBio(c.bio);
    const known = JSON.stringify({
      name: c.display_name,
      org: c.org,
      role: c.role,
      location: c.location,
      bio: head || null,
      known_facts: bullets.slice(0, 12),
    });
    return `${i + 1}. ${c.display_name}
 KNOWN: ${known}
 EVIDENCE${e.identifierMatch ? " (identifier match — this IS the person)" : ""}:
${e.text || " (none)"}`;
  });
  return `You enrich a personal CRM with who each person is in the world. For EACH numbered person, decide whether the EVIDENCE is about the SAME person as KNOWN, then extract their public professional identity.

same_person rules:
- Evidence marked "identifier match" is the person: same_person = true.
- Web results: true ONLY when a result names this person AND agrees with at least one KNOWN detail (org, school, city, field, a known fact). A matching name alone is NOT enough — common names belong to many people. If KNOWN has nothing to corroborate with, false.
- When results disagree with each other, use only the ones that corroborate KNOWN.

PEOPLE:
${blocks.join("\n\n")}

Return STRICT JSON ONLY, one object per person, same n:
[{"n": <number>, "same_person": <bool>, "org": "<current company or school>", "role": "<current title, or e.g. 'Student' / 'Undergraduate, Mathematics'>", "location": "<city, region>", "linkedin_url": "<url if in evidence>", "bio": "<at most two factual sentences: who they are in the world — role, organization, field of study, notable work. Proper capitalization. Never mention the CRM owner. No he/she/his/her — gender is not in the evidence; use the name or no pronoun.>"}]

Rules: use ONLY facts stated in the evidence; omit a field (empty string) rather than guess. Fix casing (evidence may be lowercase). When same_person is false, leave every other field empty.`;
}

function byN(raw: unknown): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  for (const o of arr) {
    if (o && typeof o === "object" && typeof (o as any).n === "number") out.set((o as any).n, o as Record<string, unknown>);
  }
  return out;
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Fill-only write. Returns the names of fields that changed. */
export function applyWebResult(db: Db, c: Candidate, o: Record<string, unknown>): string[] {
  const changed: string[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of ["org", "role", "location"] as const) {
    const v = s(o[f]);
    if (v && !c[f]) {
      sets.push(`${f} = ?`);
      vals.push(v);
      changed.push(f);
    }
  }
  const bio = s(o.bio);
  const { head, bullets } = splitBio(c.bio);
  if (bio && !head.trim()) {
    sets.push("bio = ?");
    vals.push(composeBio(bio, bullets));
    changed.push("bio");
  }
  if (sets.length) {
    db.prepare(`UPDATE person SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...vals, c.id);
  }
  const li = normalizeLinkedin(s(o.linkedin_url));
  if (li && /linkedin\.com\/in\//.test(li.norm) && !c.linkedin) {
    addAlias(db, c.id, "linkedin", `https://www.${li.norm}`, "web");
    changed.push("linkedin");
  }
  return changed;
}

export interface WebEnrichSummary {
  attempted: number;
  enriched: number;
  noMatch: number;
  pdlCalls: number;
  searches: number;
}

function logAttempt(db: Db, personId: number, status: "success" | "fail", detail: string): void {
  db.prepare("INSERT INTO enrichment_attempt (person_id, source, status, detail) VALUES (?, ?, ?, ?)").run(
    personId,
    WEB_SOURCE,
    status,
    detail
  );
}

/**
 * One daily pass. No keys or no LLM → zeros, no network. Credits are only spent for people
 * a judge call can follow — a down LLM logs `llm unavailable`, which never triggers the
 * 30-day cooldown, so those people are retried on the next pass.
 */
export async function runWebEnrichment(
  db: Db,
  llm: LlmClient | null,
  keys: WebKeys,
  opts: { limit?: number; now?: Date; io?: { pdl: PdlFetch; search: SearchFetch } } = {}
): Promise<WebEnrichSummary> {
  const now = opts.now ?? new Date();
  const io = opts.io ?? { pdl: pdlFetch, search: searchFetch };
  const out: WebEnrichSummary = { attempted: 0, enriched: 0, noMatch: 0, pdlCalls: 0, searches: 0 };
  if (!llm || (!keys.pdl && !keys.firecrawl)) return out;

  const setting = parseInt(getSetting(db, "web_enrich_daily") ?? "", 10);
  const perDay = opts.limit ?? (Number.isFinite(setting) && setting > 0 ? setting : DEFAULT_DAILY_PEOPLE);
  // Daily cap, not per-call: the enrichment block re-runs on later ticks when synthesis
  // fails, and every re-run must not buy another day's worth of lookups.
  const today = (
    db
      .prepare("SELECT COUNT(*) n FROM enrichment_attempt WHERE source = ? AND date(attempted_at) = date(?)")
      .get(WEB_SOURCE, now.toISOString()) as { n: number }
  ).n;
  const limit = Math.max(0, perDay - today);
  if (limit === 0) return out;
  const budget = {
    pdl: Math.max(0, PDL_MONTHLY_CAP - countThisMonth(db, "%pdl%", now)),
    search: Math.max(0, SEARCH_MONTHLY_CAP - countThisMonth(db, "%search%", now)),
  };

  const evidence: Evidence[] = [];
  for (const c of webCandidates(db, limit)) {
    if (budget.pdl <= 0 && budget.search <= 0) break;
    const ev = await gather(c, keys, io, budget);
    if (!ev) continue;
    out.pdlCalls += ev.via.includes("pdl") ? 1 : 0;
    out.searches += ev.via.includes("search") ? 1 : 0;
    if (!ev.text) {
      out.attempted++;
      out.noMatch++;
      logAttempt(db, c.id, "fail", `${ev.via}: no results`);
      continue;
    }
    evidence.push(ev);
  }

  for (let i = 0; i < evidence.length; i += JUDGE_BATCH) {
    const chunk = evidence.slice(i, i + JUDGE_BATCH);
    const res = await llm.call("web_enrich", "fast", buildJudgePrompt(chunk), { json: true, maxTokens: 4096 });
    let parsed: Map<number, Record<string, unknown>> | null = null;
    try {
      parsed = res ? byN(extractJson(res.text)) : null;
    } catch {
      parsed = null;
    }
    chunk.forEach((ev, j) => {
      out.attempted++;
      const o = parsed?.get(j + 1);
      if (!parsed) return logAttempt(db, ev.candidate.id, "fail", `llm unavailable (${ev.via})`);
      if (!o || o.same_person !== true) {
        out.noMatch++;
        return logAttempt(db, ev.candidate.id, "fail", `${ev.via}: no confident match`);
      }
      const changed = applyWebResult(db, ev.candidate, o);
      out.enriched += changed.length ? 1 : 0;
      logAttempt(db, ev.candidate.id, "success", `${ev.via}: ${changed.length ? changed.join(",") : "matched, nothing new"}`);
    });
  }
  return out;
}
