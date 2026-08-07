// The agentic-coding curriculum: Notion says WHAT, POS says WHEN.
//
// Owner ask 2026-08-07: "i have a specific calendar in my notion under the page 'Agentic
// Engineering...'. it gives me info on what to do for the 30 min coding sesh's i have
// everyday... pos can determine timings but that has the info on how to spend my time in
// those learning sessions."
//
// POS already owned the timing (the "Learn agentic coding" daily recurring task). This
// fills in the topic on each day's instance from the matching row of his "Agentic
// Engineering — 30 Day Plan" database, so the calendar block itself reads "Learn:
// Master.dev guide — How AI Code Generation Actually Works" instead of a generic label.
// Everything downstream (Google push, and Apple via his Google account subscribed inside
// Calendar.app) inherits that for free — no new write path.
//
// No network: queryForDate is injected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { generatePlan } from "../main/planner.ts";
import { SecretStore } from "../main/secrets.ts";
import {
  enrichAgenticCurriculumTasks,
  curriculumDbIdFromNotes,
  formatCurriculumTitle,
  formatCurriculumNotes,
  AGENTIC_CURRICULUM_MARKER_PREFIX,
  type CurriculumEntry,
} from "../main/notion.ts";
import type { SecretStore as SecretStoreType } from "../main/secrets.ts";

const withToken = { get: (n: string) => (n === "NOTION_TOKEN" ? "secret_tok" : null) } as unknown as SecretStoreType;
const noToken = { get: () => null } as unknown as SecretStoreType;

const DB_ID = "4be3743e8d574300b14a7e37a1ea2a63"; // his real 30 Day Plan database id
const TEMPLATE_TITLE = "Learn agentic coding";
const TODAY = "2026-08-10";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-curriculum-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The daily template, linked to the curriculum database via its own notes marker. */
function addTemplate(notes = `${AGENTIC_CURRICULUM_MARKER_PREFIX}${DB_ID}`): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
         status, splittable, estimate_source, plan_date, recurrence, notes)
       VALUES (?, 'focused_work', 3, 30, 30, 'inbox', 0, 'stated', ?, 'daily', ?)`
    )
    .run(TEMPLATE_TITLE, TODAY, notes);
  return Number(r.lastInsertRowid);
}

/** What crm/recurring.ts materializes for a given day: title copied, notes NULL. */
function addInstance(parentId: number, planDate: string, title = TEMPLATE_TITLE): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
         status, splittable, estimate_source, plan_date, recurrence_parent_id)
       VALUES (?, 'focused_work', 3, 30, 30, 'inbox', 0, 'stated', ?, ?)`
    )
    .run(title, planDate, parentId);
  return Number(r.lastInsertRowid);
}

const task = (id: number) => db.prepare("SELECT * FROM task WHERE id = ?").get(id) as any;

const entry = (over: Partial<CurriculumEntry> = {}): CurriculumEntry => ({
  title: "Master.dev guide — How AI Code Generation Actually Works",
  type: "Learn",
  week: "Week 1 — Reading fluency",
  link: "https://master.dev/blog/ai-assisted-coding-a-practical-guide-for-software-engineers/",
  done: false,
  ...over,
});

