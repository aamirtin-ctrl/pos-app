// Notion integration — official REST API via fetch (no SDK).
//
// Mirrors the gcal find-or-create + settings-cached-id pattern: three databases
// ("POS Tasks", "POS Journal", "POS Commitments") live under ONE user-picked parent
// page (setting `notion_parent_page_id`), their ids cached in settings and verified
// before reuse. Local↔Notion page identity is schema-free: the setting table holds
// `notion_page:task:<id>` / `notion_page:commitment:<id>` / `notion_page:journal:<date>`
// → Notion page id, so no migration was needed.
//
// push: open tasks + open commitments upsert into their databases (PATCH when a
//       mapping exists, POST otherwise); today's plan becomes one Journal page whose
//       body (narration paragraph + a bullet per block) is written on create only —
//       updates touch properties, never re-append children.
// pull: "inbox" rows in POS Tasks with NO local mapping become local planner tasks
//       (same shape ipc's commitments.toTask inserts) — type a task in Notion on the
//       phone and it feeds the planner within 15 minutes.

import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** Settings key: the user-picked page that holds the three POS databases. */
export const PARENT_PAGE_KEY = "notion_parent_page_id";

export type NotionDbKind = "tasks" | "journal" | "commitments";

export const DB_TITLES: Record<NotionDbKind, string> = {
  tasks: "POS Tasks",
  journal: "POS Journal",
  commitments: "POS Commitments",
};

const DB_SETTING_KEYS: Record<NotionDbKind, string> = {
  tasks: "notion_db_tasks",
  journal: "notion_db_journal",
  commitments: "notion_db_commitments",
};

// ── HTTP plumbing ────────────────────────────────────────────────────────────

interface NotionError extends Error {
  status?: number;
}

