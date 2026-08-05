// Personal context ("about you") — the memory behind smart date resolution.
//
// Owner report 2026-08-05: "Add task" on a commitment about a meetup at the START OF
// SCHOOL prefilled TODAY. These tests pin the whole chain that fixes it: the seeded
// facts, the upsert, the phrase → date resolver, the prompt block, and finally the
// DB-backed proof that commitmentToTask lands the task on the anchor date.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  listFacts,
  getFact,
  setFact,
  deleteFact,
  contextBlock,
  resolveNamedDate,
  parseFactDeterministic,
  SEED_FACTS,
} from "../main/context.ts";
import { commitmentToTask } from "../main/gcal/sync.ts";
import type { SecretStore } from "../main/secrets.ts";

// isGoogleConnected() only reads "GOOGLE_OAUTH_TOKENS" — null = not connected, no network.
const noGoogle = { get: () => null } as unknown as SecretStore;

const ANCHOR = "2026-09-22";
const NOW = new Date("2026-08-05T12:00:00Z");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-context-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const keys = () => listFacts(db).map((f) => f.key);

describe("seed on first read", () => {
  it("seeds the editable defaults exactly once, only while the table is empty", () => {
    expect((db.prepare("SELECT COUNT(*) AS n FROM user_fact").get() as { n: number }).n).toBe(0);

    const first = listFacts(db);
    expect(first).toHaveLength(SEED_FACTS.length);
    expect(keys()).toEqual(expect.arrayContaining(["school", "school_term_start", "home_city"]));
    expect(first.every((f) => f.source === "seed")).toBe(true);

    // The term start is a real date anchor, not just a string.
    const start = getFact(db, "school_term_start")!;
    expect(start.kind).toBe("date_anchor");
    expect(start.starts_at).toBe(ANCHOR);

    // A second read is a plain read — no duplicate rows, no re-seed.
    expect(listFacts(db)).toHaveLength(SEED_FACTS.length);
  });

  it("does not re-seed after the user deletes a default", () => {
    listFacts(db);
    expect(deleteFact(db, "home_city")).toBe(true);
    expect(keys()).not.toContain("home_city"); // the table is non-empty, so no re-seed
    expect(listFacts(db)).toHaveLength(SEED_FACTS.length - 1);
  });

  it("deleteFact reports false for a key that was never stored", () => {
    listFacts(db);
    expect(deleteFact(db, "nonexistent_key")).toBe(false);
  });
});

describe("setFact", () => {
  it("upserts on the key — correcting a seeded default replaces it, never duplicates", () => {
    listFacts(db);
    const before = listFacts(db).length;

    setFact(db, { key: "school", value: "Rice University", kind: "fact", source: "manual" });
    expect(listFacts(db)).toHaveLength(before);
    const school = getFact(db, "school")!;
    expect(school.value).toBe("Rice University");
    expect(school.source).toBe("manual");
  });

  it("adds a new fact, normalizing the key to lower_snake_case", () => {
    listFacts(db);
    setFact(db, { key: "Home City", value: "Palo Alto, CA" });
    expect(getFact(db, "home_city")!.value).toBe("Palo Alto, CA");
  });

  it("stores a date_anchor's date, falling back to its own value when startsAt is omitted", () => {
    setFact(db, { key: "school_term_end", value: "2026-12-11", kind: "date_anchor" });
    expect(getFact(db, "school_term_end")!.starts_at).toBe("2026-12-11");

    setFact(db, { key: "move_in", value: "Dorm move-in", kind: "date_anchor", startsAt: "2026-09-20" });
    expect(getFact(db, "move_in")!.starts_at).toBe("2026-09-20");
  });

  it("rejects an empty key or value", () => {
    expect(() => setFact(db, { key: "  ", value: "x" })).toThrow("fact key required");
    expect(() => setFact(db, { key: "gym", value: "   " })).toThrow("fact value required");
  });
});