/** Injected query: a date → row map, plus a log of which dates were actually asked for. */
function fakeQuery(rows: Record<string, CurriculumEntry>, asked: string[] = []) {
  return {
    asked,
    queryForDate: async (_s: SecretStoreType, _dbId: string, dateISO: string) => {
      asked.push(dateISO);
      return rows[dateISO] ?? null;
    },
  };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("curriculum helpers", () => {
  it("reads the database id out of the template's notes", () => {
    expect(curriculumDbIdFromNotes(`${AGENTIC_CURRICULUM_MARKER_PREFIX}${DB_ID}`)).toBe(DB_ID);
    expect(curriculumDbIdFromNotes(`some note\n${AGENTIC_CURRICULUM_MARKER_PREFIX}${DB_ID}`)).toBe(DB_ID);
    expect(curriculumDbIdFromNotes("just a normal note")).toBeNull();
    expect(curriculumDbIdFromNotes(null)).toBeNull();
  });

  it("folds Type into the title so the calendar block says what kind of session it is", () => {
    expect(formatCurriculumTitle(entry())).toBe(
      "Learn: Master.dev guide — How AI Code Generation Actually Works"
    );
    expect(formatCurriculumTitle(entry({ type: "Apply", title: "run the ReAct example locally" }))).toBe(
      "Apply: run the ReAct example locally"
    );
    // A row with no Type still produces a usable title rather than a stray prefix.
    expect(formatCurriculumTitle(entry({ type: null, title: "Something" }))).toBe("Something");
  });

  it("never doubles a prefix the row already carries — his real Apply rows", () => {
    // Caught against the live database: his Apply rows are titled "Apply: …" already, so
    // blindly prepending Type produced "Apply: Apply: read-before-run pass on recent AI code".
    expect(
      formatCurriculumTitle(entry({ type: "Apply", title: "Apply: run the GitHub ReAct example locally" }))
    ).toBe("Apply: run the GitHub ReAct example locally");
    // case- and space-insensitive, since the prefix is hand-typed
    expect(formatCurriculumTitle(entry({ type: "Apply", title: "apply : something" }))).toBe("apply : something");
    // a title that merely CONTAINS the word still gets its prefix
    expect(formatCurriculumTitle(entry({ type: "Learn", title: "How to learn faster" }))).toBe(
      "Learn: How to learn faster"
    );
  });

  it("puts the week and the link in the notes, and stays null when there is neither", () => {
    expect(formatCurriculumNotes(entry())).toBe(
      "Week 1 — Reading fluency\nhttps://master.dev/blog/ai-assisted-coding-a-practical-guide-for-software-engineers/"
    );
    expect(formatCurriculumNotes(entry({ link: null }))).toBe("Week 1 — Reading fluency");
    expect(formatCurriculumNotes(entry({ week: null, link: null }))).toBeNull();
  });
});

// ── enrichment ───────────────────────────────────────────────────────────────

describe("enrichAgenticCurriculumTasks", () => {
  it("fills today's session with the day's topic, week and link", async () => {
    const tpl = addTemplate();
    const inst = addInstance(tpl, TODAY);

    const q = fakeQuery({ [TODAY]: entry() });
    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(1);
    const row = task(inst);
    expect(row.title).toBe("Learn: Master.dev guide — How AI Code Generation Actually Works");
    expect(row.notes).toContain("Week 1 — Reading fluency");
    expect(row.notes).toContain("https://master.dev/blog/");
    // The timing POS owns is untouched — Notion supplies content, never schedule.
    expect(row.estimated_minutes).toBe(30);
    expect(row.plan_date).toBe(TODAY);
  });

  it("enriches each upcoming day with ITS own row, not one row for all of them", async () => {
    const tpl = addTemplate();
    const a = addInstance(tpl, TODAY);
    const b = addInstance(tpl, "2026-08-11");

    const q = fakeQuery({
      [TODAY]: entry(),
      "2026-08-11": entry({ title: "Master.dev guide — Debugging AI-Generated Code" }),
    });
    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(2);
    expect(task(a).title).toContain("How AI Code Generation Actually Works");
    expect(task(b).title).toContain("Debugging AI-Generated Code");
  });

  it("never rewrites history — a past instance is left alone", async () => {
    const tpl = addTemplate();
    const past = addInstance(tpl, "2026-08-09");
    const q = fakeQuery({ "2026-08-09": entry() });

    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(q.asked).not.toContain("2026-08-09"); // not even looked up
    expect(task(past).title).toBe(TEMPLATE_TITLE);
  });

  it("is idempotent — a second run neither re-fetches nor rewrites an enriched day", async () => {
    const tpl = addTemplate();
    const inst = addInstance(tpl, TODAY);
    const q = fakeQuery({ [TODAY]: entry() });

    await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);
    const afterFirst = task(inst).title;
    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(q.asked).toEqual([TODAY]); // exactly one lookup across both runs
    expect(task(inst).title).toBe(afterFirst);
  });

  it("respects a manual rename — his own words are never clobbered", async () => {
    const tpl = addTemplate();
    const inst = addInstance(tpl, TODAY, "Learn agentic coding — MY OWN PLAN FOR TODAY");
    const q = fakeQuery({ [TODAY]: entry() });

    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(task(inst).title).toBe("Learn agentic coding — MY OWN PLAN FOR TODAY");
  });

  it("a day the curriculum does not cover keeps the generic session, unchanged", async () => {
    // Before the plan starts, or a day it skips. A 30-minute block titled "Learn agentic
    // coding" is a perfectly good fallback — the session still happens.
    const tpl = addTemplate();
    const inst = addInstance(tpl, TODAY);
    const q = fakeQuery({}); // no row for any date

    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(task(inst).title).toBe(TEMPLATE_TITLE);
    expect(task(inst).notes).toBeNull();
  });

  it("a Notion failure on one day never blocks the others", async () => {
    const tpl = addTemplate();
    const bad = addInstance(tpl, TODAY);
    const good = addInstance(tpl, "2026-08-11");

    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, {
      queryForDate: async (_s: SecretStoreType, _d: string, dateISO: string) => {
        if (dateISO === TODAY) throw new Error("Notion 502");
        return entry({ title: "Debugging AI-Generated Code" });
      },
    });

    expect(res.enriched).toBe(1);
    expect(task(bad).title).toBe(TEMPLATE_TITLE); // untouched, retried next tick
    expect(task(good).title).toContain("Debugging AI-Generated Code");
  });

  it("leaves unlinked recurring templates entirely alone", async () => {
    // The gym / Instagram dailies have no curriculum marker and must never be touched.
    const gym = addTemplate("");
    db.prepare("UPDATE task SET title = 'Gym / workout', notes = NULL WHERE id = ?").run(gym);
    const inst = addInstance(gym, TODAY, "Gym / workout");
    const q = fakeQuery({ [TODAY]: entry() });

    const res = await enrichAgenticCurriculumTasks(db, withToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(q.asked).toEqual([]); // no lookup at all
    expect(task(inst).title).toBe("Gym / workout");
  });

  it("no Notion token → a silent no-op, never a thrown tick", async () => {
    const tpl = addTemplate();
    addInstance(tpl, TODAY);
    const q = fakeQuery({ [TODAY]: entry() });

    const res = await enrichAgenticCurriculumTasks(db, noToken, TODAY, q);

    expect(res.enriched).toBe(0);
    expect(q.asked).toEqual([]);
  });
});


