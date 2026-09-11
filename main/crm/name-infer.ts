// Name inference for unsaved senders (owner ask 2026-09-10): a person who texts from an
// unsaved number often SAYS their name ("hey it's Jake", "thanks Aamir! - Priya"). For
// 'unverified' contacts whose display_name is still a bare handle, one batched Gemini call
// proposes a name from the conversation transcript — and the code only accepts a name whose
// every word literally appears in that transcript, so a hallucinated name cannot land.
//
// Provenance contract (migration 21): an applied name stamps person.name_inferred_at and
// KEEPS the 'unverified' tag — it is a guess, not an identity. The moment a real macOS/iCloud
// contact exists for one of the person's handles, adoptSavedNames() (run on every iMessage
// sync, which already builds the AddressBook index) overwrites the guess with the saved name,
// clears the stamp and the tag — and touches nothing else: the bio survives.
//
// Quota shape follows crm/enrich.ts exactly: ONE smart-tier call per run whatever the batch
// size, budget counted per PERSON in the enrichment_attempt ledger, degrade-to-nothing when
// the LLM is unavailable (candidates are re-selected next run — a person is never dropped).

import type { NameIndex } from "../connectors/addressbook.ts";
import type { Db } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { dailyBudget, gatherConversation, usedToday } from "./enrich.ts";

export const NAME_INFER_SOURCE = "name-infer";

const MIN_CONTENT_MSGS = 3; // below this a transcript can't support a name anyway
const RETRY_FAIL_DAYS = 2; // LLM was down / response unusable → try again soon
const MAX_SCAN = 60;
const TRANSCRIPT_CHARS = 4000; // names show up early and in closings; no need for more

/** A display_name that is still a raw handle, not a human name. */
export function isHandleLikeName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (/^\+?\d[\d\s()-]*$/.test(n)) return true; // bare phone number
  if (n.includes("@")) return true; // email handle
  return !/[a-z]/i.test(n);
}

/**
 * An inferred name is applied ONLY if every word of it appears verbatim in the transcript
 * (word-boundary, case-insensitive). The model is asked for a name it can quote; this is
 * the audit that makes that rule enforceable rather than aspirational.
 */
export function nameCorroborated(name: string, transcript: string): boolean {
  const n = name.trim();
  if (!n || isHandleLikeName(n)) return false;
  const tokens = n.split(/\s+/);
  if (tokens.length > 4) return false;
  return tokens.every((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(transcript);
  });
}

interface CandidateRow {
  id: number;
  display_name: string;
}

/**
 * 'unverified' people whose display_name is still a handle, with enough content-bearing
 * conversation to be worth a call. Cadence: never attempted → eligible; last attempt failed
 * (LLM down / bad JSON) → eligible after RETRY_FAIL_DAYS; last attempt succeeded without a
 * name → eligible only once NEW messages arrive (the old transcript already said nothing).
 */
