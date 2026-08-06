// The long-term tab's Notion surface.
//
// Owner ask 2026-08-06: "add in, like, a long term to-do list… a little side tab below the
// sparkle button, only viewed on the calendar page. Make this actually a tab that connects to
// my notion — so whatever is in there, this tab is also in my notion, and they all talk to
// each other. Currently in my notion I have my social media scheduling and another page. So I
// should be able to view both of these from that tab and then also create pages and add info."
//
// The design decision under test: there is NO local mirror. Every call below goes straight to
// Notion, so "they all talk to each other" holds by construction rather than by a sync that
// can drift. These tests pin the request shapes, because a wrong body is the failure mode that
// would silently write the wrong thing into his real workspace.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../main/db/db.ts";
import {
  listWorkspacePages,
  readPageBlocks,
  appendToPage,
  setTodoChecked,
  createWorkspacePage,
  queryDatabaseRows,
  updateBlockText,
  PARENT_PAGE_KEY,
} from "../main/notion.ts";
import type { SecretStore } from "../main/secrets.ts";

const secrets = { get: (n: string) => (n === "NOTION_TOKEN" ? "secret_tok" : null) } as unknown as SecretStore;
const noToken = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;
let calls: { url: string; method: string; body: any }[];

/** Stub fetch, recording every request so the payloads can be asserted. */
function stubFetch(reply: (url: string) => unknown) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return { ok: true, status: 200, json: async () => reply(String(url)) } as unknown as Response;
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-notion-ws-"));
  db = openDb(path.join(dir, "pos.db"));
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const titled = (id: string, title: string, edited: string) => ({
  object: "page",
  id,
  url: `https://notion.so/${id}`,
  last_edited_time: edited,
  properties: { Name: { type: "title", title: [{ plain_text: title }] } },
});

describe("listWorkspacePages", () => {
  // Owner report 2026-08-06: "there are, like, a bunch of untitled pages. I don't know why. I
  // only gave it access to my Instagram content calendar, my habit tracker, and my Stanford
  // first year course planner."
  //
  // All three are DATABASES, and Notion's /search returns every ROW of a shared database as a
  // page object. Filtering to `object: page` therefore dropped the three things he named and
  // kept their contents — rows keyed by a date property with no title at all.
  it("lists what he SHARED — databases included, their rows excluded", async () => {
    stubFetch(() => ({
      results: [
        { object: "database", id: "d1", url: "https://notion.so/d1", last_edited_time: "2026-08-06T10:00:00.000Z",
          title: [{ plain_text: "Habit tracker" }], parent: { type: "workspace" } },
        { ...titled("r1", "", "2026-08-06T09:00:00.000Z"), parent: { type: "database_id" } },
        { ...titled("r2", "", "2026-08-06T08:00:00.000Z"), parent: { type: "database_id" } },
        { ...titled("p1", "Stanford first year course planner", "2026-08-05T10:00:00.000Z"),
          parent: { type: "workspace" } },
      ],
    }));
    const items = await listWorkspacePages(secrets);
    expect(items.map((p) => p.title)).toEqual(["Habit tracker", "Stanford first year course planner"]);
    expect(items[0].type).toBe("database");
    expect(items[1].type).toBe("page");
  });

  it("no longer filters the search to pages — that was what hid the databases", async () => {
    stubFetch(() => ({ results: [] }));
    await listWorkspacePages(secrets);
    expect(calls[0].body.filter).toBeUndefined();
    expect(calls[0].body.sort).toEqual({ direction: "descending", timestamp: "last_edited_time" });
  });

  it("drops untitled top-level objects — he cannot identify them anyway", async () => {
    stubFetch(() => ({
      results: [
        { ...titled("p1", "", "2026-08-06T10:00:00.000Z"), parent: { type: "workspace" } },
        { ...titled("p2", "Real page", "2026-08-06T09:00:00.000Z"), parent: { type: "workspace" } },
      ],
    }));
    expect((await listWorkspacePages(secrets)).map((p) => p.title)).toEqual(["Real page"]);
  });

  it("hides archived pages — a page he deleted is not a page", async () => {
    stubFetch(() => ({
      results: [
        { ...titled("p1", "Live", "2026-08-06T10:00:00.000Z"), parent: { type: "workspace" } },
        { ...titled("p2", "Trashed", "2026-08-06T09:00:00.000Z"), parent: { type: "workspace" }, archived: true },
      ],
    }));
    expect((await listWorkspacePages(secrets)).map((p) => p.title)).toEqual(["Live"]);
  });

  it("says what to do when Notion was never connected", async () => {
    await expect(listWorkspacePages(noToken)).rejects.toThrow(/NOTION_TOKEN|Settings/i);
  });
});

