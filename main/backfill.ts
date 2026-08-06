// Degraded-work backfill queue (owner ask 2026-08-05: "when my Gemini credits refill —
// I think hourly — it should go back and fix the stuff it couldn't summarize or abridge
// at the time because credits were exhausted").
//
// THE ARTIFACT IT REPAIRS. When the LLM is unavailable, extractCommitmentsLlm degrades to
// the deterministic followups extractor: descriptions become near-verbatim message text
// instead of rewritten headlines, confidence is capped at FALLBACK_CONFIDENCE (0.5), kind
// is always 'task' and due_at is whatever parseWhen could scrape. That is exactly what the
// owner sees on screen — his own words copied into a to-do list. Those rows are correct to
// keep (better a rough item than none), but they are UNFINISHED work, and the moment quota
// comes back they should be finished.
//
// QUEUE, SCHEMA-FREE. Migrations are owned elsewhere, so the queue lives in the existing
// `setting` table: one row per degraded item, key `degraded:<kind>:<id>`, value the JSON
// {kind, id, at, reason}. Re-marking the same id overwrites its own row, so the queue can
// never double-count a commitment. Capped at QUEUE_CAP entries, oldest dropped first — a
// multi-day outage must not turn the settings table into an unbounded log.
//
// THE SWEEP. backfillDegraded() runs ONLY when llmHealth().ok — that is the whole point of
// the feature; a repair pass that fires while the quota is still exhausted would just burn
// the first request of the new window and re-degrade. It then re-runs the SAME normalize
// prompt the extraction pipeline uses (imported, never duplicated) over up to `limit` queued
// items in ONE batched call — the same two-query economy that keeps a 30-candidate batch at
// two requests. Items the model rewrites get the headline, date, kind and confidence it
// returns; items the model now OMITS were outage-era false positives and are dropped
// (status 'dropped' + resolved_at, kept for audit exactly like dropCommitment). Anything the
// owner has since confirmed or edited by hand (confirmed_by_user = 1 — the IPC edit path
// sets it too) is skipped untouched and dequeued: his words are never overwritten by a
// model that woke up later.
//
// Never throws: the tick calls this on a freshly-refilled quota and a repair pass failing
// must not take the sync with it.

import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { extractJson, llmHealth, type LlmClient } from "./llm/provider.ts";
import { contextBlock } from "./context.ts";
import { preferencesBlock, resolvePreferencesDir } from "./preferences.ts";
import {
  buildNormalizePrompt,
  dedupeKeyFor,
  dropCommitment,
  passesCommitmentGate,
  contentHash,
  CONTEXT_INTERACTIONS,
  type Candidate,
  type PersonContext,
} from "./crm/commitments.ts";

/** What can be queued. Only commitments degrade into user-visible text today. */
export type DegradedKind = "commitment";

/** Why the row is unfinished. One value today; the field exists so the queue can grow. */
export type DegradedReason = "llm_unavailable";

export interface DegradedEntry {
  kind: DegradedKind;
  /** Row id in the table named by `kind`. */
  id: number;
  /** ISO timestamp the degradation happened. Oldest entries are trimmed first. */
  at: string;
  reason: string;
}

/** Key prefix in the `setting` table — the queue's whole schema. */
export const DEGRADED_PREFIX = "degraded:";

/**
 * Hard cap on queued entries. A quota outage lasting days would otherwise mark every
 * fallback insert forever; past this, the oldest entries are dropped (their rows keep the
 * rough description — they simply stop being candidates for a rewrite).
 */
export const QUEUE_CAP = 200;

/** The `setting` key for one queued item. */
export function degradedKey(kind: DegradedKind, id: number): string {
  return `${DEGRADED_PREFIX}${kind}:${id}`;
}

/** Parse a stored value; null when the row is not a usable queue entry. */
function parseEntry(key: string, raw: string | null): DegradedEntry | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<DegradedEntry>;
    if (!p || p.kind !== "commitment") return null;
    const id = Number(p.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (key !== degradedKey(p.kind, id)) return null; // key/value disagree — not ours
    return {
      kind: p.kind,
      id,
      at: typeof p.at === "string" ? p.at : "",
      reason: typeof p.reason === "string" ? p.reason : "llm_unavailable",
    };
  } catch {
    return null;
  }
}

