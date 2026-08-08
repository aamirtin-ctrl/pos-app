// A whole day planned with the model switched off, end to end.
//
// Owner ask 2026-08-07: "work on edge cases when the gemini credits are down (especially the
// calendar system)." The unit suites cover the pieces; this is the question he actually
// asked, answered as one test: he types his real sentences, Gemini is unavailable, and the
// calendar that comes out the other side has to be a day he could actually live.
//
// llm = null throughout — the same object parseBraindump receives when the model is out of
// quota, unreachable, or returning unusable JSON. Nothing here is mocked around: real
// deterministic parse, real solver, real SQLite, real block rows.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { generatePlan } from "../main/planner.ts";
import { deterministicParse } from "../main/engine/parse.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../main/engine/doctrine.ts";
import type { Anchor } from "../main/engine/grid.ts";

const DATE = "2026-08-12";
const NOW = new Date(`${DATE}T06:00:00`);
const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-outage-day-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine");
  secrets = new SecretStore(path.join(dir, "secrets"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Route a braindump through the no-LLM parser into the task table, as capture would. */
function braindump(text: string): void {
  const insert = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
                       is_mit, status, splittable, estimate_source, plan_date, day_part, recurrence)
     VALUES (?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?)`
  );
  for (const p of deterministicParse(text, doctrine, DATE)) {
    insert.run(
      p.title, p.blockType, p.cognitiveLoad, p.estimatedMinutes, p.rawEstimateMinutes,
      p.isMit ? 1 : 0, p.splittable ? 1 : 0, p.estimateSource, DATE, p.dayPart, p.recurrence
    );
  }
}

const plan = async (anchors: Anchor[] = []) => {
  await generatePlan(db, doctrineDir, secrets, null, DATE, { anchors: async () => anchors, now: NOW });
  const id = (db.prepare("SELECT MAX(id) id FROM plan WHERE plan_date = ?").get(DATE) as { id: number }).id;
  return {
    id,
    blocks: db
      .prepare("SELECT title, starts_at, ends_at, task_id FROM block WHERE plan_id = ? ORDER BY starts_at")
      .all(id) as { title: string; starts_at: string; ends_at: string; task_id: number | null }[],
    unplaced: JSON.parse(
      (db.prepare("SELECT unplaced_tasks u FROM plan WHERE id = ?").get(id) as { u: string }).u
    ) as { taskId: number; title: string; reason: string }[],
  };
};

const minutes = (b: { starts_at: string; ends_at: string }) =>
  Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000);
const find = <T extends { title: string }>(bs: T[], re: RegExp): T | undefined =>
  bs.find((b) => re.test(b.title));

describe("a full day planned with Gemini down", () => {
  it("his real morning braindump produces the day he asked for", async () => {
    // Verbatim, from 2026-08-07.
    braindump("slot 30 mins to edit/film insta content and 1.25 hrs to gym everyday");
    braindump("can u dedicate 30 mins a day to learning agentic coding");
    braindump("I need to spend 45 minutes doing errands to return stuff");

    const { blocks, unplaced } = await plan();

    const insta = find(blocks, /insta/i);
    const gym = find(blocks, /gym/i);
    const coding = find(blocks, /agentic/i);
    const errands = find(blocks, /errand/i);

    expect(insta, "the insta block").toBeTruthy();
    expect(gym, "the gym block").toBeTruthy();
    expect(coding, "the agentic coding block").toBeTruthy();
    expect(errands, "the errands block").toBeTruthy();

    // The durations he stated, taken literally.
    expect(minutes(insta!), "30 mins to edit/film insta content").toBe(30);
    expect(minutes(gym!), "1.25 hrs to gym — not the 1h45m he complained about").toBe(75);
    expect(minutes(coding!), "30 mins a day to learning agentic coding").toBe(30);
    expect(minutes(errands!), "45 minutes doing errands").toBe(45);

    // ONE insta block, not the film/edit pair he reported.
    expect(blocks.filter((b) => /insta|film|edit/i.test(b.title))).toHaveLength(1);

    // An open day with four short tasks has room for all of them.
    expect(unplaced, `unplaced: ${JSON.stringify(unplaced)}`).toHaveLength(0);
  });

  it("titles read like calendar entries, not like transcripts", async () => {
    braindump("I need to spend 45 minutes doing errands to return stuff tomorrow");
    braindump("can u dedicate 30 mins a day to learning agentic coding");
    const { blocks } = await plan();
    for (const b of blocks) {
      expect(b.title.trim().length, "no empty titles").toBeGreaterThan(0);
      expect(b.title, `"${b.title}" still names a duration`).not.toMatch(/\b\d+\s*(?:mins?|minutes?|hrs?|hours?)\b/i);
      expect(b.title, `"${b.title}" still addresses the assistant`).not.toMatch(/^(?:can\s+)?u\b/i);
      expect(b.title, `"${b.title}" ends with a scheduling word`).not.toMatch(/\b(?:tomorrow|today|tonight)\s*$/i);
    }
  });

  it("invents nothing from filler — a rambling dump yields only real work", async () => {
    braindump("also schedule 15 mins some day for me to call family. this can be whenever");
    braindump("it should be fine. maybe later this week");
    const { blocks } = await plan();
    const fromTasks = blocks.filter((b) => b.task_id != null);
    expect(fromTasks).toHaveLength(1);
    expect(fromTasks[0].title).toMatch(/family/i);
    expect(minutes(fromTasks[0])).toBe(15);
  });

  it("still bends around real calendar events", async () => {
    braindump("slot 30 mins to edit/film insta content and 1.25 hrs to gym everyday");
    const dinner: Anchor = {
      startMin: 19 * 60, endMin: 22 * 60, blockType: "personal",
      title: "Dinner at our home", flexibility: "fixed",
    };
    const { blocks } = await plan([dinner]);

    const d = find(blocks, /dinner/i)!;
    expect(d, "the dinner anchor survives").toBeTruthy();
    expect(minutes(d)).toBe(180);
    // and nothing the planner placed sits inside it
    for (const b of blocks) {
      if (b === d) continue;
      const overlap = Date.parse(b.starts_at) < Date.parse(d.ends_at) && Date.parse(b.ends_at) > Date.parse(d.starts_at);
      expect(overlap, `"${b.title}" overlaps dinner`).toBe(false);
    }
  });

  it("the day is internally consistent — no overlaps, nothing off the clock", async () => {
    braindump("slot 30 mins to edit/film insta content and 1.25 hrs to gym everyday");
    braindump("two and a half hours of deep work on the deck");
    braindump("45 minutes on email");
    const { blocks } = await plan();
    for (let i = 1; i < blocks.length; i++) {
      expect(
        Date.parse(blocks[i].starts_at),
        `"${blocks[i].title}" starts before "${blocks[i - 1].title}" ends`
      ).toBeGreaterThanOrEqual(Date.parse(blocks[i - 1].ends_at));
    }
    for (const b of blocks) {
      expect(b.starts_at.slice(0, 10)).toBe(DATE);
      expect(minutes(b)).toBeGreaterThan(0);
    }
  });
});
