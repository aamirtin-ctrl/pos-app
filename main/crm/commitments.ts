// Commitment extraction — the join between conversation and obligation. New module (no
// direct PersonalCRM2 ancestor): LLM fast-tier extraction over interaction batches with a
// deterministic fallback (followups.ts) when the LLM is unavailable. Rows land in the
// `commitment` table unconfirmed; confidence < 0.7 is the review queue.
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
//      workers.autoTentativeTasks — they land in the review queue instead.
//   5. Thread-resolution awareness (owner spec 2026-08-05 #3): something resolved IN
//      the message chain must not live on as an open commitment. The prompt closes
//      ask→fulfilled/cancelled pairs at extraction time, and threadResolves() — a
//      conservative keyword check over LATER messages in the same person's thread —
//      deterministically reinforces it on BOTH the LLM and fallback paths. The
//      post-hoc layer (workers.resolveFromThreads) closes already-open commitments
//      when NEW messages resolve them.

import type { Db } from "../db/db.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";
import { extractFollowups } from "./followups.ts";
import { parseWhen } from "./when.ts";

export const REVIEW_CONFIDENCE = 0.7;
/** Deterministic-fallback rows are raw message fragments, never rewrites — cap them here. */
export const FALLBACK_CONFIDENCE = 0.5;
const BATCH_SIZE = 20;

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
}

interface InteractionRow {
  id: number;
  person_id: number;
  direction: string | null;
  occurred_at: string | null;
  subject: string | null;
  body_summary: string | null;
}

/** Per-person thread context fed to the prompt (the drafts.ts pattern). */
interface PersonContext {
  name: string | null;
  recent: { direction: string | null; occurred_at: string | null; subject: string | null; body_summary: string | null }[];
}

/** Recent interactions per person in the batch, direction-labeled, newest first. */
export const CONTEXT_INTERACTIONS = 6;

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