/** Every queue row, key included, oldest first (created time, then id). */
function rawEntries(db: Db, kind?: DegradedKind): { key: string; entry: DegradedEntry | null }[] {
  const like = kind ? `${DEGRADED_PREFIX}${kind}:%` : `${DEGRADED_PREFIX}%`;
  const rows = db
    .prepare("SELECT key, value FROM setting WHERE key LIKE ? ORDER BY key")
    .all(like) as { key: string; value: string }[];
  return rows
    .map((r) => ({ key: r.key, entry: parseEntry(r.key, r.value) }))
    // Unparseable rows sort first (at = "") so the cap sweeps them out before real work.
    .sort((a, b) => {
      const at = (a.entry?.at ?? "").localeCompare(b.entry?.at ?? "");
      return at !== 0 ? at : (a.entry?.id ?? 0) - (b.entry?.id ?? 0);
    });
}

/**
 * Enqueue a row whose content came out of the deterministic fallback because the LLM was
 * unavailable. Idempotent per id (the key IS the id), and self-trimming at QUEUE_CAP.
 */
export function markDegraded(
  db: Db,
  kind: DegradedKind,
  id: number,
  reason: DegradedReason | string,
  now: Date = new Date()
): void {
  if (!Number.isFinite(id) || id <= 0) return;
  const entry: DegradedEntry = { kind, id, at: now.toISOString(), reason: String(reason) };
  setSetting(db, degradedKey(kind, id), JSON.stringify(entry));

  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM setting WHERE key LIKE ?").get(`${DEGRADED_PREFIX}%`) as {
      c: number;
    }
  ).c;
  if (count <= QUEUE_CAP) return;
  const del = db.prepare("DELETE FROM setting WHERE key = ?");
  for (const r of rawEntries(db).slice(0, count - QUEUE_CAP)) del.run(r.key);
}

/** Queued entries, oldest first. `kind` narrows to one table's queue. */
export function listDegraded(db: Db, kind?: DegradedKind): DegradedEntry[] {
  return rawEntries(db, kind)
    .map((r) => r.entry)
    .filter((e): e is DegradedEntry => e !== null);
}

/** Dequeue one item, repaired or not. Safe to call for an entry that was never queued. */
export function clearDegraded(db: Db, kind: DegradedKind, id: number): void {
  db.prepare("DELETE FROM setting WHERE key = ?").run(degradedKey(kind, id));
}

/** True when this row is still queued (used by tests and the tick's cheap guard). */
export function isDegraded(db: Db, kind: DegradedKind, id: number): boolean {
  return getSetting(db, degradedKey(kind, id)) !== null;
}

// ── the repair pass ──────────────────────────────────────────────────────────

export interface BackfillResult {
  /** Commitments whose description/date/kind/confidence the model rewrote. */
  repaired: number;
  /** Outage-era false positives the model now rejects — status 'dropped'. */
  dropped: number;
  /**
   * Why nothing happened, when nothing happened on purpose:
   *   'empty'            — the queue is clear (the common case; costs one indexed scan)
   *   'llm_unavailable'  — health is red, or the one batched call failed. Queue untouched.
   *   'bad_response'     — the model answered with something that isn't the JSON array.
   *                        Queue untouched so the next tick can retry.
   */
  skipped?: "empty" | "llm_unavailable" | "bad_response";
}

/** Default items per pass — one prompt's worth, same order of magnitude as CANDIDATE_CAP. */
export const BACKFILL_LIMIT = 20;

interface QueuedCommitment {
  entry: DegradedEntry;
  commitmentId: number;
  personId: number | null;
  description: string;
  dueAt: string | null;
  kind: string | null;
  confidence: number;
}

const clampConfidence = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

