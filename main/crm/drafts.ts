// Auto-drafting engine. Category = messaging platform; each category gets a VOICE
// learned from the user's own outbound history on that channel. Drafts are
// suggestions only — copy/edit/send happens in the native app. Never auto-send.
//
// QUOTA SHAPE (owner standing directive: never one LLM call per item when a batch
// would do — the Gemini free tier is REQUEST-limited, ~250 fast-tier calls a day).
// generateDrafts used to spend one `auto_draft` call per unanswered message, up to 15
// per run. It now spends ONE call per DRAFT_BATCH (12) messages — the same numbered-
// candidates / strict-JSON-array shape crm/commitments.ts uses:
//   numbered list of {n, who, channel, voice profile, thread context, message} → [{n, body}]
// The per-channel VOICE still governs each reply: every entry carries its own voice
// profile inline, so a mixed-channel batch is still answered in the right voice per
// item — that is what replaced the "one call per channel" alternative.
// Prompt size is bounded by TRUNCATING per-item context (DRAFT_CONTEXT_MSGS thread
// messages, clipped snippets), never by dropping items: 15 pending messages cost 2
// calls, not 15.

import type { Db } from "../db/db.ts";
import { getSetting, setSetting } from "../db/db.ts";
import type { LlmClient } from "../llm/provider.ts";
import { extractJson } from "../llm/provider.ts";

// channel → tone category
export const CHANNEL_CATEGORY: Record<string, string> = {
  gmail: "email", mailfile: "email", outlook: "email",
  imessage: "text", linkedin: "linkedin", slack: "slack",
};

export interface VoiceProfile {
  category: string;
  tone: string;          // e.g. "warm, direct, lowercase casual"
  greeting: string;      // typical opener ("Hey —", "Hi X,", none)
  signoff: string;       // typical closer ("Best, Aamir", none)
  avgWords: number;
  notes: string[];       // quirks: emoji use, punctuation, formality
}

