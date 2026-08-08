// Commitment extraction — the join between conversation and obligation. New module (no
// direct PersonalCRM2 ancestor): LLM fast-tier extraction over interaction batches with a
// deterministic fallback (followups.ts) when the LLM is unavailable. Rows land in the
// `commitment` table unconfirmed; confidence < 0.7 is the review queue.
//
// QUOTA SHAPE (owner directive 2026-08-05 #3): extraction costs exactly TWO fast-tier
// calls per run, no matter how many candidates it looks at — never one per item. The
// Gemini free tier is request-limited, so the pipeline is:
//   query 1 (ONE call)  — classify which of the N numbered candidates are commitments
//                         at all (strict JSON [{n, is_commitment, confidence}]);
//   query 2 (ONE call)  — for the M survivors, return the NORMALIZED headline title
//                         (what the app and Google Tasks show — never a quote), the
//                         date it belongs on, and TASK vs CALENDAR EVENT.
// Everything decided is written to `extraction_log` keyed by a content hash, so identical
// text is never sent to the model again — on this run or any future one.
//
// DEDUPE (owner report 2026-08-05, "2 items landed ~4 times" / "these two events are the
// same thing albeit from different texts"):
//   a. content hash — normalize (lowercase, collapse whitespace, strip punctuation) →
//      sha256. A hash already in extraction_log is skipped before any LLM call. This is
//      what kills the duplicated self-texts (iMessage echoes the note-to-self thread) and
//      the same task arriving through two paths.
//   b. dedupe_key — a slug of the AI title + person + due day, UNIQUE where set. The same
//      commitment stated in two DIFFERENT messages collapses into ONE row, both inside a
//      single batch (before insert) and across runs (INSERT … ON CONFLICT DO UPDATE keeps
//      the higher confidence and the earlier created_at).
//
// Quality layers (each catches what the previous one misses):
//   1. The prompt demands REWRITING into imperative tasks and carries real failure
//      examples as few-shot negatives — most junk never comes back from the model.
//      Second pass (owner report 2026-08-05): the prompt now also carries
//        a. per-person THREAD CONTEXT (last 6 interactions, direction-labeled, the
//           drafts.ts pattern) so references resolve ("my list" → the Stanford dorm
//           packing list the thread is about) — unresolvable references are DROPPED;
//        b. a precomputed DATE REFERENCE table anchored on each message's sent date
//           (the msgplans technique) so stated timeframes ("late September") become
//           real due_at dates — and a missing timeframe stays null, never "today".
//   2. passesCommitmentGate() — a deterministic sanity check applied to BOTH the LLM
//      and fallback paths before any insert. Questions, quote fragments, FYIs, bare
//      URLs/addresses, first-person narration, and contentless verb+pronoun stubs
//      ("find something") never reach the table no matter what the model says.
//   3. parseWhen (crm/when.ts) runs as a deterministic cross-check: when the LLM gave
//      no due date but the message states a future one, it is attached. And
//      isExpiredSameDay() backstops the same-day rule (owner report 2026-08-05 #2:
//      "be back here at 5:30 latest" texted on a previous day survived as an undated
//      task): a commitment whose ONLY temporal reference is a time-of-day or same-day
//      marker ("at 5:30", "by noon", "tonight", "this afternoon", "in an hour") is
//      scoped to its message's SENT date — once that moment has passed, the item is
//      dropped entirely on BOTH the LLM and fallback paths, never kept undated.
//   4. Deterministic-fallback rows are capped at confidence 0.5 (they are raw message
//      fragments, not rewrites), so they can never clear the autonomy threshold in
//      workers.autoTentativeTasks — they land in the review queue instead. They are ALSO
//      enqueued (backfill.markDegraded) as unfinished work: when the LLM was unavailable
//      the title is near-verbatim message text, and backfillDegraded rewrites it once the
//      quota refills. A successful call that classified everything as not-a-commitment is
//      a real verdict, not an outage — it inserts nothing and enqueues nothing.
//   4b. Personal context (main/context.ts): both prompts open with an ABOUT THE USER
//      block, and any survivor the model left undated gets resolveNamedDate() run over
//      its title + raw text. That is what turns "meetup at the start of school" into the
//      user's actual term-start date instead of leaving it undated (or, worse, today).
//   4c. Personal preferences (main/preferences.ts): the free-text companion to 4b, appended
//      directly after the facts in both prompts. The facts say who he is; the preferences
//      say how he wants his time handled.
//   5. Thread-resolution awareness (owner spec 2026-08-05 #3): something resolved IN
//      the message chain must not live on as an open commitment. The prompt closes
//      ask→fulfilled/cancelled pairs at extraction time, and threadResolves() — a
//      conservative keyword check over LATER messages in the same person's thread —
//      deterministically reinforces it on BOTH the LLM and fallback paths. The
//      post-hoc layer (workers.resolveFromThreads) closes already-open commitments
//      when NEW messages resolve them.

import { localDateISO } from "../dates.ts";
import { createHash } from "node:crypto";
import type { Db } from "../db/db.ts";
import { contextBlock, resolveNamedDate } from "../context.ts";
import { preferencesBlock, resolvePreferencesDir } from "../preferences.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { markDegraded } from "../backfill.ts";
import { extractFollowups } from "./followups.ts";
import { parseWhen } from "./when.ts";
// One reader for deadline WINDOWS across the whole app: the braindump parser and this
// extractor must agree that "the rest of the week" ends on the coming Sunday.
import { parseWindow } from "../engine/parse.ts";

export const REVIEW_CONFIDENCE = 0.7;
/** Deterministic-fallback rows are raw message fragments, never rewrites — cap them here. */
export const FALLBACK_CONFIDENCE = 0.5;
/**
 * Candidates looked at per run. The whole batch costs TWO LLM calls, so this is a prompt
 * -size bound, not a cost bound; anything past it waits for the next sync (its interaction
 * keeps extracted_at NULL).
 */
export const CANDIDATE_CAP = 30;

// ── content-hash dedupe (cheap, deterministic, first line of defense) ────────

/**
 * Text → its comparison form: lowercase, punctuation and symbols stripped, whitespace
 * collapsed. "Pick up the dry cleaning!!" and "pick up the  dry cleaning" normalize to
 * the same string, so the iMessage self-thread echo hashes identically to its original.
 */