async function notionFetch(
  token: string,
  path: string,
  init?: { method?: "GET" | "POST" | "PATCH"; body?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let msg = `notion ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = `notion ${res.status}: ${j.message}`;
    } catch {
      /* non-JSON error body — status alone will do */
    }
    const err = new Error(msg) as NotionError;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function requireToken(secrets: SecretStore): string {
  const t = secrets.get("NOTION_TOKEN");
  if (!t) throw new Error("Notion token not set — paste NOTION_TOKEN in Settings");
  return t;
}

/** Cron gate: only run the connector when both the token and the parent page exist. */
export function notionConfigured(db: Db, secrets: SecretStore): boolean {
  return Boolean(secrets.get("NOTION_TOKEN") && getSetting(db, PARENT_PAGE_KEY));
}

// ── availability probe ───────────────────────────────────────────────────────

export type NotionAvailability = { ok: true } | { ok: false; error: string };

/** Probe GET /users/me. "no_token" / "bad_token" are stable codes for the UI. */
export async function notionAvailable(secrets: SecretStore): Promise<NotionAvailability> {
  const token = secrets.get("NOTION_TOKEN");
  if (!token) return { ok: false, error: "no_token" };
  try {
    await notionFetch(token, "/users/me");
    return { ok: true };
  } catch (e) {
    if ((e as NotionError).status === 401) return { ok: false, error: "bad_token" };
    return { ok: false, error: (e as Error).message };
  }
}

// ── titles / rich text (pure) ────────────────────────────────────────────────

const text = (content: string) => [{ type: "text", text: { content } }];

function plain(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt.map((r) => (r as { plain_text?: string }).plain_text ?? "").join("");
}

/** Human title of a page or database object, "(untitled)" when Notion has none. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTitle(obj: any): string {
  if (obj?.object === "database") return plain(obj.title) || "(untitled)";
  const props = obj?.properties ?? {};
  for (const p of Object.values(props)) {
    const prop = p as { type?: string; title?: unknown };
    if (prop?.type === "title") return plain(prop.title) || "(untitled)";
  }
  return "(untitled)";
}

// ── search targets (Settings picker) ─────────────────────────────────────────

export interface NotionTarget {
  id: string;
  title: string;
  type: "page" | "database";
}

/** Everything the integration can see (pages + databases), first 20. */
export async function searchTargets(secrets: SecretStore): Promise<NotionTarget[]> {
  const token = requireToken(secrets);
  const res = await notionFetch(token, "/search", { method: "POST", body: { page_size: 20 } });
  const out: NotionTarget[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (res.results ?? []) as any[]) {
    if (r.object !== "page" && r.object !== "database") continue;
    out.push({ id: r.id, title: extractTitle(r), type: r.object });
  }
  return out;
}

// ── database schemas (pure) ──────────────────────────────────────────────────

/** Notion property schema for one POS database (the /databases create payload). */
export function dbSchemaFor(kind: NotionDbKind): Record<string, unknown> {
  switch (kind) {
    case "tasks":
      return {
        Name: { title: {} },
        Status: {
          select: {
            options: [{ name: "inbox" }, { name: "planned" }, { name: "done" }, { name: "deferred" }],
          },
        },
        Due: { date: {} },
        Type: { select: {} },
        Minutes: { number: {} },
      };
    case "journal":
      return { Name: { title: {} }, Date: { date: {} } };
    case "commitments":
      return {
        Name: { title: {} },
        Direction: { select: { options: [{ name: "i_owe_them" }, { name: "they_owe_me" }] } },
        Due: { date: {} },
        Status: {
          select: {
            options: [{ name: "open" }, { name: "scheduled" }, { name: "done" }, { name: "dropped" }],
          },
        },
        Person: { rich_text: {} },
      };
  }
}

/**
 * Find-or-create one POS database (gcal's ensurePosCalendar pattern): cached id is
 * verified with GET /databases/:id before reuse; on a miss we search for an existing
 * database with our exact title before creating a fresh one under the parent page.
 */
export async function ensureNotionDb(db: Db, secrets: SecretStore, kind: NotionDbKind): Promise<string> {
  const token = requireToken(secrets);
  const key = DB_SETTING_KEYS[kind];
  const cached = getSetting(db, key);
  if (cached) {
    try {
      await notionFetch(token, `/databases/${cached}`);
      return cached;
    } catch {
      /* deleted/revoked upstream — resolve again below */
    }
  }
  const found = await notionFetch(token, "/search", {
    method: "POST",
    body: { query: DB_TITLES[kind], filter: { property: "object", value: "database" }, page_size: 20 },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = ((found.results ?? []) as any[]).find(
    (r) => r.object === "database" && extractTitle(r) === DB_TITLES[kind]
  );
  if (existing?.id) {
    setSetting(db, key, existing.id);
    return existing.id;
  }
  const parent = getSetting(db, PARENT_PAGE_KEY);
  if (!parent) throw new Error("Notion parent page not set — pick a page in Settings");
  const created = await notionFetch(token, "/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parent },
      title: [{ type: "text", text: { content: DB_TITLES[kind] } }],
      properties: dbSchemaFor(kind),
    },
  });
  setSetting(db, key, created.id);
  return created.id as string;
}

// ── local↔Notion mapping via the setting table (pure helpers) ────────────────

export type MappingKind = "task" | "commitment" | "journal";

/** `notion_page:task:<id>` — the setting key whose value is the Notion page id. */
export function mappingKey(kind: MappingKind, id: number | string): string {
  return `notion_page:${kind}:${id}`;
}

export function parseMappingKey(key: string): { kind: MappingKind; id: string } | null {
  const m = /^notion_page:(task|commitment|journal):(.+)$/.exec(key);
  if (!m) return null;
  return { kind: m[1] as MappingKind, id: m[2] };
}

/** Every Notion page id already mapped for a kind (reverse lookup over setting keys). */
export function mappedPageIds(db: Db, kind: MappingKind): Set<string> {
  const rows = db
    .prepare("SELECT value FROM setting WHERE key LIKE ?")
    .all(`notion_page:${kind}:%`) as { value: string }[];
  return new Set(rows.map((r) => r.value));
}

/** Pull-side filter: Notion query rows that have no local mapping yet. */
export function unmappedRows<T extends { id: string }>(
  rows: readonly T[],
  mapped: ReadonlySet<string>
): T[] {
  return rows.filter((r) => !mapped.has(r.id));
}

// ── page property builders (pure) ────────────────────────────────────────────

/** Local task status → the Notion Status select (in_progress shows as planned). */
export function notionTaskStatus(local: string): "inbox" | "planned" | "done" | "deferred" {
  if (local === "in_progress") return "planned";
  if (local === "inbox" || local === "planned" || local === "done" || local === "deferred") return local;
  return "inbox";
}

export interface TaskRow {
  title: string;
  status: string;
  block_type: string;
  raw_estimate_minutes: number | null;
  estimated_minutes: number | null;
  hard_deadline_at: string | null;
}

export function taskPageProps(t: TaskRow): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name: { title: text(t.title) },
    Status: { select: { name: notionTaskStatus(t.status) } },
    Type: { select: { name: t.block_type } },
  };
  const minutes = t.raw_estimate_minutes ?? t.estimated_minutes;
  if (minutes != null) props.Minutes = { number: minutes };
  if (t.hard_deadline_at) props.Due = { date: { start: t.hard_deadline_at.slice(0, 10) } };
  return props;
}

export interface CommitmentRow {
  description: string;
  direction: string;
  due_at: string | null;
  status: string;
  who?: string | null;
}

export function commitmentPageProps(c: CommitmentRow): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name: { title: text(c.description) },
    Direction: { select: { name: c.direction } },
    Status: { select: { name: c.status } },
    Person: { rich_text: c.who ? text(c.who) : [] },
  };
  if (c.due_at) props.Due = { date: { start: c.due_at.slice(0, 10) } };
  return props;
}

export function journalPageProps(dateISO: string): Record<string, unknown> {
  return {
    Name: { title: text(`Plan ${dateISO}`) },
    Date: { date: { start: dateISO } },
  };
}

export interface JournalItem {
  title: string | null;
  startsAt: string; // "YYYY-MM-DDTHH:MM:SS" local wall clock, as `block` stores it
  endsAt: string;
}

/** Journal page body: narration paragraph (when present) + one bullet per block. */
export function journalChildren(narration: string | null, items: readonly JournalItem[]): unknown[] {
  const blocks: unknown[] = [];
  const n = narration?.trim();
  if (n) {
    blocks.push({
      object: "block",
      type: "paragraph",
      // Notion caps one rich-text content at 2000 chars.
      paragraph: { rich_text: text(n.slice(0, 2000)) },
    });
  }
  for (const it of items) {
    const label = `${it.startsAt.slice(11, 16)}–${it.endsAt.slice(11, 16)} ${it.title ?? ""}`.trim();
    blocks.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: text(label) },
    });
  }
  return blocks;
}

// ── push ─────────────────────────────────────────────────────────────────────

export interface PushCounts {
  tasks: number;
  commitments: number;
  journal: number;
}

/**
 * PATCH the mapped page, or POST a new one and record the mapping. A stale mapping
 * (page deleted in Notion) falls back to create — same recovery as gcal's push.
 * `children` (journal body) only apply on create; updates never re-append blocks.
 */
async function upsertPage(
  db: Db,
  token: string,
  databaseId: string,
  key: string,
  props: Record<string, unknown>,
  children?: unknown[]
): Promise<void> {
  const existing = getSetting(db, key);
  if (existing) {
    try {
      await notionFetch(token, `/pages/${existing}`, { method: "PATCH", body: { properties: props } });
      return;
    } catch {
      /* deleted in Notion — recreate below */
    }
  }
  const created = await notionFetch(token, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: databaseId },
      properties: props,
      ...(children?.length ? { children } : {}),
    },
  });
  setSetting(db, key, created.id);
}

/**
 * Upsert open tasks → POS Tasks, open commitments → POS Commitments, today's plan
 * (if any) → one POS Journal page. Recently-completed mapped tasks flip their Notion
 * Status to done. Returns counts of pages written per database.
 */
export async function pushToNotion(db: Db, secrets: SecretStore): Promise<PushCounts> {
  const token = requireToken(secrets);
  const counts: PushCounts = { tasks: 0, commitments: 0, journal: 0 };

  // open + planned tasks
  const tasksDb = await ensureNotionDb(db, secrets, "tasks");
  const open = db
    .prepare(
      `SELECT id, title, status, block_type, raw_estimate_minutes, estimated_minutes, hard_deadline_at
       FROM task WHERE status IN ('inbox','planned','in_progress')`
    )
    .all() as (TaskRow & { id: number })[];
  for (const t of open) {
    await upsertPage(db, token, tasksDb, mappingKey("task", t.id), taskPageProps(t));
    counts.tasks++;
  }

  // locally-done tasks with a Notion page → flip Status there too.
  // Capped at the last 7 days so the cron never re-patches all history every 15 min.
  const done = db
    .prepare(
      `SELECT id FROM task WHERE status = 'done'
       AND completed_at IS NOT NULL AND completed_at >= datetime('now', '-7 days')`
    )
    .all() as { id: number }[];
  for (const t of done) {
    const pageId = getSetting(db, mappingKey("task", t.id));
    if (!pageId) continue;
    try {
      await notionFetch(token, `/pages/${pageId}`, {
        method: "PATCH",
        body: { properties: { Status: { select: { name: "done" } } } },
      });
      counts.tasks++;
    } catch {
      /* page deleted in Notion — nothing left to mark */
    }
  }

  // open commitments
  const commitmentsDb = await ensureNotionDb(db, secrets, "commitments");
  const openCommitments = db
    .prepare(
      `SELECT c.id, c.description, c.direction, c.due_at, c.status, p.display_name AS who
       FROM commitment c LEFT JOIN person p ON p.id = c.person_id
       WHERE c.status = 'open'`
    )
    .all() as (CommitmentRow & { id: number })[];
  for (const c of openCommitments) {
    await upsertPage(db, token, commitmentsDb, mappingKey("commitment", c.id), commitmentPageProps(c));
    counts.commitments++;
  }

  // today's plan → one journal page (body written on create only)
  const today = new Date().toISOString().slice(0, 10);
  const plan = db
    .prepare("SELECT id, narration FROM plan WHERE plan_date = ? ORDER BY id DESC LIMIT 1")
    .get(today) as { id: number; narration: string | null } | undefined;
  if (plan) {
    const journalDb = await ensureNotionDb(db, secrets, "journal");
    const blocks = db
      .prepare("SELECT title, starts_at, ends_at FROM block WHERE plan_id = ? ORDER BY starts_at")
      .all(plan.id) as { title: string | null; starts_at: string; ends_at: string }[];
    const children = journalChildren(
      plan.narration,
      blocks.map((b) => ({ title: b.title, startsAt: b.starts_at, endsAt: b.ends_at }))
    );
    await upsertPage(db, token, journalDb, mappingKey("journal", today), journalPageProps(today), children);
    counts.journal++;
  }

  return counts;
}

// ── pull ─────────────────────────────────────────────────────────────────────

/**
 * POS Tasks rows with Status "inbox" and no local mapping become local planner tasks
 * (block_type focused_work, 30 min raw, plan_date today — the commitments.toTask
 * shape) and get mapped, so the next push updates rather than duplicates them.
 */
export async function pullNotionTasks(db: Db, secrets: SecretStore): Promise<number> {
  const token = requireToken(secrets);
  const tasksDb = await ensureNotionDb(db, secrets, "tasks");
  const res = await notionFetch(token, `/databases/${tasksDb}/query`, {
    method: "POST",
    body: { filter: { property: "Status", select: { equals: "inbox" } }, page_size: 100 },
  });
  const fresh = unmappedRows((res.results ?? []) as { id: string }[], mappedPageIds(db, "task"));
  const today = new Date().toISOString().slice(0, 10);
  const insert = db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
       status, plan_date, estimate_source)
     VALUES (?, 'focused_work', 2, 30, 30, 'inbox', ?, 'inferred')`
  );
  let pulled = 0;
  for (const page of fresh) {
    const title = extractTitle(page);
    if (title === "(untitled)") continue; // empty Notion rows never become tasks
    const r = insert.run(title.slice(0, 120), today);
    setSetting(db, mappingKey("task", Number(r.lastInsertRowid)), page.id);
    pulled++;
  }
  return pulled;
}

// ── combined sync ────────────────────────────────────────────────────────────

export interface NotionSyncCounts extends PushCounts {
  pulled: number;
}

/** Push first (local inbox tasks get mapped), then pull — no round-trip duplicates. */
export async function syncNotion(db: Db, secrets: SecretStore): Promise<NotionSyncCounts> {
  const push = await pushToNotion(db, secrets);
  const pulled = await pullNotionTasks(db, secrets);
  return { ...push, pulled };
}