describe("queryDatabaseRows", () => {
  it("opens a database as its entries — where the rows actually mean something", async () => {
    stubFetch(() => ({
      results: [
        titled("r1", "Week 1", "2026-08-06T10:00:00.000Z"),
        titled("r2", "Week 2", "2026-08-05T10:00:00.000Z"),
      ],
    }));
    const rows = await queryDatabaseRows(secrets, "d1");
    expect(rows.map((r) => r.title)).toEqual(["Week 1", "Week 2"]);
    expect(calls[0].url).toContain("/databases/d1/query");
    expect(rows.every((r) => r.type === "page")).toBe(true);
  });
});

describe("readPageBlocks", () => {
  it("reads to-dos with their checked state, and everything else as text", async () => {
    stubFetch(() => ({
      results: [
        { id: "b1", type: "to_do", to_do: { rich_text: [{ plain_text: "Learn agentic engineering" }], checked: false } },
        { id: "b2", type: "to_do", to_do: { rich_text: [{ plain_text: "Learn basics of coding" }], checked: true } },
        { id: "b3", type: "heading_2", heading_2: { rich_text: [{ plain_text: "This quarter" }] } },
        { id: "b4", type: "paragraph", paragraph: { rich_text: [{ plain_text: "notes" }] } },
      ],
    }));
    const blocks = await readPageBlocks(secrets, "p1");
    expect(blocks.map((b) => b.kind)).toEqual(["todo", "todo", "heading", "text"]);
    expect(blocks[0]).toMatchObject({ text: "Learn agentic engineering", checked: false });
    expect(blocks[1].checked).toBe(true);
  });

  it("still shows a block type it does not model, rather than dropping the line", async () => {
    stubFetch(() => ({ results: [{ id: "b9", type: "callout", callout: { rich_text: [{ plain_text: "heads up" }] } }] }));
    const [b] = await readPageBlocks(secrets, "p1");
    expect(b).toMatchObject({ kind: "other", text: "heads up" });
  });
});

describe("appendToPage", () => {
  it("adds a checkbox by default — a long-term list is made of to-dos", async () => {
    stubFetch(() => ({ results: [] }));
    expect(await appendToPage(secrets, "p1", "Learn agentic engineering")).toEqual({ added: true });
    const [c] = calls;
    expect(c.method).toBe("PATCH");
    expect(c.url).toContain("/blocks/p1/children");
    expect(c.body.children[0].type).toBe("to_do");
    expect(c.body.children[0].to_do.rich_text[0].text.content).toBe("Learn agentic engineering");
    expect(c.body.children[0].to_do.checked).toBe(false);
  });

  it("can add a plain line when the item is a note, not a task", async () => {
    stubFetch(() => ({ results: [] }));
    await appendToPage(secrets, "p1", "context on the above", "text");
    expect(calls[0].body.children[0].type).toBe("paragraph");
  });

  // Owner report 2026-08-06: "I get the option to add to this page, but I don't know where
  // it's adding. I wanna specifically be able to add in specific spots."
  it("inserts directly below a chosen block when asked", async () => {
    stubFetch(() => ({ results: [] }));
    await appendToPage(secrets, "p1", "a new line", "todo", "block42");
    expect(calls[0].body.after).toBe("block42");
  });

  it("appends to the end when no position is given", async () => {
    stubFetch(() => ({ results: [] }));
    await appendToPage(secrets, "p1", "a new line");
    expect(calls[0].body.after).toBeUndefined();
  });

  it("refuses an empty line without troubling Notion", async () => {
    stubFetch(() => ({ results: [] }));
    expect(await appendToPage(secrets, "p1", "   ")).toEqual({ added: false });
    expect(calls).toHaveLength(0);
  });
});

