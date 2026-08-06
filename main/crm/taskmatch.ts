// Recognising that a task and a calendar event are the SAME commitment.
//
// Owner ask 2026-08-06: "the app should be able to look at my google task list and allot time
// in my calendar for it. but beware alot of times there might be duplicates that are worded
// very differently. like i might have scheduled a google task and also added a calendar event,
// so the system should be able to relate those two. but the end goal is that the tasks and
// calendar events match eachother."
//
// His own screenshot is the case: a Google Task "Take math diagnostic" sitting above a
// calendar that separately holds "Take Stanford math test". One obligation, two records,
// no shared id — because they were created in different apps on different days.
//
// The rule this module encodes: LINK, never merge. A link says "these are the same thing", so
// the planner stops allotting a second block for work that is already on the calendar, and
// both records keep their own identity in the system that owns them. Merging would mean
// deleting one of his records on a guess, and a wrong guess is unrecoverable.
//
// Matching is deterministic and local — no LLM. A model would be better at "diagnostic" vs
// "test", but it would also be a per-item call on a list that syncs every 15 minutes, and it
// could not be audited when it was wrong. This is a scored heuristic with an explicit
// confidence, and anything below CONFIRM_AT is proposed for review rather than acted on.

/** Words that carry no identifying signal — dropping them is what lets wording differ. */
const STOP = new Set([
  "a", "an", "the", "to", "for", "of", "on", "at", "in", "with", "and", "or", "my", "me",
  "i", "is", "are", "be", "do", "does", "get", "got", "go", "going", "some", "any", "this",
  "that", "it", "up", "out", "about", "from", "by", "into", "over", "make", "take", "have",
]);

/** Tokens that identify the work: lowercase, punctuation-free, stopwords removed. */
export function contentTokens(title: string): string[] {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Character bigrams of a token — how "diagnostic" and "diagnostics" stay close. */
function bigrams(word: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
  return out;
}

/** Dice coefficient over character bigrams: 1 = identical, 0 = nothing shared. */
export function fuzzyWordScore(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** A word in `b` counts as present when some word matches it closely enough. */
const NEAR = 0.7;

/**
 * How alike two titles are, 0..1.
 *
 * Asymmetric on purpose: the score is "how much of the SHORTER title is accounted for by the
 * longer one". "Math diagnostic" against "Take Stanford math test 2h" should score on the two
 * words that matter, not be punished for the longer title carrying more detail — which is
 * exactly the shape his duplicates take, since a calendar event is usually more verbose than
 * the task that spawned it.
 */
export function titleSimilarity(a: string, b: string): number {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (A.length === 0 || B.length === 0) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  let hits = 0;
  for (const w of short) {
    if (long.some((x) => fuzzyWordScore(w, x) >= NEAR)) hits++;
  }
  return hits / short.length;
}

export interface MatchCandidate {
  taskId: number;
  taskTitle: string;
  /** Google's event id — the calendar side of the link. */
  eventId: string;
  eventTitle: string;
  /** 0..1. */
  score: number;
}

/**
 * Act on a link at or above this. Two independent signals have to agree to reach it: the
 * titles overlap almost completely, or they overlap well AND land on the same day.
 */
export const CONFIRM_AT = 0.8;
/** Below this, not worth showing him at all — the noise would be worse than the miss. */
export const PROPOSE_AT = 0.5;

export interface TaskLike {
  id: number;
  title: string;
  /** ISO date the task is planned for, or null. */
  planDate?: string | null;
}

export interface EventLike {
  /** Google event id. */
  id: string;
  title: string;
  /** ISO date the event falls on. */
  date: string;
}

/**
 * Score one task against one event. Same-day is a real signal but never sufficient on its
 * own — his calendar has several unrelated things per day, and "same day" plus "vaguely
 * similar" is how you merge a dentist appointment into a maths test.
 */
export function scoreMatch(task: TaskLike, event: EventLike): number {
  const text = titleSimilarity(task.title, event.title);
  if (text < 0.34) return 0; // nothing meaningful in common; the date cannot rescue it
  const sameDay = task.planDate != null && task.planDate === event.date;
  // A same-day pair is worth a bounded nudge, not a free pass.
  return Math.min(1, sameDay ? text + 0.15 : text);
}

/**
 * Best event for each task, above PROPOSE_AT. One event may only claim one task and vice
 * versa — a greedy pass over the highest scores first, so the strongest pairing wins rather
 * than whichever happened to be iterated first.
 */
export function proposeLinks(tasks: TaskLike[], events: EventLike[]): MatchCandidate[] {
  const scored: MatchCandidate[] = [];
  for (const t of tasks) {
    for (const e of events) {
      const score = scoreMatch(t, e);
      if (score >= PROPOSE_AT) {
        scored.push({ taskId: t.id, taskTitle: t.title, eventId: e.id, eventTitle: e.title, score });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score || x.taskId - y.taskId || x.eventId.localeCompare(y.eventId));
  const takenTasks = new Set<number>();
  const takenEvents = new Set<string>();
  const out: MatchCandidate[] = [];
  for (const c of scored) {
    if (takenTasks.has(c.taskId) || takenEvents.has(c.eventId)) continue;
    takenTasks.add(c.taskId);
    takenEvents.add(c.eventId);
    out.push(c);
  }
  return out;
}
