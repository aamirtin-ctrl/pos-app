// Commitment extraction — the join between conversation and obligation. New module (no
// direct PersonalCRM2 ancestor): LLM fast-tier extraction over interaction batches with a
// deterministic fallback (followups.ts) when the LLM is unavailable. Rows land in the
// `commitment` table unconfirmed; confidence < 0.7 is the review queue.

import type { Db } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { extractFollowups } from "./followups.ts";

export const REVIEW_CONFIDENCE = 0.7;
const BATCH_SIZE = 20;

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
  return `Extract concrete commitments (promises to do something) from these interactions between the user and their contacts.
"i_owe_them" = the user promised the contact something; "they_owe_me" = the contact promised the user something.
Only extract explicit, actionable commitments — not vague pleasantries.

INTERACTIONS (JSON):
${JSON.stringify(records, null, 2)}

Return STRICT JSON ONLY — no prose, no markdown fences — an array (possibly empty):
[{ "interaction_id": <id from the list>, "description": "<one line>", "direction": "i_owe_them" | "they_owe_me", "due_at": "<ISO date>" | null, "confidence": <0-1> }]

Rules: only use interaction_ids from the list; do not invent facts or dates; omit anything that is not a real commitment.`;
}

const insertCommitment = (db: Db) =>
  db.prepare(
    `INSERT INTO commitment (person_id, direction, description, due_at, status, source_interaction_id, confidence, confirmed_by_user)
     VALUES (?, ?, ?, ?, 'open', ?, ?, 0)`
  );

/**
 * Extract commitments from the given interactions. Batches subject+body_summary through the
 * fast tier (strict JSON); on llm null / call failure, degrades to the deterministic
 * followups extractor (confidence 0.9, direction i_owe_them). Sets interaction.extracted_at
 * on every processed row so re-runs skip. Returns counts; rows with confidence <
 * REVIEW_CONFIDENCE are the review queue (status 'open', confirmed_by_user 0).
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
          ins.run(r.person_id, "i_owe_them", p.description, p.dueAt, r.id, 0.9);
          inserted++;
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