// ── the ordering contract (the whole feature hinges on it) ──────────────────
//
// A calendar BLOCK carries its own title, copied from the task at solve time, and
// re-planning is gated on the anchor fingerprint — a task rename is not a calendar change
// and would never trigger a re-solve. So enrichment MUST land before the day is solved,
// or the task reads "Learn: …" while the block (and the Google/Apple event pushed from it)
// keeps saying "Learn agentic coding" forever. workers.ts orders it that way deliberately;
// this is the test that fails if anyone reorders it.
describe("enriched title reaches the calendar block", () => {
  it("a day solved AFTER enrichment gets a block named for the day's topic", async () => {
    const tpl = addTemplate();
    const inst = addInstance(tpl, TODAY);
    await enrichAgenticCurriculumTasks(db, withToken, TODAY, fakeQuery({ [TODAY]: entry() }));

    const doctrineDir = path.join(dir, "doctrine");
    const secrets = new SecretStore(path.join(dir, "secrets"));
    await generatePlan(db, doctrineDir, secrets, null, TODAY, {
      anchors: async () => [],
      now: new Date(`${TODAY}T07:00:00`),
    });

    const block = db
      .prepare("SELECT b.title FROM block b JOIN plan p ON b.plan_id = p.id WHERE p.plan_date = ? AND b.task_id = ?")
      .get(TODAY, inst) as { title: string } | undefined;
    expect(block, "the session should be on the day's plan").toBeTruthy();
    expect(block!.title).toBe("Learn: Master.dev guide — How AI Code Generation Actually Works");
  });
});
