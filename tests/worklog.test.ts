// Worklog memory: manual add, windowed reads, the per-ISO-week distill
// idempotency key, distillWeek's key behaviour, and the catch-up paragraph's
// deterministic fallback when no LLM is available.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import {
  addManual,
  entriesSince,
  distillWeek,
  distillWeekKey,
  catchUpParagraph,
} from "../main/worklog.ts";
import type { LlmClient } from "../main/llm/provider.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-worklog-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const insertAt = (happenedAt: string, title: string, detail: string | null = null) =>
  db
    .prepare("INSERT INTO worklog (happened_at, title, detail, source) VALUES (?, ?, ?, 'auto')")
    .run(happenedAt, title, detail);

describe("addManual", () => {
  it("inserts a manual entry happened now and returns its id", () => {
    const r = addManual(db, "Shipped the investor deck");
    const row = db.prepare("SELECT * FROM worklog WHERE id = ?").get(r.id) as any;
    expect(row.title).toBe("Shipped the investor deck");
    expect(row.source).toBe("manual");
    expect(row.happened_at).toBeTruthy();
  });

  it("rejects empty titles", () => {
    expect(() => addManual(db, "   ")).toThrow("empty worklog entry");
  });
});

describe("entriesSince windowing", () => {
  it("returns only entries at/after the cutoff, newest first, across timestamp formats", () => {
    insertAt("2026-07-01 09:00:00", "old");
    insertAt("2026-07-20T12:00:00", "mid"); // ISO 'T' format must compare correctly
    insertAt("2026-07-28 08:30:00", "new");

    const got = entriesSince(db, "2026-07-15T00:00:00");
    expect(got.map((e) => e.title)).toEqual(["new", "mid"]);

    expect(entriesSince(db, "2026-01-01").map((e) => e.title)).toEqual(["new", "mid", "old"]);
    expect(entriesSince(db, "2027-01-01")).toEqual([]);
  });

  it("includes an entry exactly at the cutoff", () => {
    insertAt("2026-07-20 12:00:00", "edge");
    expect(entriesSince(db, "2026-07-20T12:00:00").map((e) => e.title)).toEqual(["edge"]);
  });
});

describe("distillWeekKey (idempotency key helper)", () => {
  it("uses the ISO week-year, not the calendar year", () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026
    expect(distillWeekKey(new Date(2026, 0, 1))).toBe("worklog_distilled:2026-W01");
    // 2024-12-30 is a Monday → ISO week 1 of 2025
    expect(distillWeekKey(new Date(2024, 11, 30))).toBe("worklog_distilled:2025-W01");
    // 2026-01-04 is a Sunday → still week 1 of 2026
    expect(distillWeekKey(new Date(2026, 0, 4))).toBe("worklog_distilled:2026-W01");
  });

  it("is stable within one week and zero-pads the week number", () => {
    expect(distillWeekKey(new Date(2026, 1, 2))).toBe(distillWeekKey(new Date(2026, 1, 8))); // Mon..Sun
    expect(distillWeekKey(new Date(2026, 1, 4))).toMatch(/:\d{4}-W\d{2}$/);
  });
});

describe("distillWeek", () => {
  const fakeLlm = (reply: unknown): LlmClient =>
    ({
      call: async () => ({ text: JSON.stringify(reply), model: "fake", inputTokens: 0, outputTokens: 0 }),
    }) as unknown as LlmClient;

  it("skips without an LLM and does NOT mark the week (retries later)", async () => {
    const res = await distillWeek(db, null);
    expect(res).toEqual({ inserted: 0, skipped: "no-llm" });
    expect(getSetting(db, distillWeekKey())).toBeNull();
  });

  it("distills once per ISO week: inserts, marks the week, then no-ops", async () => {
    db.prepare(
      "INSERT INTO task (title, block_type, status, completed_at) VALUES ('Ship deck', 'deep', 'done', datetime('now'))"
    ).run();

    const first = await distillWeek(db, fakeLlm([{ title: "Shipped the deck", detail: "sent to 3 investors" }]));
    expect(first).toEqual({ inserted: 1, skipped: null });
    expect(getSetting(db, distillWeekKey())).toBeTruthy();
    const row = db.prepare("SELECT title, detail, source FROM worklog").get() as any;
    expect(row).toEqual({ title: "Shipped the deck", detail: "sent to 3 investors", source: "auto" });

    const second = await distillWeek(db, fakeLlm([{ title: "should not appear" }]));
    expect(second).toEqual({ inserted: 0, skipped: "already-distilled" });
    expect((db.prepare("SELECT COUNT(*) c FROM worklog").get() as any).c).toBe(1);
  });

  it("marks a week with no activity as done without calling the LLM", async () => {
    let called = 0;
    const llm = { call: async () => (called++, null) } as unknown as LlmClient;
    const res = await distillWeek(db, llm);
    expect(res).toEqual({ inserted: 0, skipped: "no-activity" });
    expect(called).toBe(0);
    expect(getSetting(db, distillWeekKey())).toBeTruthy();
  });

  it("caps at 3 entries and drops malformed items", async () => {
    db.prepare(
      "INSERT INTO task (title, block_type, status, completed_at) VALUES ('t', 'admin', 'done', datetime('now'))"
    ).run();
    const res = await distillWeek(
      db,
      fakeLlm([{ title: "a" }, { title: "b" }, { title: "" }, { title: "c" }, { title: "d" }])
    );
    // first three items considered; the empty-title one is dropped
    expect(res.inserted).toBe(2);
  });
});

describe("catchUpParagraph fallback (llm null)", () => {
  it("builds a bullet list of entries since last_contact_at, no LLM needed", async () => {
    const pid = Number(
      db
        .prepare("INSERT INTO person (display_name, last_contact_at) VALUES ('Sarah', '2026-07-10T00:00:00')")
        .run().lastInsertRowid
    );
    insertAt("2026-07-01 10:00:00", "before last contact"); // excluded
    insertAt("2026-07-20 10:00:00", "Closed the pilot", "with Acme");
    insertAt("2026-07-25 10:00:00", "Hired first engineer");

    const res = await catchUpParagraph(db, null, pid);
    expect(res.usedLlm).toBe(false);
    expect(res.entries.map((e) => e.title)).toEqual(["Hired first engineer", "Closed the pilot"]);
    expect(res.paragraph).toBe("- Hired first engineer\n- Closed the pilot — with Acme");
    expect(res.channel).toBe("email"); // no interactions → default voice category
  });

  it("uses the most recent interaction channel for the voice category", async () => {
    const pid = Number(
      db
        .prepare("INSERT INTO person (display_name, last_contact_at) VALUES ('Raj', '2026-07-10T00:00:00')")
        .run().lastInsertRowid
    );
    db.prepare(
      "INSERT INTO interaction (person_id, channel, external_id, occurred_at) VALUES (?, 'imessage', 'x1', '2026-07-30T09:00:00')"
    ).run(pid);
    insertAt("2026-07-20 10:00:00", "Something notable");

    const res = await catchUpParagraph(db, null, pid);
    expect(res.channel).toBe("text");
  });

  it("says so when nothing was logged, and falls back to a 90-day window without last_contact_at", async () => {
    const pid = Number(db.prepare("INSERT INTO person (display_name) VALUES ('Nobody')").run().lastInsertRowid);
    const res = await catchUpParagraph(db, null, pid);
    expect(res.paragraph).toBe("Nothing notable in the worklog since you last talked.");
    expect(res.entries).toEqual([]);
  });

  it("throws for a missing person", async () => {
    await expect(catchUpParagraph(db, null, 9999)).rejects.toThrow("person not found");
  });
});