export function normalizeContent(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 of the normalized text — the extraction_log key. */
export function contentHash(text: string | null | undefined): string {
  return createHash("sha256").update(normalizeContent(text)).digest("hex");
}

/** True when this exact content was already decided (any verdict) — never re-send it. */
export function contentSeen(db: Db, hash: string): boolean {
  return !!db.prepare("SELECT 1 FROM extraction_log WHERE content_hash = ?").get(hash);
}

/**
 * Record a decision for a piece of content. Idempotent on the hash; an existing row keeps
 * its original interaction_id (the first message that carried this text) and takes the new
 * verdict, so a re-decision never creates a second row.
 */
export function logExtraction(
  db: Db,
  interactionId: number | null,
  hash: string,
  verdict: string
): void {
  db.prepare(
    `INSERT INTO extraction_log (interaction_id, content_hash, verdict) VALUES (?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       verdict = excluded.verdict,
       interaction_id = COALESCE(extraction_log.interaction_id, excluded.interaction_id)`
  ).run(interactionId, hash, verdict);
}

// ── semantic duplicate collapse (dedupe_key) ─────────────────────────────────

/** Title → slug: lowercase, alphanumerics joined by single hyphens, first 60 chars. */
export function slugifyTitle(title: string | null | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * The semantic identity of a commitment: the normalized AI title, the person it involves,
 * and the ISO day it is due on (or 'undated'). The SAME thing said in two different texts
 * produces the same key — that is what collapses owner report (b) into one row. Different
 * days stay different commitments. Null when the title has no alphanumerics at all (such a
 * row is stored with dedupe_key NULL and never participates in collapse).
 */
export function dedupeKeyFor(
  title: string | null | undefined,
  personId: number | null,
  dueAt: string | null | undefined
): string | null {
  const slug = slugifyTitle(title);
  if (!slug) return null;
  const day = dueAt && /^\d{4}-\d{2}-\d{2}/.test(dueAt) ? dueAt.slice(0, 10) : "undated";
  return `p${personId ?? 0}:${day}:${slug}`;
}

// ── post-extraction sanity gate ──────────────────────────────────────────────

// Interrogative openers — a task description is an imperative, never a question.
const INTERROGATIVE_START =
  /^(what|whats|what's|who|whom|whose|when|where|why|how|which|do you|did you|are you|can i|can you|could you|would you|will you|should i|is this|is that|is it)\b/i;

// First words that can never head an imperative task phrase (FYIs, fragments, gerund
// status updates like "looking at 345 Westwood Court on Google Maps", first-person
// narration like "I wanna be back here at 5:30 latest", explanatory chatter opening on
// a preposition like "for our school it's a little different…").
const NON_VERB_START = new Set([
  "this", "that", "these", "those", "there", "it", "its", "it's", "the", "a", "an",
  "fyi", "ok", "okay", "yes", "no", "maybe", "also", "just", "so", "and", "but", "or", "if",
  "i", "i'm", "i'll", "i'd", "i've", // first-person narration, not an imperative
  "for", "at", "by", "of", "with", "from", "about", "because", // prepositional/explanatory openers
  "my", "our", "their", "his", "her", // possessive openers ("my flight is…")
]);

// -ing first words are gerunds (status updates), except these genuine imperative verbs.
const ING_VERBS = new Set(["bring", "ping", "ring", "sing", "swing", "string", "spring"]);

// Contentless objects: a verb followed only by these is not an actionable task
// ("find something", "handle it", "do that thing" — the owner's "find something" case).
const VAGUE_WORDS = new Set([
  "something", "anything", "everything", "nothing", "stuff", "thing", "things",
  "it", "that", "this", "them", "those", "these", "someone", "somebody", "anyone", "whatever",
]);
// Grammatical filler that carries no content on its own (articles, possessives, particles).
const FILLER_WORDS = new Set([
  "the", "a", "an", "some", "any", "my", "your", "our", "their", "his", "her",
  "up", "out", "on", "in", "to", "for", "with", "about", "of", "at", "and", "or",
]);

/**
 * Deterministic sanity gate for a commitment description, applied to BOTH the LLM and
 * deterministic extraction paths before any insert (and again by the autonomy layer in
 * workers.ts and the startup cleanup). Rejects:
 *   - empty / over-120-char strings (tightened from 140 — the prompt already demands
 *     under 120; anything longer is explanatory chatter, not a task),
 *   - questions ("…?" or an interrogative opener: what/who/when/where/why/how/do you/…),
 *   - descriptions with no verb-ish head (FYI openers like "This is…", gerund openers
 *     like "looking at…", first-person narration "I wanna…", prepositional chatter
 *     "for our school…", bare nouns, digit-leading address fragments),
 *   - bare URLs,
 *   - contentless objects: a verb whose every following word is a vague pronoun or
 *     filler ("find something", "handle it") names nothing anyone can act on,
 *   - unrewritten quote fragments: second-person pronouns ("call you", "you can upload")
 *     and the anonymous "to/for contact" placeholder ("Give cash to contact").
 */
export function passesCommitmentGate(description: string): boolean {
  const d = (description ?? "").replace(/\s+/g, " ").trim();
  if (!d) return false;
  if (d.length > 120) return false;
  if (/\?$/.test(d)) return false;
  if (INTERROGATIVE_START.test(d)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(d)) return false; // a bare URL is not a task
  const words = d.split(" ");
  if (words.length < 2) return false; // a lone topic word has no action
  const first = words[0].toLowerCase().replace(/[^a-z']/g, "");
  if (!first) return false; // leading digit/symbol — address or URL fragment
  if (NON_VERB_START.has(first)) return false;
  if (/[a-z]ing$/.test(first) && !ING_VERBS.has(first)) return false; // gerund head
  // Vagueness: everything after the verb head must include at least one content word.
  const rest = words.slice(1).map((w) => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  if (rest.length > 0 && rest.every((w) => VAGUE_WORDS.has(w) || FILLER_WORDS.has(w))) return false;
  if (/\b(to|for|with|from)\s+(the\s+)?contact\b/i.test(d)) return false; // anonymous placeholder
  if (/\byou\b|\byour\b/i.test(d)) return false; // second-person = unrewritten message quote
  // ── third-person narration about the thread (owner report 2026-08-06) ──
  //
  // "So in those commitments, it's just taking a text, copying it, copy-paste. It needs to
  // take the text in context of a conversation so we can understand what the task is and
  // then give a brief phrase that actually describes the task."
  //
  // His live rows: "User will ask Papa to get a paid Spotify account." and "Contact will
  // talk to him during their call tomorrow." Neither is a QUOTE, so every copy-detection
  // rule above passed them — they are the model narrating the conversation back in the
  // third person, in the prompt's own vocabulary. On a to-do list that is worse than a
  // quote: "Contact will talk to him" names nobody and asks nothing of the reader.
  //
  // A task is addressed to the person doing it. Anything that opens by describing a party,
  // or that refers to "the user"/"the contact" anywhere, is a restatement rather than an
  // instruction, and goes to review instead of onto the list.
  if (/^(?:the\s+)?(?:user|contact|they|he|she|it)\b/i.test(d)) return false;
  if (/\bthe\s+(?:user|contact)\b/i.test(d)) return false;
  return true;
}

// ── same-day expiry backstop ─────────────────────────────────────────────────

const DAY_MS = 86_400_000;

// Same-day markers: temporal words that scope an instruction to its message's sent day
// without naming a date ("tonight", "this afternoon", "in an hour", "by noon", "eod").
const SAME_DAY_MARKER =
  /\b(?:tonight|today|this\s+(?:morning|afternoon|evening)|later\s+today|end\s+of\s+(?:the\s+)?day|eod|in\s+(?:an?|a\s+few|a\s+couple(?:\s+of)?|\d{1,2})\s+(?:hour|hours|hr|hrs|min|mins|minute|minutes)|(?:at|by|before|until|till|around)\s+(?:noon|midnight))\b/i;

/**
 * Clock time mentioned in `text`, or null. PM-biased when am/pm is omitted — an
 * ambiguous "5:30" only counts as expired once even the 5:30 PM reading has passed
 * (conservative: never drop something that might still be ahead).
 */
function timeOfDayIn(text: string): { h: number; m: number } | null {
  // "5:30", "5:30pm" — lookarounds keep "09:00:00"-style timestamp fragments out.
  const hm = text.match(/(?<![\d:.])\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i);
  if (hm) {
    let h = +hm[1];
    const m = +hm[2];
    const suffix = (hm[3] ?? "").toLowerCase();
    if (suffix.startsWith("p") && h < 12) h += 12;
    else if (suffix.startsWith("a") && h === 12) h = 0;
    else if (!suffix && h >= 1 && h <= 11) h += 12; // ambiguous → the later (PM) reading
    return { h, m };
  }
  const hOnly = text.match(/\b(1[0-2]|0?[1-9])\s*(a\.?m\.?|p\.?m\.?)\b/i); // "5pm", "11 am"
  if (hOnly) {
    let h = +hOnly[1];
    if (/^p/i.test(hOnly[2]) && h < 12) h += 12;
    else if (/^a/i.test(hOnly[2]) && h === 12) h = 0;
    return { h, m: 0 };
  }
  if (/\b(?:at|by|before|until|till|around)\s+noon\b/i.test(text)) return { h: 12, m: 0 };
  return null;
}

/**
 * The same-day rule (owner report 2026-08-05 #2): a commitment whose ONLY temporal
 * reference is a time-of-day or same-day marker ("at 5:30", "by noon", "tonight",
 * "this afternoon", "in an hour") is scoped to its message's SENT date. Returns true
 * when that moment has already passed at `now` — such an item must be DROPPED
 * entirely, never kept as an undated task.
 *
 * Resolution: an explicit other-day reference in the text (a weekday, "tomorrow", a
 * month, an ISO date — anything parseWhen resolves past the sent day) means the item
 * is NOT same-day-scoped and is left untouched. Otherwise the deadline is the stated
 * clock time on the sent day (PM-biased when ambiguous), or the sent day's end of day
 * for marker-only text ("tonight"); the item is expired when that deadline < now.
 */
export function isExpiredSameDay(text: string, sentDate: Date, now: Date = new Date()): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  const sent = sentDate instanceof Date ? sentDate : new Date(sentDate);
  if (Number.isNaN(sent.getTime())) return false;
  const time = timeOfDayIn(t);
  if (!time && !SAME_DAY_MARKER.test(t)) return false; // no same-day temporal reference
  const sentDay = Date.UTC(sent.getUTCFullYear(), sent.getUTCMonth(), sent.getUTCDate());
  const when = parseWhen(t, sent);
  if (when && when.getTime() > sentDay) return false; // explicit future/other-day date — untouched
  const deadline = time ? sentDay + (time.h * 60 + time.m) * 60_000 : sentDay + DAY_MS;
  return deadline < now.getTime();
}

// ── thread-resolution awareness ──────────────────────────────────────────────

// A later message that asks for something NEW is a continuation of the thread, never
// a resolution ("sent it! also can you review the memo?" keeps the thread open).
const RESOLUTION_NEW_ASK =
  /\?|\b(?:can|could|would|will)\s+you\b|\bplease\b|\bdon'?t\s+forget\b|\bone\s+more\s+thing\b|\balso\s+(?:need|send|bring|grab|get|do)\b/i;

// Cancellations: either side withdraws the obligation ("nvm", "don't worry about it").
const RESOLUTION_CANCEL =
  /\b(?:nvm|never\s*mind|don'?t\s+worry\s+about\s+it|all\s+set|figured\s+it\s+out|no\s+longer\s+need(?:ed)?|not\s+needed\s+anymore|forget\s+(?:about\s+)?it|took\s+care\s+of\s+it)\b/i;

// Fulfillment reports: the thing was done and handed over ("sent it", "here you go",
// "got them", a bare "done" message). Deliberately narrow — "got it" alone is an
// acknowledgment ("understood"), not a completion, so it is NOT here.
const RESOLUTION_FULFILL =
  /\b(?:just\s+)?(?:sent|emailed|forwarded|shared|uploaded|delivered|attached|dropped\s+off)\s+(?:it|that|them|those|these|one|over|everything|the\s+\S+)\b|\bjust\s+sent\b|\bhere\s+(?:you\s+go|it\s+is|they\s+are)\b|\bjust\s+did\s*(?:it|that)?\b|\bgot\s+(?:them|those|it\s+done)\b|\b(?:it'?s|that'?s|all|everything'?s)\s+(?:done|sorted|handled|taken\s+care\s+of)\b|^(?:ok(?:ay)?[,!.\s]+)?(?:all\s+)?done[.!\s]*$/i;

// "done"-adjacent phrasing that is NOT a completion report ("not done yet",
// "when you're done", "almost done", "getting it done").
const RESOLUTION_NOT_DONE =
  /\b(?:not|isn'?t|aren'?t|almost|nearly|barely|when|once|until|till|before|after|get|getting)\b[^.!?]{0,24}\bdone\b/i;

// Promising to do it later is not doing it ("got it, will send tomorrow").
const RESOLUTION_FUTURE =
  /\b(?:will|i'?ll|we'?ll|gonna|going\s+to|about\s+to|planning\s+to|tomorrow|tonight|later|soon|in\s+a\s+bit|this\s+(?:afternoon|evening|week|weekend))\b/i;

/**
 * Conservative deterministic check: do these LATER messages (from either side of the
 * thread) resolve the obligation? True only when some later message carries a
 * cancellation ("nvm", "never mind", "don't worry about it", "all set", "figured it
 * out") or a fulfillment report ("sent it", "here you go", "got them", "just did",
 * a bare "done") AND that message references no new ask (no question, no "can you…",
 * no "also need…") — a message asking for something new keeps the thread open.
 * Promises ("will send tonight") and negated/deferred "done"s never count.
 *
 * `commitmentText` is required non-empty (there must be something to resolve) but the
 * match itself is message-driven: callers scope the later messages to the thread the
 * commitment came from, which is the disambiguation this check relies on.
 */
export function threadResolves(commitmentText: string, laterMessages: string[]): boolean {
  if (!(commitmentText ?? "").trim() || !Array.isArray(laterMessages)) return false;
  for (const raw of laterMessages) {
    const m = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!m) continue;
    if (RESOLUTION_NEW_ASK.test(m)) continue; // a new ask keeps the thread open
    if (RESOLUTION_CANCEL.test(m)) return true;
    if (RESOLUTION_FUTURE.test(m)) continue; // a promise, not a report
    if (RESOLUTION_FULFILL.test(m) && !RESOLUTION_NOT_DONE.test(m)) return true;
  }
  return false;
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
  /** Slug of the normalized title + person + due day; UNIQUE where set (migration 6). */
  dedupe_key: string | null;
  /** 'task' | 'event' — the second extraction query's verdict. */
  kind: string | null;
  /** HH:MM, only meaningful when kind = 'event'. */
  start_time: string | null;
}

/** A source message, as both prompt builders see it. Exported for main/backfill.ts. */
export interface InteractionRow {
  id: number;
  person_id: number;
  direction: string | null;
  occurred_at: string | null;
  subject: string | null;
  body_summary: string | null;
}

/** Per-person thread context fed to the prompt (the drafts.ts pattern). */
export interface PersonContext {
  name: string | null;
  recent: { direction: string | null; occurred_at: string | null; subject: string | null; body_summary: string | null }[];
}

/**
 * Recent interactions per person in the batch, direction-labeled, newest first. Kept SHORT
 * (2 per person, down from 6) because both batched queries carry the same context block and
 * the whole candidate batch now shares one prompt.
 */
export const CONTEXT_INTERACTIONS = 2;

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The msgplans technique (msgplans.buildDateReference), anchored on a message's SENT
 * date: a precomputed weekday map for the following week plus early/mid/late anchors
 * for the next six months, so the model NEVER does calendar math itself.
 */
export function buildAnchoredDateReference(anchor: Date): string {
  const base = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const days: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(base + i * 86_400_000);
    const tag = i === 0 ? " (sent day)" : i === 1 ? " (day after)" : "";
    days.push(`${DOW_SHORT[d.getUTCDay()]}=${d.toISOString().slice(0, 10)}${tag}`);
  }
  const months: string[] = [];
  for (let i = 0; i < 6; i++) {
    const m = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + i, 1));
    const y = m.getUTCFullYear();
    const mo = pad2(m.getUTCMonth() + 1);
    months.push(`${MONTH_NAMES[m.getUTCMonth()]} ${y}: early=${y}-${mo}-05, mid=${y}-${mo}-15, late=${y}-${mo}-25`);
  }
  return `weekdays after send: ${days.join(", ")} | month anchors: ${months.join("; ")}`;
}

const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * A numbered candidate: exactly what both queries refer to by its `n`. Exported so the
 * backfill sweep (main/backfill.ts) can feed buildNormalizePrompt the same shape rather
 * than duplicating the prompt.
 */
export interface Candidate {
  n: number;
  row: InteractionRow;
  /** subject + body_summary, joined — the text that was hashed. */
  text: string;
  hash: string;
}

/** Per-person thread context blocks, drafts.ts-style — shared by both queries. */
function contextBlocks(contexts: Map<number, PersonContext>): string {
  const blocks: string[] = [];
  for (const [personId, ctx] of contexts) {
    const lines = ctx.recent.map((h) =>
      `  [${h.direction ?? "?"} ${clip(h.occurred_at, 10)}] ${clip([h.subject, h.body_summary].filter(Boolean).join(" — "), 160)}`
    );
    blocks.push(`${ctx.name ?? "Unknown contact"} (person_id ${personId}):\n${lines.join("\n")}`);
  }
  return blocks.join("\n") || "(none)";
}

/** The numbered snippet list both queries share — `n` is the only handle the model gets. */
function numberedSnippets(cands: Candidate[], contexts: Map<number, PersonContext>): string {
  return cands
    .map((c) => {
      const who = c.row.person_id != null ? contexts.get(c.row.person_id)?.name ?? "Unknown contact" : "Unknown contact";
      const when = clip(c.row.occurred_at, 10);
      return `${c.n}. [${c.row.direction ?? "?"} ${when}] ${who}: ${clip(c.text, 400)}`;
    })
    .join("\n");
}

/**
 * The ABOUT THE USER block (main/context.ts), rendered as a prompt preamble. Both queries
 * carry it so the model can resolve personal references the message never spells out —
 * "meetup at the start of school" only means 2026-09-22 if you know where he goes to
 * school and when its term starts. Empty when the user has no facts recorded.
 */
function aboutPreamble(about: string | undefined): string {
  const block = (about ?? "").trim();
  return block ? `${block}\n\n` : "";
}

/**
 * The USER PREFERENCES block (main/preferences.ts), rendered directly AFTER the facts. Two
 * layers of the same memory: the facts say who he is, the preferences say how he wants his
 * time and attention handled — which is what decides whether a "let's grab lunch sometime"
 * is worth turning into an obligation at all. Empty when the file has no content lines.
 */
function preferencesPreamble(prefs: string | undefined): string {
  const block = (prefs ?? "").trim();
  return block ? `${block}\n\n` : "";
}

/** One date-reference line per distinct sent DATE in the batch (msgplans technique). */
function dateReferenceLines(cands: Candidate[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of cands) {
    const iso = (c.row.occurred_at ?? "").slice(0, 10);
    if (!iso || seen.has(iso)) continue;
    seen.add(iso);
    const anchor = new Date(c.row.occurred_at!);
    if (Number.isNaN(anchor.getTime())) continue;
    lines.push(`- messages sent ${iso}: ${buildAnchoredDateReference(anchor)}`);
  }
  return lines.join("\n") || "- (no dated messages in this batch)";
}

/**
 * QUERY 1 (ONE call for the whole batch): which of these numbered snippets are real
 * commitments at all? Classification only — no rewriting, no dates. Cheap output, so the
 * expensive normalization prompt only ever runs over survivors.
 */
export function buildClassifyPrompt(
  cands: Candidate[],
  contexts: Map<number, PersonContext>,
  about?: string,
  prefs?: string
): string {
  return `${aboutPreamble(about)}${preferencesPreamble(prefs)}Decide which of these numbered message snippets contain a REAL commitment between the user and a contact. Classify only — do not rewrite anything.

WHAT COUNTS AS A COMMITMENT — every one of these must hold:
- A concrete action the USER owes a contact, or a contact owes the user.
- Someone actually agreed or promised to do it — not merely mentioned, offered, suggested, or asked about it.
- It can be stated as a short imperative phrase a person would put on a to-do list.

NEVER commitments — is_commitment must be false for these:
- Questions of any kind ("do you want…", "what time…", "can you…?" that was never answered).
- Offers and invitations that were not accepted.
- Status updates, FYIs, opinions, links, screenshots, addresses, or things merely being discussed.
- Explanatory chatter about how something works ("for our school it's a little different because…").
- Old logistics fragments about a moment already past ("I wanna be back here at 5:30 latest").
- Other people's plans or chatter that create no obligation involving the user.
- Anything the thread already resolved: a later message fulfilled it ("sent it", "done", "got them", "here you go") or cancelled it ("nvm", "don't worry about it", "all set", "figured it out").
- Automated/transactional messages: verification codes, appointment reminders, receipts, "do not reply".

REAL FAILURES — these exact snippets were wrongly turned into tasks before; is_commitment false:
- "do you want eggs?" (a question/offer)
- "find something" (unresolvable reference — nothing anyone can act on)
- "This is the health plan you can upload for approval…" (an FYI about a document)
- "what do you wanna inquire about?" (a question)
- "looking at 345 Westwood Court on Google Maps" (a link/screenshot being discussed)
- "for our school it's a little different because…" (explanatory chatter)
- "I wanna be back here at 5:30 latest" (old logistics fragment)

When unsure, answer false. An all-false answer is good and common.

THREAD CONTEXT (per contact, newest first):
${contextBlocks(contexts)}

SNIPPETS:
${numberedSnippets(cands, contexts)}

Return STRICT JSON ONLY — no prose, no markdown fences — one object per snippet, using the SAME n:
[{ "n": <number>, "is_commitment": true | false, "confidence": <0-1> }]`;
}

/**
 * QUERY 2 (ONE call for all survivors): the normalization pass. For each surviving `n`,
 * the model returns the HEADLINE TITLE the app and Google Tasks will show (a rewritten
 * imperative, never a quote — owner report (c)), the date it belongs on, and whether it is
 * a TASK or a CALENDAR EVENT. Carries the date-reference table and every date rule.
 */
export function buildNormalizePrompt(
  cands: Candidate[],
  contexts: Map<number, PersonContext>,
  about?: string,
  prefs?: string
): string {
  return `${aboutPreamble(about)}${preferencesPreamble(prefs)}These numbered snippets each contain a real commitment. For each one, write the HEADLINE TITLE it should be called in a to-do app, the date it belongs on, and whether it is a TASK or a CALENDAR EVENT.

TITLE — the headline, never a quote (this exact string becomes the task in the app and in Google Tasks):
- "title" MUST be a rewritten imperative headline, NOT a copied message fragment. Copying the snippet is a failure.
- Start with a verb. Name who it involves and what it is for whenever the thread makes that clear. Keep it under 120 characters.
- Write "Bring cash for <person>", never "Give cash to contact". Never leave second-person fragments like "call you" or "you can upload".
- Two snippets that mean the SAME thing must get the SAME title, word for word — they are one commitment, not two.

WRITE AN INSTRUCTION, NOT A SUMMARY OF THE CHAT. You are writing the line the reader will see
on their own to-do list, addressed to them. Never narrate the conversation back:
- NEVER begin a title with "User", "Contact", "They", "He", "She" — and never use the words
  "the user" or "the contact" anywhere in it. Those are words from THIS prompt, not from a task.
- Resolve every pronoun against the thread before you write. If you cannot tell who "him" or
  "they" refers to, you do not understand the commitment well enough to record it — omit it.
- A snippet is one turn in a conversation. Read the THREAD CONTEXT to find out what the
  exchange was actually about, then name that. The snippet is evidence, not the answer.
These are real failures from this user's own data — do not repeat their shape:
  BAD  "User will ask Papa to get a paid Spotify account."   (narrates; "User" is not a person)
  GOOD "Ask Papa about upgrading to Spotify Premium"
  BAD  "Contact will talk to him during their call tomorrow." (whose call? who is "him"?)
  GOOD (omit — the obligation is someone else's, and the thread does not say what it is)
  BAD  "Can u figure out a way to integrate Hubspot scheduler" (a quoted question)
  GOOD "Look into integrating the HubSpot scheduler for Taha"

TASK vs CALENDAR EVENT — set "kind":
- "event" only when it happens at a place/time with other people: a meeting, call, dinner, flight, appointment, meetup. Give "start_time" as HH:MM (24h) when the snippet states a clock time, else null.
- "task" for everything else — something to do by a date, with no meeting time. "start_time" MUST be null for tasks.

STILL NOT A COMMITMENT — if a snippet turns out to be one of these, OMIT it entirely (the classifier is not perfect):
- If a LATER message in the same thread — from EITHER side — shows the obligation was fulfilled ("sent it", "done", "got them", "just did", "here you go", an attachment delivering the thing), it is closed. Output nothing for it.
- If a later message cancels it ("nvm", "don't worry about it", "never mind", "all set", "figured it out"), it is closed. Output nothing for it.
- Only a message that ASKS for something new reopens the thread — treat that new ask on its own merits.

RESOLVED-IN-THREAD EXAMPLES — ask→fulfilled pairs like these produce NOTHING:
- Sarah: "can you send me the pitch deck?" — user: "yep will do" — user, later in the thread: "sent it!" → fulfilled within the thread; not a commitment; output nothing.
- User: "could you grab the game tickets?" — Omar, later in the thread: "got them, here you go" → fulfilled within the thread; not a commitment; output nothing.

RESOLVE REFERENCES — use THREAD CONTEXT below:
- Each contact's recent messages (newest first, direction-labeled) are given. Use them to resolve "my list", "that place", "the doc" into what the thread is actually about.
- Example: "add a boot tray to my list" in a thread about Stanford dorm packing → "Add boot tray to the Stanford dorm packing list".
- If a reference CANNOT be resolved from the thread context ("find something" with nothing to anchor it), DROP the item entirely. A task nobody can act on is worse than no task.

RESOLVE DATES — use the DATE REFERENCE table below; never invent:
- The table is precomputed from each message's SENT date — take dates from it EXACTLY; never do weekday or month math yourself.
- A stated timeframe becomes due_at: "in <month>" → that month's mid anchor (the 15th); "early <month>" → the 05 anchor; "late <month>" → the 25 anchor; "next week" / a weekday → the exact date from the table.
- If the message states or implies NO timeframe, due_at MUST be null. NEVER default to the sent date or to today — a null due_at is correct and common.
- SAME-DAY SCOPE: a time-of-day or same-day marker with NO other date ("at 5:30", "by noon", "tonight", "this afternoon", "in an hour") refers to the message's SENT date, not to today. If that moment has already passed by now, the item is EXPIRED — output nothing for it. NEVER keep it as an undated task.
- PERSONAL ANCHORS: a reference to a named point in the USER's own life — "the start of school", "when school starts", "the beginning of the term", "move-in", "next semester" — resolves against the ABOUT THE USER block at the top of this prompt. "meetup at the start of school" gets that term-start date as due_at. If the block records no such date, leave due_at null; never guess one.

DEADLINE WINDOW — "on Thursday" and "any day up to Thursday" are different promises:
- "window_end" is the LAST day the work may happen; "flexible" says whether it may happen on ANY day up to it.
- A RANGE — "this week", "the rest of the week", "by Friday", "over the next few days", "whenever", "no rush", "it doesn't have to be today" — sets "window_end" to the last day of that range (from the table) and "flexible": true.
- A SPECIFIC day — "today", "tomorrow", "Thursday", a clock time — sets "window_end" to that day and "flexible": false. It happens that day; it does not move.
- No stated timeframe at all → "window_end": null, "flexible": false. Never invent a range.
- Window examples: "I could go through the advising stuff the rest of the week, it doesn't have to be today" → { "window_end": "<the coming Sunday from the table>", "flexible": true }. "the math test is today" → { "window_end": "<the sent day from the table>", "flexible": false }.

DIRECTION:
- "i_owe_them" when the USER owes the contact; "they_owe_me" when the contact owes the user.

REAL FAILURES — these exact snippets were wrongly turned into tasks before. They are NOT commitments; for input like these, output nothing:
- "do you want eggs?" (a question/offer)
- "Give cash to contact" (verbatim fragment; no named person, no agreement)
- "find something, call you" (chatter fragment; no concrete obligation)
- "find something" (unresolvable reference — nothing anyone can act on)
- "This is the health plan you can upload for approval. There are high chances they will decline the first time around" (an FYI about a document)
- "what do you wanna inquire about?" (a question)
- "looking at 345 Westwood Court on Google Maps" (a link/screenshot being discussed)
- "for our school it's a little different because for girls to come to our helco they have to have one of us take them…" (explanatory chatter)
- "I wanna be back here at 5:30 latest" (old logistics fragment)
- "be back here at 5:30 latest (sent yesterday)" (expired same-day instruction — not a commitment)

POSITIVE EXAMPLES (message → normalized headline):
- Sarah: "can you send me the deck by fri?" — user: "yep will do" → { "title": "Send Sarah the pitch deck", "direction": "i_owe_them", "due_at": "<that Friday from the table>", "kind": "task", "start_time": null }
- User to Omar: "I'll bring the cash for the tickets tomorrow" → { "title": "Bring Omar cash for the tickets", "direction": "i_owe_them", "due_at": "<the day after send>", "kind": "task", "start_time": null }
- Dev: "I'll send over the signed lease on Monday" → { "title": "Collect the signed lease from Dev", "direction": "they_owe_me", "due_at": "<that Monday from the table>", "kind": "task", "start_time": null }
- Mom-thread about Stanford dorm packing — user: "add a boot tray to my list" → { "title": "Add boot tray to the Stanford dorm packing list", "direction": "i_owe_them", "due_at": null, "kind": "task", "start_time": null }
- "dinner with Priya thursday 7pm" → { "title": "Dinner with Priya", "due_at": "<that Thursday from the table>", "kind": "event", "start_time": "19:00" }
- Thread agrees on a meetup "in late September" → due_at = that September's late anchor (the 25th) from the table.
- User: "I need about two hours to go through my Stanford academic advising stuff — I could do this the rest of the week, it doesn't have to be today" → { "title": "Go through Stanford academic advising", "direction": "i_owe_them", "due_at": "<the coming Sunday from the table>", "window_end": "<the same Sunday>", "flexible": true, "kind": "task", "start_time": null }

CONFIDENCE — be honest:
- 0.9+ only when the obligation is explicit and unambiguous in the text.
- Anything below 0.8 is held for human review instead of acted on — do not inflate.
- When unsure whether something is a commitment at all, OMIT it entirely. An empty array is a good and common answer.

DATE REFERENCE (precomputed — use these exact dates):
${dateReferenceLines(cands)}

THREAD CONTEXT (per contact, newest first):
${contextBlocks(contexts)}

SNIPPETS:
${numberedSnippets(cands, contexts)}

Return STRICT JSON ONLY — no prose, no markdown fences — an array (possibly empty), using the SAME n:
[{ "n": <number>, "title": "<rewritten imperative headline>", "direction": "i_owe_them" | "they_owe_me", "due_at": "<ISO date>" | null, "window_end": "<ISO date>" | null, "flexible": true | false, "kind": "task" | "event", "start_time": "<HH:MM>" | null, "confidence": <0-1> }]

Rules: only use n values from the list; do not invent facts or dates; never copy snippet text verbatim into title.`;
}

/**
 * Upsert on the semantic identity. A dedupe_key collision means the SAME commitment
 * arrived again (a second text saying the same thing, or a re-run): keep the higher
 * confidence — and with it that row's title/kind — and the earlier created_at, filling in
 * any due_at/start_time the original lacked. Rows with dedupe_key NULL never conflict.
 */
const insertCommitment = (db: Db) =>
  db.prepare(
    `INSERT INTO commitment (person_id, direction, description, due_at, status, source_interaction_id,
                             confidence, confirmed_by_user, dedupe_key, kind, start_time, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?, datetime('now'))
     ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
       description = CASE WHEN excluded.confidence > commitment.confidence THEN excluded.description ELSE commitment.description END,
       kind        = CASE WHEN excluded.confidence > commitment.confidence THEN excluded.kind        ELSE commitment.kind        END,
       direction   = CASE WHEN excluded.confidence > commitment.confidence THEN excluded.direction   ELSE commitment.direction   END,
       confidence  = MAX(commitment.confidence, excluded.confidence),
       due_at      = COALESCE(commitment.due_at, excluded.due_at),
       start_time  = COALESCE(commitment.start_time, excluded.start_time),
       created_at  = MIN(commitment.created_at, excluded.created_at)`
  );

/** One commitment about to be written, after normalization and before collapse. */
interface PendingCommitment {
  /** The candidate it came from — used to write that candidate's extraction_log verdict. */
  candidateN: number;
  personId: number | null;
  direction: CommitmentDirection;
  /** The AI headline (LLM path) or the raw fragment (deterministic fallback). */
  description: string;
  dueAt: string | null;
  kind: "task" | "event";
  startTime: string | null;
  sourceId: number;
  confidence: number;
  dedupeKey: string | null;
  /**
   * True only for rows written by the deterministic fallback because the LLM was
   * UNAVAILABLE (no client, a failed call, or unusable JSON from either query) — i.e. the
   * description is near-verbatim message text instead of a rewritten headline. These are
   * enqueued for main/backfill.ts to finish once the quota refills. A successful LLM call
   * that classified everything as not-a-commitment never sets this: nothing is inserted,
   * and the model's verdict is the answer, not an outage.
   */
  degraded?: boolean;
}

const joinText = (r: InteractionRow): string =>
  [r.subject, r.body_summary].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();

/** "HH:MM" (24h) or null — the model's start_time, defensively parsed. */
function parseStartTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? `${String(+m[1]).padStart(2, "0")}:${m[2]}` : null;
}

/**
 * Extract commitments from the given interactions in TWO fast-tier calls total (see the
 * module header): query 1 classifies the numbered candidates, query 2 normalizes the
 * survivors into headline titles + dates + task/event. On llm null, a call failure, or
 * unusable JSON from either query, the whole batch degrades to the deterministic followups
 * extractor (confidence capped at FALLBACK_CONFIDENCE, direction i_owe_them) — unchanged
 * behavior. Every candidate — LLM or fallback — must pass passesCommitmentGate before
 * insert, and every candidate gets an extraction_log row so its content is never sent to
 * the model again.
 *
 * Duplicate suppression: content-hash skip before the LLM (identical text, whether it is
 * the iMessage self-thread echo or the same task arriving twice), then dedupe_key collapse
 * inside the batch and again on insert. Sets interaction.extracted_at on every candidate so
 * re-runs skip. Returns counts; rows with confidence < REVIEW_CONFIDENCE are the review
 * queue (status 'open', confirmed_by_user 0).
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
       FROM interaction WHERE extracted_at IS NULL AND id IN (${interactionIds.map(() => "?").join(",")})
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(...interactionIds) as InteractionRow[];
  if (rows.length === 0) return { inserted: 0, needsReview: 0, processed: 0 };

  // ── phase 0: content-hash dedupe (no LLM involved) ────────────────────────
  // Anything whose normalized text was already decided — on an earlier run OR earlier in
  // this same batch — is marked extracted and never looked at again. This is the layer
  // that kills the duplicated self-texts.
  const candidates: Candidate[] = [];
  const handledIds: number[] = [];
  const seenThisRun = new Set<string>();
  for (const r of rows) {
    if (candidates.length >= CANDIDATE_CAP) break; // the rest wait for the next run
    const text = joinText(r);
    if (!text) {
      handledIds.push(r.id); // nothing to extract from an empty body
      continue;
    }
    const hash = contentHash(text);
    if (seenThisRun.has(hash) || contentSeen(db, hash)) {
      handledIds.push(r.id); // exact duplicate content — already decided
      continue;
    }
    seenThisRun.add(hash);
    candidates.push({ n: candidates.length + 1, row: r, text, hash });
  }
  handledIds.push(...candidates.map((c) => c.row.id));

  const markExtracted = db.prepare("UPDATE interaction SET extracted_at = datetime('now') WHERE id = ?");
  const markAll = db.transaction((ids: number[]) => ids.forEach((id) => markExtracted.run(id)));
  if (candidates.length === 0) {
    markAll(handledIds);
    return { inserted: 0, needsReview: 0, processed: handledIds.length };
  }

  // Per-person thread context (drafts.ts pattern), shared by both queries.
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

  // Thread-resolution reinforcement: messages in the same person's thread AFTER the source
  // message — if any of them fulfills/cancels the obligation, the candidate is dropped.
  const laterStmt = db.prepare(
    `SELECT subject, body_summary FROM interaction
     WHERE person_id = ? AND occurred_at > ? ORDER BY occurred_at ASC LIMIT 12`
  );
  const laterTexts = (personId: number | null, occurredAt: string | null): string[] =>
    personId == null || !occurredAt
      ? []
      : (laterStmt.all(personId, occurredAt) as { subject: string | null; body_summary: string | null }[])
          .map((r) => [r.subject, r.body_summary].filter(Boolean).join(" — "))
          .filter((t) => t.length > 0);

  const pending: PendingCommitment[] = [];
  let llmHandled = false;
  // Personal context (main/context.ts): who the user is, where they are, and the named
  // dates in their life. Carried by BOTH queries so "start of school" is resolvable text
  // rather than a phrase the model has to guess at.
  const about = contextBlock(db);
  // The free-text half of the same memory (main/preferences.ts). Read-only and best-effort:
  // this path takes no directory argument, and a missing/unreadable file must never stop an
  // extraction run — it just means there is nothing to say about how he likes things.
  let prefs = "";
  try {
    prefs = preferencesBlock(resolvePreferencesDir());
  } catch {
    /* no preferences file — extraction proceeds without it */
  }
  const now = new Date();

  if (llm) {
    // ── query 1 (ONE call): which candidates are commitments at all? ────────
    const res1 = await llm.call("commitments-classify", "fast", buildClassifyPrompt(candidates, contexts, about, prefs), {
      json: true,
    });
    let survivors: Candidate[] | null = null;
    const classifyConfidence = new Map<number, number>();
    if (res1) {
      try {
        const parsed = extractJson(res1.text);
        if (Array.isArray(parsed)) {
          const keep = new Set<number>();
          for (const item of parsed) {
            if (!item || typeof item !== "object") continue;
            const o = item as Record<string, unknown>;
            const n = Number(o.n);
            if (!Number.isFinite(n) || o.is_commitment !== true) continue;
            keep.add(n);
            const conf = Number(o.confidence);
            if (Number.isFinite(conf)) classifyConfidence.set(n, Math.min(1, Math.max(0, conf)));
          }
          survivors = candidates.filter((c) => keep.has(c.n));
        }
      } catch (e) {
        console.warn(`commitments: bad classify JSON, batch degrades (${(e as Error).message})`);
      }
    }

    if (survivors) {
      // A parsed classification IS the LLM's answer — an all-false verdict means the batch
      // held nothing, and the deterministic fallback must NOT override that.
      llmHandled = true;
      // Deterministic reinforcement before spending the second call: an obligation a later
      // message in the thread already fulfilled ("sent it") or cancelled ("nvm") is closed.
      survivors = survivors.filter((c) => !threadResolves(c.text, laterTexts(c.row.person_id, c.row.occurred_at)));

      if (survivors.length > 0) {
        // ── query 2 (ONE call): normalize survivors into headlines + dates ──
        const res2 = await llm.call("commitments-normalize", "fast", buildNormalizePrompt(survivors, contexts, about, prefs), {
          json: true,
        });
        let normalized = false;
        if (res2) {
          try {
            const parsed = extractJson(res2.text);
            if (Array.isArray(parsed)) {
              normalized = true;
              const byN = new Map(survivors.map((c) => [c.n, c]));
              for (const item of parsed) {
                if (!item || typeof item !== "object") continue;
                const o = item as Record<string, unknown>;
                const src = byN.get(Number(o.n));
                const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
                if (!src || !title) continue;
                // The gate runs on the AI HEADLINE (never on the raw snippet — raw messages
                // are questions and first-person chatter by nature). Questions, quotes,
                // FYIs and contentless stubs never land no matter what the model said.
                if (!passesCommitmentGate(title)) continue;
                const direction: CommitmentDirection = o.direction === "they_owe_me" ? "they_owe_me" : "i_owe_them";
                const kind = o.kind === "event" ? "event" : "task";
                const startTime = kind === "event" ? parseStartTime(o.start_time) : null;
                const confRaw = Number(o.confidence);
                const confidence = Number.isFinite(confRaw)
                  ? Math.min(1, Math.max(0, confRaw))
                  : classifyConfidence.get(src.n) ?? 0.5;
                let dueAt = typeof o.due_at === "string" && o.due_at ? o.due_at.slice(0, 10) : null;
                // ── deadline window (owner report 2026-08-06) ──
                //
                // "I could do this the rest of the week, it doesn't have to be today" used to
                // leave due_at null, because none of the date rules above recognise a RANGE —
                // only a day. So work he had explicitly given himself a week for arrived
                // undated, and every surface that sorts by due_at treated it as "someday".
                //
                // A flexible range has one honest due date: the LAST day of the range. The
                // model states it; when it does not, the sent-date-anchored deterministic
                // reader (engine/parse.ts parseWindow) does — the same rules the braindump
                // parser uses, so one sentence means the same thing on both surfaces.
                const win = parseWindow(
                  src.text,
                  (src.row.occurred_at ?? now.toISOString()).slice(0, 10)
                );
                const modelEnd =
                  typeof o.window_end === "string" && /^\d{4}-\d{2}-\d{2}/.test(o.window_end)
                    ? o.window_end.slice(0, 10)
                    : null;
                const windowEnd = o.flexible === true && modelEnd ? modelEnd : win.flexible ? win.windowEnd : null;
                if (!dueAt && windowEnd) dueAt = windowEnd;
                if (!dueAt) {
                  // Named-date cross-check (main/context.ts): the model left this undated,
                  // but the text points at a named moment in the USER's own life — "meetup
                  // at the start of school". Resolve it against their date anchors. Null
                  // when nothing matches, which leaves the existing paths untouched.
                  dueAt = resolveNamedDate(db, `${title} ${src.text}`, now);
                }
                if (!dueAt && src.row.occurred_at) {
                  // Deterministic cross-check (crm/when.ts): the model gave no due date, but
                  // the message itself states one, anchored to its SENT date. Only a date
                  // still in the future is attached — a stale "next Friday" from months ago
                  // must not schedule anything.
                  const anchor = new Date(src.row.occurred_at);
                  const when = !Number.isNaN(anchor.getTime()) ? parseWhen(src.text, anchor) : null;
                  if (when && when.getTime() > Date.now()) dueAt = when.toISOString().slice(0, 10);
                  // Same-day backstop: an item still undated here whose only temporal
                  // reference is a time-of-day / same-day marker was scoped to its message's
                  // SENT date — if that moment has passed, drop it entirely. Items the model
                  // dated (explicit future date) never reach this check.
                  if (!dueAt && !Number.isNaN(anchor.getTime()) && isExpiredSameDay(`${title} — ${src.text}`, anchor)) {
                    continue;
                  }
                }
                pending.push({
                  candidateN: src.n,
                  personId: src.row.person_id,
                  direction,
                  description: title,
                  dueAt,
                  kind,
                  startTime,
                  sourceId: src.row.id,
                  confidence,
                  dedupeKey: dedupeKeyFor(title, src.row.person_id, dueAt),
                });
              }
            }
          } catch (e) {
            console.warn(`commitments: bad normalize JSON, batch degrades (${(e as Error).message})`);
          }
        }
        // The second call failing means we have no titles at all — degrade the whole batch
        // to the deterministic path rather than inserting raw snippets.
        if (!normalized) {
          llmHandled = false;
          pending.length = 0;
        }
      }
    }
  }

  if (!llmHandled) {
    // Deterministic fallback (unchanged behavior): each candidate's text runs through the
    // follow-up extractor, capped at FALLBACK_CONFIDENCE so it can never auto-convert.
    // Reaching here means the LLM was UNAVAILABLE (no client, a failed call, or unusable
    // JSON) — every row written below is unfinished work, flagged `degraded` so it can be
    // rewritten when credits come back (main/backfill.ts).
    for (const c of candidates) {
      if (!c.row.occurred_at) continue;
      const proposals = extractFollowups(db, c.row.person_id, [
        { text: c.text, sentAt: c.row.occurred_at, direction: c.row.direction },
      ]);
      for (const p of proposals) {
        if (!passesCommitmentGate(p.description)) continue; // same gate as the LLM path
        if (threadResolves(p.description, laterTexts(c.row.person_id, c.row.occurred_at))) continue;
        if (isExpiredSameDay(`${p.description} — ${c.text}`, new Date(c.row.occurred_at))) continue;
        pending.push({
          candidateN: c.n,
          personId: c.row.person_id,
          direction: "i_owe_them",
          description: p.description,
          dueAt: p.dueAt,
          kind: "task",
          startTime: null,
          sourceId: c.row.id,
          confidence: FALLBACK_CONFIDENCE,
          dedupeKey: dedupeKeyFor(p.description, c.row.person_id, p.dueAt),
          degraded: true,
        });
      }
    }
  }

  // ── batch-internal collapse: the same thing from two messages is ONE row ──
  const survivorsByKey = new Map<string, PendingCommitment>();
  const finals: PendingCommitment[] = [];
  const producedCommitment = new Set<number>();
  for (const p of pending) {
    producedCommitment.add(p.candidateN);
    if (!p.dedupeKey) {
      finals.push(p);
      continue;
    }
    const prev = survivorsByKey.get(p.dedupeKey);
    if (!prev) {
      survivorsByKey.set(p.dedupeKey, p);
      finals.push(p);
      continue;
    }
    // Merge into the row already claiming this key: better title/kind win with confidence,
    // and any date the first one lacked is filled in.
    if (p.confidence > prev.confidence) {
      prev.description = p.description;
      prev.kind = p.kind;
      prev.direction = p.direction;
      prev.confidence = p.confidence;
    }
    prev.dueAt = prev.dueAt ?? p.dueAt;
    prev.startTime = prev.startTime ?? p.startTime;
    prev.degraded = prev.degraded || p.degraded; // one degraded source degrades the survivor
  }

  // ── insert (cross-run collapse happens in the ON CONFLICT clause) ─────────
  const ins = insertCommitment(db);
  const existing = db.prepare("SELECT id FROM commitment WHERE dedupe_key = ?");
  let inserted = 0;
  let needsReview = 0;
  let merged = 0;
  for (const p of finals) {
    // Captured BEFORE the upsert: on the conflict path lastInsertRowid does not move, so
    // the pre-existing row's id is the only handle on what the write actually touched.
    const prior = p.dedupeKey ? (existing.get(p.dedupeKey) as { id: number } | undefined) : undefined;
    const info = ins.run(
      p.personId,
      p.direction,
      p.description,
      p.dueAt,
      p.sourceId,
      p.confidence,
      p.dedupeKey,
      p.kind,
      p.startTime
    );
    const rowId = prior ? prior.id : Number(info.lastInsertRowid);
    if (p.degraded && rowId > 0) {
      // Unfinished work: the description is a raw fragment because the model was down.
      // Queued for the backfill sweep, which rewrites it the moment quota is back.
      markDegraded(db, "commitment", rowId, "llm_unavailable");
    }
    if (prior) {
      merged++; // an existing commitment absorbed this one — no new row
      continue;
    }
    inserted++;
    if (p.confidence < REVIEW_CONFIDENCE) needsReview++;
  }

  // Every candidate is logged, so identical content is never sent to the model again.
  for (const c of candidates) {
    logExtraction(db, c.row.id, c.hash, producedCommitment.has(c.n) ? "commitment" : "rejected");
  }
  markAll(handledIds);

  if (merged > 0 || pending.length !== finals.length) {
    console.log(
      `commitments: collapsed ${pending.length - finals.length} in-batch duplicate(s), ${merged} into existing commitment(s)`
    );
  }
  return { inserted, needsReview, processed: handledIds.length };
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

// ── recency: why undated commitments nag forever ─────────────────────────────
//
// Owner report 2026-08-06: "I was looking through the commitments on the relationships page,
// and it was suggesting commitments that are from messages that are weeks old… obviously it's
// better to have a false positive than stuff I'm not sure about, but it's kind of annoying."
//
// Looking at his actual table explained it better than the complaint did: EVERY open
// commitment had `due_at` NULL. Nine of the fourteen were inherited from the PersonalCRM2
// migration and have no source message in POS at all — nothing has ever evidenced them here,
// and the migration did not preserve their original dates, so `created_at` is the migration
// timestamp and says nothing about their age.
//
// An undated commitment can never become a calendar block. It has no day to be scheduled on,
// so it cannot be done, cannot age out, and cannot do anything except appear on the list
// again tomorrow. That is the whole mechanism of the annoyance, and it is a missing DATE, not
// a missing filter.
//
// Two answers, in this order:
//   1. rehydrateCommitmentDates — many of them state their own timing ("Reconnect in
//      September", "Meet up at start of school"). Read it and write it down; the commitment
//      then surfaces when it is actually relevant instead of every morning until then.
//   2. Everything still undated is separated rather than deleted. `stale` marks the ones with
//      no recent evidence, so a surface can keep them one disclosure away instead of mixed in
//      with live work. Nothing is dropped — he was explicit that he would rather see a false
//      positive than lose something real.

/** Undated with no evidence for this long → not worth raising unprompted. */
export const COMMITMENT_STALE_DAYS = 30;

/**
 * When a message was actually sent, from whatever `interaction.occurred_at` happens to hold.
 *
 * That column carries TWO shapes: SQLite's own `datetime()` output ("2026-08-05 07:33:09",
 * UTC, no zone marker) and full ISO from the connectors ("2026-08-05T02:05:58.617Z"). A first
 * pass here normalised the first shape by appending "Z" and corrupted the second into
 * "…617ZZ" — an invalid Date that silently fell back to "now", which is precisely the bug
 * this anchor exists to prevent. Caught on his live data: a commitment from a message sent on
 * the 5th was dated the 7th.
 *
 * Null for anything unparseable, so the caller decides the fallback rather than inheriting a
 * silently wrong instant.
 */
export function messageInstant(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // Already zoned (ISO with Z or ±hh:mm) → trust it verbatim.
  const direct = new Date(s);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && !Number.isNaN(direct.getTime())) return direct;
  // Bare "YYYY-MM-DD HH:MM:SS" (or with a T): SQLite writes these in UTC.
  const utc = new Date(`${s.replace(" ", "T")}Z`);
  if (!Number.isNaN(utc.getTime())) return utc;
  return Number.isNaN(direct.getTime()) ? null : direct;
}

