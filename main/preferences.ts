// Personal preferences — the FREE-TEXT half of the app's memory of its owner.
//
// Owner ask 2026-08-05: "in the morning I'd like half an hour to shower and read before
// starting anything. Stuff like this — personal preference context — should be givable to
// the sparkle box AND live as files I can read and edit."
//
// So this is a plain Markdown file at ~/Library/Application Support/pos/preferences.md,
// next to doctrine.yaml. He owns it: the app seeds a commented template once, reads it
// into the prompts where judgment happens, and only ever APPENDS a line when he says
// "prefer: …". It never rewrites his prose.
//
// ── the boundary with main/context.ts ────────────────────────────────────────
//
//   context.ts (user_fact table)  = STRUCTURED FACTS. Things with a key and often a date:
//     school, school_term_start, home_city, birthday. They exist to be RESOLVED against
//     ("start of school" → 2026-09-22) by deterministic code with no LLM. A fact is
//     queryable; that is the whole point of the table.
//
//   preferences.md (this file)    = FREE-TEXT PREFERENCES. Habits, tastes, standing rules:
//     "the first 30 minutes after waking are mine", "no meetings before 10". Nothing here
//     resolves to a value — it INFORMS judgment, so it belongs in a prompt, not a column.
//     Trying to schematize a preference is how you lose the half of it that mattered.
//
// The layering is deliberate and matches where the ecosystem landed (CLAUDE.md / AGENTS.md
// style human-owned prose next to a structured store): the DB holds what must be queried,
// the file holds what must be read, and BOTH are prepended to the prompts that judge.
//
// A preference alone cannot reserve time — only the doctrine can. The owner's morning
// preference is therefore ALSO a fixed ritual in engine/doctrine.ts; see the comment there.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import type { LlmClient, LlmOptions, LlmTier } from "./llm/provider.ts";

/** The file name, alongside doctrine.yaml in the same user-owned directory. */
export const PREFERENCES_FILE = "preferences.md";

/** The sections the template ships with. Free-form headers are still allowed. */
export const PREFERENCE_SECTIONS = [
  "Mornings",
  "Deep work",
  "Meetings",
  "Communication",
  "Personal",
] as const;

export type PreferenceSection = (typeof PREFERENCE_SECTIONS)[number];

/** Full path to the preferences file inside `dir`. */
export function preferencesPath(dir: string): string {
  return path.join(dir, PREFERENCES_FILE);
}

/**
 * Seeded once, on the first read. Every example is inside an HTML comment: the app strips
 * comments before prompting, so a freshly seeded file contributes NOTHING to any prompt.
 * The template is instructions for the human, not content for the model.
 */
export const DEFAULT_PREFERENCES_MD = `# Preferences

<!--
This file is yours. POS reads it; it never rewrites it. The only thing the app writes here
is a new bullet when you say "prefer: ..." in the command box.

It is read by the PLANNER (parsing your braindump, narrating the finished day) and by the
ASSISTANT (answering questions, planning your day) and by message extraction. Keep it in
your own words — one preference per bullet, under a section header.

Anything inside an HTML comment like this one is ignored by the app.

Dated facts about you ("school starts Sept 22", "I live in Dallas") are NOT preferences —
they belong in Settings > About you, where the app can resolve dates against them.
-->

## Mornings

<!-- Example: The first 30 minutes after I wake up are mine - shower and reading, nothing scheduled. -->

## Deep work

<!-- Example: I want my hardest block before noon, and I would rather do 90 minutes once than 45 twice. -->

## Meetings

<!-- Example: No meetings before 10:00, and never two back to back without a gap. -->

## Communication

<!-- Example: I answer email in batches, not as it lands. Texts can wait until the evening. -->

## Personal

<!-- Example: Gym in the late afternoon, and dinner is not a working meal. -->
`;

/**
 * Read the file, seeding the commented template on the FIRST read — the same contract as
 * loadDoctrine(). This is the call the Settings card and appendPreference() use, because
 * both want the file to exist afterwards.
 */
export function readPreferences(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = preferencesPath(dir);
  if (!fs.existsSync(file)) fs.writeFileSync(file, DEFAULT_PREFERENCES_MD, "utf8");
  return fs.readFileSync(file, "utf8");
}

/**
 * Replace the whole file with the user's text. The ONLY validation is non-empty — this is
 * his prose, and there is no schema he can get wrong. Throws on empty so a mis-click in
 * Settings can't silently erase the file.
 */
