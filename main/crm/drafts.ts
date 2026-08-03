// Auto-drafting engine. Category = messaging platform; each category gets a VOICE
// learned from the user's own outbound history on that channel. Drafts are
// suggestions only — copy/edit/send happens in the native app. Never auto-send.

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
       WHERE i.direction = 'inbound' AND i.occurred_at >= datetime('now', '-14 days')
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

/** Generate drafts for unanswered inbound messages, in the learned channel voice. */
export async function generateDrafts(db: Db, llm: LlmClient | null): Promise<{ drafted: number; skipped: string | null }> {
  if (!llm) return { drafted: 0, skipped: "Add an AI key in Settings to auto-draft replies." };
  const voices = getVoices(db);
  if (Object.keys(voices).length === 0) await synthesizeVoices(db, llm);
  const pending = unansweredInbound(db, 15);
  let drafted = 0;
  for (const m of pending) {
    const cat = CHANNEL_CATEGORY[m.channel] ?? "text";
    const voice = getVoices(db)[cat];
    const history = db
      .prepare(
        `SELECT direction, subject, body_summary FROM interaction
         WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 6`
      )
      .all(m.person_id) as { direction: string; subject: string | null; body_summary: string | null }[];
    const bio = (db.prepare("SELECT bio FROM person WHERE id = ?").get(m.person_id) as { bio: string | null })?.bio;
    const res = await llm.call(
      "auto_draft", "fast",
      `Draft a reply AS the user, in their ${cat} voice. VOICE: tone "${voice?.tone}"; opener "${voice?.greeting}"; closer "${voice?.signoff}"; quirks: ${voice?.notes?.join("; ") || "none"}. Target length ≈ ${voice?.avgWords ?? 30} words.
ABOUT ${m.who}: ${bio?.slice(0, 300) ?? "(no bio)"}
RECENT THREAD (newest first): ${history.map((h) => `[${h.direction}] ${h.subject ?? ""} ${h.body_summary ?? ""}`.trim().slice(0, 140)).join(" | ")}
MESSAGE TO ANSWER (${m.channel}): ${m.subject ? `Subject: ${m.subject}. ` : ""}${m.body_summary ?? ""}
Rules: sound exactly like the voice, not like an assistant. Answer what was asked; if a commitment or time is needed, propose one concrete option. Plain text only, no preamble, no quotes around the reply.`,
      { maxTokens: 300 }
    );
    if (res?.text.trim()) {
      db.prepare(
        "INSERT OR IGNORE INTO draft (interaction_id, person_id, channel, body) VALUES (?, ?, ?, ?)"
      ).run(m.id, m.person_id, m.channel, res.text.trim());
      drafted++;
    }
  }
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