/** Learn a voice per category from the user's own outbound snippets. */
export async function synthesizeVoices(db: Db, llm: LlmClient | null): Promise<Record<string, VoiceProfile>> {
  const out: Record<string, VoiceProfile> = {};
  const cats = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT channel, subject, body_summary FROM interaction
       WHERE direction = 'outbound' AND body_summary IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 400`
    )
    .all() as { channel: string; subject: string | null; body_summary: string }[];
  for (const r of rows) {
    const cat = CHANNEL_CATEGORY[r.channel] ?? "text";
    const arr = cats.get(cat) ?? [];
    if (arr.length < 40) arr.push(r.subject ? `[${r.subject}] ${r.body_summary}` : r.body_summary);
    cats.set(cat, arr);
  }
  for (const [cat, samples] of cats) {
    // deterministic baseline
    const words = samples.map((s) => s.split(/\s+/).length);
    const avgWords = Math.round(words.reduce((a, b) => a + b, 0) / Math.max(1, words.length));
    let profile: VoiceProfile = {
      category: cat, tone: cat === "email" ? "polite, concise" : "casual, brief",
      greeting: cat === "email" ? "Hi <name>," : "", signoff: cat === "email" ? "Best, Aamir" : "",
      avgWords, notes: [],
    };
    if (llm && samples.length >= 5) {
      const res = await llm.call(
        "voice_synthesis", "smart",
        `These are snippets of how one person writes on ${cat}. Describe their voice so a ghostwriter could imitate it. STRICT JSON:
{"tone":"<5-8 words>","greeting":"<their typical opener, or empty>","signoff":"<their typical closer, or empty>","notes":["<2-4 short quirks: punctuation, formality, emoji, sentence length>"]}
SNIPPETS:\n${samples.slice(0, 30).map((s) => `- ${s.slice(0, 160)}`).join("\n")}`,
        { json: true }
      );
      if (res) {
        try {
          const p = extractJson(res.text) as Record<string, unknown>;
          profile = {
            ...profile,
            tone: typeof p.tone === "string" ? p.tone : profile.tone,
            greeting: typeof p.greeting === "string" ? p.greeting : profile.greeting,
            signoff: typeof p.signoff === "string" ? p.signoff : profile.signoff,
            notes: Array.isArray(p.notes) ? (p.notes as string[]).slice(0, 4) : [],
          };
        } catch { /* keep baseline */ }
      }
    }
    out[cat] = profile;
    setSetting(db, `voice_${cat}`, JSON.stringify(profile));
  }
  return out;
}

export function getVoices(db: Db): Record<string, VoiceProfile> {
  const out: Record<string, VoiceProfile> = {};
  for (const cat of ["email", "text", "linkedin", "slack"]) {
    const raw = getSetting(db, `voice_${cat}`);
    if (raw) try { out[cat] = JSON.parse(raw); } catch { /* skip */ }
  }
  return out;
}

/** Inbound messages (last 14 days) with no reply yet and no draft yet. */
export function unansweredInbound(db: Db, limit = 25) {
  return db
    .prepare(
      `SELECT i.id, i.person_id, i.channel, i.subject, i.body_summary, i.occurred_at,
              p.display_name AS who
       FROM interaction i JOIN person p ON p.id = i.person_id
       -- julianday(), not a string >=. occurred_at is ISO-8601 with a 'T' and a trailing Z;
       -- datetime('now', …) renders "YYYY-MM-DD HH:MM:SS" with a SPACE. Comparing those as
       -- text compares 'T' (0x54) against ' ' (0x20) once the date halves match, so every
       -- interaction on the boundary day counted as inside the window whatever its hour.
       -- julianday parses both shapes and compares instants (audited 2026-08-08).
       WHERE i.direction = 'inbound' AND julianday(i.occurred_at) >= julianday('now', '-14 days')
         AND NOT EXISTS (SELECT 1 FROM draft d WHERE d.interaction_id = i.id)
         AND NOT EXISTS (
           SELECT 1 FROM interaction o WHERE o.person_id = i.person_id
             AND o.direction = 'outbound' AND o.occurred_at > i.occurred_at)
       ORDER BY i.occurred_at DESC LIMIT ?`
    )
    .all(limit) as {
    id: number; person_id: number; channel: string; subject: string | null;
    body_summary: string | null; occurred_at: string; who: string;
  }[];
}

/** Unanswered messages looked at per run (unchanged) — now costing 2 calls, not 15. */
export const DRAFT_SCAN = 15;
/** Messages answered per `auto_draft` call. More than this and a SECOND call is made. */
export const DRAFT_BATCH = 12;
/** Thread-context messages carried per item — the size knob, so no item is ever dropped. */
export const DRAFT_CONTEXT_MSGS = 2;

const clip = (s: string | null | undefined, n: number) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** One numbered message awaiting a reply — the only handle the model gets is `n`. */
export interface DraftCandidate {
  n: number;
  id: number;
  personId: number;
  channel: string;
  who: string;
  category: string;
  voice: VoiceProfile | undefined;
  bio: string | null;
  subject: string | null;
  inbound: string;
  history: { direction: string; subject: string | null; body_summary: string | null }[];
}

/** "tone …; opener …; closer …; quirks …" — the per-item voice line, inline per entry. */
function voiceLine(c: DraftCandidate): string {
  const v = c.voice;
  return `tone "${v?.tone}"; opener "${v?.greeting}"; closer "${v?.signoff}"; quirks: ${
    v?.notes?.join("; ") || "none"
  }; target length ≈ ${v?.avgWords ?? 30} words`;
}

/**
 * ONE call for the whole batch. Every rule of the old per-message prompt survives; the
 * VOICE moved from the preamble (where it could only describe one channel) into each
 * numbered entry, so a batch mixing email and iMessage still answers each in its own voice.
 */
export function buildDraftsPrompt(items: DraftCandidate[]): string {
  const entries = items
    .map((c) => {
      const thread = c.history
        .slice(0, DRAFT_CONTEXT_MSGS)
        .map((h) => clip(`[${h.direction}] ${h.subject ?? ""} ${h.body_summary ?? ""}`, 140))
        .join(" | ");
      return `${c.n}. REPLY AS THE USER on ${c.channel} (${c.category} voice), to ${c.who}
   VOICE: ${voiceLine(c)}
   ABOUT ${c.who}: ${clip(c.bio, 300) || "(no bio)"}
   RECENT THREAD (newest first): ${thread || "(none)"}
   MESSAGE TO ANSWER: ${c.subject ? `Subject: ${clip(c.subject, 120)}. ` : ""}${clip(c.inbound, 600)}`;
    })
    .join("\n\n");

  return `Draft a reply AS the user for EACH of these numbered messages. Each entry carries its own VOICE — use that entry's voice for that entry's reply, never a blended one.

Rules for every reply: sound exactly like the voice, not like an assistant. Answer what was asked; if a commitment or time is needed, propose one concrete option. Plain text only, no preamble, no quotes around the reply. Write one reply per numbered entry — never merge two entries, never skip one.

MESSAGES:
${entries}

Return STRICT JSON ONLY — no prose, no markdown fences — one object per entry, using the SAME n:
[{ "n": <number>, "body": "<the reply text>" }]`;
}

/** `[{n, body}]` → n → body. Tolerates `reply`/`text` keys and a lone object for a 1-item batch. */
function parseDraftBodies(raw: unknown, batchSize: number): Map<number, string> | null {
  const out = new Map<number, string>();
  const take = (o: Record<string, unknown>, fallbackN: number) => {
    const nRaw = Number(o.n);
    const n = Number.isFinite(nRaw) ? nRaw : fallbackN;
    const body = [o.body, o.reply, o.text].find((v) => typeof v === "string" && v.trim());
    if (typeof body === "string") out.set(n, body.trim());
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      take(item as Record<string, unknown>, NaN);
    }
    return out;
  }
  // Defensive: a one-item batch often comes back as a bare object instead of an array.
  if (raw && typeof raw === "object" && batchSize === 1) {
    take(raw as Record<string, unknown>, 1);
    return out;
  }
  return null;
}

/**
 * Generate drafts for unanswered inbound messages, in the learned channel voice.
 *
 * QUOTA: DRAFT_SCAN messages cost ceil(DRAFT_SCAN / DRAFT_BATCH) calls — two, not
 * fifteen. A batch whose response is unparseable produces no drafts for that batch (the
 * same outcome the old per-message path had when a call failed); because nothing is
 * written, those messages are still unanswered and are retried on the next run rather
 * than silently lost. Entries missing from an otherwise-good response are logged and
 * likewise retried next run.
 */
export async function generateDrafts(db: Db, llm: LlmClient | null): Promise<{ drafted: number; skipped: string | null }> {
  if (!llm) return { drafted: 0, skipped: "Add an AI key in Settings to auto-draft replies." };
  if (Object.keys(getVoices(db)).length === 0) await synthesizeVoices(db, llm);
  const voices = getVoices(db); // read ONCE, not once per message
  const pending = unansweredInbound(db, DRAFT_SCAN);
  if (pending.length === 0) return { drafted: 0, skipped: null };

  const historyStmt = db.prepare(
    `SELECT direction, subject, body_summary FROM interaction
     WHERE person_id = ? ORDER BY occurred_at DESC LIMIT ${DRAFT_CONTEXT_MSGS}`
  );
  const bioStmt = db.prepare("SELECT bio FROM person WHERE id = ?");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO draft (interaction_id, person_id, channel, body) VALUES (?, ?, ?, ?)"
  );

  const candidates: DraftCandidate[] = pending.map((m) => {
    const category = CHANNEL_CATEGORY[m.channel] ?? "text";
    return {
      n: 0, // assigned per batch below, so every prompt is numbered 1..k

      id: m.id,
      personId: m.person_id,
      channel: m.channel,
      who: m.who,
      category,
      voice: voices[category],
      bio: (bioStmt.get(m.person_id) as { bio: string | null } | undefined)?.bio ?? null,
      subject: m.subject,
      inbound: m.body_summary ?? "",
      history: historyStmt.all(m.person_id) as DraftCandidate["history"],
    };
  });

  let drafted = 0;
  let calls = 0;
  for (let i = 0; i < candidates.length; i += DRAFT_BATCH) {
    // Renumber so each prompt's `n` runs 1..batch.length (the model never sees gaps).
    const batch = candidates.slice(i, i + DRAFT_BATCH).map((c, j) => ({ ...c, n: j + 1 }));
    const res = await llm.call("auto_draft", "fast", buildDraftsPrompt(batch), {
      json: true,
      maxTokens: Math.min(4000, 300 * batch.length),
    });
    calls++;
    if (!res) {
      console.warn(`drafts: batch of ${batch.length} got no response — retried next run`);
      continue;
    }
    let bodies: Map<number, string> | null = null;
    try {
      bodies = parseDraftBodies(extractJson(res.text), batch.length);
    } catch (e) {
      console.warn(`drafts: bad batch JSON, ${batch.length} message(s) retried next run (${(e as Error).message})`);
    }
    if (!bodies) continue; // unusable shape — the WHOLE batch waits for the next run
    let missing = 0;
    for (const c of batch) {
      const body = bodies.get(c.n);
      if (!body) {
        missing++;
        continue;
      }
      insert.run(c.id, c.personId, c.channel, body);
      drafted++;
    }
    if (missing) console.warn(`drafts: ${missing}/${batch.length} entries missing from the batch reply`);
  }
  console.log(`drafts: ${drafted} draft(s) for ${candidates.length} message(s) in ${calls} LLM call(s)`);
  return { drafted, skipped: null };
}

export function listDrafts(db: Db) {
  return db
    .prepare(
      `SELECT d.id, d.channel, d.body, d.status, d.created_at,
              i.subject, i.body_summary AS inbound, i.occurred_at,
              p.id AS person_id, p.display_name AS who
       FROM draft d JOIN interaction i ON i.id = d.interaction_id
       JOIN person p ON p.id = d.person_id
       WHERE d.status = 'suggested' ORDER BY i.occurred_at DESC`
    )
    .all();
}

export function setDraftStatus(db: Db, id: number, status: "dismissed" | "sent") {
  db.prepare("UPDATE draft SET status = ? WHERE id = ?").run(status, id);
  return { ok: true };
}
