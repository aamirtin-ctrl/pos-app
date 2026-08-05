// Unified command box backend: one line of text in → routed action out.
// Sees everything: calendar/plan, tasks, commitments, contacts, interactions.

import type { Db } from "./db/db.ts";
import { hasVec } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import type { LlmClient } from "./llm/provider.ts";
import { extractJson } from "./llm/provider.ts";
import { rank } from "./crm/ranking.ts";
import { makeQueryEmbedder } from "./llm/embeddings.ts";
import { patchPersonWithExtract } from "./crm/people.ts";
import { reconnectDue, refreshNextTouch } from "./crm/reconnect.ts";
import * as planner from "./planner.ts";
import { addManual } from "./worklog.ts";
import {
  contextBlock,
  setFact,
  parseFactDeterministic,
  normalizeKey,
  REMEMBER_PREFIX,
  type FactKind,
  type FactRequest,
} from "./context.ts";

export interface AssistantResult {
  kind: "plan" | "people" | "note" | "answer" | "search" | "event" | "rule" | "error";
  reply: string;
  results?: { id: number; name: string; reason: string }[];
  hits?: { type: string; label: string; sub: string; href: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

// ── NL rules engine (gap #19; ported from PersonalCRM2 lib/llm.ts parseRuleRequest) ──
// The user configures the CRM in prose: "my family group shouldn't show as follow-ups",
// "re-enable follow-ups for investors", "delete the recruiters group". Deterministic
// patterns run first (free, offline, predictable); the LLM only covers phrasings they miss.

export type RuleAction = "suppress_followups" | "unsuppress_followups" | "delete_group" | "none";

export interface RuleRequest {
  action: RuleAction;
  group: string | null;
}

/** Strip articles, the trailing word "group", quotes and "people in …" scaffolding. */
export function cleanGroupName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let g = raw.trim().toLowerCase();
  g = g.replace(/[."'“”!?]+$/g, "").replace(/^["'“”]+/g, "");
  g = g.replace(/^(?:all\s+)?(?:the\s+|my\s+|our\s+)?(?:people|persons|contacts|everyone|anyone|folks)\s+(?:in|from|of)\s+/, "");
  g = g.replace(/^(?:the|my|our)\s+/, "");
  g = g.replace(/\s+group$/, "");
  g = g.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return g || null;
}

const RULE_PATTERNS: { re: RegExp; action: RuleAction }[] = [
  // delete: "delete the family group" / "remove my recruiters group" / "delete group family"
  { re: /\b(?:delete|remove|drop|get rid of)\s+(?:the\s+|my\s+|our\s+)?(.+?)\s+group\b/i, action: "delete_group" },
  { re: /\b(?:delete|remove|drop)\s+(?:the\s+|my\s+|our\s+)?group\s+(.+)$/i, action: "delete_group" },
  // negative "show" phrasings first, so they never read as an un-suppress
  {
    re: /\b(?:don'?t|do not|never|no longer|stop)\s+show(?:ing)?\s+(?:me\s+)?follow-?ups?\s+(?:for|from|in|on)\s+(.+)$/i,
    action: "suppress_followups",
  },
  {
    re: /\b(?:re-?enable|re-?activate|resume|restart|turn\s+on|unmute|unsuppress|unhide|allow|start\s+showing|show)\s+(?:the\s+)?follow-?ups?\s+(?:for|on|in|from)\s+(.+)$/i,
    action: "unsuppress_followups",
  },
  {
    re: /\b(?:stop|mute|suppress|disable|hide|silence|pause|turn\s+off)\s+(?:the\s+)?follow-?ups?\s+(?:for|on|from|in)\s+(.+)$/i,
    action: "suppress_followups",
  },
  // "<group> shouldn't show as follow-ups" / "<group> should stop appearing in follow-ups"
  {
    re: /^(.+?)\s+(?:should\s*n[o']?t|shouldn'?t|do\s*n[o']?t|don'?t|does\s*n[o']?t|doesn'?t|no longer|should stop)\s+(?:ever\s+)?(?:show|showing|appear|appearing|surface|surfacing)(?:\s+up)?\s*(?:as|in|for|under)?\s*(?:my\s+|the\s+)?follow-?ups?/i,
    action: "suppress_followups",
  },
  // "<group> should show as follow-ups again"
  {
    re: /^(.+?)\s+(?:should|can|may)\s+(?:show|appear|surface)(?:\s+up)?\s*(?:as|in|for|under)?\s*(?:my\s+|the\s+)?follow-?ups?\s+again/i,
    action: "unsuppress_followups",
  },
];

/** Regex-only rule parsing. Returns null when nothing matches (caller may try the LLM). */
export function parseRuleDeterministic(text: string): RuleRequest | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const { re, action } of RULE_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const group = cleanGroupName(m[1]);
    if (!group) continue;
    return { action, group };
  }
  return null;
}

/** LLM mapping of a free-form rule request → a supported action. Null on no key / error. */
export async function parseRuleRequest(llm: LlmClient | null, message: string): Promise<RuleRequest | null> {
  if (!llm || !message.trim()) return null;
  const res = await llm.call(
    "assistant_rule",
    "fast",
    `You configure a personal CRM through natural-language rules. Map the user's request to exactly ONE supported action.
Supported actions:
- "suppress_followups": stop surfacing follow-ups for members of a named group (e.g. "people in my family group shouldn't show as follow-ups").
- "unsuppress_followups": re-enable follow-ups for a named group.
- "delete_group": delete a named group entirely (e.g. "delete the family group", "remove my recruiters group").
- "none": the request doesn't match a supported action.

For the group name, return just the name itself (e.g. "Family"), without the word "group" or articles like "the"/"my".

User request:
"""${message.slice(0, 300)}"""

Return STRICT JSON ONLY — no prose: { "action": "suppress_followups" | "unsuppress_followups" | "delete_group" | "none", "group": "<group name, or null>" }`,
    { json: true }
  );
  if (!res) return null;
  try {
    const p = extractJson(res.text) as Record<string, unknown>;
    const action = p.action;
    const group = cleanGroupName(typeof p.group === "string" ? p.group : null);
    if (action === "suppress_followups" || action === "unsuppress_followups" || action === "delete_group") {
      return { action, group };
    }
    return { action: "none", group };
  } catch {
    return null;
  }
}

// ── "remember: …" → a personal fact (main/context.ts) ────────────────────────
// Two layers, same shape as the rules engine above: the deterministic parser handles the
// phrasings that matter ("remember: school starts Sept 22", "I go to Stanford", "my
// birthday is March 4") for free and offline; the LLM only covers what it misses.

/** LLM parse of a free-form fact statement. Null on no key / bad JSON / nothing to store. */
export async function parseFactRequest(llm: LlmClient | null, message: string): Promise<FactRequest | null> {
  if (!llm || !message.trim()) return null;
  const todayISO = today();
  const res = await llm.call(
    "assistant_fact",
    "fast",
    `The user is telling their personal assistant a durable fact about THEMSELVES, to be remembered and reused later. Today is ${todayISO}.

Turn it into ONE stored fact:
- "key": lower_snake_case, stable and reusable. Use these exact keys when they fit: school, school_term_start, school_term_end, home_city, employer, birthday. Otherwise invent a short one ("gym", "advisor", "dorm").
- "value": the fact itself, under 120 characters, no leading "my"/"I".
- "kind": "date_anchor" when the fact IS a point in time the user will refer to colloquially later (a term start, a birthday, a move-in day); "recurring" when it repeats on a schedule; "fact" otherwise.
- "date": for a date_anchor, the resolved date as YYYY-MM-DD (pick the next upcoming occurrence when no year is stated). null for everything else.

Statement:
"""${message.slice(0, 300)}"""

Return STRICT JSON ONLY — no prose: { "key": "<key>", "value": "<value>", "kind": "fact" | "date_anchor" | "recurring", "date": "YYYY-MM-DD" | null }`,
    { json: true }
  );
  if (!res) return null;
  try {
    const p = extractJson(res.text) as Record<string, unknown>;
    const key = normalizeKey(typeof p.key === "string" ? p.key : null);
    const rawValue = typeof p.value === "string" ? p.value.replace(/\s+/g, " ").trim() : "";
    const date = typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date.slice(0, 10))
      ? p.date.slice(0, 10)
      : null;
    const kind: FactKind =
      p.kind === "date_anchor" ? "date_anchor" : p.kind === "recurring" ? "recurring" : "fact";
    const value = rawValue || date || "";
    if (!key || !value) return null;
    return { key, value, kind, date };
  } catch {
    return null;
  }
}

/** Store a parsed fact and describe what was kept, in the user's own terms. */
export function applyFact(db: Db, req: FactRequest): AssistantResult {
  const stored = setFact(db, {
    key: req.key,
    value: req.value,
    kind: req.kind,
    startsAt: req.date,
    source: "assistant",
  });
  const label = stored.key.replace(/_/g, " ");
  // The date is usually the value itself ("school starts Sept 22") — don't say it twice.
  const when =
    stored.kind === "date_anchor" && stored.starts_at && stored.starts_at !== stored.value
      ? ` (${stored.starts_at})`
      : "";
  return {
    kind: "note",
    reply: `Got it — I'll remember your ${label}: ${stored.value}${when}. Edit it any time in Settings → About you.`,
  };
}

interface GroupRow {
  id: number;
  name: string;
  suppress_follow_ups: number;
}

/** Case-insensitive exact name match, then a unique substring match. */
function findGroup(db: Db, name: string): GroupRow | null {
  const exact = db
    .prepare("SELECT id, name, suppress_follow_ups FROM grp WHERE LOWER(name) = LOWER(?)")
    .get(name) as GroupRow | undefined;
  if (exact) return exact;
  const like = db
    .prepare("SELECT id, name, suppress_follow_ups FROM grp WHERE LOWER(name) LIKE LOWER(?) LIMIT 2")
    .all(`%${name}%`) as GroupRow[];
  return like.length === 1 ? like[0] : null;
}

const memberCount = (db: Db, groupId: number): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM person_group WHERE group_id = ?").get(groupId) as { n: number }).n;

const CANT = "I can't do that one yet. I can mute or re-enable follow-ups for a group, or delete a group.";

/** Execute a parsed rule against the DB and describe what changed. */
export function applyRule(db: Db, req: RuleRequest): AssistantResult {
  if (req.action === "none") return { kind: "error", reply: CANT };
  if (!req.group) return { kind: "error", reply: "Which group? Try: \"stop follow-ups for family\"." };

  const grp = findGroup(db, req.group);
  if (!grp) return { kind: "error", reply: `I don't have a group called "${req.group}".` };
  const members = memberCount(db, grp.id);

  if (req.action === "delete_group") {
    // person_group rows cascade (ON DELETE CASCADE); the people themselves are untouched.
    db.prepare("DELETE FROM grp WHERE id = ?").run(grp.id);
    return {
      kind: "rule",
      reply: `Deleted the "${grp.name}" group. ${members} ${members === 1 ? "person keeps their" : "people keep their"} record — only the grouping is gone.`,
    };
  }

  const on = req.action === "suppress_followups" ? 1 : 0;
  db.prepare("UPDATE grp SET suppress_follow_ups = ? WHERE id = ?").run(on, grp.id);
  if (grp.suppress_follow_ups === on) {
    return {
      kind: "rule",
      reply: on
        ? `Follow-ups were already off for "${grp.name}".`
        : `Follow-ups were already on for "${grp.name}".`,
    };
  }
  return {
    kind: "rule",
    reply: on
      ? `Follow-ups are off for "${grp.name}" — ${members} ${members === 1 ? "person" : "people"} will stop showing in Reconnect.`
      : `Follow-ups are back on for "${grp.name}" — ${members} ${members === 1 ? "person" : "people"} can surface in Reconnect again.`,
  };
}

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
{"intent":"plan_day"|"add_event"|"find_people"|"add_note"|"log_work"|"remember"|"search"|"rule"|"question","person":"<name if the command is about a specific person, else null>","content":"<the note text if add_note, else the original>"}
"plan_day" = a braindump of tasks to schedule, or asking to plan the day.
"add_event" = ONE specific commitment at a stated time ("lunch with Raj Thursday 1pm", "dentist tomorrow at 9"). A time must be stated or clearly implied.
"find_people" = who should I talk to / reach out to / intro ideas.
"add_note" = remember/save a fact about a person in the network.
"log_work" = record something the USER did into their worklog ("log: shipped the deck", "log closed the Series A intro").
"remember" = a durable fact about the USER THEMSELVES, not about a contact ("remember: school starts Sept 22", "I go to Stanford", "my birthday is March 4", "I live in Dallas"). Facts about someone else in the network are add_note, not remember.
"rule" = change how the CRM behaves for a GROUP of people ("my family group shouldn't show as follow-ups", "stop follow-ups for recruiters", "re-enable follow-ups for investors", "delete the mentors group").
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
  // Same for the "remember: …" prefix — it must never be read as a note about a contact.
  if (REMEMBER_PREFIX.test(t)) intent = "remember";
  // Group rules are unambiguous when a pattern matches, so they win over the classifier.
  const ruleReq = parseRuleDeterministic(t);
  if (ruleReq) intent = "rule";

  try {
    if (intent === "rule") {
      const req = ruleReq ?? (await parseRuleRequest(llm, t)) ?? { action: "none" as const, group: null };
      return applyRule(db, req);
    }

    if (intent === "remember") {
      // Deterministic first (free, offline, predictable), LLM only for what it misses.
      const req = parseFactDeterministic(t) ?? (await parseFactRequest(llm, t));
      if (!req) {
        return {
          kind: "error",
          reply: "What should I remember? Try: \"remember: school starts Sept 22\" or \"remember: I go to Stanford\".",
        };
      }
      return applyFact(db, req);
    }

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
      // "met X …" / "just met them" is the QuickNote "I just met them" checkbox in prose:
      // it bumps last_contact_at for real. A plain note only fills a never-contacted blank.
      const metToday = /^met\b/i.test(t) || /\bjust met\b/i.test(t);
      const res = await patchPersonWithExtract(
        db,
        llm,
        hit.id,
        { bio: `${hit.bio ? hit.bio + "\n" : ""}${line}` },
        { metToday }
      );
      if (!metToday) {
        db.prepare("UPDATE person SET last_contact_at = COALESCE(last_contact_at, datetime('now')) WHERE id = ?").run(hit.id);
      }
      const followUp = res.detectedFollowUp ? ` Follow-up tracked: "${res.detectedFollowUp.description}".` : "";
      return {
        kind: "note",
        reply: `Noted on ${hit.display_name}: "${line}"${metToday ? " — last contact set to today." : ""}${followUp}`,
        results: [{ id: hit.id, name: hit.display_name, reason: "updated" }],
      };
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
    // Personal context first (main/context.ts): "what do I have when school starts" is
    // unanswerable without knowing when the user's school starts.
    const about = contextBlock(db);
    const context = `${about ? `${about}\n\n` : ""}TODAY'S PLAN: ${blocks || "(none generated)"}\nOPEN COMMITMENTS: ${commitments || "(none)"}\nRECONNECT DUE: ${due || "(none)"}\nRECENT MESSAGES: ${recent || "(none)"}\nRECENT WORKLOG: ${worklog || "(none)"}`;
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
