// Unified command box backend: one line of text in → routed action out.
// Sees everything: calendar/plan, tasks, commitments, contacts, interactions.

import type { Db } from "./db/db.ts";
import { hasVec } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import type { LlmClient } from "./llm/provider.ts";
import { extractJson } from "./llm/provider.ts";
import { rank } from "./crm/ranking.ts";
import { makeQueryEmbedder } from "./llm/embeddings.ts";
import { patchPerson } from "./crm/people.ts";
import { reconnectDue, refreshNextTouch } from "./crm/reconnect.ts";
import * as planner from "./planner.ts";

export interface AssistantResult {
  kind: "plan" | "people" | "note" | "answer" | "error";
  reply: string;
  results?: { id: number; name: string; reason: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

export async function handleCommand(
  deps: { db: Db; doctrineDir: string; secrets: SecretStore; llm: LlmClient | null },
  text: string
): Promise<AssistantResult> {
  const { db, doctrineDir, secrets, llm } = deps;
  const t = text.trim();
  if (!t) return { kind: "error", reply: "Say what you need — plan the day, find someone, note a fact." };

  // classify: LLM fast-tier with deterministic fallback
  let intent = "question";
  let person: string | null = null;
  let content = t;
  if (llm) {
    const res = await llm.call(
      "assistant_route",
      "fast",
      `Classify this personal-assistant command. STRICT JSON only:
{"intent":"plan_day"|"find_people"|"add_note"|"question","person":"<name if the command is about a specific person, else null>","content":"<the note text if add_note, else the original>"}
"plan_day" = a braindump of tasks to schedule, or asking to plan the day.
"find_people" = who should I talk to / reach out to / intro ideas.
"add_note" = remember/save a fact about a person in the network.
"question" = anything else about their calendar, commitments, or contacts.
Command: """${t.slice(0, 600)}"""`,
      { json: true }
    );
    if (res) {
      try {
        const p = extractJson(res.text) as Record<string, unknown>;
        if (typeof p.intent === "string") intent = p.intent;
        person = typeof p.person === "string" && p.person.trim() ? p.person.trim() : null;
        content = typeof p.content === "string" && p.content.trim() ? p.content.trim() : t;
      } catch { /* fall through to regex */ }
    }
  }
  if (intent === "question") {
    if (/\b(who|reach out|talk to|intro|connect me)\b/i.test(t) && /\babout|for|on|who\b/i.test(t)) intent = "find_people";
    if (/^(note|remember|met|log)\b/i.test(t)) intent = "add_note";
    if (/\b(plan|schedule|braindump)\b/i.test(t) || /\d+\s*(h|hr|hrs|hours|min)/i.test(t)) intent = "plan_day";
  }

  try {
    if (intent === "plan_day") {
      await planner.braindump(db, doctrineDir, llm, t, today());
      const view = await planner.generatePlan(db, doctrineDir, secrets, llm, today());
      const n = view?.blocks.filter((b: any) => !b.is_anchor).length ?? 0;
      const un = view?.unplaced?.length ?? 0;
      return {
        kind: "plan",
        reply: `${(view?.plan as any)?.narration ?? "Plan generated."} — ${n} blocks placed${un ? `, ${un} didn't fit` : ""}. Review it on the Calendar.`,
      };
    }

    if (intent === "find_people") {
      const r = await rank(db, llm, t, { embedQuery: (hasVec() && makeQueryEmbedder(db, secrets)) || undefined });
      const results = (r.results ?? []).slice(0, 3).map((x: any) => ({
        id: Number(x.id), name: String(x.name), reason: String(x.reason ?? ""),
      }));
      return results.length
        ? { kind: "people", reply: results.map((x) => `${x.name} — ${x.reason}`).join("  ·  "), results }
        : { kind: "people", reply: "No strong matches in your network for that." };
    }

    if (intent === "add_note") {
      const name = person ?? t.match(/(?:about|met|note on)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ?? null;
      if (!name) return { kind: "error", reply: "Who is this about? Try: 'note about Sarah: …'" };
      const hit = db
        .prepare("SELECT id, display_name, bio FROM person WHERE display_name LIKE ? ORDER BY LENGTH(display_name) LIMIT 1")
        .get(`%${name}%`) as { id: number; display_name: string; bio: string | null } | undefined;
      if (!hit) return { kind: "error", reply: `No contact matching "${name}".` };
      const line = content.replace(new RegExp(`^(note|remember|met|log)\\b[^:]*:?\\s*`, "i"), "").trim() || content;
      patchPerson(db, hit.id, { bio: `${hit.bio ? hit.bio + "\n" : ""}${line}` });
      db.prepare("UPDATE person SET last_contact_at = COALESCE(last_contact_at, datetime('now')) WHERE id = ?").run(hit.id);
      return { kind: "note", reply: `Noted on ${hit.display_name}: "${line}"`, results: [{ id: hit.id, name: hit.display_name, reason: "updated" }] };
    }

    // question → answer over a unified context snapshot
    refreshNextTouch(db);
    const plan = planner.getPlan(db, today());
    const blocks = (plan?.blocks ?? [])
      .map((b: any) => `${String(b.starts_at).slice(11, 16)} ${b.title ?? b.block_type}`)
      .join("; ");
    const commitments = (db
      .prepare("SELECT c.description, c.due_at, p.display_name AS who FROM commitment c LEFT JOIN person p ON p.id=c.person_id WHERE c.status='open' ORDER BY c.due_at IS NULL, c.due_at LIMIT 10")
      .all() as any[])
      .map((c) => `${c.description}${c.who ? ` (${c.who})` : ""}${c.due_at ? ` due ${String(c.due_at).slice(0, 10)}` : ""}`)
      .join("; ");
    const due = (reconnectDue(db) as any[]).slice(0, 5).map((p) => p.display_name ?? p.name).join(", ");
    const recent = (db
      .prepare("SELECT i.subject, i.body_summary, p.display_name AS who FROM interaction i JOIN person p ON p.id=i.person_id ORDER BY i.occurred_at DESC LIMIT 8")
      .all() as any[])
      .map((r) => `${r.who}: ${r.subject ?? r.body_summary ?? ""}`.slice(0, 90))
      .join("; ");
    const context = `TODAY'S PLAN: ${blocks || "(none generated)"}\nOPEN COMMITMENTS: ${commitments || "(none)"}\nRECONNECT DUE: ${due || "(none)"}\nRECENT MESSAGES: ${recent || "(none)"}`;
    if (llm) {
      const res = await llm.call(
        "assistant_answer",
        "smart",
        `You are the user's chief of staff inside their personal OS. Answer their question from this live context. Be concrete and brief (1-4 sentences). No emoji.\n\nCONTEXT:\n${context}\n\nQUESTION: ${t}`,
        { maxTokens: 300 }
      );
      if (res?.text.trim()) return { kind: "answer", reply: res.text.trim() };
    }
    return { kind: "answer", reply: context.replace(/\n/g, " · ").slice(0, 500) };
  } catch (e) {
    return { kind: "error", reply: (e as Error).message };
  }
}
