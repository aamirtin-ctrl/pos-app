// Stage 4 (§5.7) — LLM (smart tier). 3-5 sentences: the shape of the day, what got
// prioritized, what got cut and why, one flag if over-committed. No emoji. No
// motivational language. Chief of staff, not a wellness app.
// Deterministic template fallback when the LLM is unavailable.

import { shutdownStartMin, type Doctrine } from "./doctrine.ts";
import { DEFERRED_REASON, nextDayInWindow, type SolveResult, type PlacedBlock } from "./solver.ts";
import type { LlmClient } from "../llm/provider.ts";

const fmt = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "2026-08-07" → "Friday". Falls back to the raw date if it is unparseable. */
const dayName = (dateISO: string | null | undefined): string => {
  if (!dateISO) return "a later day";
  const t = Date.parse(`${dateISO}T00:00:00Z`);
  return Number.isNaN(t) ? dateISO : WEEKDAYS[new Date(t).getUTCDay()];
};

/**
 * Deferrals are not losses and must never be narrated as ones. A windowed task that moved has
 * days left; the task that stayed does not. That is a CHOICE the engine made on his behalf,
 * and the sentence has to read like one — "Advising moved to Friday; it has until Sunday and
 * the test doesn't", never "1 task did not fit".
 */
const deferralSentence = (result: SolveResult): string | null => {
  const moved = result.unplaced.filter((u) => u.reason === DEFERRED_REASON);
  if (moved.length === 0) return null;
  const clauses = moved.map((u) => {
    const to = dayName(nextDayInWindow(u.task));
    const until = u.task.windowEnd ? `, and it has until ${dayName(u.task.windowEnd)}` : "";
    return `${u.task.title} moved to ${to}${until}`;
  });
  return `${clauses.join("; ")} — today's work does not.`;
};

export async function narrate(
  result: SolveResult,
  doctrine: Doctrine,
  llm: LlmClient | null
): Promise<string> {
  const summary = summarize(result);
  const closes = shutdownStartMin(doctrine);
  // Two different things wearing one field. A deferral is a scheduling DECISION; an unplaced
  // task is work that fell off. Handing the model one undifferentiated list is how "moved to
  // Friday, it has all week" turns into "did not fit" in the summary he actually reads.
  const moved = result.unplaced.filter((u) => u.reason === DEFERRED_REASON);
  const dropped = result.unplaced.filter((u) => u.reason !== DEFERRED_REASON);
  if (llm) {
    const prompt = `You are a chief of staff summarizing a generated day plan. Write 3-5 plain sentences:
the shape of the day, what got prioritized, what got cut and why, and one specific flag if the
day is over-committed. No emoji. No motivational language. No bullet points.
${
  closes === null
    ? ""
    : `\nThe work day CLOSES at ${fmt(closes)} (the shutdown ritual). Free time after that hour is
deliberate — never suggest moving work into it, and never call it wasted or available.\n`
}
PLAN:
${summary}

MOVED TO A LATER DAY (these are NOT cut and NOT failures — each one has a deadline window with
days left in it, so the planner chose to give today's minutes to work that has only today.
Report each as a deliberate choice and say where it went and how long it still has):
${
  moved.length === 0
    ? "(none)"
    : moved
        .map(
          (u) =>
            `- ${u.task.title}: moved to ${dayName(nextDayInWindow(u.task))}` +
            (u.task.windowEnd ? `, has until ${dayName(u.task.windowEnd)} (${u.task.windowEnd})` : "")
        )
        .join("\n")
}

UNPLACED (work that did NOT fit anywhere, with reasons):
${dropped.length === 0 ? "(none)" : dropped.map((u) => `- ${u.task.title}: ${u.reason}`).join("\n")}

NOTES FROM THE SOLVER:
${result.notes.length === 0 ? "(none)" : result.notes.map((n) => `- ${n}`).join("\n")}`;
    const res = await llm.call("narration", "smart", prompt, { maxTokens: 400 });
    if (res?.text.trim()) return res.text.trim();
  }
  return deterministicNarration(result, doctrine);
}

function summarize(result: SolveResult): string {
  return result.blocks
    .map((b: PlacedBlock) => `${fmt(b.startMin)}-${fmt(b.endMin)} ${b.blockType}: ${b.title}${b.isAnchor ? " (fixed)" : ""}`)
    .join("\n");
}

/**
 * `doctrine` is optional only so older callers keep compiling; pass it when you have it.
 * With it, the over-commitment flag names the real cause — the work day has an end, and
 * tasks that missed it were deferred rather than pushed into the evening.
 */
export function deterministicNarration(result: SolveResult, doctrine?: Doctrine): string {
  const deep = result.blocks.filter((b) => b.blockType === "deep_work");
  const meetings = result.blocks.filter((b) => b.blockType === "meeting");
  const parts: string[] = [];
  if (deep.length > 0) {
    const mins = deep.reduce((s, b) => s + (b.endMin - b.startMin), 0);
    parts.push(
      `The day carries ${deep.length} deep work block${deep.length > 1 ? "s" : ""} (${mins} minutes), the first starting at ${fmt(deep[0].startMin)}.`
    );
  } else {
    parts.push("No deep work is scheduled today.");
  }
  if (meetings.length > 0) parts.push(`${meetings.length} meeting${meetings.length > 1 ? "s are" : " is"} on the calendar.`);
  const deferred = deferralSentence(result);
  if (deferred) parts.push(deferred);
  const dropped = result.unplaced.filter((u) => u.reason !== DEFERRED_REASON);
  if (dropped.length > 0) {
    parts.push(
      `${dropped.length} task${dropped.length > 1 ? "s" : ""} did not fit: ` +
        dropped.map((u) => `${u.task.title} (${u.reason.replace(/_/g, " ")})`).join(", ") + "."
    );
    const closes = doctrine ? shutdownStartMin(doctrine) : null;
    parts.push(
      closes === null
        ? "The day is over-committed; either defer these explicitly or cut scope now rather than at 22:00."
        : `The work day closes at ${fmt(closes)}, so the overflow is deferred rather than pushed into the evening; defer it explicitly or cut scope now.`
    );
  }
  if (result.notes.length > 0) parts.push(result.notes[0]);
  return parts.slice(0, 5).join(" ");
}
