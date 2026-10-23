// Reconnect drafts (owner ask 2026-10-23): one click on a Reconnect row writes a short
// "how are you + here's my news" message and opens it prefilled in the app it belongs to —
// Messages, the mail client, or LinkedIn. Never sends. He reads it, edits it, hits send.
//
// The ask, verbatim: "a message texting them asking them how they are doing and catching
// them up on my life (3 sentences total, sweet and inviting)". So the body is exactly three
// sentences — ask, update, invitation — in his learned channel voice. Email wraps those three
// in his usual greeting/sign-off; that framing is not counted as a sentence.
//
// What the model is allowed to know about "my life": the worklog since they last talked and
// the "About you" facts. Nothing else. A reconnect note that invents a shared memory or a
// piece of news is worse than a generic one, so the prompt forbids it and the deterministic
// fallback (no key, over ceiling, API error) only ever says true, generic things.

import type { Db } from "../db/db.ts";
import type { LlmClient } from "../llm/provider.ts";
import { CHANNEL_CATEGORY, getVoices, type VoiceProfile } from "./drafts.ts";
import { entriesSince, type WorklogEntry } from "../worklog.ts";
import { contextBlock } from "../context.ts";
import { isHandleLikeName } from "./name-infer.ts";
import { normalizeLinkedin } from "./normalize.ts";

export type ReconnectChannel = "text" | "email" | "linkedin";

/** Where each channel would go for this person. null = no handle on file. */
export interface ReconnectTargets {
  /** Phone number or iMessage handle (an Apple ID email is a valid iMessage handle). */
  text: string | null;
  email: string | null;
  /** Profile URL when we have one; otherwise null (opening falls back to a people search). */
  linkedin: string | null;
}

export interface ReconnectDraft {
  personId: number;
  name: string;
  channel: ReconnectChannel;
  targets: ReconnectTargets;
  /** Email only. */
  subject: string | null;
  /** The full message as it will be prefilled — greeting/sign-off included for email. */
  body: string;
  usedLlm: boolean;
}

interface PersonRow {
  id: number;
  display_name: string;
  given_name: string | null;
  org: string | null;
  role: string | null;
  bio: string | null;
  relationship_summary: string | null;
  last_contact_at: string | null;
}

