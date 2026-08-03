// Deterministic follow-up extraction from MESSAGE text — no LLM. Ported from PersonalCRM2
// lib/message-followups.ts + lib/action-items.ts (CUES/hasActionCue). The pure detection
// logic is byte-identical; only the output changed: instead of writing Contact.followUp we
// return proposed commitments for the caller (commitments.ts fallback path, review UI).
//
// Each message has a sent date, so a relative phrase ("lunch next Friday") resolves against
// THAT date and is then checked against today: anything that already happened is dropped, so
// we never resurface a past plan as "due".

import type { Db } from "../db/db.ts";
import { parseWhen } from "./when.ts";

const DAY = 86_400_000;
const RECENCY_DAYS = 45; // an undated action item only counts if the message itself is recent
const ANCHOR_RECENCY_DAYS = 30; // a dated plan is only "live" if the message proposing it is recent;
//                                older asks ("send me the dates" from April) are assumed resolved.

// ── Action cues (ported from lib/action-items.ts) ───────────────────────────
// Strong action cues — phrases that signal a thing to DO (kept tight to avoid flagging bios).
export const CUES = [
  "follow up", "follow-up", "followup", "reach out", "circle back", "check in", "check-in",
  "touch base", "get back to", "ping", "remind", "schedule", "set up a", "book a", "send",
  "email", "call", "text", "meet", "meetup", "meet up", "grab lunch", "grab coffee", "grab a",
  "wanna grab", "want to grab", "lunch", "coffee", "dinner", "drinks", "hang out", "catch up",
  "link up", "intro", "introduce", "connect", "next step", "to-do", "todo", "action item",
  "ask about", "loop in", "set a time", "let's do", "let's meet", "see you",
];

/** Whether the text contains any action cue. */
export function hasActionCue(text: string | null | undefined): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  return CUES.some((c) => low.includes(c));
}

