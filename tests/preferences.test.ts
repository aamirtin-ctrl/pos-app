// Personal preferences — the free-text half of the app's memory (main/preferences.ts).
//
// Owner ask 2026-08-05: "in the morning I'd like half an hour to shower and read before
// starting anything… should be givable to the sparkle box AND live as files I can read and
// edit." These tests pin both halves of that: the file behaves like a file (seeded once,
// appended to, never duplicated, rendered compactly into prompts), and the command box
// routes a preference to it WITHOUT stealing a dated fact from main/context.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPreferences,
  writePreferences,
  appendPreference,
  preferencesBlock,
  preferencesPath,
  DEFAULT_PREFERENCES_MD,
  PREFERENCE_SECTIONS,
  withPreferences,
} from "../main/preferences.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import {
  parsePreferenceDeterministic,
  applyPreference,
  sectionForPreference,
  PREFER_PREFIX,
} from "../main/assistant.ts";
import { parseFactDeterministic } from "../main/context.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../main/engine/doctrine.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-prefs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => fs.readFileSync(preferencesPath(dir), "utf8");

describe("the file", () => {
  it("seeds the commented template on a first-ever read, then never re-seeds", () => {
    expect(fs.existsSync(preferencesPath(dir))).toBe(false);
    const first = readPreferences(dir);
    expect(first).toBe(DEFAULT_PREFERENCES_MD);
    for (const s of PREFERENCE_SECTIONS) expect(first).toContain(`## ${s}`);
    // The template says what reads it — the file has to explain itself to its owner.
    expect(first).toMatch(/PLANNER/);
    expect(first).toMatch(/ASSISTANT/);

    // An edited file is not re-seeded, and an emptied one is a legitimate state.
    writePreferences(dir, "## Mornings\n\n- Mine.");
    expect(readPreferences(dir)).toContain("- Mine.");
    expect(readPreferences(dir)).not.toContain("Example:");
  });

  it("seeds a directory that does not exist yet", () => {
    const nested = path.join(dir, "a", "b");
    expect(readPreferences(nested)).toBe(DEFAULT_PREFERENCES_MD);
  });

  it("refuses to write an empty file", () => {
    expect(() => writePreferences(dir, "   \n  ")).toThrow(/empty/i);
  });
});

describe("appendPreference", () => {
  it("appends into an existing section, below the shipped example", () => {
    const r = appendPreference(dir, "Mornings", "The first 30 minutes after I wake up are mine.");
    expect(r.added).toBe(true);
    expect(r.section).toBe("Mornings");
    expect(r.line).toBe("- The first 30 minutes after I wake up are mine.");

    const md = read();
    const mornings = md.indexOf("## Mornings");
    const deep = md.indexOf("## Deep work");
    const line = md.indexOf("- The first 30 minutes");
    expect(line).toBeGreaterThan(mornings);
    expect(line).toBeLessThan(deep); // it landed IN the section, not at the end of the file
    // The rest of the owner's file is untouched.
    expect(md).toContain("## Communication");
  });

  it("creates a section that isn't there yet", () => {
    appendPreference(dir, "Travel", "I don't fly on Mondays.");
    const md = read();
    expect(md).toContain("## Travel");
    expect(md.indexOf("- I don't fly on Mondays.")).toBeGreaterThan(md.indexOf("## Travel"));
    expect(preferencesBlock(dir)).toContain("## Travel");
  });

  it("dedupes identical lines, including across sections and bullet styles", () => {
    expect(appendPreference(dir, "Meetings", "No meetings before 10.").added).toBe(true);
    expect(appendPreference(dir, "Meetings", "no meetings before 10.").added).toBe(false);
    expect(appendPreference(dir, "Meetings", "- No meetings before 10.").added).toBe(false);
    // Same preference, different section — still one preference.
    expect(appendPreference(dir, "Personal", "No meetings before 10.").added).toBe(false);
    expect(read().match(/No meetings before 10\./g)).toHaveLength(1);
  });

  it("keeps section lookup case-insensitive so 'mornings' doesn't fork the file", () => {
    appendPreference(dir, "Mornings", "Shower first.");
    appendPreference(dir, "mornings", "Then read.");
    expect(read().match(/## Mornings/gi)).toHaveLength(1);
  });

  it("requires a line", () => {
    expect(() => appendPreference(dir, "Mornings", "   ")).toThrow(/required/i);
  });
});

describe("preferencesBlock", () => {
  it("is empty before the file exists, and empty for a freshly seeded template", () => {
    expect(preferencesBlock(dir)).toBe("");
    readPreferences(dir); // all comments, no content
    expect(preferencesBlock(dir)).toBe("");
  });

  it("does not create the file — a prompt path must not have side effects", () => {
    preferencesBlock(dir);
    expect(fs.existsSync(preferencesPath(dir))).toBe(false);
  });

  it("strips comments and blank lines, keeps section headers, drops empty sections", () => {
    writePreferences(
      dir,
      `# Preferences

<!-- a note to myself that the model must never see -->

## Mornings

<!-- Example: something -->
- Half an hour to shower and read before anything else.

## Deep work

## Meetings
- No meetings before 10.
`
    );
    const block = preferencesBlock(dir);
    expect(block).not.toContain("never see");
    expect(block).not.toContain("Example:");
    expect(block).not.toContain("# Preferences");
    expect(block).toContain("## Mornings");
    expect(block).toContain("- Half an hour to shower and read before anything else.");
    expect(block).toContain("## Meetings");
    expect(block).not.toContain("## Deep work"); // header with nothing under it carries nothing
    expect(block.split("\n").every((l) => l.trim().length > 0)).toBe(true);
  });

  it("respects maxChars", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `- Preference number ${i} with some words in it.`);
    writePreferences(dir, `## Personal\n\n${lines.join("\n")}\n`);
    expect(preferencesBlock(dir).length).toBeLessThanOrEqual(1200); // the default
    for (const cap of [200, 500, 900]) {
      expect(preferencesBlock(dir, { maxChars: cap }).length).toBeLessThanOrEqual(cap);
    }
    expect(preferencesBlock(dir, { maxChars: 0 })).toBe("");
    // Truncation drops the tail, never mangles a line.
    const short = preferencesBlock(dir, { maxChars: 300 });
    for (const l of short.split("\n").slice(1)) expect(lines.includes(l) || l.startsWith("## ")).toBe(true);
  });
});

