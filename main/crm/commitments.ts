// Commitment extraction — the join between conversation and obligation. New module (no
// direct PersonalCRM2 ancestor): LLM fast-tier extraction over interaction batches with a
// deterministic fallback (followups.ts) when the LLM is unavailable. Rows land in the
// `commitment` table unconfirmed; confidence < 0.7 is the review queue.
//
// Quality layers (each catches what the previous one misses):
//   1. The prompt demands REWRITING into imperative tasks and carries real failure
//      examples as few-shot negatives — most junk never comes back from the model.
//   2. passesCommitmentGate() — a deterministic sanity check applied to BOTH the LLM
//      and fallback paths before any insert. Questions, quote fragments, FYIs, bare
//      URLs/addresses never reach the table no matter what the model says.
//   3. Deterministic-fallback rows are capped at confidence 0.5 (they are raw message
//      fragments, not rewrites), so they can never clear the autonomy threshold in
//      workers.autoTentativeTasks — they land in the review queue instead.

import type { Db } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { extractFollowups } from "./followups.ts";

export const REVIEW_CONFIDENCE = 0.7;
/** Deterministic-fallback rows are raw message fragments, never rewrites — cap them here. */
export const FALLBACK_CONFIDENCE = 0.5;
const BATCH_SIZE = 20;

// ── post-extraction sanity gate ──────────────────────────────────────────────