// Retrospective reports and present-tense status updates are NOT future follow-ups, even if they
// mention a date or a topic word. "I sent the email" / "I'm in a meeting" / "thanks for lunch" all
// describe something done or happening now — not something to follow up on.
const RETRO_OR_STATUS =
  /\b(i (sent|emailed|called|texted|messaged|submitted|finished|paid|already|went|did)\b|i'?m (in a meeting|on a call|busy|here|home|driving|at\b)|in a meeting with|thanks?\s+for\b|thank you\b|was (great|nice|fun|good)\b|great (call|chat|talk|meeting|seeing you)|nice (to meet|meeting|talking|to see))/i;

// Pasted plans/notes and recurring cadences aren't discrete, conversational follow-ups — they're
// reference material or standing agreements (e.g. "Timeline: …", "Daily check-ins").
const NOT_A_PLAN = /(\b(timeline|agenda|roadmap)\s*:)|\b(daily|weekly|bi-?weekly|monthly)\s+check-?ins?\b/i;

// Forward-looking INTENT — the message proposes doing something. This is stricter than a topic
// cue ("lunch"/"call"), so casual or retrospective mentions ("thanks for lunch", "great call")
// don't get flagged. An undated follow-up requires one of these.
const INTENT = [
  "let's", "lets ", "we should", "we need to", "we could", "we'll", "i'll", "i will",
  "i'd love to", "would love to", "wanna", "want to", "do you want", "do you wanna",
  "are you free", "you free", "you around", "you down", "down to", "let me know",
  "follow up", "follow-up", "circle back", "reach out", "touch base", "get back to you",
  "set up a", "set a time", "find a time", "schedule", "book a", "grab ", "meet up", "meetup",
  "catch up", "hop on", "jump on", "get on a call", "when are you", "what time works",
  "looking forward", "i'll send", "send you", "i'll call", "let's hop", "let's chat",
  "let's connect", "let's grab", "let's meet", "ping me", "shoot me",
];
const hasIntent = (low: string) => INTENT.some((p) => low.includes(p));

// Automated / transactional texts are never personal follow-ups (appointment reminders, OTPs,
// shipping, "do not reply"…). Filtering these removes a whole class of false positives.
const AUTOMATED =
  /\b(do ?not reply|don'?t reply|reply (stop|help|yes|y to)|your (code|otp|verification|appointment|order|account|payment)|verification code|appointment (with|at|reminder|confirmed)|confirm your|automated|no-?reply|has shipped|your package|invoice|due date|past due|balance|premier health|clinic|pharmacy|refill)\b/i;

function midnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function clean(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 120).replace(/\s+\S*$/, "") + "…" : t;
}

export interface MessageFollowUp {
  text: string; // stored follow-up text; an ISO date is baked in when resolved
  dueDate: Date | null;
  isDue: boolean; // dueDate is today-or-earlier-but-not-past (i.e. == today)
}

/**
 * Detect a live follow-up in one message. `messageDate` = when it was sent; `now` = today.
 * Returns null when there's no action cue, when a resolved date is already in the past, or
 * when an undated action item came from a message older than the recency window.
 */
export function detectMessageFollowUp(
  text: string | null | undefined,
  messageDate: Date,
  now: Date
): MessageFollowUp | null {
  if (!text) return null;
  // iMessage tapback reactions ("Liked …", "Loved …") aren't plans — skip them.
  if (/^\s*(liked|loved|laughed at|disliked|emphasi[sz]ed|questioned)\s+["“]/i.test(text)) return null;

  const low = text.toLowerCase();
  if (AUTOMATED.test(low)) return null; // appointment reminders, OTPs, etc. aren't follow-ups
  if (RETRO_OR_STATUS.test(low) || NOT_A_PLAN.test(low)) return null; // retrospective/status/notes
  const intent = hasIntent(low);
  const cue = hasActionCue(text);
  if (!intent && !cue) return null;

  const today = midnight(now);
  const due = parseWhen(text, messageDate);

  if (due) {
    if (due.getTime() < today.getTime()) return null; // the plan already passed
    // A future date alone isn't a follow-up; it needs an intent or a real action cue.
    if (!intent && !cue) return null;
    return { text: `${clean(text)} (due ${iso(due)})`, dueDate: due, isDue: due.getTime() === today.getTime() };
  }

  // No explicit date → require a real forward INTENT (not just a topic word), and recency.
  if (!intent) return null;
  const ageDays = (today.getTime() - midnight(messageDate).getTime()) / DAY;
  if (ageDays > RECENCY_DAYS) return null;
  return { text: clean(text), dueDate: null, isDue: false };
}

// ── Conversation-context resolution ─────────────────────────────────────────
// A single text rarely holds the whole plan, so we read a window around an anchor (the
// message proposing a plan) within the same texting SESSION, gather candidate dates, and pick
// the one that was confirmed (latest confirmed wins; a cancellation drops it).

const SESSION_GAP_MS = 6 * 3_600_000; // texts >6h apart start a new session

const CONFIRM = [
  "works", "sounds good", "sounds great", "sounds perfect", "perfect", "see you then",
  "see you there", "see u then", "confirmed", "deal", "let's do it", "lets do it",
  "that works", "works for me", "i'm in", "im in", "down for", "yep", "yup", "yes",
  "see you", "let's go", "i'll be there", "ill be there", "👍", "✅",
];
const DECLINE = [
  "can't", "cant ", "cannot", "won't work", "wont work", "no can do", "rain check",
  "reschedule", "busy that", "busy then", "not free", "another time", "can't make it",
  "cant make it", "have to cancel", "gotta cancel", "postpone",
];
const hasConfirm = (low: string) => CONFIRM.some((c) => low.includes(c));
const hasDecline = (low: string) => DECLINE.some((c) => low.includes(c));

export interface SessionMsg { snippet: string; date: Date }

/** Does this message propose a plan (a forward intent / action cue, not automated)? */
export function isPlanMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/^\s*(liked|loved|laughed at|disliked|emphasi[sz]ed|questioned)\s+["“]/i.test(text)) return false;
  const low = text.toLowerCase();
  if (AUTOMATED.test(low)) return false;
  if (RETRO_OR_STATUS.test(low) || NOT_A_PLAN.test(low)) return false; // retrospective/status/notes
  return hasIntent(low) || hasActionCue(text);
}

/**
 * From a window of messages around an anchor, return the planned (confirmed) future date — or
 * null. Each date resolves against its own message's sent date; confirmed dates beat
 * unconfirmed, latest beats earlier, and a later decline cancels it.
 */
export function plannedDateInWindow(window: SessionMsg[], now: Date): { date: Date; isDue: boolean } | null {
  const today = midnight(now);
  const dated = window
    .map((m, idx) => {
      const d = parseWhen(m.snippet, m.date);
      return d ? { date: d, idx, conf: hasConfirm(m.snippet.toLowerCase()) } : null;
    })
    .filter((x): x is { date: Date; idx: number; conf: boolean } => x !== null);
  if (dated.length === 0) return null;

  // A date is confirmed if its own message confirms it, or a LATER message in the window
  // confirms without itself naming a new date (a "sounds good" that refers back).
  const confirmed = dated.filter(
    (e) =>
      e.conf ||
      window.slice(e.idx + 1).some((mm) => hasConfirm(mm.snippet.toLowerCase()) && !parseWhen(mm.snippet, mm.date))
  );
  const pool = confirmed.length ? confirmed : dated;
  const chosen = [...pool].sort((a, b) => b.idx - a.idx)[0]; // latest (revision wins)

  // Cancelled afterward with no replacement date → no follow-up.
  const cancelled = window
    .slice(chosen.idx + 1)
    .some((mm) => hasDecline(mm.snippet.toLowerCase()) && !parseWhen(mm.snippet, mm.date));
  if (cancelled) return null;

  if (chosen.date.getTime() < today.getTime()) return null; // already passed
  return { date: chosen.date, isDue: chosen.date.getTime() === today.getTime() };
}

// ── Adapted output: proposed commitments ────────────────────────────────────

export interface MessageIn {
  text: string;
  sentAt: string; // ISO datetime
  direction?: string | null; // inbound | outbound (informational; both scanned)
}

export interface ProposedCommitment {
  personId: number;
  description: string;
  dueAt: string | null; // ISO date (UTC midnight) or null for undated intents
}

/**
 * Scan one person's messages for live follow-ups and return proposed commitments.
 * Sessionizes on a >6h gap, anchors on plan-proposing messages (recent only), reads a
 * ±2-message window for the confirmed date (latest confirmed wins; declines cancel),
 * drops past plans and automated texts. Undated forward intents from recent messages are
 * proposed with dueAt null. Deduped by description+date.
 *
 * (Adaptation vs source extractFollowupsFromMessages: no Contact.followUp write — the
 * caller decides what to persist; `db` is accepted for signature parity with the other
 * crm modules but the scan itself is pure.)
 */
export function extractFollowups(
  _db: Db,
  personId: number,
  messages: MessageIn[],
  now: Date = new Date()
): ProposedCommitment[] {
  const msgs: SessionMsg[] = messages
    .filter((m) => m.text && m.sentAt)
    .map((m) => ({ snippet: m.text, date: new Date(m.sentAt) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // Split into sessions on a >6h gap (msgs are time-ordered ascending).
  const sessions: SessionMsg[][] = [];
  let cur: SessionMsg[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0 && msgs[i].date.getTime() - msgs[i - 1].date.getTime() > SESSION_GAP_MS) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(msgs[i]);
  }
  if (cur.length) sessions.push(cur);

  const todayMs = midnight(now).getTime();
  const out = new Map<string, ProposedCommitment>();

  for (const session of sessions) {
    for (let i = 0; i < session.length; i++) {
      if (!isPlanMessage(session[i].snippet)) continue; // anchor = a message proposing a plan
      // Internal clock: a plan is only "live" if the message proposing it is recent. Old asks
      // ("send me the dates" from months ago) are assumed handled, even if a future date is nearby.
      const anchorAgeDays = (todayMs - midnight(session[i].date).getTime()) / DAY;
      if (anchorAgeDays > ANCHOR_RECENCY_DAYS) continue;
      const window = session.slice(Math.max(0, i - 2), Math.min(session.length, i + 3)); // 2 before + anchor + 2 after
      const planned = plannedDateInWindow(window, now);
      if (planned) {
        const key = `${clean(session[i].snippet)}|${iso(planned.date)}`;
        if (!out.has(key)) {
          out.set(key, { personId, description: clean(session[i].snippet), dueAt: iso(planned.date) });
        }
        continue;
      }
      // No confirmed date in the window — fall back to single-message detection (keeps
      // undated forward intents, drops past/retro/automated per detectMessageFollowUp).
      const single = detectMessageFollowUp(session[i].snippet, session[i].date, now);
      if (single && single.dueDate === null) {
        const key = `${single.text}|`;
        if (!out.has(key)) out.set(key, { personId, description: single.text, dueAt: null });
      }
    }
  }

  // Soonest dated first, then undated.
  return [...out.values()].sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return 0;
  });
}
