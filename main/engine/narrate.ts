// Stage 4 (§5.7) — LLM (smart tier). 3-5 sentences: the shape of the day, what got
// prioritized, what got cut and why, one flag if over-committed. No emoji. No
// motivational language. Chief of staff, not a wellness app.
// Deterministic template fallback when the LLM is unavailable.

import { shutdownStartMin, type Doctrine } from "./doctrine.ts";
import type { SolveResult, PlacedBlock } from "./solver.ts";
import type { LlmClient } from "../llm/provider.ts";

const fmt = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export async function narrate(
  result: SolveResult,
  doctrine: Doctrine,
  llm: LlmClient | null
): Promise<string> {
  const summary = summarize(result);
  const closes = shutdownStartMin(doctrine);
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

UNPLACED (with reasons):
${result.unplaced.length === 0 ? "(none)" : result.unplaced.map((u) => `- ${u.task.title}: ${u.reason}`).join("\n")}

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
  if (result.unplaced.length > 0) {
    parts.push(
      `${result.unplaced.length} task${result.unplaced.length > 1 ? "s" : ""} did not fit: ` +
        result.unplaced.map((u) => `${u.task.title} (${u.reason.replace(/_/g, " ")})`).join(", ") + "."
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