// Interrogative openers — a task description is an imperative, never a question.
const INTERROGATIVE_START =
  /^(what|whats|what's|who|whom|whose|when|where|why|how|which|do you|did you|are you|can i|can you|could you|would you|will you|should i|is this|is that|is it)\b/i;

// First words that can never head an imperative task phrase (FYIs, fragments, gerund
// status updates like "looking at 345 Westwood Court on Google Maps").
const NON_VERB_START = new Set([
  "this", "that", "these", "those", "there", "it", "its", "it's", "the", "a", "an",
  "fyi", "ok", "okay", "yes", "no", "maybe", "also", "just", "so", "and", "but", "or", "if",
]);

// -ing first words are gerunds (status updates), except these genuine imperative verbs.
const ING_VERBS = new Set(["bring", "ping", "ring", "sing", "swing", "string", "spring"]);

/**
 * Deterministic sanity gate for a commitment description, applied to BOTH the LLM and
 * deterministic extraction paths before any insert (and again by the autonomy layer in
 * workers.ts and the startup cleanup). Rejects:
 *   - empty / over-140-char strings,
 *   - questions ("…?" or an interrogative opener: what/who/when/where/why/how/do you/…),
 *   - descriptions with no verb-ish head (FYI openers like "This is…", gerund openers
 *     like "looking at…", bare nouns, digit-leading address fragments),
 *   - bare URLs,
 *   - unrewritten quote fragments: second-person pronouns ("call you", "you can upload")
 *     and the anonymous "to/for contact" placeholder ("Give cash to contact").
 */
export function passesCommitmentGate(description: string): boolean {
  const d = (description ?? "").replace(/\s+/g, " ").trim();
  if (!d) return false;
  if (d.length > 140) return false;
  if (/\?$/.test(d)) return false;
  if (INTERROGATIVE_START.test(d)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(d)) return false; // a bare URL is not a task
  const words = d.split(" ");
  if (words.length < 2) return false; // a lone topic word has no action
  const first = words[0].toLowerCase().replace(/[^a-z']/g, "");
  if (!first) return false; // leading digit/symbol — address or URL fragment
  if (NON_VERB_START.has(first)) return false;
  if (/[a-z]ing$/.test(first) && !ING_VERBS.has(first)) return false; // gerund head
  if (/\b(to|for|with|from)\s+(the\s+)?contact\b/i.test(d)) return false; // anonymous placeholder
  if (/\byou\b|\byour\b/i.test(d)) return false; // second-person = unrewritten message quote
  return true;
}

export type CommitmentDirection = "i_owe_them" | "they_owe_me";

export interface CommitmentRow {
  id: number;
  person_id: number | null;
  direction: CommitmentDirection;
  description: string;
  due_at: string | null;
  status: string;
  source_interaction_id: number | null;
  confidence: number;
  confirmed_by_user: number;
  created_at: string;
  resolved_at: string | null;
}

interface InteractionRow {
  id: number;
  person_id: number;
  direction: string | null;
  occurred_at: string | null;
  subject: string | null;
  body_summary: string | null;
}

function buildPrompt(rows: InteractionRow[]): string {
  const records = rows.map((r) => ({
    interaction_id: r.id,
    direction: r.direction,
    occurred_at: r.occurred_at,
    subject: r.subject,
    body: r.body_summary,
  }));
  return `Extract real commitments from these interactions between the user and their contacts, and REWRITE each one as a clean imperative task.

WHAT COUNTS AS A COMMITMENT — every one of these must hold:
- A concrete action the USER owes a contact ("i_owe_them") or a contact owes the user ("they_owe_me").
- Someone actually agreed or promised to do it — not merely mentioned, offered, suggested, or asked about it.
- It can be stated as a short imperative phrase a person would put on a to-do list.

NEVER commitments — extract nothing for these:
- Questions of any kind ("do you want…", "what time…", "can you…?" that was never answered).
- Offers and invitations that were not accepted.
- Status updates, FYIs, opinions, links, screenshots, addresses, or things merely being discussed.
- Other people's plans or chatter that create no obligation involving the user.

REWRITE — never quote:
- "description" MUST be a rewritten imperative task phrase, NOT a copied message fragment.
- Start with a verb. Name who it involves and what it is for whenever the thread makes that clear. Keep it under 120 characters.
- Write "Bring cash for <person>", never "Give cash to contact". Never leave second-person fragments like "call you" or "you can upload".

REAL FAILURES — these exact snippets were wrongly turned into tasks before. They are NOT commitments; for input like these, output nothing:
- "do you want eggs?" (a question/offer)
- "Give cash to contact" (verbatim fragment; no named person, no agreement)
- "find something, call you" (chatter fragment; no concrete obligation)
- "This is the health plan you can upload for approval. There are high chances they will decline the first time around" (an FYI about a document)
- "what do you wanna inquire about?" (a question)
- "looking at 345 Westwood Court on Google Maps" (a link/screenshot being discussed)

POSITIVE EXAMPLES (message → rewritten task):
- Sarah: "can you send me the deck by fri?" — user: "yep will do" → { "description": "Send Sarah the pitch deck", "direction": "i_owe_them", "due_at": "<that Friday>" }
- User to Omar: "I'll bring the cash for the tickets tomorrow" → { "description": "Bring Omar cash for the tickets", "direction": "i_owe_them", "due_at": "<tomorrow>" }
- Dev: "I'll send over the signed lease on Monday" → { "description": "Collect the signed lease from Dev", "direction": "they_owe_me", "due_at": "<that Monday>" }

CONFIDENCE — be honest:
- 0.9+ only when the obligation is explicit and unambiguous in the text.
- Anything below 0.8 is held for human review instead of acted on — do not inflate.
- When unsure whether something is a commitment at all, OMIT it entirely. An empty array is a good and common answer.

INTERACTIONS (JSON):
${JSON.stringify(records, null, 2)}

Return STRICT JSON ONLY — no prose, no markdown fences — an array (possibly empty):
[{ "interaction_id": <id from the list>, "description": "<rewritten imperative task>", "direction": "i_owe_them" | "they_owe_me", "due_at": "<ISO date>" | null, "confidence": <0-1> }]

Rules: only use interaction_ids from the list; do not invent facts or dates; never copy message text verbatim into description.`;
}

const insertCommitment = (db: Db) =>
  db.prepare(
    `INSERT INTO commitment (person_id, direction, description, due_at, status, source_interaction_id, confidence, confirmed_by_user)
     VALUES (?, ?, ?, ?, 'open', ?, ?, 0)`
  );

/**
 * Extract commitments from the given interactions. Batches subject+body_summary through the
 * fast tier (strict JSON); on llm null / call failure, degrades to the deterministic
 * followups extractor (confidence capped at FALLBACK_CONFIDENCE, direction i_owe_them).
 * Every candidate — LLM or fallback — must pass passesCommitmentGate before insert.
 * Sets interaction.extracted_at on every processed row so re-runs skip. Returns counts;
 * rows with confidence < REVIEW_CONFIDENCE are the review queue (status 'open',
 * confirmed_by_user 0).
 */
export async function extractCommitmentsLlm(
  db: Db,
  llm: LlmClient | null,
  interactionIds: number[]
): Promise<{ inserted: number; needsReview: number; processed: number }> {
  if (interactionIds.length === 0) return { inserted: 0, needsReview: 0, processed: 0 };
  const rows = db
    .prepare(
      `SELECT id, person_id, direction, occurred_at, subject, body_summary
       FROM interaction WHERE extracted_at IS NULL AND id IN (${interactionIds.map(() => "?").join(",")})`
    )
    .all(...interactionIds) as InteractionRow[];
  if (rows.length === 0) return { inserted: 0, needsReview: 0, processed: 0 };

  const ins = insertCommitment(db);
  let inserted = 0;
  let needsReview = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    let extracted = false;

    if (llm) {
      const res = await llm.call("commitments", "fast", buildPrompt(batch), { json: true });
      if (res) {
        extracted = true;
        try {
          const parsed = extractJson(res.text);
          const byId = new Map(batch.map((r) => [r.id, r]));
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (!item || typeof item !== "object") continue;
              const o = item as Record<string, unknown>;
              const src = byId.get(Number(o.interaction_id));
              const description = typeof o.description === "string" ? o.description.trim() : "";
              const direction = o.direction === "they_owe_me" ? "they_owe_me" : "i_owe_them";
              const dueAt = typeof o.due_at === "string" && o.due_at ? o.due_at : null;
              const confRaw = Number(o.confidence);
              const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0.5;
              if (!src || !description) continue;
              if (!passesCommitmentGate(description)) continue; // questions/quotes/FYIs never land
              ins.run(src.person_id, direction, description, dueAt, src.id, confidence);
              inserted++;
              if (confidence < REVIEW_CONFIDENCE) needsReview++;
            }
          }
        } catch (e) {
          console.warn(`commitments: bad LLM JSON, batch skipped (${(e as Error).message})`);
        }
      }
    }

    if (!extracted) {
      // Deterministic fallback: each interaction's text runs through the follow-up extractor.
      for (const r of batch) {
        const text = [r.subject, r.body_summary].filter(Boolean).join(" — ");
        if (!text || !r.occurred_at) continue;
        const proposals = extractFollowups(db, r.person_id, [
          { text, sentAt: r.occurred_at, direction: r.direction },
        ]);
        for (const p of proposals) {
          if (!passesCommitmentGate(p.description)) continue; // same gate as the LLM path
          // Fallback proposals are raw message fragments, so their confidence is capped
          // below the autonomy threshold — they queue for review, never auto-convert.
          ins.run(r.person_id, "i_owe_them", p.description, p.dueAt, r.id, FALLBACK_CONFIDENCE);
          inserted++;
          needsReview++;
        }
      }
    }

    const mark = db.prepare("UPDATE interaction SET extracted_at = datetime('now') WHERE id = ?");
    const markAll = db.transaction((ids: number[]) => ids.forEach((id) => mark.run(id)));
    markAll(batch.map((r) => r.id));
  }

  return { inserted, needsReview, processed: rows.length };
}

/** User accepted an extracted commitment. */
export function confirmCommitment(db: Db, id: number): void {
  db.prepare("UPDATE commitment SET confirmed_by_user = 1 WHERE id = ?").run(id);
}

/** User rejected it — keep the row for audit, out of every active view. */
export function dropCommitment(db: Db, id: number): void {
  db.prepare(
    "UPDATE commitment SET status = 'dropped', resolved_at = datetime('now') WHERE id = ?"
  ).run(id);
}

/** Commitments, optionally filtered by status; due-dated first (soonest), then undated. */
export function listCommitments(db: Db, status?: string): CommitmentRow[] {
  const where = status ? "WHERE status = ?" : "";
  const args = status ? [status] : [];
  return db
    .prepare(
      `SELECT * FROM commitment ${where}
       ORDER BY due_at IS NULL, due_at ASC, created_at DESC`
    )
    .all(...args) as CommitmentRow[];
}