describe("setTodoChecked", () => {
  it("ticks the block in Notion — the tab keeps no copy of the state", async () => {
    stubFetch(() => ({}));
    await setTodoChecked(secrets, "b1", true);
    expect(calls[0]).toMatchObject({ method: "PATCH", url: expect.stringContaining("/blocks/b1") });
    expect(calls[0].body).toEqual({ to_do: { checked: true } });
  });
});

describe("createWorkspacePage", () => {
  it("creates under the configured parent and can seed the first line", async () => {
    setSetting(db, PARENT_PAGE_KEY, "parent123");
    stubFetch(() => ({ id: "new1", url: "https://notion.so/new1", last_edited_time: "2026-08-06T12:00:00.000Z" }));
    const page = await createWorkspacePage(db, secrets, "Long term to-do", { firstLine: "Learn agentic engineering" });
    expect(page).toMatchObject({ id: "new1", title: "Long term to-do" });
    const [c] = calls;
    expect(c.body.parent).toEqual({ page_id: "parent123" });
    expect(c.body.properties.title.title[0].text.content).toBe("Long term to-do");
    expect(c.body.children[0].to_do.rich_text[0].text.content).toBe("Learn agentic engineering");
  });

  it("omits children entirely when there is no first line", async () => {
    setSetting(db, PARENT_PAGE_KEY, "parent123");
    stubFetch(() => ({ id: "new2", url: null, last_edited_time: null }));
    await createWorkspacePage(db, secrets, "Empty page");
    expect(calls[0].body.children).toBeUndefined();
  });

  it("explains the missing parent instead of surfacing a raw Notion 400", async () => {
    stubFetch(() => ({}));
    await expect(createWorkspacePage(db, secrets, "Anything")).rejects.toThrow(/parent page in Settings/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses an untitled page", async () => {
    setSetting(db, PARENT_PAGE_KEY, "parent123");
    stubFetch(() => ({}));
    await expect(createWorkspacePage(db, secrets, "   ")).rejects.toThrow(/needs a title/i);
  });
});

// "Maybe the pop ups should just be, like, the notion page, basically, but editable."
describe("updateBlockText", () => {
  it("rewrites a to-do in place without touching its checked state", async () => {
    stubFetch(() => ({}));
    await updateBlockText(secrets, "b1", "todo", "Learn agentic engineering properly");
    expect(calls[0]).toMatchObject({ method: "PATCH", url: expect.stringContaining("/blocks/b1") });
    expect(calls[0].body.to_do.rich_text[0].text.content).toBe("Learn agentic engineering properly");
    expect(calls[0].body.to_do.checked).toBeUndefined();
  });

  it("rewrites a paragraph as a paragraph", async () => {
    stubFetch(() => ({}));
    await updateBlockText(secrets, "b2", "text", "some context");
    expect(calls[0].body.paragraph.rich_text[0].text.content).toBe("some context");
  });

  it("refuses to empty a line — that is a delete, and says so", async () => {
    stubFetch(() => ({}));
    await expect(updateBlockText(secrets, "b1", "todo", "   ")).rejects.toThrow(/delete it instead/i);
    expect(calls).toHaveLength(0);
  });
});

describe("readPageBlocks editability", () => {
  it("marks only the shapes it can safely rewrite", async () => {
    stubFetch(() => ({
      results: [
        { id: "b1", type: "to_do", to_do: { rich_text: [{ plain_text: "x" }], checked: false } },
        { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "y" }] } },
        { id: "b3", type: "heading_2", heading_2: { rich_text: [{ plain_text: "z" }] } },
        { id: "b4", type: "child_database", child_database: {} },
      ],
    }));
    expect((await readPageBlocks(secrets, "p1")).map((b) => b.editable)).toEqual([true, true, false, false]);
  });
});