export function writePreferences(dir: string, md: string): string {
  const text = (md ?? "").trim();
  if (!text) throw new Error("preferences cannot be empty");
  fs.mkdirSync(dir, { recursive: true });
  const out = `${text}\n`;
  fs.writeFileSync(preferencesPath(dir), out, "utf8");
  return out;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** "## Mornings" → "Mornings"; null for any other line. */
function headerName(line: string): string | null {
  const m = line.match(/^\s*##\s+(.*?)\s*$/);
  return m ? m[1] : null;
}

const sameSection = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** "- shower first" / "shower first" → "- Shower first". Bullets are the storage form. */
function bulletize(line: string): string {
  const body = (line ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-*+]\s*/, "")
    .trim();
  if (!body) return "";
  return `- ${body.charAt(0).toUpperCase()}${body.slice(1)}`;
}

export interface AppendResult {
  /** false when the identical line was already in the file. */
  added: boolean;
  /** The section it landed in (or would have). */
  section: string;
  /** The bullet as stored. */
  line: string;
  /** Absolute path, so the caller can tell the user where his words went. */
  file: string;
}

/**
 * Append ONE preference bullet under `section`, creating the section when it is absent and
 * refusing to write a line the file already carries (case-insensitively, anywhere — the
 * same preference filed under two headers is still one preference).
 *
 * Insertion goes at the END of the section's body, so the shipped example comment stays
 * above the user's real lines and the file keeps reading top-to-bottom.
 */
export function appendPreference(dir: string, section: string, line: string): AppendResult {
  const sec = (section ?? "").replace(/\s+/g, " ").trim() || "Personal";
  const bullet = bulletize(line);
  const file = preferencesPath(dir);
  if (!bullet) throw new Error("preference line required");

  const current = readPreferences(dir);
  const lines = current.split("\n");

  // Dedupe against the file's real content (comments stripped), not against its examples.
  const existing = new Set(
    current
      .replace(HTML_COMMENT, "")
      .split("\n")
      .map((l) => bulletize(l).toLowerCase())
      .filter((l) => l.length > 0)
  );
  if (existing.has(bullet.toLowerCase())) return { added: false, section: sec, line: bullet, file };

  // Find the section, then the end of its body (the line before the next "## ", or EOF).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = headerName(lines[i]);
    if (name !== null && sameSection(name, sec)) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    // New section, appended at the end of the file.
    const body = current.replace(/\s+$/, "");
    fs.writeFileSync(file, `${body}\n\n## ${sec}\n\n${bullet}\n`, "utf8");
    return { added: true, section: sec, line: bullet, file };
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headerName(lines[i]) !== null) {
      end = i;
      break;
    }
  }
  // Trim the section's trailing blank lines so the bullet joins the body, not the gap.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, bullet);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return { added: true, section: sec, line: bullet, file };
}

export interface PreferencesBlockOptions {
  /** Hard cap on the returned string. Prompts are shared real estate. */
  maxChars?: number;
}

/**
 * The prompt-ready rendering: comments and blank lines stripped, section headers kept,
 * empty sections dropped, capped at `maxChars`.
 *
 * Deliberately does NOT seed the file. A prompt path must never create files as a side
 * effect of being called — and a freshly seeded template is all comments anyway, so it
 * would render to nothing regardless. Missing file, unreadable file, no content → "",
 * which callers can concatenate unconditionally.
 */
export function preferencesBlock(dir: string, opts: PreferencesBlockOptions = {}): string {
  const maxChars = Math.max(0, opts.maxChars ?? 1200);
  if (maxChars === 0) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(preferencesPath(dir), "utf8");
  } catch {
    return ""; // not seeded yet, or unreadable — silence is the right answer
  }

  // Group content lines under their header so a header with nothing under it can be dropped.
  const groups: { header: string | null; lines: string[] }[] = [];
  let current: { header: string | null; lines: string[] } = { header: null, lines: [] };
  for (const rawLine of raw.replace(HTML_COMMENT, "").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const name = headerName(line);
    if (name !== null) {
      groups.push(current);
      current = { header: name, lines: [] };
      continue;
    }
    if (/^\s*#\s+/.test(line)) continue; // the "# Preferences" title carries no information
    current.lines.push(line.trim());
  }
  groups.push(current);

  const kept = groups.filter((g) => g.lines.length > 0);
  if (kept.length === 0) return "";

  const head =
    "USER PREFERENCES (from their own preferences.md — how they want their time and work handled; honor these unless something harder conflicts):";
  const out: string[] = [head];
  let size = head.length;
  for (const g of kept) {
    const chunk = (g.header ? [`## ${g.header}`] : []).concat(g.lines);
    for (const l of chunk) {
      if (size + 1 + l.length > maxChars) return out.join("\n");
      out.push(l);
      size += 1 + l.length;
    }
  }
  return out.join("\n");
}

/**
 * Where the preferences file lives when nobody passed a directory in. Inside Electron
 * that's userData (pinned to ~/Library/Application Support/pos in main/index.ts); outside
 * Electron (tests, scripts) the same path via os.homedir. Mirrors capture.resolveDoctrineDir
 * rather than importing it — commitments.ts must not pull the capture pipeline in.
 */
export function resolvePreferencesDir(): string {
  try {
    const electron = createRequire(import.meta.url)("electron") as {
      app?: { getPath(name: string): string };
    };
    const p = electron.app?.getPath("userData");
    if (p) return p;
  } catch {
    /* not running inside Electron */
  }
  return path.join(homedir(), "Library", "Application Support", "pos");
}

/**
 * Wrap an LlmClient so the named features get the preferences block prepended to their
 * prompt. This is how the block reaches prompts that live in modules whose signatures take
 * no context argument (engine/parse.ts's braindump parse, engine/narrate.ts's narration):
 * the caller injects at the client, and those modules stay unaware.
 *
 * Returns the ORIGINAL client when there is nothing to say, so the common case adds no
 * indirection. The wrapper delegates to the real client, so metering, key selection and
 * the never-throw contract are untouched.
 */
export function withPreferences(
  llm: LlmClient | null,
  dir: string,
  features: readonly string[],
  opts: PreferencesBlockOptions = {}
): LlmClient | null {
  if (!llm) return null;
  let block = "";
  try {
    block = preferencesBlock(dir, opts);
  } catch {
    return llm;
  }
  if (!block) return llm;
  const wanted = new Set(features);
  const wrapper = Object.create(llm) as LlmClient;
  (wrapper as { call: LlmClient["call"] }).call = (
    feature: string,
    tier: LlmTier,
    prompt: string,
    callOpts?: LlmOptions
  ) => llm.call(feature, tier, wanted.has(feature) ? `${block}\n\n${prompt}` : prompt, callOpts);
  return wrapper;
}