/**
 * Repair queued degraded work now that the model is answering again.
 *
 * Gate: returns immediately with skipped 'llm_unavailable' when llmHealth(db, secrets).ok
 * is false — this pass exists to run on a refilled quota and nowhere else, and it must
 * leave the queue completely intact when it declines.
 *
 * Cost: ONE fast-tier call for up to `limit` items, reusing buildNormalizePrompt — the same
 * batched query the extraction pipeline's second half spends, over the queued commitments'
 * source interactions plus their short per-person thread context.
 *
 * Per item: the model's rewritten headline replaces the raw fragment (and its due_at / kind
 * / confidence replace the fallback's 0.5-capped guesses); an item the model OMITS was never
 * a commitment and is dropped; a row the owner confirmed or edited by hand, a row already
 * closed, and a row whose source message is gone are skipped untouched. Everything looked at
 * is dequeued, so a repair pass never repeats itself.
 *
 * Never throws.
 */
export async function backfillDegraded(
  db: Db,
  secrets: SecretStore,
  llm: LlmClient | null,
  opts: { limit?: number } = {}
): Promise<BackfillResult> {
  const out: BackfillResult = { repaired: 0, dropped: 0 };
  try {
    const limit = Math.max(1, opts.limit ?? BACKFILL_LIMIT);
    // The whole point: only ever run on a healthy provider. A red ring means the credits
    // are still gone and a "repair" would just re-degrade at our own expense.
    if (!llmHealth(db, secrets).ok || !llm) return { ...out, skipped: "llm_unavailable" };

    const queue = listDegraded(db, "commitment").slice(0, limit);
    if (queue.length === 0) return { ...out, skipped: "empty" };

    // ── load each queued row + its source message; dequeue what can't be repaired ──
    const rowStmt = db.prepare(
      `SELECT c.id, c.person_id, c.description, c.due_at, c.status, c.confidence, c.kind,
              c.confirmed_by_user, c.source_interaction_id,
              i.id AS i_id, i.person_id AS i_person_id, i.direction, i.occurred_at,
              i.subject, i.body_summary
         FROM commitment c LEFT JOIN interaction i ON i.id = c.source_interaction_id
        WHERE c.id = ?`
    );

    const candidates: Candidate[] = [];
    const queued: QueuedCommitment[] = [];
    for (const entry of queue) {
      const r = rowStmt.get(entry.id) as
        | {
            id: number;
            person_id: number | null;
            description: string;
            due_at: string | null;
            status: string;
            confidence: number;
            kind: string | null;
            confirmed_by_user: number;
            source_interaction_id: number | null;
            i_id: number | null;
            i_person_id: number | null;
            direction: string | null;
            occurred_at: string | null;
            subject: string | null;
            body_summary: string | null;
          }
        | undefined;
      // Gone, already closed, or confirmed/edited by the owner: dequeue, change nothing.
      // His edits are never overwritten by a model that woke up an hour later.
      if (!r || (r.status !== "open" && r.status !== "scheduled") || r.confirmed_by_user !== 0) {
        clearDegraded(db, "commitment", entry.id);
        continue;
      }
      const text = [r.subject, r.body_summary].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
      if (r.i_id == null || !text) {
        clearDegraded(db, "commitment", entry.id); // no source text left to re-read
        continue;
      }
      const n = candidates.length + 1;
      candidates.push({
        n,
        row: {
          id: r.i_id,
          person_id: (r.i_person_id ?? r.person_id ?? 0) as number,
          direction: r.direction,
          occurred_at: r.occurred_at,
          subject: r.subject,
          body_summary: r.body_summary,
        },
        text,
        hash: contentHash(text),
      });
      queued.push({
        entry,
        commitmentId: r.id,
        personId: r.person_id,
        description: r.description,
        dueAt: r.due_at,
        kind: r.kind,
        confidence: r.confidence,
      });
    }
    if (candidates.length === 0) return out; // everything was already handled/dequeued

    // Per-person thread context — the same short window extraction uses, so references
    // ("my list", "that place") resolve the same way they would have at the time.
    const nameStmt = db.prepare("SELECT display_name FROM person WHERE id = ?");
    const recentStmt = db.prepare(
      `SELECT direction, occurred_at, subject, body_summary FROM interaction
        WHERE person_id = ? ORDER BY occurred_at DESC LIMIT ${CONTEXT_INTERACTIONS}`
    );
    const contexts = new Map<number, PersonContext>();
    for (const c of candidates) {
      const pid = c.row.person_id;
      if (pid == null || contexts.has(pid)) continue;
      const person = nameStmt.get(pid) as { display_name: string | null } | undefined;
      contexts.set(pid, {
        name: person?.display_name ?? null,
        recent: recentStmt.all(pid) as PersonContext["recent"],
      });
    }

    const about = contextBlock(db);
    let prefs = "";
    try {
      prefs = preferencesBlock(resolvePreferencesDir());
    } catch {
      /* no preferences file — the repair proceeds without it */
    }

    // ── ONE call for the whole batch (the two-query economy, second half only) ──
    const res = await llm.call(
      "commitments-backfill",
      "fast",
      buildNormalizePrompt(candidates, contexts, about, prefs),
      { json: true }
    );
    // A failed call means the quota went away again between the health check and now —
    // leave the queue exactly as it was and try on a later tick.
    if (!res) return { ...out, skipped: "llm_unavailable" };

    let parsed: unknown;
    try {
      parsed = extractJson(res.text);
    } catch (e) {
      console.warn(`backfill: unusable JSON, queue kept for retry (${(e as Error).message})`);
      return { ...out, skipped: "bad_response" };
    }
    if (!Array.isArray(parsed)) return { ...out, skipped: "bad_response" };

    // ── apply ────────────────────────────────────────────────────────────────
    const byN = new Map(queued.map((q, i) => [candidates[i].n, q]));
    const update = db.prepare(
      "UPDATE commitment SET description = ?, due_at = ?, kind = ?, confidence = ? WHERE id = ?"
    );
    const setKey = db.prepare("UPDATE commitment SET dedupe_key = ? WHERE id = ?");
    const answered = new Set<number>();

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const q = byN.get(Number(o.n));
      if (!q || answered.has(q.commitmentId)) continue;
      const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
      // The same gate the extraction path applies to the AI headline. A rewrite that
      // fails it is no better than the fragment already stored — leave the row alone,
      // but dequeue it: re-asking would spend quota on the same bad answer.
      if (!title || !passesCommitmentGate(title)) {
        answered.add(q.commitmentId);
        clearDegraded(db, "commitment", q.entry.id);
        continue;
      }
      answered.add(q.commitmentId);
      const dueAt = typeof o.due_at === "string" && o.due_at ? o.due_at.slice(0, 10) : q.dueAt;
      const kind = o.kind === "event" ? "event" : o.kind === "task" ? "task" : q.kind ?? "task";
      const confidence = clampConfidence(o.confidence, q.confidence);
      update.run(title, dueAt, kind, confidence, q.commitmentId);
      // The semantic identity moved with the description; keep dedupe_key in step so future
      // extractions collapse into this row. Best-effort: another row may already own the key
      // (UNIQUE where set), in which case the stale key is the lesser problem.
      const key = dedupeKeyFor(title, q.personId, dueAt);
      if (key) {
        try {
          setKey.run(key, q.commitmentId);
        } catch {
          /* key already claimed — leave this row's key as it was */
        }
      }
      out.repaired++;
      clearDegraded(db, "commitment", q.entry.id);
      console.log(
        `backfill: rewrote commitment ${q.commitmentId} "${q.description}" → "${title}" (conf ${confidence})`
      );
    }

    // Anything sent to the model and NOT answered is something it no longer judges a
    // commitment at all — an outage-era false positive, which is exactly what this sweep
    // should clean up. Dropped, never deleted: the row stays for audit.
    for (const q of queued) {
      if (answered.has(q.commitmentId)) continue;
      dropCommitment(db, q.commitmentId);
      out.dropped++;
      clearDegraded(db, "commitment", q.entry.id);
      console.log(`backfill: dropped commitment ${q.commitmentId} "${q.description}" — no longer a commitment`);
    }

    return out;
  } catch (e) {
    // Never throws: a failed repair pass must not take the tick (or a sync) with it.
    console.warn(`backfill: pass failed (${(e as Error).message})`);
    return out;
  }
}