export interface CommitmentRowWithAge extends CommitmentRow {
  /** When this obligation was last evidenced: its source message, else its creation. */
  evidence_at: string | null;
  /** No source interaction — inherited from the PersonalCRM2 migration, unevidenced in POS. */
  inherited: boolean;
  /** Undated AND unevidenced recently. Real, but not something to raise today. */
  stale: boolean;
}

/**
 * Commitments, optionally filtered by status; due-dated first (soonest), then undated.
 * Each row carries its freshness so a surface can group rather than filter — see above.
 */
export function listCommitments(db: Db, status?: string, now: Date = new Date()): CommitmentRowWithAge[] {
  const where = status ? "WHERE c.status = ?" : "";
  const args = status ? [status] : [];
  const rows = db
    .prepare(
      `SELECT c.*, i.occurred_at AS source_occurred_at
         FROM commitment c
         LEFT JOIN interaction i ON i.id = c.source_interaction_id
         ${where}
        ORDER BY c.due_at IS NULL, c.due_at ASC, c.created_at DESC`
    )
    .all(...args) as (CommitmentRow & { source_occurred_at: string | null })[];

  const cutoff = new Date(now.getTime() - COMMITMENT_STALE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return rows.map(({ source_occurred_at, ...c }) => {
    const inherited = c.source_interaction_id == null;
    const evidence_at = source_occurred_at ?? c.created_at ?? null;
    // A dated commitment is never stale: it has a day, so it will surface on its own terms.
    // An inherited one is stale on sight — nothing in POS has ever evidenced it.
    const stale =
      !c.due_at && (inherited || (evidence_at ?? "").slice(0, 10) < cutoff);
    return { ...c, evidence_at, inherited, stale };
  });
}

/**
 * Give undated open commitments the date their own text already states.
 *
 * "Reconnect in September" and "Meet up at start of school" are not vague — they name a time,
 * and POS can resolve both (parseWhen for calendar language, resolveNamedDate for the
 * personal anchors like his school term). Writing the date down is what moves a commitment
 * out of the permanent-nag state into something that surfaces once, when it matters.
 *
 * Deliberately conservative: only fills a NULL due_at, never overwrites one, and never
 * invents a date for text that names none. Returns how many were dated.
 */
export function rehydrateCommitmentDates(db: Db, now: Date = new Date()): number {
  const rows = db
    .prepare(
      `SELECT c.id, c.description, i.occurred_at AS source_occurred_at
         FROM commitment c
         LEFT JOIN interaction i ON i.id = c.source_interaction_id
        WHERE c.status = 'open' AND c.due_at IS NULL`
    )
    .all() as { id: number; description: string; source_occurred_at: string | null }[];
  if (rows.length === 0) return 0;

  const set = db.prepare("UPDATE commitment SET due_at = ? WHERE id = ? AND due_at IS NULL");
  const today = localDateISO(now);
  let dated = 0;
  for (const r of rows) {
    // ANCHOR ON THE MESSAGE, not on today. "Tomorrow" in a text sent on the 5th means the
    // 6th, forever — resolving it against the current date silently walks the deadline
    // forward one day for every day it stays open, which is the exact opposite of a deadline.
    // (Caught by a dry run over his live data: a commitment from a message sent 2026-08-05
    // was being dated 2026-08-07.) crm/when.ts is built for this: its whole contract is
    // "resolve relative language against the moment it was written".
    const base = messageInstant(r.source_occurred_at) ?? now;
    // The personal anchors first: "start of school" is a date POS knows and parseWhen does not.
    const named = resolveNamedDate(db, r.description, base);
    const when = named ?? (parseWhen(r.description, base)?.toISOString().slice(0, 10) ?? null);
    // A resolved date in the past means the text named a moment that has already gone by;
    // dating it backwards would make it instantly overdue rather than answered.
    if (!when || when < today) continue;
    set.run(when, r.id);
    dated++;
  }
  if (dated > 0) console.log(`commitments: dated ${dated} undated commitment(s) from their own text`);
  return dated;
}
