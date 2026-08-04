// Notion integration — pure builders + DB-backed mapping helpers. NO network:
// everything under test is an exported pure function or reads/writes the local
// setting table only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, getSetting, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import {
  dbSchemaFor,
  DB_TITLES,
  taskPageProps,
  commitmentPageProps,
  journalPageProps,
  journalChildren,
  notionTaskStatus,
  mappingKey,
  parseMappingKey,
  mappedPageIds,
  unmappedRows,
  extractTitle,
  notionAvailable,
  notionConfigured,
  PARENT_PAGE_KEY,
} from "../main/notion.ts";

// ── database create payloads ─────────────────────────────────────────────────

describe("dbSchemaFor", () => {
  it("POS Tasks: Name title, Status select with the four options, Due date, Type select, Minutes number", () => {
    const s = dbSchemaFor("tasks") as any;
    expect(s.Name).toEqual({ title: {} });
    expect(s.Due).toEqual({ date: {} });
    expect(s.Minutes).toEqual({ number: {} });
    expect(s.Type.select).toBeDefined();
    const options = s.Status.select.options.map((o: { name: string }) => o.name);
    expect(options).toEqual(["inbox", "planned", "done", "deferred"]);
  });

  it("POS Journal: Name title + Date date only", () => {
    expect(dbSchemaFor("journal")).toEqual({ Name: { title: {} }, Date: { date: {} } });
  });

  it("POS Commitments: Direction/Status selects, Due date, Person rich_text", () => {
    const s = dbSchemaFor("commitments") as any;
    expect(s.Name).toEqual({ title: {} });
    expect(s.Due).toEqual({ date: {} });
    expect(s.Person).toEqual({ rich_text: {} });
    expect(s.Direction.select.options.map((o: { name: string }) => o.name)).toEqual([
      "i_owe_them",
      "they_owe_me",
    ]);
    expect(s.Status.select.options.map((o: { name: string }) => o.name)).toEqual([
      "open",
      "scheduled",
      "done",
      "dropped",
    ]);
  });

  it("database titles are the POS names", () => {
    expect(DB_TITLES).toEqual({
      tasks: "POS Tasks",
      journal: "POS Journal",
      commitments: "POS Commitments",
    });
  });
});

// ── page property builders ───────────────────────────────────────────────────

describe("taskPageProps", () => {
  const base = {
    title: "Write the memo",
    status: "planned",
    block_type: "focused_work",
    raw_estimate_minutes: 45,
    estimated_minutes: 60,
    hard_deadline_at: "2026-08-10T17:00:00",
  };

  it("builds Notion property shapes for a full task", () => {
    const p = taskPageProps(base) as any;
    expect(p.Name).toEqual({ title: [{ type: "text", text: { content: "Write the memo" } }] });
    expect(p.Status).toEqual({ select: { name: "planned" } });
    expect(p.Type).toEqual({ select: { name: "focused_work" } });
    expect(p.Minutes).toEqual({ number: 45 }); // raw estimate wins over buffered
    expect(p.Due).toEqual({ date: { start: "2026-08-10" } });
  });

  it("omits Due and Minutes when the task has neither", () => {
    const p = taskPageProps({ ...base, raw_estimate_minutes: null, estimated_minutes: null, hard_deadline_at: null });
    expect(p).not.toHaveProperty("Due");
    expect(p).not.toHaveProperty("Minutes");
  });

  it("falls back to estimated_minutes when raw is null", () => {
    const p = taskPageProps({ ...base, raw_estimate_minutes: null }) as any;
    expect(p.Minutes).toEqual({ number: 60 });
  });

  it("maps local statuses onto the Notion select options", () => {
    expect(notionTaskStatus("inbox")).toBe("inbox");
    expect(notionTaskStatus("planned")).toBe("planned");
    expect(notionTaskStatus("in_progress")).toBe("planned"); // no in_progress option in Notion
    expect(notionTaskStatus("done")).toBe("done");
    expect(notionTaskStatus("deferred")).toBe("deferred");
    expect(notionTaskStatus("garbage")).toBe("inbox");
  });
});

describe("commitmentPageProps", () => {
  it("builds Notion property shapes for a commitment with a person and a due date", () => {
    const p = commitmentPageProps({
      description: "Send the deck to Sam",
      direction: "i_owe_them",
      due_at: "2026-08-06T00:00:00",
      status: "open",
      who: "Sam Chen",
    }) as any;
    expect(p.Name.title[0].text.content).toBe("Send the deck to Sam");
    expect(p.Direction).toEqual({ select: { name: "i_owe_them" } });
    expect(p.Status).toEqual({ select: { name: "open" } });
    expect(p.Person).toEqual({ rich_text: [{ type: "text", text: { content: "Sam Chen" } }] });
    expect(p.Due).toEqual({ date: { start: "2026-08-06" } });
  });

  it("no person → empty rich_text; no due → no Due prop", () => {
    const p = commitmentPageProps({
      description: "Ship it",
      direction: "they_owe_me",
      due_at: null,
      status: "open",
      who: null,
    }) as any;
    expect(p.Person).toEqual({ rich_text: [] });
    expect(p).not.toHaveProperty("Due");
  });
});

