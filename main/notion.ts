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

import { todayISO } from "./dates.ts";
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
  const today = todayISO();
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
  const today = todayISO();
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

// ── agentic-coding curriculum (a specific Notion database drives ONE recurring task) ──
//
// Owner ask 2026-08-07: "i have a specific calendar in my notion under the page 'Agentic
// Engineering...'. it gives me info on what to do for the 30 min coding sesh's i have
// everyday... pos can determine timings but that has the info on how to spend my time."
//
// POS already owns WHEN (the "Learn agentic coding" daily recurring task, materialized
// per-day by crm/recurring.ts). This owns WHAT: each day's materialized instance is
// enriched from the matching row of the owner's "Agentic Engineering — 30 Day Plan"
// database (one row per calendar day: Task title, Type select Learn/Apply, Week select,
// Link url), so the title/notes carry the day's actual topic once — and everything
// downstream (Google Calendar push, and Apple Calendar via his Google account already
// being subscribed inside Calendar.app) inherits it automatically. No new write path.
//
// The link between the recurring template and its Notion database lives in the
// TEMPLATE row's own `notes` (never an instance's — instances don't inherit notes at
// materialization, see recurring.ts), same marker-in-notes idiom as gtasks-sync's
// `pos:task:<id>`. Never write to the template's TITLE: every future instance copies it
// verbatim, so overwriting it with one day's topic would poison every day after.

export const AGENTIC_CURRICULUM_MARKER_PREFIX = "notion:curriculum:";

/** The Notion database id a recurring template is linked to, from its own `notes`. */
export function curriculumDbIdFromNotes(notes: string | null | undefined): string | null {
  const m = new RegExp(`${AGENTIC_CURRICULUM_MARKER_PREFIX}(\\S+)`).exec(notes ?? "");
  return m ? m[1] : null;
}

export interface CurriculumEntry {
  title: string;
  type: string | null;
  week: string | null;
  link: string | null;
  done: boolean;
}

/** The one row (if any) whose Date property equals `dateISO` — a calendar keyed by day. */
export async function queryCurriculumForDate(
  secrets: SecretStore,
  databaseId: string,
  dateISO: string
): Promise<CurriculumEntry | null> {
  const token = requireToken(secrets);
  const res = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: { filter: { property: "Date", date: { equals: dateISO } }, page_size: 1 },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = ((res.results ?? []) as any[])[0];
  if (!row) return null;
  const props = row.properties ?? {};
  return {
    title: extractTitle(row),
    type: props.Type?.select?.name ?? null,
    week: props.Week?.select?.name ?? null,
    link: props.Link?.url ?? null,
    done: props.Done?.checkbox === true,
  };
}

/**
 * "Learn: Master.dev guide — How AI Code Generation Actually Works" — Type folded into the
 * title so the calendar block says what KIND of session it is at a glance.
 *
 * Skips the prefix when the row's own title already carries it: his "Apply" rows are titled
 * "Apply: run the GitHub ReAct example locally", which would otherwise read "Apply: Apply:
 * …" on the calendar (caught against the real database, 2026-08-07).
 */
export function formatCurriculumTitle(entry: CurriculumEntry): string {
  const title = entry.title.trim();
  if (!entry.type) return title.slice(0, 200);
  const alreadyPrefixed = new RegExp(`^${entry.type}\\s*:`, "i").test(title);
  return (alreadyPrefixed ? title : `${entry.type}: ${title}`).slice(0, 200);
}

/** Week + link, one per line; null when the row carries neither (nothing to add). */
export function formatCurriculumNotes(entry: CurriculumEntry): string | null {
  const lines = [entry.week, entry.link].filter((v): v is string => Boolean(v));
  return lines.length ? lines.join("\n") : null;
}

/** A date-only ISO string shifted by N days (UTC-noon anchor avoids DST edge slips). */
export function shiftISODate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Push every curriculum row on/after `fromISO` later by `deltaDays` (owner ask 2026-08-16:
 * a missed session carries over and "everything gets pushed down the line" — in the Notion
 * calendar itself, so Notion stays the source of truth the enrichment reads from).
 *
 * The rows are shifted latest-first purely for tidiness in Notion's history; date rows have
 * no uniqueness constraint, so order is not correctness-bearing. Rows the owner already
 * ticked Done are left where they are — history doesn't move.
 */