describe("resolveNamedDate", () => {
  it("resolves the owner's exact phrase: 'meetup at the start of school'", () => {
    expect(resolveNamedDate(db, "meetup at the start of school", NOW)).toBe(ANCHOR);
  });

  it("resolves the other colloquial ways he says it", () => {
    for (const phrase of [
      "when school starts",
      "school starts",
      "let's grab dinner the beginning of the term",
      "catch up at the start of the semester",
      "first day of classes",
      "help with move-in",
      "coffee once the quarter begins",
    ]) {
      expect(resolveNamedDate(db, phrase, NOW), phrase).toBe(ANCHOR);
    }
  });

  it("is case-insensitive and tolerant of surrounding words", () => {
    expect(resolveNamedDate(db, "MEETUP AT THE START OF SCHOOL", NOW)).toBe(ANCHOR);
    expect(resolveNamedDate(db, "Remind me to see Cory When School Starts, probably", NOW)).toBe(ANCHOR);
    expect(resolveNamedDate(db, "   start   of   school   ", NOW)).toBe(ANCHOR);
  });

  it("resolves end-of-term phrases only when that anchor exists", () => {
    expect(resolveNamedDate(db, "flight home at the end of the term", NOW)).toBeNull();
    setFact(db, { key: "school_term_end", value: "2026-12-11", kind: "date_anchor" });
    expect(resolveNamedDate(db, "flight home at the end of the term", NOW)).toBe("2026-12-11");
    expect(resolveNamedDate(db, "party when school ends", NOW)).toBe("2026-12-11");
    // …and never as a start-of-school phrase.
    expect(resolveNamedDate(db, "end of school", NOW)).toBe("2026-12-11");
  });

  it("resolves vague upcoming-term phrases only while the anchor is still ahead", () => {
    expect(resolveNamedDate(db, "let's do it next semester", NOW)).toBe(ANCHOR);
    expect(resolveNamedDate(db, "visit in the fall", NOW)).toBe(ANCHOR);
    // The term has already begun — "next semester" no longer means this anchor.
    expect(resolveNamedDate(db, "let's do it next semester", new Date("2026-10-01T12:00:00Z"))).toBeNull();
  });

  it("returns null when there is no anchor at all", () => {
    listFacts(db);
    deleteFact(db, "school_term_start");
    expect(resolveNamedDate(db, "meetup at the start of school", NOW)).toBeNull();
  });

  it("returns null for unrelated text", () => {
    for (const phrase of [
      "Send Sarah the pitch deck",
      "Bring Omar cash for the tickets",
      "Move in the new couch on Saturday",
      "",
      "   ",
    ]) {
      expect(resolveNamedDate(db, phrase, NOW), phrase).toBeNull();
    }
  });

  it("follows the anchor when the user corrects it", () => {
    setFact(db, { key: "school_term_start", value: "2027-01-04", kind: "date_anchor", startsAt: "2027-01-04" });
    expect(resolveNamedDate(db, "meetup at the start of school", NOW)).toBe("2027-01-04");
  });
});

describe("contextBlock", () => {
  it("renders a compact ABOUT THE USER block from the seeded facts", () => {
    const block = contextBlock(db);
    expect(block.split("\n")[0]).toBe("ABOUT THE USER:");
    expect(block).toContain("- Attends Stanford University");
    expect(block).toContain(`- Fall term starts ${ANCHOR}`);
    expect(block).toContain("- Based in Dallas, TX");
    // Compact: a header plus one line per fact, nothing else.
    expect(block.split("\n")).toHaveLength(SEED_FACTS.length + 1);
  });

  it("falls back to 'Key: value' for a key it has no phrasing for", () => {
    listFacts(db);
    setFact(db, { key: "dorm", value: "Wilbur Hall" });
    expect(contextBlock(db)).toContain("- Dorm: Wilbur Hall");
  });

  it("is empty when the user has deleted every fact", () => {
    for (const f of listFacts(db)) deleteFact(db, f.key);
    expect(contextBlock(db)).toBe("");
  });
});

describe("parseFactDeterministic (the 'remember: …' path)", () => {
  it("reads a date anchor out of a spoken sentence", () => {
    expect(parseFactDeterministic("remember: school starts Sept 22", NOW)).toEqual({
      key: "school_term_start",
      value: ANCHOR,
      kind: "date_anchor",
      date: ANCHOR,
    });
    expect(parseFactDeterministic("remember my birthday is March 4", NOW)).toMatchObject({
      key: "birthday",
      kind: "date_anchor",
      date: "2027-03-04", // no year stated → the next upcoming occurrence
    });
  });

  it("reads plain facts, with or without the prefix", () => {
    expect(parseFactDeterministic("I go to Stanford", NOW)).toEqual({
      key: "school",
      value: "Stanford",
      kind: "fact",
      date: null,
    });
    expect(parseFactDeterministic("remember: I live in Dallas, TX", NOW)).toMatchObject({
      key: "home_city",
      value: "Dallas, TX",
    });
  });

  it("returns null when there is nothing storable", () => {
    expect(parseFactDeterministic("remember:", NOW)).toBeNull();
    expect(parseFactDeterministic("what do I have when school starts", NOW)).toBeNull();
  });
});

describe("commitmentToTask prefill (the owner's click-path, DB-backed)", () => {
  const addCommitment = (description: string, dueAt: string | null = null): number =>
    Number(
      db
        .prepare("INSERT INTO commitment (description, due_at, status, confirmed_by_user) VALUES (?, ?, 'open', 0)")
        .run(description, dueAt).lastInsertRowid
    );

  it("lands an undated 'start of school' commitment on the anchor date, not today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const id = addCommitment("Meet up with Cory at the start of school");

    const res = await commitmentToTask(db, noGoogle, id);
    expect(res.task).toBe(true);

    const task = db.prepare("SELECT * FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task.plan_date).toBe(ANCHOR);
    expect(task.hard_deadline_at).toBe(`${ANCHOR}T00:00:00`);
    expect(task.plan_date).not.toBe(today);
  });

  it("leaves an unrelated undated commitment in the inbox (no date invented)", async () => {
    const id = addCommitment("Send Sarah the pitch deck");
    await commitmentToTask(db, noGoogle, id);
    const task = db.prepare("SELECT * FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task.plan_date).toBeNull();
    expect(task.hard_deadline_at).toBeNull();
  });

  it("an explicit picked date still wins over the anchor", async () => {
    const id = addCommitment("Meet up with Cory at the start of school");
    await commitmentToTask(db, noGoogle, id, "2026-10-01");
    const task = db.prepare("SELECT * FROM task WHERE commitment_id = ?").get(id) as any;
    expect(task.plan_date).toBe("2026-10-01");
  });
});