describe("journal builders", () => {
  it("journalPageProps names the page after the date and sets the Date prop", () => {
    const p = journalPageProps("2026-08-04") as any;
    expect(p.Name.title[0].text.content).toBe("Plan 2026-08-04");
    expect(p.Date).toEqual({ date: { start: "2026-08-04" } });
  });

  it("journalChildren: narration paragraph + one bullet per block, HH:MM ranges", () => {
    const kids = journalChildren("A focused day.", [
      { title: "Deep work", startsAt: "2026-08-04T09:00:00", endsAt: "2026-08-04T10:30:00" },
      { title: null, startsAt: "2026-08-04T11:00:00", endsAt: "2026-08-04T11:30:00" },
    ]) as any[];
    expect(kids).toHaveLength(3);
    expect(kids[0].type).toBe("paragraph");
    expect(kids[0].paragraph.rich_text[0].text.content).toBe("A focused day.");
    expect(kids[1].type).toBe("bulleted_list_item");
    expect(kids[1].bulleted_list_item.rich_text[0].text.content).toBe("09:00–10:30 Deep work");
    expect(kids[2].bulleted_list_item.rich_text[0].text.content).toBe("11:00–11:30");
  });

  it("journalChildren: no narration → bullets only; long narration capped at 2000", () => {
    expect(journalChildren(null, [])).toEqual([]);
    expect(journalChildren("   ", [])).toEqual([]);
    const kids = journalChildren("x".repeat(3000), []) as any[];
    expect(kids[0].paragraph.rich_text[0].text.content).toHaveLength(2000);
  });
});

// ── mapping keys ─────────────────────────────────────────────────────────────

describe("mapping keys", () => {
  it("round-trips task and commitment ids", () => {
    for (const [kind, id] of [["task", 42], ["commitment", 7], ["journal", "2026-08-04"]] as const) {
      const key = mappingKey(kind, id);
      expect(key).toBe(`notion_page:${kind}:${id}`);
      expect(parseMappingKey(key)).toEqual({ kind, id: String(id) });
    }
  });

  it("rejects keys that are not notion page mappings", () => {
    expect(parseMappingKey("notion_db_tasks")).toBeNull();
    expect(parseMappingKey("notion_page:person:3")).toBeNull();
    expect(parseMappingKey("notion_page:task:")).toBeNull();
    expect(parseMappingKey("")).toBeNull();
  });
});

// ── extractTitle ─────────────────────────────────────────────────────────────

describe("extractTitle", () => {
  it("reads a page's title property wherever it lives", () => {
    expect(
      extractTitle({
        object: "page",
        properties: {
          Minutes: { type: "number", number: 30 },
          Name: { type: "title", title: [{ plain_text: "Buy " }, { plain_text: "milk" }] },
        },
      })
    ).toBe("Buy milk");
  });

  it("reads a database's title array", () => {
    expect(extractTitle({ object: "database", title: [{ plain_text: "POS Tasks" }] })).toBe("POS Tasks");
  });

  it("falls back to (untitled)", () => {
    expect(extractTitle({ object: "page", properties: {} })).toBe("(untitled)");
    expect(extractTitle({ object: "page", properties: { Name: { type: "title", title: [] } } })).toBe("(untitled)");
  });
});

// ── DB-backed: reverse mapping lookup + pull-side filter ─────────────────────

describe("mapping lookups + pull filter (DB)", () => {
  let dir: string;
  let db: Db | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-notion-"));
    db = openDb(path.join(dir, "pos.db"));
  });
  afterEach(() => {
    db?.close();
    db = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mappedPageIds returns only the requested kind's page ids", () => {
    setSetting(db!, mappingKey("task", 1), "page-a");
    setSetting(db!, mappingKey("task", 2), "page-b");
    setSetting(db!, mappingKey("commitment", 1), "page-c");
    setSetting(db!, "notion_db_tasks", "db-x"); // unrelated setting, must not leak in
    expect(mappedPageIds(db!, "task")).toEqual(new Set(["page-a", "page-b"]));
    expect(mappedPageIds(db!, "commitment")).toEqual(new Set(["page-c"]));
    expect(mappedPageIds(db!, "journal")).toEqual(new Set());
  });

  it("unmappedRows keeps only Notion rows without a local mapping", () => {
    setSetting(db!, mappingKey("task", 10), "page-known");
    const fakeQueryResults = [
      { id: "page-known", object: "page" },
      { id: "page-new-1", object: "page" },
      { id: "page-new-2", object: "page" },
    ];
    const fresh = unmappedRows(fakeQueryResults, mappedPageIds(db!, "task"));
    expect(fresh.map((r) => r.id)).toEqual(["page-new-1", "page-new-2"]);
  });

  it("round-trip: mapping written for a created task makes the row 'seen' next pull", () => {
    const r = db!
      .prepare(
        `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
           status, plan_date, estimate_source)
         VALUES ('From Notion', 'focused_work', 2, 30, 30, 'inbox', '2026-08-04', 'inferred')`
      )
      .run();
    const localId = Number(r.lastInsertRowid);
    setSetting(db!, mappingKey("task", localId), "page-xyz");
    expect(getSetting(db!, `notion_page:task:${localId}`)).toBe("page-xyz");
    expect(unmappedRows([{ id: "page-xyz" }], mappedPageIds(db!, "task"))).toEqual([]);
  });

  it("notionConfigured needs both the token and the parent page", () => {
    const secrets = new SecretStore(dir);
    expect(notionConfigured(db!, secrets)).toBe(false);
    secrets.set("NOTION_TOKEN", "secret_abc");
    expect(notionConfigured(db!, secrets)).toBe(false);
    setSetting(db!, PARENT_PAGE_KEY, "parent-page-id");
    expect(notionConfigured(db!, secrets)).toBe(true);
  });
});

// ── availability without a token (no network is touched) ─────────────────────

describe("notionAvailable", () => {
  it("returns no_token before any HTTP happens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-notion-sec-"));
    try {
      const secrets = new SecretStore(dir);
      await expect(notionAvailable(secrets)).resolves.toEqual({ ok: false, error: "no_token" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
