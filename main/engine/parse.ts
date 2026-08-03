// Stage 2 (§5.5) — LLM (fast tier). Parses a free-text braindump into typed tasks.
// The prompt FORBIDS time assignment: the LLM decides WHAT a task is, never WHEN.
// Buffers are applied in code after parsing, not in the prompt.
// Degrades to a deterministic keyword parser when the LLM is unavailable.

import { BLOCK_DEFAULTS, BLOCK_TYPES, bufferedMinutes, type BlockType, type Doctrine } from "./doctrine.ts";
import { extractJson, type LlmClient } from "../llm/provider.ts";

export interface ParsedTask {
  title: string;
  blockType: BlockType;
  cognitiveLoad: number;
  rawEstimateMinutes: number;
  estimatedMinutes: number; // buffered, ceil-15
  isMit: boolean;
  hardDeadlineAt: string | null; // ISO, resolved by caller against plan date
  personHint: string | null;
  splittable: boolean;
  estimateSource: "stated" | "inferred";
  reasoning: string;
}

const PARSE_PROMPT = (text: string) => `You classify tasks for a day planner. Parse the braindump below into a JSON array.

For each distinct task output exactly:
{
  "title": "<short imperative title>",
  "block_type": "<one of: deep_work | focused_work | admin | comms | meeting | gym | personal>",
  "cognitive_load": <1-5>,
  "raw_estimate_minutes": <integer>,
  "estimate_source": "stated" | "inferred",
  "is_mit": <true for the single most important task, at most one>,
  "hard_deadline_hhmm": "<HH:MM 24h today, ONLY if the text states a hard deadline, else null>",
  "person_hint": "<a person's name if the task involves someone specific, else null>",
  "splittable": <true if the work can split across two sessions>,
  "reasoning": "<one line, for the audit trail>"
}

Classification guide: deep_work = creative/analytical, load 4-5, needs long focus (problem sets,
writing, coding, design). focused_work = load 3, under an hour of real focus. admin = load 1-2
chores (forms, email cleanup, booking). comms = replies/outreach. gym = exercise. personal = errands, social.

Rules:
- NEVER assign times of day, ordering, or schedule — that is not your job.
- If duration is unstated, estimate from the task type and set estimate_source "inferred".
- Long deep work is almost always splittable.
- Return STRICT JSON only: a bare array, no preamble, no markdown fences.

BRAINDUMP:
"""${text.slice(0, 4000)}"""`;

export async function parseBraindump(
  text: string,
  doctrine: Doctrine,
  llm: LlmClient | null
): Promise<{ tasks: ParsedTask[]; usedLlm: boolean }> {
  if (llm) {
    const res = await llm.call("plan_parse", "fast", PARSE_PROMPT(text), { json: true });
    if (res) {
      try {
        const raw = extractJson(res.text);
        const tasks = coerce(raw, doctrine);
        if (tasks.length > 0) return { tasks, usedLlm: true };
      } catch (e) {
        console.warn(`parseBraindump: bad LLM output (${(e as Error).message}); falling back`);
      }
    }
  }
  return { tasks: deterministicParse(text, doctrine), usedLlm: false };
}

function coerce(raw: unknown, doctrine: Doctrine): ParsedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedTask[] = [];
  let mitSeen = false;
  for (const r of raw as Record<string, unknown>[]) {
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue;
    const btRaw = typeof r.block_type === "string" ? r.block_type : "focused_work";
    const blockType = (BLOCK_TYPES as readonly string[]).includes(btRaw) ? (btRaw as BlockType) : "focused_work";
    const load = clampInt(r.cognitive_load, 1, 5, BLOCK_DEFAULTS[blockType].load || 3);
    const rawEst = clampInt(r.raw_estimate_minutes, 5, 12 * 60, BLOCK_DEFAULTS[blockType].minutes);
    const isMit = r.is_mit === true && !mitSeen;
    if (isMit) mitSeen = true;
    const hhmm = typeof r.hard_deadline_hhmm === "string" && /^\d{2}:\d{2}$/.test(r.hard_deadline_hhmm)
      ? r.hard_deadline_hhmm
      : null;
    out.push({
      title,
      blockType,
      cognitiveLoad: load,
      rawEstimateMinutes: rawEst,
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst),
      isMit,
      hardDeadlineAt: hhmm,
      personHint: typeof r.person_hint === "string" && r.person_hint.trim() ? r.person_hint.trim() : null,
      splittable: r.splittable === true,
      estimateSource: r.estimate_source === "stated" ? "stated" : "inferred",
      reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    });
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ── deterministic fallback (no LLM): line/comma split + keyword classification ──
const KEYWORDS: [RegExp, BlockType, number][] = [
  [/\bgym\b|work ?out|lift|run\b|exercise/i, "gym", 0],
  [/\bemail|reply|respond|follow ?up|message|text|call\b|reach out/i, "comms", 2],
  [/\bform|book|schedule|expense|invoice|renew|pay |errand|order\b/i, "admin", 2],
  [/\bpset|problem set|essay|write|paper|design|build|code|study|research|deck\b/i, "deep_work", 5],
  [/\bmeet|meeting|1:1|sync\b/i, "meeting", 3],
];

export function deterministicParse(text: string, doctrine: Doctrine): ParsedTask[] {
  const parts = text
    .split(/\n|,|;| and /i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  const out: ParsedTask[] = [];
  for (const p of parts) {
    let blockType: BlockType = "focused_work";
    let load = 3;
    for (const [re, bt, l] of KEYWORDS) {
      if (re.test(p)) {
        blockType = bt;
        load = l || BLOCK_DEFAULTS[bt].load || 3;
        break;
      }
    }
    // stated duration: "2h", "2 hrs", "90 min", "1.5 hours"
    const hr = p.match(/(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\b/i);
    const mn = p.match(/(\d+)\s*min/i);
    const stated = hr ? Math.round(parseFloat(hr[1]) * 60) : mn ? parseInt(mn[1], 10) : null;
    const rawEst = stated ?? BLOCK_DEFAULTS[blockType].minutes;
    out.push({
      title: p.replace(/\s*\(?\d+(?:\.\d+)?\s*h(?:ou)?rs?\)?|\s*\(?\d+\s*min\s*\)?/gi, "").trim() || p,
      blockType,
      cognitiveLoad: load,
      rawEstimateMinutes: rawEst,
      estimatedMinutes: bufferedMinutes(doctrine, blockType, rawEst),
      isMit: false,
      hardDeadlineAt: null,
      personHint: null,
      splittable: blockType === "deep_work" && rawEst > 120,
      estimateSource: stated ? "stated" : "inferred",
      reasoning: "deterministic fallback (no LLM)",
    });
  }
  return out;
}