export async function shiftCurriculumDates(
  secrets: SecretStore,
  databaseId: string,
  fromISO: string,
  deltaDays: number
): Promise<{ shifted: number }> {
  if (deltaDays <= 0) return { shifted: 0 };
  const token = requireToken(secrets);

  // Collect every not-done row with Date >= fromISO (paginated).
  const rows: { id: string; date: string }[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionFetch(token, `/databases/${databaseId}/query`, {
      method: "POST",
      body: {
        filter: { property: "Date", date: { on_or_after: fromISO.slice(0, 10) } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (res.results ?? []) as any[]) {
      const date = row.properties?.Date?.date?.start;
      const done = row.properties?.Done?.checkbox === true;
      if (typeof date === "string" && !done) rows.push({ id: row.id, date: date.slice(0, 10) });
    }
    cursor = res.has_more ? (res.next_cursor as string | undefined) : undefined;
  } while (cursor);

  rows.sort((a, b) => b.date.localeCompare(a.date)); // latest first
  for (const r of rows) {
    await notionFetch(token, `/pages/${r.id}`, {
      method: "PATCH",
      body: { properties: { Date: { date: { start: shiftISODate(r.date, deltaDays) } } } },
    });
  }
  return { shifted: rows.length };
}

/** Swappable query fn — real Notion in production, a fake in tests. No network in tests. */
export interface CurriculumDeps {
  queryForDate: typeof queryCurriculumForDate;
}

export interface CurriculumSyncResult {
  enriched: number;
}

/**
 * For every recurring template linked to a curriculum database, enrich whichever of its
 * already-materialized instances (today or later — never rewrite history) still carry the
 * template's generic title. That equality check IS the "not yet enriched" sentinel: once
 * enriched, a task's title reads like a specific topic and stops matching, so it is never
 * re-fetched or clobbered — including by the owner renaming it, which is meant to stick.
 * A day with no matching row (before the plan starts, or a weekend the curriculum skips)
 * is left exactly as materialized: the generic title is a perfectly good fallback.
 */
export async function enrichAgenticCurriculumTasks(
  db: Db,
  secrets: SecretStore,
  todayISO: string,
  deps: CurriculumDeps = { queryForDate: queryCurriculumForDate }
): Promise<CurriculumSyncResult> {
  if (!secrets.get("NOTION_TOKEN")) return { enriched: 0 };

  const templates = db
    .prepare(
      `SELECT id, title, notes FROM task
        WHERE recurrence = 'daily' AND recurrence_parent_id IS NULL AND notes LIKE ?`
    )
    .all(`${AGENTIC_CURRICULUM_MARKER_PREFIX}%`) as { id: number; title: string; notes: string }[];

  let enriched = 0;
  for (const t of templates) {
    const dbId = curriculumDbIdFromNotes(t.notes);
    if (!dbId) continue;
    const pending = db
      .prepare(
        `SELECT id, plan_date FROM task
          WHERE recurrence_parent_id = ? AND title = ? AND plan_date IS NOT NULL AND plan_date >= ?`
      )
      .all(t.id, t.title, todayISO) as { id: number; plan_date: string }[];
    for (const p of pending) {
      let entry: CurriculumEntry | null;
      try {
        entry = await deps.queryForDate(secrets, dbId, p.plan_date);
      } catch (e) {
        console.warn(`agentic curriculum lookup failed for ${p.plan_date}: ${(e as Error).message}`);
        continue;
      }
      if (!entry) continue;
      db.prepare("UPDATE task SET title = ?, notes = ? WHERE id = ?").run(
        formatCurriculumTitle(entry),
        formatCurriculumNotes(entry),
        p.id
      );
      enriched++;
    }
  }
  return { enriched };
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

// ── the workspace tab: HIS pages, live, not a local copy ─────────────────────
//
// Owner ask 2026-08-06: "add in, like, a long term to-do list… a little side tab below the
// sparkle button, only viewed on the calendar page. Make this actually a tab that connects to
// my notion — so whatever is in there, this tab is also in my notion, and they all talk to
// each other. Currently in my notion I have my social media scheduling and another page. So I
// should be able to view both of these from that tab and then also create pages and add info."
//
// The design decision that matters: there is NO local mirror. Everything below reads and
// writes Notion directly, so "they all talk to each other" is true by construction rather than
// by a sync that can drift. A long-term list is exactly the kind of thing that is edited on a
// phone at midnight and in this tab the next morning; a second copy would be wrong within a
// day. The cost is that the tab needs the network and does nothing without a token, which is
// the honest trade and is what the UI says.
//
// This is deliberately separate from pushToNotion/pullNotionTasks above, which mirror POS's
// OWN databases (tasks/journal/commitments). Those are POS data published to Notion. This is
// his workspace, borrowed.

/** One thing the tab can open: a page he shared, or a database he shared. */
export interface NotionPageRef {
  id: string;
  title: string;
  /** Databases are opened as a row list; pages are opened as a block document. */
  type: "page" | "database";
  /** Notion's own URL, for "open in Notion". */
  url: string | null;
  /** Last edit time, ISO — the tab sorts on it so what he touched last is on top. */
  editedAt: string | null;
}

/** A block rendered in the tab. Only the shapes a to-do list actually needs. */
export interface NotionBlock {
  id: string;
  /** "todo" carries `checked`; everything else is read as a line of text. */
  kind: "todo" | "text" | "heading" | "other";
  text: string;
  checked?: boolean;
  /** False for shapes the tab knows how to display but not how to rewrite safely. */
  editable: boolean;
}

/**
 * What he actually SHARED with the integration — not everything Notion will hand back.
 *
 * Owner report 2026-08-06: "when I click the tab, there are, like, a bunch of untitled pages.
 * I don't know why. I only gave it access to my Instagram content calendar, my habit tracker,
 * and my Stanford first year course planner."
 *
 * Those three are DATABASES, and /search returns every ROW of a shared database as a page
 * object in its own right. Filtering to `object: page` therefore did the exact opposite of
 * what it looked like: it dropped the three things he named and kept their contents — habit
 * rows and content-calendar entries, most of which are keyed by a date property and carry no
 * title at all, hence a wall of "(untitled)".
 *
 * The top level is now what he connected: databases and top-level pages, never a row. Rows are
 * reachable by opening the database they belong to, which is where they mean something.
 */
export async function listWorkspacePages(secrets: SecretStore, limit = 50): Promise<NotionPageRef[]> {
  const token = requireToken(secrets);
  const res = await notionFetch(token, "/search", {
    method: "POST",
    body: {
      page_size: Math.min(100, Math.max(1, limit)),
      sort: { direction: "descending", timestamp: "last_edited_time" },
    },
  });
  const out: NotionPageRef[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (res.results ?? []) as any[]) {
    if (r.archived) continue;
    if (r.object !== "page" && r.object !== "database") continue;
    // A row of a shared database is content, not a thing he connected.
    if (r.object === "page" && r.parent?.type === "database_id") continue;
    const title = extractTitle(r);
    // An untitled top-level object is noise he cannot identify anyway.
    if (title === "(untitled)") continue;
    out.push({
      id: r.id as string,
      title,
      type: r.object as "page" | "database",
      url: (r.url as string) ?? null,
      editedAt: (r.last_edited_time as string) ?? null,
    });
  }
  return out;
}

/** The rows of a database, newest edit first — what "open the habit tracker" means. */
export async function queryDatabaseRows(
  secrets: SecretStore,
  databaseId: string,
  limit = 100
): Promise<NotionPageRef[]> {
  const token = requireToken(secrets);
  const res = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: {
      page_size: Math.min(100, Math.max(1, limit)),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res.results ?? []) as any[])
    .filter((r) => !r.archived)
    .map((r) => ({
      id: r.id as string,
      // A row with no title still has to be openable, so it keeps the placeholder here.
      title: extractTitle(r),
      type: "page" as const,
      url: (r.url as string) ?? null,
      editedAt: (r.last_edited_time as string) ?? null,
    }));
}

/** Read one page's top-level blocks — what the tab shows when a page is opened. */
export async function readPageBlocks(secrets: SecretStore, pageId: string, limit = 100): Promise<NotionBlock[]> {
  const token = requireToken(secrets);
  const res = await notionFetch(
    token,
    `/blocks/${pageId}/children?page_size=${Math.min(100, Math.max(1, limit))}`
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res.results ?? []) as any[]).map((b): NotionBlock => {
    const t = b.type as string;
    const body = b[t] ?? {};
    const line = plain(body.rich_text);
    if (t === "to_do") return { id: b.id, kind: "todo", text: line, checked: !!body.checked, editable: true };
    if (t === "paragraph") return { id: b.id, kind: "text", text: line, editable: true };
    if (t?.startsWith("heading_")) return { id: b.id, kind: "heading", text: line, editable: false };
    // Anything else (toggles, callouts, child databases…) is shown so the page still reads,
    // but not offered for editing — rewriting a shape we do not model could destroy content.
    return { id: b.id, kind: "other", text: line || `(${t})`, editable: false };
  });
}

/** Append one line to a page. `todo` makes it a checkbox — the long-term list's whole point. */
export async function appendToPage(
  secrets: SecretStore,
  pageId: string,
  line: string,
  kind: "todo" | "text" = "todo",
  /**
   * Insert directly BELOW this block instead of at the end of the page.
   *
   * Owner report 2026-08-06: "when I open Stanford first year course planner, I get the option
   * to add to this page, but I don't know where it's adding. I wanna specifically be able to
   * add in specific spots." Appending blindly to the end of a structured page is close to
   * useless — it lands under whatever happens to be last.
   */
  after?: string
): Promise<{ added: boolean }> {
  const token = requireToken(secrets);
  const body = line.replace(/\s+/g, " ").trim();
  if (!body) return { added: false };
  const block =
    kind === "todo"
      ? { object: "block", type: "to_do", to_do: { rich_text: text(body), checked: false } }
      : { object: "block", type: "paragraph", paragraph: { rich_text: text(body) } };
  await notionFetch(token, `/blocks/${pageId}/children`, {
    method: "PATCH",
    body: { children: [block], ...(after ? { after } : {}) },
  });
  return { added: true };
}

/** Tick or untick a to-do, in Notion. The tab never keeps its own copy of the state. */
export async function setTodoChecked(
  secrets: SecretStore,
  blockId: string,
  checked: boolean
): Promise<{ ok: true }> {
  const token = requireToken(secrets);
  await notionFetch(token, `/blocks/${blockId}`, {
    method: "PATCH",
    body: { to_do: { checked } },
  });
  return { ok: true };
}

/**
 * Create a page. `parentId` defaults to the configured parent, so "new page" works with no
 * picking; pass one to nest a page under something specific.
 *
 * Notion refuses a page with no parent, and a workspace-level parent needs a capability most
 * integrations are not granted — so a missing parent is reported as the actionable thing it
 * is rather than as a raw 400.
 */
export async function createWorkspacePage(
  db: Db,
  secrets: SecretStore,
  title: string,
  opts: { parentId?: string; firstLine?: string } = {}
): Promise<NotionPageRef> {
  const token = requireToken(secrets);
  const name = title.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("A page needs a title");
  const parentId = opts.parentId ?? getSetting(db, PARENT_PAGE_KEY);
  if (!parentId) {
    throw new Error("Pick a parent page in Settings → Notion first — Notion won't create a page without one");
  }
  const children = opts.firstLine?.trim()
    ? [{ object: "block", type: "to_do", to_do: { rich_text: text(opts.firstLine.trim()), checked: false } }]
    : [];
  const res = await notionFetch(token, "/pages", {
    method: "POST",
    body: {
      parent: { page_id: parentId },
      properties: { title: { title: text(name) } },
      ...(children.length > 0 ? { children } : {}),
    },
  });
  return {
    id: res.id as string,
    title: name,
    type: "page",
    url: (res.url as string) ?? null,
    editedAt: (res.last_edited_time as string) ?? null,
  };
}

/**
 * Rewrite one block's text in place — the tab is his page, editable, not a form that only
 * appends (owner ask 2026-08-06: "maybe the pop ups should just be, like, the notion page,
 * basically, but editable").
 *
 * Only the shapes readPageBlocks marks `editable` may be sent here. A heading or a callout is
 * displayed but never rewritten: guessing at a structure we do not model risks destroying
 * content in his real workspace, and there is no undo on the other side.
 */
export async function updateBlockText(
  secrets: SecretStore,
  blockId: string,
  kind: "todo" | "text",
  line: string
): Promise<{ ok: true }> {
  const token = requireToken(secrets);
  const body = line.replace(/\s+/g, " ").trim();
  if (!body) throw new Error("A line cannot be emptied — delete it instead");
  await notionFetch(token, `/blocks/${blockId}`, {
    method: "PATCH",
    body: kind === "todo" ? { to_do: { rich_text: text(body) } } : { paragraph: { rich_text: text(body) } },
  });
  return { ok: true };
}

/** Remove a block. Notion archives rather than destroys, so this is recoverable in his trash. */
export async function deleteBlock(secrets: SecretStore, blockId: string): Promise<{ ok: true }> {
  const token = requireToken(secrets);
  await notionFetch(token, `/blocks/${blockId}`, { method: "PATCH", body: { archived: true } });
  return { ok: true };
}