describe("withPreferences (how the block reaches prompts owned by other modules)", () => {
  const fakeLlm = (calls: { feature: string; prompt: string }[]) =>
    ({
      call: async (feature: string, _tier: string, prompt: string) => {
        calls.push({ feature, prompt });
        return { text: "[]", model: "fake", inputTokens: 0, outputTokens: 0 };
      },
    }) as unknown as LlmClient;

  it("prepends the block for the named features only, and passes everything else through", async () => {
    writePreferences(dir, "## Mornings\n\n- The first 30 minutes are mine.\n");
    const calls: { feature: string; prompt: string }[] = [];
    const wrapped = withPreferences(fakeLlm(calls), dir, ["plan_parse", "narration"])!;
    await wrapped.call("plan_parse", "fast", "PARSE THIS", { json: true });
    await wrapped.call("narration", "smart", "NARRATE THIS");
    await wrapped.call("assistant_route", "fast", "CLASSIFY THIS");

    expect(calls[0].prompt).toContain("The first 30 minutes are mine.");
    expect(calls[0].prompt).toContain("PARSE THIS");
    expect(calls[1].prompt).toContain("The first 30 minutes are mine.");
    expect(calls[2].prompt).toBe("CLASSIFY THIS"); // untouched
  });

  it("returns the client itself when there is nothing to say, and null for a null client", () => {
    const llm = fakeLlm([]);
    expect(withPreferences(llm, dir, ["plan_parse"])).toBe(llm); // no file yet
    readPreferences(dir); // template only — all comments
    expect(withPreferences(llm, dir, ["plan_parse"])).toBe(llm);
    expect(withPreferences(null, dir, ["plan_parse"])).toBeNull();
  });
});

describe("the assistant's prefer intent", () => {
  it("routes the owner's own sentence deterministically, with no LLM", () => {
    const req = parsePreferenceDeterministic(
      "prefer: in the morning I'd like half an hour to shower and read before starting anything"
    );
    expect(req).toBeTruthy();
    expect(req!.section).toBe("Mornings");
    expect(req!.line).toBe("in the morning I'd like half an hour to shower and read before starting anything");

    const res = applyPreference(dir, req!);
    expect(res.kind).toBe("note");
    expect(res.reply).toContain("Mornings");
    expect(res.reply).toContain("preferences.md");
    expect(read()).toContain("- In the morning I'd like half an hour to shower");

    // Saying it twice does not write it twice.
    expect(applyPreference(dir, req!).reply).toMatch(/already/i);
    expect(read().match(/half an hour to shower/g)).toHaveLength(1);
  });

  it("recognizes every documented prefix and sorts statements into sections", () => {
    for (const t of [
      "prefer no meetings before 10",
      "preference: I answer email in batches",
      "I like a long block before noon",
      "I want the gym in the late afternoon",
      "I'd like dinner kept free",
      "remind me that I don't take calls on Fridays",
    ]) {
      expect(PREFER_PREFIX.test(t)).toBe(true);
      expect(parsePreferenceDeterministic(t)).toBeTruthy();
    }
    expect(sectionForPreference("no meetings before 10")).toBe("Meetings");
    expect(sectionForPreference("I answer email in batches")).toBe("Communication");
    expect(sectionForPreference("a long uninterrupted block for writing")).toBe("Deep work");
    expect(sectionForPreference("shower before anything else")).toBe("Mornings");
    expect(sectionForPreference("I don't cook on Sundays")).toBe("Personal");
  });

  it("does NOT swallow a fact: 'remember: school starts Sept 22' stays a fact", () => {
    const text = "remember: school starts Sept 22";
    expect(parsePreferenceDeterministic(text)).toBeNull();
    const fact = parseFactDeterministic(text, new Date("2026-08-05T12:00:00Z"));
    expect(fact).toBeTruthy();
    expect(fact!.key).toBe("school_term_start");
    expect(fact!.kind).toBe("date_anchor");
    expect(fact!.date).toBe("2026-09-22");

    // …and a dated statement wearing a preference's clothes is still a fact.
    expect(parsePreferenceDeterministic("I want school to start Sept 22")).toBeNull();
    // Ordinary chatter is neither.
    expect(parsePreferenceDeterministic("what's on my calendar tomorrow")).toBeNull();
  });
});

describe("the morning ritual in the shipped doctrine", () => {
  it("reserves the first 30 minutes, because a preference line cannot", () => {
    const d = parseDoctrine(DEFAULT_DOCTRINE_YAML);
    const ritual = d.fixed_rituals.find((r) => /morning routine/i.test(r.label));
    expect(ritual).toBeTruthy();
    expect(ritual!.type).toBe("personal");
    expect(ritual!.at_hours_after_wake).toBe(0);
    expect(ritual!.duration).toBe(30);
    // It sits inside the first-hour cognitive ban rather than fighting it.
    expect(d.hard_constraints.no_cognitive_work_before_hours_after_wake).toBeGreaterThanOrEqual(0.5);
  });
});
