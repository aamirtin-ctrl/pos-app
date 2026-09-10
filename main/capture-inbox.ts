// Nothing he says is allowed to evaporate.
//
// Owner ask 2026-08-06: "the system should be able to take info from my emails to myself,
// sparkle button, and personal texts and all that should run through a tasks/calendar
// event/personal info gleaning pipeline and update tasks/calendar/personal info accordingly
// and update connected calendars/google tasks as well. that should be the working pipeline."
//
// The pipeline already existed at all three entry points — main/capture.ts routes self-email
// and note-to-self iMessage through the assistant, the sparkle box calls the same
// handleCommand, and message extraction turns texts into commitments and then tasks, all of
// which push to Google Calendar and Google Tasks. What it did not have was DURABILITY.
//
// Every entry point classified with the model and acted on the answer in one pass. So when the
// provider was unavailable the input was read, misrouted or ignored, and then gone — with no
// record he had ever said it. That is not hypothetical: his Gemini quota ran out at 18:18 on
// 2026-08-06 and the things he typed into the sparkle box afterwards produced no task, no
// event, no note, and no error he could see. The only evidence they happened is that he
// remembered typing them.
//
// So the raw text lands here FIRST, before anything is interpreted, and interpretation becomes
// a separate step that is allowed to fail and be retried. The queue is drained when the model
// is healthy again.

import type { Db } from "./db/db.ts";

/** Where he said it. Every surface that can carry an instruction writes one of these. */
export type CaptureSource = "sparkle" | "self_email" | "imessage" | "alexa" | "apple_notes";

export interface CaptureRow {
  id: number;
  source: CaptureSource;
  raw_text: string;
  received_at: string;
  processed_at: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
}

/**
 * Give up on a line after this many failed interpretations. Not a quota problem — the drain
 * only runs when the model is healthy — but a line the pipeline genuinely cannot parse, which
 * would otherwise be retried on every tick forever.
 */
export const MAX_CAPTURE_ATTEMPTS = 5;

/** How many to interpret per drain, so a backlog cannot monopolise a tick. */
export const CAPTURE_DRAIN_LIMIT = 20;

/**
 * Record what he said, before deciding what it means. Returns the row id so the caller can
 * mark the same row processed once it knows.
 *
 * Empty input is not recorded — there is nothing to lose and nothing to retry.
 */
export function recordCapture(db: Db, source: CaptureSource, rawText: string): number | null {
  const text = (rawText ?? "").trim();
  if (!text) return null;
  const { lastInsertRowid } = db
    .prepare("INSERT INTO capture_inbox (source, raw_text) VALUES (?, ?)")
    .run(source, text.slice(0, 8000));
  return Number(lastInsertRowid);
}

/** Interpretation succeeded — record what the pipeline made of it and stop retrying. */
export function markCaptureDone(db: Db, id: number, result: unknown): void {
  db.prepare(
    "UPDATE capture_inbox SET processed_at = datetime('now'), result = ?, error = NULL WHERE id = ?"
  ).run(JSON.stringify(result ?? null).slice(0, 4000), id);
}

/**
 * A failure that says nothing about the TEXT — the model itself was unreachable (quota, 429,
 * 503, outage). The `healthy` gate in drainCaptures catches a fully-down provider, but a
 * per-call refusal slips past it; on 2026-08-16 five such refusals permanently closed a
 * contact-bio capture the owner expected to be filed once the model returned.
 */
const TRANSIENT_LLM_RE = /llm unavailable|quota|rate ?limit|\b429\b|\b503\b|overloaded|unavailable|timed? ?out|network/i;

/**
 * Interpretation failed. A TRANSIENT failure (model unreachable) records the error but burns
 * no attempt — the row simply waits for a healthier run. A real failure counts toward the
 * cap, and a row that exhausts it is closed with the error kept — a line that can never be
 * parsed should stop costing model calls, but it must still be findable.
 */
export function markCaptureFailed(db: Db, id: number, error: string): void {
  const msg = String(error).slice(0, 500);
  if (TRANSIENT_LLM_RE.test(msg)) {
    db.prepare("UPDATE capture_inbox SET error = ? WHERE id = ?").run(msg, id);
    return;
  }
  db.prepare("UPDATE capture_inbox SET attempts = attempts + 1, error = ? WHERE id = ?").run(msg, id);
  db.prepare(
    `UPDATE capture_inbox SET processed_at = datetime('now')
      WHERE id = ? AND attempts >= ? AND processed_at IS NULL`
  ).run(id, MAX_CAPTURE_ATTEMPTS);
}

/** Oldest first — he said them in an order, and that order can matter. */
export function pendingCaptures(db: Db, limit = CAPTURE_DRAIN_LIMIT): CaptureRow[] {
  return db
    .prepare(
      `SELECT * FROM capture_inbox
        WHERE processed_at IS NULL AND attempts < ?
        ORDER BY id LIMIT ?`
    )
    .all(MAX_CAPTURE_ATTEMPTS, Math.max(1, limit)) as CaptureRow[];
}

/** How much is waiting — surfaced so a backlog is visible rather than silent. */
export function pendingCaptureCount(db: Db): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM capture_inbox WHERE processed_at IS NULL AND attempts < ?"
      )
      .get(MAX_CAPTURE_ATTEMPTS) as { n: number }
  ).n;
}

export interface DrainResult {
  processed: number;
  failed: number;
  /** Set when the drain declined to run at all. */
  skipped?: "llm_unavailable" | "empty";
}

/**
 * Re-run the gleaning pipeline over everything that has not been interpreted yet.
 *
 * `interpret` is the pipeline itself (assistant.handleCommand in production), injected so this
 * module stays free of the assistant's dependencies and so the queue semantics can be tested
 * without a model. `healthy` gates the whole drain: retrying against a provider that is still
 * down would burn every row's attempts on an outage that has nothing to do with the text.
 */
export async function drainCaptures(
  db: Db,
  interpret: (text: string, source: CaptureSource) => Promise<unknown>,
  opts: { healthy: boolean; limit?: number } = { healthy: true }
): Promise<DrainResult> {
  const out: DrainResult = { processed: 0, failed: 0 };
  if (!opts.healthy) return { ...out, skipped: "llm_unavailable" };
  const rows = pendingCaptures(db, opts.limit ?? CAPTURE_DRAIN_LIMIT);
  if (rows.length === 0) return { ...out, skipped: "empty" };

  for (const row of rows) {
    try {
      const result = await interpret(row.raw_text, row.source);
      markCaptureDone(db, row.id, result);
      out.processed++;
    } catch (e) {
      markCaptureFailed(db, row.id, (e as Error).message);
      out.failed++;
    }
  }
  return out;
}
