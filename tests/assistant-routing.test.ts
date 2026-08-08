// What the sparkle box does with a sentence, when there is no model to ask.
//
// handleCommand's deterministic router decides whether a line schedules work, answers a
// question, records a fact or files a note. On an outage day it is the ONLY router, and a
// misroute is silent: the wrong thing happens and nothing says so.
//
// Audited 2026-08-08 by running a spread of realistic inputs through it. "gym for an hour
// tomorrow" came back as an ANSWER — a context blob on screen and nothing scheduled — while
// "gym for 1 hour tomorrow" planned the day correctly. The rule tested for a DIGIT before a
// unit, so it could not see a word duration, even though statedMinutes has understood "an
// hour", "half an hour" and "a couple hours" all along. Two definitions of one idea, and the
// weaker one sat on the path that matters — the same drift that let a sticker reaction become
// a commitment.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { handleCommand } from "../main/assistant.ts";

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-routing-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine");
  secrets = new SecretStore(path.join(dir, "secrets"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const morning = () => {
  const d = new Date();
  d.setHours(8, 30, 0, 0);
  return d;
};
const run = (text: string) =>
  handleCommand(
    { db, doctrineDir, secrets, llm: null, now: morning, planDeps: { anchors: async () => [], now: morning() } },
    text
  );
const taskCount = () => (db.prepare("SELECT COUNT(*) n FROM task").get() as { n: number }).n;

describe("a duration means SCHEDULE, however it is written", () => {
  it("word durations schedule, exactly like digits do", async () => {
    for (const t of [
      "gym for an hour tomorrow",
      "half an hour of reading tonight",
      "a couple hours on the deck",
      "two and a half hours of deep work tomorrow",
    ]) {
      const r = await run(t);
      expect(r.kind, `"${t}" must schedule, not answer`).toBe("plan");
      expect(taskCount(), `"${t}" must create work`).toBeGreaterThan(0);
      db.prepare("DELETE FROM task").run();
    }
  });

  it("the digit forms still work — this widened the rule, it did not move it", async () => {
    for (const t of ["gym for 1 hour tomorrow", "i need 45 mins to do errands tomorrow", "90 mins on the pset"]) {
      expect((await run(t)).kind, t).toBe("plan");
      db.prepare("DELETE FROM task").run();
    }
  });
});

describe("a duration inside a QUESTION is still a question", () => {
  it("retrospective and lookup phrasings are not scheduling requests", async () => {
    // The later find/search rule reclaims these, which is what makes widening the duration
    // test safe. If that ordering is ever changed, these fail.
    for (const t of ["what did I do for two hours yesterday?", "find the notes from two hours of advising"]) {
      const r = await run(t);
      expect(r.kind, `"${t}" must not schedule`).toBe("search");
      expect(taskCount(), `"${t}" must create nothing`).toBe(0);
    }
  });

  it("a bare mention of hours with no quantity is not a duration at all", async () => {
    const r = await run("how many hours did I work this week");
    expect(r.kind).not.toBe("plan");
    expect(taskCount()).toBe(0);
  });
});

describe("the other intents still route where they should", () => {
  it("keeps its footing across the everyday inputs", async () => {
    const cases: [string, string][] = [
      ["just woke up", "plan"],
      ["remember: my advisor is Dr. Patel", "note"],
      ["log: spent 2 hours on the deck", "note"],
      ["dinner with Zayn friday 7pm", "event"],
      ["can u dedicate 30 mins a day to learning agentic coding", "plan"],
      ["", "error"],
    ];
    for (const [text, kind] of cases) {
      expect((await run(text)).kind, JSON.stringify(text)).toBe(kind);
      db.prepare("DELETE FROM task").run();
    }
  });
});