export function nameInferCandidates(db: Db, limit: number): CandidateRow[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name,
              MAX(julianday(i.occurred_at)) AS latest_j,
              (SELECT e.status FROM enrichment_attempt e
                WHERE e.person_id = p.id AND e.source = '${NAME_INFER_SOURCE}'
                ORDER BY e.attempted_at DESC LIMIT 1) AS last_status,
              julianday((SELECT MAX(e.attempted_at) FROM enrichment_attempt e
                WHERE e.person_id = p.id AND e.source = '${NAME_INFER_SOURCE}')) AS last_j
       FROM person p
       JOIN person_tag t ON t.person_id = p.id AND t.tag = 'unverified'
       JOIN interaction i ON i.person_id = p.id
       WHERE p.name_inferred_at IS NULL
         AND i.body_summary IS NOT NULL AND TRIM(i.body_summary) <> ''
       GROUP BY p.id
       HAVING COUNT(*) >= ${MIN_CONTENT_MSGS}
       ORDER BY COUNT(*) DESC
       LIMIT ${MAX_SCAN}`
    )
    .all() as (CandidateRow & { latest_j: number | null; last_status: string | null; last_j: number | null })[];

  const nowJ = Date.now() / 86_400_000 + 2440587.5;
  return rows
    .filter((r) => isHandleLikeName(r.display_name))
    .filter((r) => {
      if (r.last_j == null) return true;
      if (r.last_status === "fail") return nowJ - r.last_j >= RETRY_FAIL_DAYS;
      return (r.latest_j ?? 0) > r.last_j; // succeeded w/o a name: wait for new messages
    })
    .slice(0, limit);
}

export interface NameInferItem {
  n: number;
  handle: string;
  transcript: string;
}

function inferEntry(item: NameInferItem): string {
  return `${item.n}. Unsaved sender ${item.handle}
 Conversation (oldest → newest; "me" is the user, "them" is the unsaved sender):
 """${item.transcript.slice(0, TRANSCRIPT_CHARS)}"""`;
}

export function buildNameInferBatchPrompt(items: NameInferItem[]): string {
  return `The user's phone has conversations with several UNSAVED senders, numbered below. For EACH one, determine the SENDER's real name — only if the conversation itself states it: they introduce themselves ("hey it's Jake"), sign off with it, or the user addresses THEM by it. Never mix people up between entries.

HARD RULES:
1. The name must appear VERBATIM in that entry's conversation text. If it does not, return "".
2. Only the SENDER's name ("them") — never the user's own name, and never a third party the two of them merely talk about.
3. First name alone is fine; add a last name only if the conversation states it.
4. When unsure between two possibilities, return "". A wrong name is worse than none.

SENDERS:
${items.map(inferEntry).join("\n\n")}

Return STRICT JSON ONLY — no prose, no markdown fences — one object per sender, using the SAME n:
[{ "n": <number>, "name": "<the sender's name, or empty string>", "evidence": "<short verbatim quote from the conversation showing the name, or empty string>" }]`;
}

export interface NameInferSummary {
  attempted: number;
  /** People whose display_name was set from the conversation (still 'unverified'). */
  named: number;
  /** Model proposed a name the transcript doesn't contain — rejected, nothing written. */
  rejected: number;
  noName: number;
  failed: number;
  budgetLeft: number;
}

function logAttempt(db: Db, personId: number, status: "success" | "fail", detail: string | null): void {
  db.prepare(
    "INSERT INTO enrichment_attempt (person_id, source, status, detail) VALUES (?, ?, ?, ?)"
  ).run(personId, NAME_INFER_SOURCE, status, detail);
}

/**
 * The inference pass: ONE LLM call for the whole batch. A returned name is applied only
 * when nameCorroborated() finds every word of it in the transcript; applied names stamp
 * name_inferred_at and leave the 'unverified' tag in place.
 */
export async function inferUnknownNames(
  db: Db,
  llm: LlmClient | null,
  opts: { limit?: number; budget?: number; now?: Date } = {}
): Promise<NameInferSummary> {
  const summary: NameInferSummary = {
    attempted: 0, named: 0, rejected: 0, noName: 0, failed: 0, budgetLeft: 0,
  };
  if (!llm) return summary;

  const now = opts.now ?? new Date();
  const budget = dailyBudget(db, opts.budget);
  let remaining = budget - usedToday(db, NAME_INFER_SOURCE, now);
  summary.budgetLeft = Math.max(0, remaining);
  if (remaining <= 0) return summary;

  const cap = Math.min(opts.limit ?? 8, remaining);
  const candidates = nameInferCandidates(db, cap);

  const items: NameInferItem[] = [];
  const meta: { id: number; transcript: string }[] = [];
  for (const c of candidates) {
    const conv = gatherConversation(db, c.id, now);
    if (conv.contentCount < MIN_CONTENT_MSGS) continue;
    items.push({ n: items.length + 1, handle: c.display_name, transcript: conv.transcript });
    meta.push({ id: c.id, transcript: conv.transcript });
  }
  if (items.length === 0) return summary;

  const res = await llm.call("name_infer", "smart", buildNameInferBatchPrompt(items), {
    json: true,
    maxTokens: Math.min(2000, 150 * items.length),
  });
  summary.attempted = items.length;
  remaining -= items.length;
  summary.budgetLeft = Math.max(0, remaining);
  console.log(`name-infer: asked about ${items.length} unsaved sender(s) in 1 LLM call`);

  let byN: Map<number, { name: string }> | null = null;
  let failDetail = "llm returned null";
  if (res) {
    try {
      const raw = extractJson(res.text);
      const arr = Array.isArray(raw) ? raw : items.length === 1 && raw && typeof raw === "object" ? [raw] : null;
      if (arr) {
        byN = new Map();
        for (const o of arr as Record<string, unknown>[]) {
          if (!o || typeof o !== "object") continue;
          const n = Number(o.n);
          byN.set(Number.isFinite(n) ? n : byN.size + 1, {
            name: typeof o.name === "string" ? o.name.trim() : "",
          });
        }
      } else failDetail = "unusable JSON shape";
    } catch {
      failDetail = "unparseable JSON";
    }
  }
  if (!byN) {
    for (const m of meta) {
      summary.failed++;
      logAttempt(db, m.id, "fail", failDetail);
    }
    return summary;
  }

  items.forEach((item, i) => {
    const { id, transcript } = meta[i];
    const o = byN!.get(item.n);
    if (!o) {
      summary.failed++;
      logAttempt(db, id, "fail", "missing from batch response");
      return;
    }
    if (!o.name) {
      summary.noName++;
      logAttempt(db, id, "success", "no name stated in conversation");
      return;
    }
    if (!nameCorroborated(o.name, transcript)) {
      summary.rejected++;
      logAttempt(db, id, "fail", `proposed "${o.name}" not found in transcript`);
      return;
    }
    db.prepare(
      "UPDATE person SET display_name = ?, name_inferred_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(o.name, id);
    summary.named++;
    logAttempt(db, id, "success", `named "${o.name}" from conversation`);
  });

  return summary;
}

// ── saved-contact override ───────────────────────────────────────────────────

/**
 * A real saved contact beats a guess (owner ask 2026-09-10: "if a contact is created in my
 * icloud that POS can then see it should override the unverified contacts name — but
 * obviously keep the personal bio"). For every person still 'unverified' or carrying an
 * inferred name, check their handles against the AddressBook index the iMessage sync just
 * built; on a hit, adopt the saved name (and org, if ours is blank), clear the stamp and the
 * tag. display_name/org are the ONLY person fields touched — bio and everything else stay.
 */
/**
 * Owner ask 2026-09-11: a bare number that stays nameless for 30 days gets DELETED —
 * "if there aren't any messages that allow that or if I haven't created an apple contact,
 * POS should delete that unsaved number from the database". Nameless = display_name still
 * a handle after every chance: inference found nothing and no saved contact matched.
 * The delete cascades (aliases, interactions, tags, drafts); commitments/msg_plans keep
 * their rows with person_id nulled. chat.db still holds the raw history, so a number that
 * texts again later simply starts over as a fresh unverified person with a fresh 30 days.
 */
export function purgeNamelessNumbers(db: Db, days = 30): { deleted: number } {
  const rows = db
    .prepare(
      `SELECT id, display_name FROM person
       WHERE name_inferred_at IS NULL
         AND created_at <= datetime('now', ?)`
    )
    .all(`-${days} days`) as { id: number; display_name: string }[];
  const doomed = rows.filter((r) => isHandleLikeName(r.display_name));
  const del = db.prepare("DELETE FROM person WHERE id = ?");
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
  });
  tx(doomed.map((r) => r.id));
  if (doomed.length > 0) console.log(`name-infer: purged ${doomed.length} nameless number(s) older than ${days}d`);
  return { deleted: doomed.length };
}

export function adoptSavedNames(db: Db, ab: NameIndex): { renamed: number } {
  if (ab.index.size === 0) return { renamed: 0 };
  // apple_card_id IS NULL: a person whose card POS itself created must NOT be verified
  // by finding that same card in AddressBook — the card carries "Inferred by POS" for
  // exactly this reason. Their verification is a USER EDIT of the card (or its deletion
  // mirroring back), both handled by the daily crm/apple-bios.ts sync.
  const people = db
    .prepare(
      `SELECT DISTINCT p.id, p.display_name, p.org FROM person p
       LEFT JOIN person_tag t ON t.person_id = p.id AND t.tag = 'unverified'
       WHERE (p.name_inferred_at IS NOT NULL OR t.tag IS NOT NULL)
         AND p.apple_card_id IS NULL`
    )
    .all() as { id: number; display_name: string; org: string | null }[];

  let renamed = 0;
  const aliasStmt = db.prepare(
    "SELECT value FROM alias WHERE person_id = ? AND kind IN ('phone','email','imessage_handle')"
  );
  for (const p of people) {
    let hit: { name: string; company: string | null } | undefined;
    for (const a of aliasStmt.all(p.id) as { value: string }[]) {
      hit = ab.index.get(a.value);
      if (hit) break;
    }
    if (!hit || !hit.name.trim()) continue;
    // A hit verifies the person even when the saved name matches the guess exactly.
    db.prepare(
      `UPDATE person SET display_name = ?, org = COALESCE(NULLIF(org, ''), ?),
        name_inferred_at = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(hit.name, hit.company, p.id);
    db.prepare("DELETE FROM person_tag WHERE person_id = ? AND tag = 'unverified'").run(p.id);
    if (hit.name !== p.display_name) renamed++;
  }
  return { renamed };
}