const one = <T>(db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;

export function reconnectTargets(db: Db, personId: number): ReconnectTargets {
  const pick = (kinds: string[]) =>
    one<{ value: string }>(
      db,
      `SELECT value FROM alias WHERE person_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
       ORDER BY ${kinds.map((_, i) => `CASE kind WHEN ? THEN ${i} ELSE ${kinds.length} END`).join(", ")},
                is_primary DESC, confidence DESC, id ASC
       LIMIT 1`,
      personId,
      ...kinds,
      ...kinds
    )?.value ?? null;
  const li = pick(["linkedin"]);
  const liNorm = li ? normalizeLinkedin(li)?.norm ?? null : null;
  return {
    text: pick(["imessage_handle", "phone"]),
    email: pick(["email"]),
    linkedin: liNorm && liNorm.startsWith("linkedin.com/in/") ? `https://www.${liNorm}` : null,
  };
}

/**
 * Which channel to open by default: the one they last talked on, if we can still reach
 * them there; else text, then email, then LinkedIn (always reachable via people search).
 */
export function defaultChannel(db: Db, personId: number, targets: ReconnectTargets): ReconnectChannel {
  const last = one<{ channel: string }>(
    db,
    `SELECT channel FROM interaction WHERE person_id = ? AND channel != 'manual'
     ORDER BY occurred_at DESC LIMIT 1`,
    personId
  )?.channel;
  const cat = last ? CHANNEL_CATEGORY[last] : undefined;
  if (cat === "text" && targets.text) return "text";
  if (cat === "email" && targets.email) return "email";
  if (cat === "linkedin") return "linkedin";
  if (targets.text) return "text";
  if (targets.email) return "email";
  return "linkedin";
}

export function firstName(p: Pick<PersonRow, "display_name" | "given_name">): string | null {
  const g = p.given_name?.trim();
  if (g) return g;
  if (isHandleLikeName(p.display_name)) return null;
  const first = p.display_name.trim().split(/\s+/)[0];
  return first && /^\p{L}/u.test(first) ? first : null;
}

/**
 * Split prose into sentences; keeps the terminal punctuation. A bare greeting ("Hey Sam!")
 * is part of the sentence after it, not one of the three — otherwise trimming a model's
 * "Hey Sam! How are you? … news … Coffee?" to three would cut the invitation.
 */
export function sentences(text: string): string[] {
  const parts = (text.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1 && /^(hey|hi|hello|hiya|yo)\b[^.!?]{0,30}[!.]$/i.test(parts[0]) && parts[0].split(/\s+/).length <= 4) {
    return [`${parts[0]} ${parts[1]}`, ...parts.slice(2)];
  }
  return parts;
}

/** The deterministic three sentences — only ever claims true, generic things. */
export function fallbackSentences(first: string | null, news: WorklogEntry[]): string[] {
  const hi = first ? `Hey ${first}! ` : "Hey! ";
  const update =
    news.length > 0
      ? `Quick update from my end: ${news
          .slice(0, 2)
          .map((e) => e.title.replace(/[.!?]+$/, "").replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase()))
          .join(", and ")}.`
      : "Things on my end have been busy in the best way, and I'd love to hear what you've been up to.";
  return [
    `${hi}It's been way too long, how have you been?`,
    update,
    "Would love to catch up soon, maybe a quick call or coffee whenever works for you?",
  ];
}

/** Email framing around the three sentences, from his learned email voice. */
export function wrapEmail(first: string | null, three: string, voice: VoiceProfile | undefined): string {
  const greetingTpl = voice?.greeting?.trim() || "Hi <name>,";
  const greeting = first
    ? greetingTpl.replace(/<name>|\{name\}|\bX\b/g, first)
    : greetingTpl.replace(/\s*(<name>|\{name\}|\bX\b)/g, "").replace(/\s+,/, ",") || "Hi,";
  const signoff = voice?.signoff?.trim() || "Best,\nAamir";
  // "Best, Aamir" on one line reads as a typo in a mail client — break after the comma.
  const signoffLines = signoff.replace(/,\s*(?=\S)/, ",\n");
  // The three sentences are the greeting's body; drop a duplicated "Hey X!" opener.
  const body = three.replace(/^(hey|hi|hello)\b[^!.,]*[!.,]\s*/i, "");
  return `${greeting}\n\n${body}\n\n${signoffLines}`;
}

export const SUBJECT_FALLBACK = "It's been a while!";

function personRow(db: Db, personId: number): PersonRow {
  const p = one<PersonRow>(
    db,
    `SELECT id, display_name, given_name, org, role, bio, relationship_summary, last_contact_at
     FROM person WHERE id = ?`,
    personId
  );
  if (!p) throw new Error("person not found");
  return p;
}

/** What was last said between them — light context so the note doesn't feel generic. */
function lastExchange(db: Db, personId: number): string[] {
  const rows = db
    .prepare(
      `SELECT direction, subject, body_summary FROM interaction
       WHERE person_id = ? AND body_summary IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 4`
    )
    .all(personId) as { direction: string | null; subject: string | null; body_summary: string }[];
  return rows
    .reverse()
    .map((r) => `${r.direction === "outbound" ? "me" : "them"}: ${(r.subject ? `[${r.subject}] ` : "") + r.body_summary.replace(/\s+/g, " ").slice(0, 160)}`);
}

export async function draftReconnect(
  db: Db,
  llm: LlmClient | null,
  personId: number,
  channel?: ReconnectChannel,
  now: Date = new Date()
): Promise<ReconnectDraft> {
  const p = personRow(db, personId);
  const targets = reconnectTargets(db, personId);
  const ch = channel ?? defaultChannel(db, personId, targets);
  const first = firstName(p);
  const category = ch === "text" ? "text" : ch; // voice categories: text | email | linkedin
  const voice = getVoices(db)[category];

  const since = p.last_contact_at ?? new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 19);
  const news = entriesSince(db, since).slice(0, 12); // newest first
  const about = contextBlock(db);

  let three = fallbackSentences(first, news).join(" ");
  let subject: string | null = ch === "email" ? SUBJECT_FALLBACK : null;
  let usedLlm = false;

  if (llm) {
    const them = [
      p.role || p.org ? `- Works as: ${[p.role, p.org].filter(Boolean).join(" at ")}` : "",
      p.bio ? `- About them: ${p.bio.replace(/\s+/g, " ").slice(0, 400)}` : "",
      p.relationship_summary ? `- Our history: ${p.relationship_summary.replace(/\s+/g, " ").slice(0, 400)}` : "",
      p.last_contact_at ? `- Last talked: ${p.last_contact_at.slice(0, 10)}` : "",
    ].filter(Boolean).join("\n");
    const convo = lastExchange(db, personId);
    const res = await llm.call(
      "reconnect_draft",
      "smart",
      `Write a reconnect message FROM the user TO ${first ?? p.display_name}, someone they haven't talked to in a while, sent by ${
        ch === "text" ? "text message" : ch === "email" ? "email" : "LinkedIn message"
      }.
EXACTLY 3 sentences, sweet and inviting:
1. Greet them${first ? ` by first name (${first})` : ""} and warmly ask how they're doing — mention something specific about them only if it is stated below.
2. Catch them up on the user's life in one sentence, drawn ONLY from the worklog / about-the-user facts below. If there is nothing notable, keep it light and true without specifics.
3. An inviting close — suggest catching up (call, coffee, etc.) without naming a date or claiming a plan exists.
Rules: never invent facts, shared memories, places or news. No subject line, no sign-off, no emoji unless the voice notes call for them. Plain text.
VOICE (${category}): tone "${voice?.tone ?? "warm, casual"}"; quirks: ${voice?.notes?.join("; ") || "none"}.
${about}
WORKLOG SINCE ${since.slice(0, 10)}:
${news.length ? news.map((e) => `- ${e.happened_at.slice(0, 10)}: ${e.title}${e.detail ? ` — ${e.detail}` : ""}`).join("\n") : "- (nothing logged)"}
ABOUT THEM:
${them || "- (nothing on file)"}
${convo.length ? `LAST MESSAGES BETWEEN US (context only — do not quote):\n${convo.join("\n")}` : ""}
Return STRICT JSON: {"message":"<the 3 sentences>"${ch === "email" ? ',"subject":"<3-6 word friendly subject>"' : ""}}`,
      { json: true, maxTokens: 300 }
    );
    if (res?.text) {
      try {
        const m = res.text.match(/\{[\s\S]*\}/);
        const o = JSON.parse(m ? m[0] : res.text) as { message?: unknown; subject?: unknown };
        const s = typeof o.message === "string" ? sentences(o.message.replace(/^["']|["']$/g, "")) : [];
        if (s.length >= 2) {
          three = s.slice(0, 3).join(" ");
          usedLlm = true;
        }
        if (ch === "email" && typeof o.subject === "string" && o.subject.trim()) {
          subject = o.subject.trim().replace(/^subject:\s*/i, "").slice(0, 80);
        }
      } catch {
        /* keep the deterministic draft */
      }
    }
  }

  const body = ch === "email" ? wrapEmail(first, three, voice) : three;
  return { personId, name: p.display_name, channel: ch, targets, subject, body, usedLlm };
}

/**
 * The URL that opens the message prefilled. Built in main from handles in the DB — the
 * renderer never supplies a URL, so nothing it does can make the app open an arbitrary one.
 *
 *   text     → sms:<handle>&body=…        (Messages; iMessage or SMS per the handle)
 *   email    → mailto:<addr>?subject=…&body=…
 *   linkedin → the profile, or a people search by name. LinkedIn has no prefill URL for
 *              messages, so the caller also puts the text on the clipboard to paste.
 */
export function openUrlFor(
  channel: ReconnectChannel,
  targets: ReconnectTargets,
  name: string,
  body: string,
  subject: string | null
): string {
  const enc = encodeURIComponent;
  if (channel === "text") {
    if (!targets.text) throw new Error("no phone or iMessage handle on file for this contact");
    const h = targets.text.trim();
    // A phone number goes in bare (+digits); an Apple ID email is a valid iMessage handle.
    const handle = h.includes("@") ? enc(h).replace(/%40/g, "@") : h.replace(/(?!^\+)[^\d]/g, "");
    return `sms:${handle}&body=${enc(body)}`;
  }
  if (channel === "email") {
    if (!targets.email) throw new Error("no email address on file for this contact");
    return `mailto:${enc(targets.email).replace(/%40/g, "@")}?subject=${enc(subject ?? SUBJECT_FALLBACK)}&body=${enc(body)}`;
  }
  return targets.linkedin ?? `https://www.linkedin.com/search/results/people/?keywords=${enc(name)}`;
}

/**
 * "I sent it." Logs an outbound manual touch so the person leaves the Reconnect list and
 * the cadence restarts from today. body_summary stays NULL on purpose: voice synthesis
 * learns from outbound body_summary, and a draft is not evidence of how he writes.
 */
export function markReachedOut(
  db: Db,
  personId: number,
  channel: ReconnectChannel,
  body: string,
  now: Date = new Date()
): { interactionId: number } {
  personRow(db, personId);
  // Same shape the connectors write (ISO, trailing Z); compared via julianday, never as text.
  const at = now.toISOString();
  const run = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_raw)
         VALUES (?, 'manual', 'outbound', ?, ?, ?)`
      )
      .run(personId, at, `Reconnect (${channel})`, body);
    db.prepare(
      `UPDATE person SET last_contact_at = ?, updated_at = datetime('now')
       WHERE id = ? AND (last_contact_at IS NULL OR julianday(last_contact_at) < julianday(?))`
    ).run(at, personId, at);
    return Number(r.lastInsertRowid);
  });
  return { interactionId: run() };
}