function buildPrompt(rows: InteractionRow[], contexts: Map<number, PersonContext>): string {
  const records = rows.map((r) => ({
    interaction_id: r.id,
    person_id: r.person_id,
    direction: r.direction,
    occurred_at: r.occurred_at,
    subject: r.subject,
    body: r.body_summary,
  }));

  // One date-reference line per distinct sent DATE in the batch (msgplans technique).
  const seenDates = new Set<string>();
  const dateRefLines: string[] = [];
  for (const r of rows) {
    const iso = (r.occurred_at ?? "").slice(0, 10);
    if (!iso || seenDates.has(iso)) continue;
    seenDates.add(iso);
    const anchor = new Date(r.occurred_at!);
    if (Number.isNaN(anchor.getTime())) continue;
    dateRefLines.push(`- messages sent ${iso}: ${buildAnchoredDateReference(anchor)}`);
  }

  // Per-person thread context, drafts.ts-style: last few interactions, direction-labeled.
  const contextBlocks: string[] = [];
  for (const [personId, ctx] of contexts) {
    const lines = ctx.recent.map((h) =>
      `  [${h.direction ?? "?"} ${clip(h.occurred_at, 10)}] ${clip([h.subject, h.body_summary].filter(Boolean).join(" — "), 160)}`
    );
    contextBlocks.push(`${ctx.name ?? "Unknown contact"} (person_id ${personId}):\n${lines.join("\n")}`);
  }

  return `Extract real commitments from these interactions between the user and their contacts, and REWRITE each one as a clean imperative task, resolving references and dates from the context below.

WHAT COUNTS AS A COMMITMENT — every one of these must hold:
- A concrete action the USER owes a contact ("i_owe_them") or a contact owes the user ("they_owe_me").
- Someone actually agreed or promised to do it — not merely mentioned, offered, suggested, or asked about it.
- It can be stated as a short imperative phrase a person would put on a to-do list.

NEVER commitments — extract nothing for these:
- Questions of any kind ("do you want…", "what time…", "can you…?" that was never answered).
- Offers and invitations that were not accepted.
- Status updates, FYIs, opinions, links, screenshots, addresses, or things merely being discussed.
- Explanatory chatter about how something works ("for our school it's a little different because…").
- Old logistics fragments about a moment already past ("I wanna be back here at 5:30 latest").
- Other people's plans or chatter that create no obligation involving the user.

THREAD RESOLUTION — something resolved IN the message chain is CLOSED; extract nothing:
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

REWRITE — never quote:
- "description" MUST be a rewritten imperative task phrase, NOT a copied message fragment.
- Start with a verb. Name who it involves and what it is for whenever the thread makes that clear. Keep it under 120 characters.
- Write "Bring cash for <person>", never "Give cash to contact". Never leave second-person fragments like "call you" or "you can upload".

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

POSITIVE EXAMPLES (message → rewritten task):
- Sarah: "can you send me the deck by fri?" — user: "yep will do" → { "description": "Send Sarah the pitch deck", "direction": "i_owe_them", "due_at": "<that Friday from the table>" }
- User to Omar: "I'll bring the cash for the tickets tomorrow" → { "description": "Bring Omar cash for the tickets", "direction": "i_owe_them", "due_at": "<the day after send>" }
- Dev: "I'll send over the signed lease on Monday" → { "description": "Collect the signed lease from Dev", "direction": "they_owe_me", "due_at": "<that Monday from the table>" }
- Mom-thread about Stanford dorm packing — user: "add a boot tray to my list" → { "description": "Add boot tray to the Stanford dorm packing list", "direction": "i_owe_them", "due_at": null }
- Thread agrees on a meetup "in late September" → due_at = that September's late anchor (the 25th) from the table.

CONFIDENCE — be honest:
- 0.9+ only when the obligation is explicit and unambiguous in the text.
- Anything below 0.8 is held for human review instead of acted on — do not inflate.
- When unsure whether something is a commitment at all, OMIT it entirely. An empty array is a good and common answer.

DATE REFERENCE (precomputed — use these exact dates):
${dateRefLines.join("\n") || "- (no dated messages in this batch)"}

THREAD CONTEXT (per contact, newest first):
${contextBlocks.join("\n") || "(none)"}

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
  const nameStmt = db.prepare("SELECT display_name FROM person WHERE id = ?");
  const recentStmt = db.prepare(
    `SELECT direction, occurred_at, subject, body_summary FROM interaction
     WHERE person_id = ? ORDER BY occurred_at DESC LIMIT ${CONTEXT_INTERACTIONS}`
  );
  // Thread-resolution reinforcement: messages in the same person's thread AFTER the
  // source message — if any of them fulfills/cancels the obligation (threadResolves),
  // the candidate is dropped on both paths.
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
  let inserted = 0;
  let needsReview = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    let extracted = false;

    if (llm) {
      // Per-person thread context (drafts.ts pattern) so references resolve.
      const contexts = new Map<number, PersonContext>();
      for (const r of batch) {
        if (r.person_id == null || contexts.has(r.person_id)) continue;
        const person = nameStmt.get(r.person_id) as { display_name: string | null } | undefined;
        contexts.set(r.person_id, {
          name: person?.display_name ?? null,
          recent: recentStmt.all(r.person_id) as PersonContext["recent"],
        });
      }
      const res = await llm.call("commitments", "fast", buildPrompt(batch, contexts), { json: true });
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
              let dueAt = typeof o.due_at === "string" && o.due_at ? o.due_at : null;
              const confRaw = Number(o.confidence);
              const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0.5;
              if (!src || !description) continue;
              if (!passesCommitmentGate(description)) continue; // questions/quotes/FYIs never land
              // Thread-resolution reinforcement: a later message in the same thread
              // that fulfills ("sent it") or cancels ("nvm") the obligation means it
              // is CLOSED — never inserted, regardless of what the model said.
              if (threadResolves(description, laterTexts(src.person_id, src.occurred_at))) continue;
              // Deterministic cross-check (crm/when.ts): the model gave no due date, but
              // the message itself states one, anchored to its SENT date. Only a date
              // still in the future is attached — a stale "next Friday" from months ago
              // must not schedule anything.
              if (!dueAt && src.occurred_at) {
                const text = [src.subject, src.body_summary].filter(Boolean).join(" — ");
                const anchor = new Date(src.occurred_at);
                const when = text && !Number.isNaN(anchor.getTime()) ? parseWhen(text, anchor) : null;
                if (when && when.getTime() > Date.now()) dueAt = when.toISOString().slice(0, 10);
                // Same-day backstop: an item still undated here whose only temporal
                // reference is a time-of-day / same-day marker was scoped to its
                // message's SENT date — if that moment has passed, drop it entirely.
                // Items the model dated (explicit future date) never reach this check.
                if (
                  !dueAt &&
                  !Number.isNaN(anchor.getTime()) &&
                  isExpiredSameDay([description, text].filter(Boolean).join(" — "), anchor)
                ) {
                  continue;
                }
              }
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
          // Thread-resolution reinforcement, same as the LLM path: an obligation a
          // later message already fulfilled or cancelled never reaches the queue.
          if (threadResolves(p.description, laterTexts(r.person_id, r.occurred_at))) continue;
          // Same-day backstop, same as the LLM path: an expired "at 5:30"/"tonight"
          // fragment never reaches the review queue. (A text with an explicit
          // other-day date makes isExpiredSameDay return false, so dated proposals
          // are untouched.)
          if (isExpiredSameDay([p.description, text].join(" — "), new Date(r.occurred_at))) continue;
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
