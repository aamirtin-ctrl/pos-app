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
import { addManual } from "./worklog.ts";

export interface AssistantResult {
  kind: "plan" | "people" | "note" | "answer" | "search" | "event" | "error";
  reply: string;
  results?: { id: number; name: string; reason: string }[];
  hits?: { type: string; label: string; sub: string; href: string }[];
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
{"intent":"plan_day"|"add_event"|"find_people"|"add_note"|"log_work"|"search"|"question","person":"<name if the command is about a specific person, else null>","content":"<the note text if add_note, else the original>"}
"plan_day" = a braindump of tasks to schedule, or asking to plan the day.
"add_event" = ONE specific commitment at a stated time ("lunch with Raj Thursday 1pm", "dentist tomorrow at 9"). A time must be stated or clearly implied.
"find_people" = who should I talk to / reach out to / intro ideas.
"add_note" = remember/save a fact about a person in the network.
"log_work" = record something the USER did into their worklog ("log: shipped the deck", "log closed the Series A intro").
"search" = find/look up specific info they saved (a person, message, commitment, task, note).
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
    if (/^(find|search|look ?up|show me|when did|what did)\b/i.test(t)) intent = "search";
    // a single item with an explicit clock time is an event, not a braindump
    if (/\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/i.test(t) && !/[,;\n]/.test(t)) intent = "add_event";
  }
  // Deterministic worklog prefix wins over everything (incl. the add_note "log" regex).
  if (/^log[:\s]/i.test(t)) intent = "log_work";

  try {
    if (intent === "log_work") {
      const line = t.replace(/^log[:\s]+/i, "").trim();
      if (!line) return { kind: "error", reply: "What should I log? Try: 'log: shipped the deck'." };
      addManual(db, line);
      return { kind: "note", reply: "Logged." };
    }

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

    if (intent === "add_event") {
      const ev = await parseEvent(t, llm);
      if (!ev) return { kind: "error", reply: "Couldn't read a date and time from that. Try: \"lunch with Raj Thursday 1pm\"." };
      const startsAt = `${ev.date}T${ev.start}:00`;
      const endMin = toMin(ev.start) + ev.minutes;
      const endsAt = `${ev.date}T${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}:00`;
      // is_locked=1 → the planner treats it as immovable; is_anchor=0 → it still pushes to Google.
      const plan = db.prepare("SELECT id FROM plan WHERE plan_date = ? ORDER BY generated_at DESC LIMIT 1").get(ev.date) as { id: number } | undefined;
      db.prepare(
        `INSERT INTO block (block_type, title, starts_at, ends_at, is_anchor, is_locked, plan_id)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      ).run(ev.blockType, ev.title, startsAt, endsAt, plan?.id ?? null);
      const pretty = new Date(`${ev.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      return { kind: "event", reply: `Added "${ev.title}" — ${pretty} at ${ev.start} (${ev.minutes} min). It's pinned, so the planner will work around it.` };
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

    if (intent === "search") {
      const q = `%${content.replace(/^(find|search|look ?up|show me)\s*/i, "").trim() || t}%`;
      const hits: { type: string; label: string; sub: string; href: string }[] = [];
      for (const r of db.prepare(
        "SELECT id, display_name, org, role, bio FROM person WHERE display_name LIKE ? OR org LIKE ? OR role LIKE ? OR bio LIKE ? LIMIT 5"
      ).all(q, q, q, q) as any[]) {
        hits.push({ type: "person", label: r.display_name, sub: [r.role, r.org].filter(Boolean).join(" · ") || (r.bio ?? "").slice(0, 70), href: `#/contact/${r.id}` });
      }
      for (const r of db.prepare(
        `SELECT i.id, i.channel, i.subject, i.body_summary, i.occurred_at, p.id AS pid, p.display_name AS who
         FROM interaction i JOIN person p ON p.id=i.person_id
         WHERE i.subject LIKE ? OR i.body_summary LIKE ? ORDER BY i.occurred_at DESC LIMIT 5`
      ).all(q, q) as any[]) {
        hits.push({ type: r.channel, label: `${r.who}: ${(r.subject ?? r.body_summary ?? "").slice(0, 60)}`, sub: String(r.occurred_at ?? "").slice(0, 10), href: `#/contact/${r.pid}` });
      }
      for (const r of db.prepare(
        "SELECT c.id, c.description, c.due_at, p.id AS pid FROM commitment c LEFT JOIN person p ON p.id=c.person_id WHERE c.description LIKE ? LIMIT 4"
      ).all(q) as any[]) {
        hits.push({ type: "commitment", label: r.description.slice(0, 70), sub: r.due_at ? `due ${String(r.due_at).slice(0, 10)}` : "open", href: r.pid ? `#/contact/${r.pid}` : "#/relationships" });
      }
      for (const r of db.prepare(
        "SELECT id, title, plan_date, status FROM task WHERE title LIKE ? ORDER BY created_at DESC LIMIT 4"
      ).all(q) as any[]) {
        hits.push({ type: "task", label: r.title, sub: `${r.status} · ${r.plan_date ?? ""}`, href: "#/calendar" });
      }
      return hits.length
        ? { kind: "search", reply: `${hits.length} result${hits.length > 1 ? "s" : ""}:`, hits }
        : { kind: "search", reply: "Nothing matched across contacts, messages, commitments, or tasks." };
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
    const worklog = (db
      .prepare("SELECT happened_at, title, detail FROM worklog ORDER BY datetime(happened_at) DESC, id DESC LIMIT 5")
      .all() as { happened_at: string; title: string; detail: string | null }[])
      .map((w) => `${w.happened_at.slice(0, 10)}: ${w.title}${w.detail ? ` (${w.detail})` : ""}`)
      .join("; ");
    const context = `TODAY'S PLAN: ${blocks || "(none generated)"}\nOPEN COMMITMENTS: ${commitments || "(none)"}\nRECONNECT DUE: ${due || "(none)"}\nRECENT MESSAGES: ${recent || "(none)"}\nRECENT WORKLOG: ${worklog || "(none)"}`;
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


// ── event parsing for the "add_event" intent ────────────────────────────────
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface ParsedEvent {
  title: string;
  date: string;   // YYYY-MM-DD
  start: string;  // HH:MM 24h
  minutes: number;
  blockType: "meeting" | "personal";
}

/** LLM first (handles "coffee w/ Raj a week from Tuesday"), deterministic fallback second. */
async function parseEvent(text: string, llm: LlmClient | null): Promise<ParsedEvent | null> {
  const todayISO = new Date().toISOString().slice(0, 10);
  if (llm) {
    const res = await llm.call(
      "event_parse", "fast",
      `Extract ONE calendar event. Today is ${todayISO} (${WEEKDAYS[new Date().getDay()]}).
Return STRICT JSON only:
{"title":"<short title, no date/time words>","date":"YYYY-MM-DD","start":"HH:MM" 24-hour,"minutes":<duration, default 60>,"block_type":"meeting"|"personal"}
"meeting" if another person is involved, else "personal". Resolve relative dates against today. If no year is stated pick the nearest future occurrence.
TEXT: """${text.slice(0, 300)}"""`,
      { json: true }
    );
    if (res) {
      try {
        const p = extractJson(res.text) as Record<string, unknown>;
        const date = String(p.date ?? "");
        const start = String(p.start ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(start)) {
          return {
            title: String(p.title || text).slice(0, 120),
            date,
            start,
            minutes: Math.max(15, Math.min(480, Number(p.minutes) || 60)),
            blockType: p.block_type === "personal" ? "personal" : "meeting",
          };
        }
      } catch { /* fall through */ }
    }
  }
  return deterministicEvent(text);
}

/** Handles "<title> [today|tomorrow|<weekday>] at H[:MM]am/pm" without an LLM. */
export function deterministicEvent(text: string, now = new Date()): ParsedEvent | null {
  const tm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!tm) return null;
  let h = Number(tm[1]);
  const mins = Number(tm[2] ?? 0);
  const ampm = (tm[3] ?? "").toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23) return null;

  const d = new Date(now);
  const lower = text.toLowerCase();
  if (/\btomorrow\b/.test(lower)) d.setDate(d.getDate() + 1);
  else {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
    if (wd >= 0) {
      let delta = (wd - d.getDay() + 7) % 7;
      if (delta === 0) delta = 7; // "thursday" on a Thursday means next Thursday
      d.setDate(d.getDate() + delta);
    } else if (h * 60 + mins <= now.getHours() * 60 + now.getMinutes()) {
      d.setDate(d.getDate() + 1); // a time already past today means tomorrow
    }
  }

  const title = text
    .replace(tm[0], "")
    .replace(/\b(today|tomorrow|at|on|next)\b/gi, "")
    .replace(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const durM = text.match(/\b(\d+)\s*(min|minutes|hour|hours|hr|hrs)\b/i);
  const minutes = durM ? (/(hour|hr)/i.test(durM[2]) ? Number(durM[1]) * 60 : Number(durM[1])) : 60;

  return {
    title: title || "Event",
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    start: `${String(h).padStart(2, "0")}:${String(mins).padStart(2, "0")}`,
    minutes: Math.max(15, Math.min(480, minutes)),
    blockType: /\b(with|w\/|meet|call|lunch|coffee|dinner|1:1)\b/i.test(text) ? "meeting" : "personal",
  };
}
