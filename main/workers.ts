// Sync orchestration. runSync wraps one connector run in a sync_run row (started/finished/
// records/error — errors are recorded, NEVER propagated), then runs the post-ingest hook:
// commitment extraction over the newest unprocessed interactions (LLM optional), the
// thread-resolution pass (resolveFromThreads — new messages that fulfill/cancel open
// commitments close them and their tasks), forward-only last-contact advancement from
// outbound interactions, and the reconnect-cadence refresh.
// startWorkers schedules gmail + linkedin-email + imessage every 15 minutes while the app is open, guarded by
// a running flag so runs never overlap; sources with missing creds/FDA are skipped silently.

import { createRequire } from "node:module";
import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { extractJson, llmHealth, type LlmClient } from "./llm/provider.ts";
import { backfillDegraded, listDegraded } from "./backfill.ts";
import {
  extractCommitmentsLlm,
  passesCommitmentGate,
  isExpiredSameDay,
  threadResolves,
  dedupeKeyFor,
  rehydrateCommitmentDates,
} from "./crm/commitments.ts";
import { refreshNextTouch } from "./crm/reconnect.ts";
import { runEnrichment } from "./crm/enrich.ts";
import { commitmentToTask, closeGoogleTask, drainTombstones, readAnchors, type GcalPushDeps } from "./gcal/sync.ts";
import { hasCalendarWriteScope, isGoogleConnected } from "./gcal/auth.ts";
import { autoPushEnabled, pushPlanToGoogle } from "./planner.ts";
import { eventsForDate as icsEventsForDate } from "./icscal.ts";
import { distillWeek, distillWeekKey } from "./worklog.ts";
import type { ConnectorDeps, SyncReport } from "./connectors/common.ts";
import { syncAllMail, gmailConfigured } from "./connectors/gmail.ts";
import { reconcileGoogleTasks } from "./gtasks-sync.ts";
import { runNudgeCheck } from "./nudge.ts";
import { screenTimeAvailable, autoCaptureOutcomes } from "./screentime.ts";
import { generatePlan, replanUpcoming } from "./planner.ts";
import { ENGINE_VERSION } from "./engine/solver.ts";
import { syncImessage, imessageAvailable } from "./connectors/imessage.ts";
import { syncLinkedin } from "./connectors/linkedin.ts";
import { syncLinkedinEmail } from "./connectors/linkedin-email.ts";
import { syncMailfile } from "./connectors/mailfile.ts";
import { runCapture, resolveDoctrineDir } from "./capture.ts";
import { sendMorningDigest, shouldSendDigest } from "./digest.ts";
import { loadDoctrine } from "./engine/doctrine.ts";
import { runMsgPlans } from "./msgplans.ts";
import { syncNotion, notionConfigured } from "./notion.ts";
import { getSetting, setSetting } from "./db/db.ts";

// node-cron ships no type declarations — minimal local surface via createRequire.
interface CronTask {
  stop(): void;
}
interface CronModule {
  schedule(expr: string, fn: () => void | Promise<void>): CronTask;
}
const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

export type SyncSource =
  | "gmail"
  | "imessage"
  | "linkedin"
  | "linkedin-email"
  | "mailfile"
  | "capture"
  | "msgplans"
  | "notion";

/** `extra` = LinkedIn export folder / mailfile path (unused by gmail/imessage). */
export type ConnectorFn = (deps: ConnectorDeps, extra?: string) => Promise<SyncReport>;

/** Cap on interactions fed to commitment extraction per run (newest first). */
const EXTRACT_CAP = 50;

const CONNECTORS: Record<SyncSource, ConnectorFn> = {
  gmail: (deps) => syncAllMail(deps), // every configured mail account (gmail/outlook/imap)
  imessage: (deps) => syncImessage(deps),
  "linkedin-email": (deps) => syncLinkedinEmail(deps), // LinkedIn notification mail, all accounts
  linkedin: (deps, extra) =>
    extra
      ? syncLinkedin(deps, extra)
      : Promise.resolve({ source: "linkedin", ingested: 0, skipped: 0, created: 0, error: "path-required" }),
  mailfile: (deps, extra) =>
    extra
      ? syncMailfile(deps, extra)
      : Promise.resolve({ source: "mailfile", ingested: 0, skipped: 0, created: 0, error: "path-required" }),
  // Morning capture: self-messages (note-to-self email + iMessage) routed through the
  // unified assistant. Needs the llm from runSync's deps threading.
  capture: (deps) => runCapture(deps),
  // Plans from messages: scheduling talk in iMessage threads → one event per conversation
  // on the dedicated "POS — From Messages" Google calendar. Never writes anywhere else.
  msgplans: (deps) => runMsgPlans(deps),
  // Notion: push open tasks/commitments + today's plan up, pull phone-typed inbox
  // tasks down. `ingested` counts only NEW local tasks pulled, so the 15-min cron
  // stays quiet on push-only runs.
  notion: async (deps) => {
    const c = await syncNotion(deps.db, deps.secrets);
    return { source: "notion", ingested: c.pulled, skipped: 0, created: 0 };
  },
};

/**
 * Forward-only: person.last_contact_at advances to the newest OUTBOUND interaction (ported
 * behavior from PersonalCRM2 advanceLastContactFromOutbound — your outreach recency, not
 * inbound noise). Never moves backwards. Returns rows changed.
 */
export function advanceLastContact(db: Db): number {
  return db
    .prepare(
      `UPDATE person SET last_contact_at = (
         SELECT MAX(i.occurred_at) FROM interaction i
         WHERE i.person_id = person.id AND i.direction = 'outbound' AND i.occurred_at IS NOT NULL
       ), updated_at = datetime('now')
       WHERE id IN (
         SELECT i.person_id FROM interaction i
         WHERE i.direction = 'outbound' AND i.occurred_at IS NOT NULL
         GROUP BY i.person_id
         HAVING MAX(i.occurred_at) > COALESCE(
           (SELECT p2.last_contact_at FROM person p2 WHERE p2.id = i.person_id), ''
         )
       )`
    )
    .run().changes;
}

/**
 * Run one connector inside a sync_run row. Connector errors (thrown OR reported) land in
 * sync_run.error and the returned report — they never propagate. On success, the
 * post-ingest hook runs: the one-shot duplicate-commitment backfill, commitment extraction
 * (when an LLM client is provided; capped at EXTRACT_CAP newest unprocessed interactions —
 * extraction itself costs exactly two LLM calls), last-contact advancement, reconnect refresh.
 *
 * `overrides` swaps a connector implementation (tests / dry runs).
 */
export async function runSync(
  db: Db,
  secrets: SecretStore,
  llm: LlmClient | null,
  source: string,
  extra?: string,
  overrides?: Partial<Record<string, ConnectorFn>>
): Promise<SyncReport> {
  const runId = Number(
    db
      .prepare("INSERT INTO sync_run (source, started_at) VALUES (?, datetime('now'))")
      .run(source).lastInsertRowid
  );

  const deps: ConnectorDeps = { db, secrets, llm };
  let report: SyncReport;
  const fn = overrides?.[source] ?? CONNECTORS[source as SyncSource];
  try {
    if (!fn) throw new Error(`unknown sync source: ${source}`);
    report = await fn(deps, extra);
  } catch (e) {
    report = { source, ingested: 0, skipped: 0, created: 0, error: (e as Error).message };
  }

  db.prepare(
    "UPDATE sync_run SET finished_at = datetime('now'), records_ingested = ?, error = ? WHERE id = ?"
  ).run(report.ingested, report.error ?? null, runId);

  // Post-ingest hook — best-effort, never fails the sync.
  if (!report.error && report.ingested > 0) {
    try {
      // One-shot duplicate backfill, on the first sync after the upgrade. The setting
      // guard makes every later call a single indexed lookup.
      await cleanupDuplicateCommitments(db, secrets);
      const ids = (
        db
          .prepare(
            "SELECT id FROM interaction WHERE extracted_at IS NULL ORDER BY id DESC LIMIT ?"
          )
          .all(EXTRACT_CAP) as { id: number }[]
      ).map((r) => r.id);
      if (llm && ids.length) {
        const beforeMax = (
          db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM commitment").get() as { m: number }
        ).m;
        await extractCommitmentsLlm(db, llm, ids);
        await autoTentativeTasks(db, secrets, beforeMax);
      }
      // Thread-resolution pass AFTER extraction: new messages that fulfill or cancel
      // an already-open commitment close it (and its task). Counts land on the report.
      if (ids.length) {
        const rr = await resolveFromThreads(db, secrets, llm, ids);
        if (rr.resolved > 0) {
          const r = report as SyncReport & { threadResolved?: number; threadTasksClosed?: number };
          r.threadResolved = rr.resolved;
          r.threadTasksClosed = rr.tasksClosed;
        }
      }
      advanceLastContact(db);
      refreshNextTouch(db);
    } catch (e) {
      console.warn(`workers: post-ingest hook failed for ${source}: ${(e as Error).message}`);
    }
  }

  return report;
}

// ── thread-resolution pass (post-hoc layer) ──────────────────────────────────

export interface ThreadResolutionResult {
  /** Commitments moved to status 'done' because new messages resolved them. */
  resolved: number;
  /** Open linked tasks closed alongside (local 'done' + best-effort Google complete). */
  tasksClosed: number;
  /** People whose open commitments were checked (people with none cost nothing). */
  peopleChecked: number;
}

interface ResolutionMsg {
  direction: string | null;
  occurred_at: string | null;
  subject: string | null;
  body_summary: string | null;
}

/** People per thread-resolution call. Beyond this a SECOND call is made — never per person. */
export const RESOLUTION_BATCH_PEOPLE = 15;
/** New messages carried per person: the size knob, so no PERSON is ever dropped. */
export const RESOLUTION_MSGS_PER_PERSON = 6;

/** One numbered person in a resolution batch — `n` is the only handle the model gets. */
interface ResolutionItem {
  n: number;
  personId: number;
  name: string | null;
  open: { id: number; description: string; due_at: string | null }[];
  msgs: ResolutionMsg[];
}

const clipText = (s: string | null | undefined, n: number) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * ONE call for every person with open commitments. Each numbered entry carries that
 * person's own open commitments (id + description) and their own new messages; the model
 * may only return ids from that entry's list, and omission still means "unresolved".
 * Prompt size is bounded by keeping the newest RESOLUTION_MSGS_PER_PERSON messages per
 * person, never by dropping a person.
 */
function buildResolutionPrompt(items: ResolutionItem[]): string {
  const entries = items.map((it) => {
    const commitments = it.open.map(
      (c) => `  - id ${c.id}: ${clipText(c.description, 160)}${c.due_at ? ` (due ${c.due_at.slice(0, 10)})` : ""}`
    );
    const lines = it.msgs
      .slice(-RESOLUTION_MSGS_PER_PERSON)
      .map(
        (m) =>
          `  [${m.direction ?? "?"} ${clipText(m.occurred_at, 16)}] ${clipText([m.subject, m.body_summary].filter(Boolean).join(" — "), 200)}`
      );
    return `${it.n}. ${it.name ?? "a contact"}
 OPEN COMMITMENTS:
${commitments.join("\n")}
 NEW MESSAGES (direction-labeled, oldest first):
${lines.join("\n")}`;
  });

  return `Each numbered entry below is one contact of the user's. The commitments listed under a contact are currently OPEN, and new messages just arrived in that contact's conversation. For EACH entry, decide which of THAT ENTRY'S commitments its NEW messages CLEARLY show as already fulfilled or cancelled.

CONTACTS:
${entries.join("\n\n")}

Rules:
- "resolved" means a NEW message shows the obligation was FULFILLED ("sent it", "done", "got them", "here you go", an attachment delivering the thing) or explicitly CANCELLED ("nvm", "never mind", "don't worry about it", "all set", "figured it out").
- The message that CREATED an obligation does not resolve it. A promise to do it later ("will send tonight") does not resolve it. A new ask does not resolve anything.
- Only include ids CLEARLY fulfilled or cancelled by that entry's OWN messages — never an id from another entry. When unsure, OMIT the id — an empty array is a good and common answer.

Return STRICT JSON ONLY — no prose, no markdown fences — one object per numbered entry, using the SAME n:
[{ "n": <number>, "resolved_ids": [<commitment id from THAT entry's list>], "reason": "<short phrase citing the message>" }]`;
}

/**
 * The batched reply → n → resolved ids. Accepts the batched shape
 * `[{n, resolved_ids: [...], reason}]` and, defensively, the older per-person shape
 * `[{id, resolved: true, reason}]` — an `id` is attributed to whichever entry actually
 * owns that open commitment, so a stray id still resolves nothing. Returns null when the
 * payload is not an array at all (the caller then degrades the whole batch).
 */
function parseResolutions(
  raw: unknown,
  items: ResolutionItem[]
): Map<number, { id: number; reason: string }[]> | null {
  if (!Array.isArray(raw)) return null;
  const out = new Map<number, { id: number; reason: string }[]>();
  const ownerOf = new Map<number, number>(); // commitment id → entry n
  for (const it of items) for (const c of it.open) ownerOf.set(c.id, it.n);
  const push = (n: number, id: number, reason: string) => {
    const list = out.get(n) ?? [];
    if (!list.some((r) => r.id === id)) list.push({ id, reason });
    out.set(n, list);
  };

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const reason = typeof o.reason === "string" && o.reason ? o.reason : "resolved by new messages";
    const nRaw = Number(o.n);
    const ids = Array.isArray(o.resolved_ids) ? o.resolved_ids : null;
    if (ids) {
      for (const v of ids) {
        const id = Number(v);
        // Only ids from THAT entry's own list survive. An id belonging to another
        // person (or to nobody) is dropped, whatever `n` the model claimed.
        const owner = ownerOf.get(id);
        if (owner == null) continue;
        if (Number.isFinite(nRaw) && owner !== nRaw) continue;
        push(owner, id, reason);
      }
      continue;
    }
    // Legacy single-item shape: {id, resolved: true}. Same conservatism.
    const id = Number(o.id);
    if (o.resolved !== true || !Number.isFinite(id)) continue;
    const owner = ownerOf.get(id);
    if (owner == null) continue;
    push(owner, id, reason);
  }
  return out;
}

/**
 * Post-hoc thread-resolution layer (owner spec 2026-08-05 #3): when something is
 * resolved IN the message chain, it must not live on as an open task/commitment.
 * For each person with NEW messages this sync, load their OPEN commitments (status
 * open/scheduled); people with none are skipped before any LLM call (zero cost).
 * With an LLM: ONE fast-tier strict-JSON call for the whole batch of people (owner
 * standing directive — never one call per item; RESOLUTION_BATCH_PEOPLE per call, so
 * six people cost one request, not six). Each numbered entry carries only its own
 * person's open commitments and messages, and only ids from that entry's own list are
 * accepted — unsure ids are omitted, exactly as before.
 * Without an LLM (or when a batch's call fails / returns unusable JSON — the WHOLE batch
 * degrades, never a silent partial): deterministic threadResolves only, and only
 * when the person has exactly ONE open commitment — a keyword match can't tell WHICH
 * of several "sent it" refers to, so ambiguity resolves nothing (conservative).
 *
 * Each resolved commitment: status 'done' + resolved_at; any open linked task goes
 * status 'done' + completed_at with a best-effort, time-boxed closeGoogleTask.
 * Automatic action → NO undo entries, but every resolution logs a console line.
 */
export async function resolveFromThreads(
  db: Db,
  secrets: SecretStore,
  llm: LlmClient | null,
  newInteractionIds: number[]
): Promise<ThreadResolutionResult> {
  const out: ThreadResolutionResult = { resolved: 0, tasksClosed: 0, peopleChecked: 0 };
  if (newInteractionIds.length === 0) return out;

  const msgs = db
    .prepare(
      `SELECT id, person_id, direction, occurred_at, subject, body_summary
       FROM interaction
       WHERE person_id IS NOT NULL AND id IN (${newInteractionIds.map(() => "?").join(",")})
       ORDER BY occurred_at ASC`
    )
    .all(...newInteractionIds) as (ResolutionMsg & { id: number; person_id: number })[];
  const byPerson = new Map<number, ResolutionMsg[]>();
  for (const m of msgs) {
    const list = byPerson.get(m.person_id) ?? [];
    list.push(m);
    byPerson.set(m.person_id, list);
  }

  const openStmt = db.prepare(
    "SELECT id, description, due_at FROM commitment WHERE person_id = ? AND status IN ('open','scheduled')"
  );
  const nameStmt = db.prepare("SELECT display_name FROM person WHERE id = ?");
  const markDone = db.prepare(
    "UPDATE commitment SET status = 'done', resolved_at = datetime('now') WHERE id = ?"
  );
  const openTasks = db.prepare(
    "SELECT id, gtasks_id FROM task WHERE commitment_id = ? AND status IN ('inbox','planned','in_progress')"
  );
  const closeTask = db.prepare(
    "UPDATE task SET status = 'done', completed_at = datetime('now') WHERE id = ?"
  );

  // ── phase 1 (ZERO tokens): only people who actually have something to resolve ──
  const items: ResolutionItem[] = [];
  for (const [personId, personMsgs] of byPerson) {
    const open = openStmt.all(personId) as { id: number; description: string; due_at: string | null }[];
    if (open.length === 0) continue; // nothing to resolve — zero LLM cost
    out.peopleChecked++;
    items.push({
      n: items.length + 1,
      personId,
      name: (nameStmt.get(personId) as { display_name: string | null } | undefined)?.display_name ?? null,
      open,
      msgs: personMsgs,
    });
  }
  if (items.length === 0) return out;

  // ── phase 2: ONE call per batch of people (never one per person) ─────────────
  const resolutions = new Map<number, { id: number; reason: string }[]>();
  const llmHandled = new Set<number>();
  let calls = 0;
  if (llm) {
    for (let i = 0; i < items.length; i += RESOLUTION_BATCH_PEOPLE) {
      const batch = items.slice(i, i + RESOLUTION_BATCH_PEOPLE);
      // Renumber so each prompt's `n` runs 1..batch.length (the model never sees gaps).
      const numbered = batch.map((it, j) => ({ ...it, n: j + 1 }));
      const res = await llm.call("thread-resolution", "fast", buildResolutionPrompt(numbered), {
        json: true,
      });
      calls++;
      if (!res) continue; // whole batch degrades to the deterministic path below
      let parsed: Map<number, { id: number; reason: string }[]> | null = null;
      try {
        parsed = parseResolutions(extractJson(res.text), numbered);
      } catch (e) {
        console.warn(`workers: thread-resolution bad LLM JSON, batch degrades (${(e as Error).message})`);
      }
      if (!parsed) continue; // unusable shape — the WHOLE batch takes the deterministic path
      for (const it of numbered) {
        // A parsed reply IS the model's answer for every person in the batch: an
        // omitted person means "nothing resolved", not "the call failed".
        llmHandled.add(batch[it.n - 1].personId);
        const found = parsed.get(it.n);
        if (found?.length) resolutions.set(batch[it.n - 1].personId, found);
      }
    }
    console.log(`workers: thread-resolution checked ${items.length} person(s) in ${calls} LLM call(s)`);
  }

  for (const it of items) {
    if (!llmHandled.has(it.personId) && it.open.length === 1) {
      // Deterministic path (no LLM / call failed / unusable JSON): conservative — only an
      // unambiguous single open commitment can be closed by a keyword match.
      const texts = it.msgs
        .map((m) => [m.subject, m.body_summary].filter(Boolean).join(" — "))
        .filter((t) => t.length > 0);
      if (threadResolves(it.open[0].description, texts)) {
        resolutions.set(it.personId, [
          { id: it.open[0].id, reason: "deterministic thread-resolution match" },
        ]);
      }
    }

    for (const r of resolutions.get(it.personId) ?? []) {
      markDone.run(r.id);
      out.resolved++;
      const desc = it.open.find((c) => c.id === r.id)?.description ?? "";
      console.log(`workers: thread-resolution closed commitment ${r.id} ("${desc}") — ${r.reason}`);
      for (const t of openTasks.all(r.id) as { id: number; gtasks_id: string | null }[]) {
        closeTask.run(t.id);
        out.tasksClosed++;
        if (t.gtasks_id) await closeGoogleTask(db, secrets, t.gtasks_id); // best-effort, time-boxed
      }
    }
  }

  return out;
}

/** Autonomy threshold: only commitments at or above this confidence auto-convert. */
export const AUTO_CONVERT_CONFIDENCE = 0.8;

/**
 * Scoped autonomy (owner directive 2026-08-04, refining the earlier full-autonomy one):
 * a NEWLY extracted commitment (id > `beforeMaxId`) becomes a local task + a Google task
 * titled "Tentative: …" (local title stays clean) ONLY when its confidence is >=
 * AUTO_CONVERT_CONFIDENCE AND its description passes passesCommitmentGate. Everything
 * else stays status 'open' / confirmed_by_user 0 — visible in the dashboard's
 * "Needs review" section, never in tasks or Google. Idempotent: a commitment with ANY
 * existing task — open or done — is skipped. This is an automatic action, so it
 * records NO undo entries; dropping the commitment later cleans the task up
 * (dropCommitmentCascade). Failures are logged and never propagate.
 */
export async function autoTentativeTasks(db: Db, secrets: SecretStore, beforeMaxId: number): Promise<number> {
  const fresh = db
    .prepare("SELECT id, description, due_at, confidence FROM commitment WHERE id > ? AND status = 'open'")
    .all(beforeMaxId) as { id: number; description: string; due_at: string | null; confidence: number }[];
  let created = 0;
  for (const c of fresh) {
    // Below-threshold or gate-failing rows are left untouched for human review.
    if (c.confidence < AUTO_CONVERT_CONFIDENCE || !passesCommitmentGate(c.description)) continue;
    if (db.prepare("SELECT 1 FROM task WHERE commitment_id = ?").get(c.id)) continue; // idempotent
    // Only explicit dates schedule things (owner directive 2026-08-05): no due_at →
    // no dateISO → commitmentToTask creates an inbox task with plan_date NULL and a
    // Google task with NO due date. The old today-default put months-away and undated
    // commitments on today's list.
    const dateISO = c.due_at ? c.due_at.slice(0, 10) : undefined;
    try {
      const res = await commitmentToTask(db, secrets, c.id, dateISO, { tentative: true });
      if (!res.duplicate) created++;
    } catch (e) {
      console.warn(`workers: auto task for commitment ${c.id} failed: ${(e as Error).message}`);
    }
  }
  return created;
}

/** One-shot flag: the 2026-08-04 junk-task cleanup runs exactly once per database. */
export const CLEANUP_TENTATIVE_KEY = "cleanup_tentative_v1";

/**
 * One-time repair for the morning the old any-confidence pipeline shipped junk
 * ("do you want eggs?" et al.) straight to Google Tasks. For every still-open task
 * (status inbox/planned, created_at >= 2026-08-04) whose linked commitment has
 * confidence < AUTO_CONVERT_CONFIDENCE OR fails passesCommitmentGate:
 *   - delete the local task,
 *   - best-effort complete its Google counterpart (closeGoogleTask is time-boxed and
 *     swallows errors),
 *   - return the commitment to status 'open' / confirmed_by_user 0 so it lands in the
 *     "Needs review" section instead of vanishing.
 * Keyed on setting CLEANUP_TENTATIVE_KEY, set only after the pass completes.
 */
export async function cleanupTentativeTasks(
  db: Db,
  secrets: SecretStore
): Promise<{ deletedTasks: number; reopenedCommitments: number }> {
  if (getSetting(db, CLEANUP_TENTATIVE_KEY)) return { deletedTasks: 0, reopenedCommitments: 0 };

  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.gtasks_id, c.id AS commitment_id, c.confidence, c.description
       FROM task t JOIN commitment c ON c.id = t.commitment_id
       WHERE t.commitment_id IS NOT NULL AND t.status IN ('inbox','planned') AND t.created_at >= '2026-08-04'`
    )
    .all() as { task_id: number; gtasks_id: string | null; commitment_id: number; confidence: number; description: string }[];

  let deletedTasks = 0;
  const reopened = new Set<number>();
  for (const r of rows) {
    if (r.confidence >= AUTO_CONVERT_CONFIDENCE && passesCommitmentGate(r.description)) continue; // legitimate — keep
    db.prepare("DELETE FROM task WHERE id = ?").run(r.task_id);
    deletedTasks++;
    if (r.gtasks_id) await closeGoogleTask(db, secrets, r.gtasks_id); // best-effort, time-boxed
    db.prepare("UPDATE commitment SET status = 'open', confirmed_by_user = 0 WHERE id = ?").run(r.commitment_id);
    reopened.add(r.commitment_id);
  }

  setSetting(db, CLEANUP_TENTATIVE_KEY, new Date().toISOString());
  console.log(
    `workers: ${CLEANUP_TENTATIVE_KEY} removed ${deletedTasks} junk task(s), returned ${reopened.size} commitment(s) to review (${rows.length} candidate(s) examined)`
  );
  return { deletedTasks, reopenedCommitments: reopened.size };
}

/** One-shot flag: the 2026-08-05 full reset onto the fixed extraction pipeline. */
export const CLEANUP_TENTATIVE_V2_KEY = "cleanup_tentative_v2";

/**
 * Second-pass full reset (owner report 2026-08-05). The v1 cleanup kept tasks whose
 * commitments were high-confidence AND gate-passing — but everything created since
 * 2026-08-04 came out of the context-blind, today-defaulting pipeline, so even the
 * "legitimate" survivors carry unresolved references ("add a boot tray to my list")
 * and wrong dates (everything undated landed on TODAY). Remove ALL remaining
 * commitment-linked tasks in the incident window (created_at >= 2026-08-04, status
 * inbox/planned), best-effort complete their Google counterparts, and return every
 * affected commitment to status 'open' / confirmed_by_user 0 so it re-enters review
 * through the fixed pipeline. Keyed on setting CLEANUP_TENTATIVE_V2_KEY, set only
 * after the pass completes.
 */
export async function cleanupTentativeTasksV2(
  db: Db,
  secrets: SecretStore
): Promise<{ deletedTasks: number; reopenedCommitments: number }> {
  if (getSetting(db, CLEANUP_TENTATIVE_V2_KEY)) return { deletedTasks: 0, reopenedCommitments: 0 };

  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.gtasks_id, t.commitment_id
       FROM task t
       WHERE t.commitment_id IS NOT NULL AND t.status IN ('inbox','planned') AND t.created_at >= '2026-08-04'`
    )
    .all() as { task_id: number; gtasks_id: string | null; commitment_id: number }[];

  let deletedTasks = 0;
  const reopened = new Set<number>();
  for (const r of rows) {
    db.prepare("DELETE FROM task WHERE id = ?").run(r.task_id);
    deletedTasks++;
    if (r.gtasks_id) await closeGoogleTask(db, secrets, r.gtasks_id); // best-effort, time-boxed
    db.prepare("UPDATE commitment SET status = 'open', confirmed_by_user = 0 WHERE id = ?").run(r.commitment_id);
    reopened.add(r.commitment_id);
  }

  setSetting(db, CLEANUP_TENTATIVE_V2_KEY, new Date().toISOString());
  console.log(
    `workers: ${CLEANUP_TENTATIVE_V2_KEY} reset ${deletedTasks} auto-created task(s), returned ${reopened.size} commitment(s) to review`
  );
  return { deletedTasks, reopenedCommitments: reopened.size };
}

/** One-shot flag: the 2026-08-05 expired same-day sweep over the review queue. */
export const CLEANUP_TENTATIVE_V3_KEY = "cleanup_tentative_v3";

/**
 * Third-pass sweep (owner report 2026-08-05 #2): "be back here at 5:30 latest" texted
 * on a PREVIOUS day survived as an undated review item. A commitment whose only
 * temporal reference is a time-of-day / same-day marker is scoped to its message's
 * sent date — once that moment passed it should have been dropped, never kept undated
 * (extraction now enforces this via isExpiredSameDay; this repairs what already
 * landed). Over every open+unconfirmed commitment (the review queue) whose source
 * interaction occurred more than 2 days ago, drop (status 'dropped', resolved_at set,
 * kept for audit like dropCommitment) any where isExpiredSameDay over the description
 * plus the source message's subject/body holds. Review-queue rows have no tasks and
 * never reached Google, so the sweep is purely local. Keyed on setting
 * CLEANUP_TENTATIVE_V3_KEY, set only after the pass completes.
 */
export function cleanupTentativeTasksV3(db: Db): { dropped: number } {
  if (getSetting(db, CLEANUP_TENTATIVE_V3_KEY)) return { dropped: 0 };

  const now = new Date();
  const cutoff = now.getTime() - 2 * 86_400_000; // only messages more than 2 days old
  const rows = db
    .prepare(
      `SELECT c.id, c.description, i.occurred_at, i.subject, i.body_summary
       FROM commitment c JOIN interaction i ON i.id = c.source_interaction_id
       WHERE c.status = 'open' AND c.confirmed_by_user = 0 AND i.occurred_at IS NOT NULL`
    )
    .all() as {
    id: number;
    description: string;
    occurred_at: string;
    subject: string | null;
    body_summary: string | null;
  }[];

  const drop = db.prepare(
    "UPDATE commitment SET status = 'dropped', resolved_at = datetime('now') WHERE id = ?"
  );
  let dropped = 0;
  for (const r of rows) {
    const sent = new Date(r.occurred_at);
    if (Number.isNaN(sent.getTime()) || sent.getTime() > cutoff) continue; // recent — leave alone
    const text = [r.description, r.subject, r.body_summary].filter(Boolean).join(" — ");
    if (!isExpiredSameDay(text, sent, now)) continue;
    drop.run(r.id);
    dropped++;
  }

  setSetting(db, CLEANUP_TENTATIVE_V3_KEY, new Date().toISOString());
  console.log(
    `workers: ${CLEANUP_TENTATIVE_V3_KEY} dropped ${dropped} expired same-day commitment(s) from review (${rows.length} candidate(s) examined)`
  );
  return { dropped };
}

/** One-shot flag: the 2026-08-05 duplicate-commitment backfill runs once per database. */
export const CLEANUP_DUPES_KEY = "cleanup_dupes_v1";

/**
 * Backfill sweep for owner report 2026-08-05 (b): "these two events are the same thing
 * albeit from different texts". Extraction now collapses semantic duplicates through
 * commitment.dedupe_key, but the rows that already landed have no key. For every live
 * commitment (status open/scheduled — done and dropped rows are history, left alone),
 * compute the key from its description + person + due day and group:
 *   - keep the highest-confidence row (earliest created_at breaks ties) and stamp the key
 *     on it, so future extractions collapse INTO it;
 *   - drop the rest (status 'dropped' + resolved_at, kept for audit exactly like
 *     dropCommitment), close any local task they created, and best-effort complete its
 *     Google counterpart (closeGoogleTask is time-boxed and swallows errors).
 * Keyed on setting CLEANUP_DUPES_KEY, set only after the pass completes, so it runs on the
 * first sync after the upgrade and is free forever after.
 */
export async function cleanupDuplicateCommitments(
  db: Db,
  secrets: SecretStore
): Promise<{ groups: number; dropped: number; tasksClosed: number }> {
  if (getSetting(db, CLEANUP_DUPES_KEY)) return { groups: 0, dropped: 0, tasksClosed: 0 };

  const rows = db
    .prepare(
      `SELECT id, person_id, description, due_at, confidence, created_at, dedupe_key
       FROM commitment WHERE status IN ('open','scheduled')
       ORDER BY id ASC`
    )
    .all() as {
    id: number;
    person_id: number | null;
    description: string;
    due_at: string | null;
    confidence: number;
    created_at: string;
    dedupe_key: string | null;
  }[];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = dedupeKeyFor(r.description, r.person_id, r.due_at);
    if (!key) continue; // no alphanumerics in the description — nothing to match on
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const setKey = db.prepare("UPDATE commitment SET dedupe_key = ? WHERE id = ?");
  const drop = db.prepare(
    "UPDATE commitment SET status = 'dropped', resolved_at = datetime('now') WHERE id = ?"
  );
  const openTasks = db.prepare(
    "SELECT id, gtasks_id FROM task WHERE commitment_id = ? AND status IN ('inbox','planned','in_progress')"
  );
  const closeTask = db.prepare(
    "UPDATE task SET status = 'done', completed_at = datetime('now') WHERE id = ?"
  );

  let dupGroups = 0;
  let dropped = 0;
  let tasksClosed = 0;
  for (const [key, list] of groups) {
    // Highest confidence wins; the earliest created_at (then the lowest id) breaks ties.
    const ordered = [...list].sort(
      (a, b) => b.confidence - a.confidence || a.created_at.localeCompare(b.created_at) || a.id - b.id
    );
    const keeper = ordered[0];
    if (keeper.dedupe_key !== key) {
      try {
        setKey.run(key, keeper.id);
      } catch {
        /* another row (e.g. a resolved one) already owns this key — leave the keeper bare */
      }
    }
    if (ordered.length === 1) continue;
    dupGroups++;
    for (const loser of ordered.slice(1)) {
      drop.run(loser.id);
      dropped++;
      console.log(
        `workers: ${CLEANUP_DUPES_KEY} dropped duplicate commitment ${loser.id} ("${loser.description}") in favour of ${keeper.id}`
      );
      for (const t of openTasks.all(loser.id) as { id: number; gtasks_id: string | null }[]) {
        closeTask.run(t.id);
        tasksClosed++;
        if (t.gtasks_id) await closeGoogleTask(db, secrets, t.gtasks_id); // best-effort, time-boxed
      }
    }
  }

  setSetting(db, CLEANUP_DUPES_KEY, new Date().toISOString());
  console.log(
    `workers: ${CLEANUP_DUPES_KEY} examined ${rows.length} live commitment(s), collapsed ${dupGroups} duplicate group(s), dropped ${dropped} row(s), closed ${tasksClosed} task(s)`
  );
  return { groups: dupGroups, dropped, tasksClosed };
}

/** Settings key marking the day's enrichment pass as done (one pass per calendar day). */
export function enrichDayKey(now: Date = new Date()): string {
  return `enrich_day:${now.toISOString().slice(0, 10)}`;
}

// ── auto-push sweep ──────────────────────────────────────────────────────────
//
// Generating a plan pushes it (planner.generatePlan). This is the safety net for every plan
// that did NOT get out: the app was offline, Google was slow, or the push timed out. Runs on
// the same 15-minute tick.
//
// Owner report 2026-08-06: "it should automatically populate to my Google Calendar, it
// shouldn't require me to press a button." It already did not — but ONLY for plans he had
// ACCEPTED, and acceptance was a button. Today's plan sat with accepted_at NULL, so both the
// accept-time push and this sweep skipped it and Google stayed empty. Acceptance is no longer
// the gate: a plan is the app's best current answer for that day, and Google should show it.

/** How far back the sweep looks. Older plans are history, not pending work. */
export const AUTO_PUSH_WINDOW_DAYS = 7;

export interface AutoPushSweepResult {
  /** Plans that pushed cleanly. */
  plans: number;
  /** Calendar blocks written across them. */
  pushed: number;
  /** Stale events withdrawn from Google (blocks a re-plan removed). */
  withdrawn: number;
  /** Why the sweep did nothing, when it did nothing on purpose. */
  skipped?: "auto_push_off" | "not_connected" | "no_write_scope";
  /** First real push failure encountered (the sweep still tries the rest). */
  error?: string;
}

/**
 * Plans within the window that Google does not have in full:
 *   - never pushed (`pushed_at IS NULL`), or
 *   - carrying a non-anchor block Google has no event for, or one created after the last
 *     push (the plan changed since it went out).
 *
 * Only the NEWEST plan per day is a candidate. Re-planning an already-accepted day leaves the
 * superseded row behind (generatePlan only deletes un-accepted ones), and pushing both would
 * put two contradictory schedules on the same calendar. The newest plan is the live answer;
 * the older row's events are withdrawn by the tombstone drain instead.
 */
export function plansNeedingPush(db: Db, windowDays = AUTO_PUSH_WINDOW_DAYS): number[] {
  return (
    db
      .prepare(
        `WITH newest AS (
           SELECT p.id, p.pushed_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY p.plan_date ORDER BY p.generated_at DESC, p.id DESC
                  ) AS rn
             FROM plan p
            WHERE p.plan_date >= date('now', ?)
         )
         SELECT n.id FROM newest n
          WHERE n.rn = 1
            AND (
              n.pushed_at IS NULL
              OR EXISTS (
                SELECT 1 FROM block b
                 WHERE b.plan_id = n.id AND b.is_anchor = 0
                   AND (b.gcal_event_id IS NULL OR b.created_at > n.pushed_at)
              )
            )
          ORDER BY n.id`
      )
      .all(`-${windowDays} day`) as { id: number }[]
  ).map((r) => r.id);
}

/** Are there events awaiting withdrawal? Drives a drain even when no plan needs pushing. */
export function tombstonesPending(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM gcal_tombstone").get() as { n: number }).n;
}

// ── an engine fix has to reach the day that already has a plan ───────────────
//
// Owner report 2026-08-06, after the fixes shipped: "I talked about the bug in today's
// schedule where it scheduled unpacking my travel bag almost two hours after my shutdown
// ritual and it not taking into account the Stanford math test. Why didn't it do that?"
//
// Because a plan is SOLVED ONCE AND STORED. Fixing the solver changes what the next solve
// produces; it does nothing to a row that already exists. His plan was generated at 12:01
// and nothing re-solved it: replanIfConflicted only fires when the EXTERNAL calendar moves
// (the anchor fingerprint), and the calendar had not moved — the engine had.
//
// So a fix could pass every test, ship, and leave his actual day showing the bug it fixed.
// `plan.engine_version` was already written on every row for exactly this and nothing ever
// read it. Now a version bump is what invalidates a stale day.
//
// Accepted plans are deliberately left alone: acceptance means he read that day and locked
// it, and silently re-solving it would be a worse bug than the one being fixed. They are
// reported instead, so the surface can offer a re-plan rather than perform one.

/** How far ahead a stale-engine sweep looks. Yesterday is history; it is not re-solved. */
export const STALE_ENGINE_WINDOW_DAYS = 7;

export interface StaleEnginePlan {
  planId: number;
  planDate: string;
  engineVersion: string;
  /** The owner locked this day — re-solve is offered, never performed. */
  accepted: boolean;
}

/**
 * Upcoming days whose newest plan was solved by an older engine. Today counts: the day is
 * still being lived, and that is precisely when a scheduling bug still matters.
 */
export function plansOnStaleEngine(
  db: Db,
  now: Date = new Date(),
  windowDays = STALE_ENGINE_WINDOW_DAYS
): StaleEnginePlan[] {
  const today = now.toISOString().slice(0, 10);
  const until = new Date(now.getTime() + windowDays * 86_400_000).toISOString().slice(0, 10);
  return (
    db
      .prepare(
        `WITH newest AS (
           SELECT p.id, p.plan_date, p.engine_version, p.accepted_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY p.plan_date ORDER BY p.generated_at DESC, p.id DESC
                  ) AS rn
             FROM plan p
            WHERE p.plan_date >= ? AND p.plan_date <= ?
         )
         SELECT id, plan_date, engine_version, accepted_at FROM newest
          WHERE rn = 1 AND engine_version <> ?
          ORDER BY plan_date`
      )
      .all(today, until, ENGINE_VERSION) as {
      id: number;
      plan_date: string;
      engine_version: string;
      accepted_at: string | null;
    }[]
  ).map((r) => ({
    planId: r.id,
    planDate: r.plan_date,
    engineVersion: r.engine_version,
    accepted: r.accepted_at != null,
  }));
}

export interface StaleEngineSweepResult {
  /** Days re-solved on the current engine. */
  replanned: string[];
  /** Days left alone because the owner had locked them. */
  lockedSkipped: string[];
  error?: string;
}

/** Re-solve every upcoming un-accepted day still carrying an older engine version. */
export async function replanStaleEngine(
  db: Db,
  doctrineDir: string,
  secrets: SecretStore,
  llm: LlmClient | null,
  now: Date = new Date()
): Promise<StaleEngineSweepResult> {
  const out: StaleEngineSweepResult = { replanned: [], lockedSkipped: [] };
  for (const p of plansOnStaleEngine(db, now)) {
    if (p.accepted) {
      out.lockedSkipped.push(p.planDate);
      continue;
    }
    try {
      await generatePlan(db, doctrineDir, secrets, llm, p.planDate);
      out.replanned.push(p.planDate);
      console.log(`workers: re-solved ${p.planDate} (was engine ${p.engineVersion}, now ${ENGINE_VERSION})`);
    } catch (e) {
      out.error ??= (e as Error).message;
      console.warn(`workers: stale-engine replan of ${p.planDate} failed: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Push every accepted-but-unpushed plan. Silent no-op when auto-push is off, Google is not
 * connected, or the stored grant predates the calendar-write scope widening — that last
 * case would otherwise fail identically on every tick forever, which is exactly the noise
 * the Settings warning exists to replace.
 */
export async function sweepAutoPush(
  db: Db,
  secrets: SecretStore,
  deps?: Partial<GcalPushDeps>
): Promise<AutoPushSweepResult> {
  const out: AutoPushSweepResult = { plans: 0, pushed: 0, withdrawn: 0 };
  if (!autoPushEnabled(db)) return { ...out, skipped: "auto_push_off" };
  if (!isGoogleConnected(secrets)) return { ...out, skipped: "not_connected" };
  if (!hasCalendarWriteScope(secrets)) return { ...out, skipped: "no_write_scope" };

  const planIds = plansNeedingPush(db);
  for (const planId of planIds) {
    const res = await pushPlanToGoogle(db, secrets, planId, deps);
    if (res.error) {
      out.error ??= res.error;
      console.warn(`workers: auto-push of plan ${planId} failed: ${res.error}`);
      continue;
    }
    out.plans++;
    out.pushed += res.pushed;
    out.withdrawn += res.withdrawn;
  }
  // A day whose plan was abandoned entirely leaves events to withdraw and no plan to push,
  // so the drain cannot be left to ride along with a push that never happens.
  if (planIds.length === 0 && tombstonesPending(db) > 0) {
    try {
      out.withdrawn += (await drainTombstones(db, secrets, deps)).deleted;
    } catch (e) {
      out.error ??= (e as Error).message;
    }
  }
  return out;
}

export interface WorkersHandle {
  stop(): void;
}

/**
 * Schedule gmail + linkedin-email + imessage every 15 minutes while the app is open. Sources that aren't
 * ready (no Gmail creds / no Full Disk Access) are skipped silently — no sync_run noise.
 * A running flag guarantees runs never overlap. `notify` fires with a short human message
 * when a run brought in new interactions.
 */
export function startWorkers(
  db: Db,
  secrets: SecretStore,
  llm: LlmClient | null,
  notify?: (msg: string) => void
): WorkersHandle {
  const cron = req("node-cron") as CronModule;
  let running = false;

  // Warm today's calendar caches at startup, fire-and-forget: readAnchors serves any
  // persisted snapshot instantly and refreshes live in the background; eventsForDate
  // does the same for subscribed feeds. Either way the in-process caches are hot
  // before the user first clicks Calendar, so the tab opens without a network wait.
  void (async () => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      await readAnchors(db, secrets, today);
    } catch (e) {
      console.warn(`workers: anchors warm-up failed: ${(e as Error).message}`);
    }
    try {
      await icsEventsForDate(db, today);
    } catch (e) {
      console.warn(`workers: ics warm-up failed: ${(e as Error).message}`);
    }
  })();

  const announce = (r: SyncReport) => {
    if (r.error || r.ingested === 0) return; // quiet unless something new landed
    if (r.source === "msgplans") {
      // msgplans counts calendar changes, not interactions — say so.
      notify?.(`Plans from messages: ${r.ingested} calendar change${r.ingested === 1 ? "" : "s"}`);
      return;
    }
    if (r.source === "notion") {
      // notion counts tasks pulled from the POS Tasks database, not interactions.
      notify?.(`Notion: pulled ${r.ingested} new task${r.ingested === 1 ? "" : "s"}`);
      return;
    }
    const people = r.created > 0 ? `, ${r.created} new ${r.created === 1 ? "person" : "people"}` : "";
    notify?.(`Synced ${r.source}: ${r.ingested} new interaction${r.ingested === 1 ? "" : "s"}${people}`);
  };

  const tick = async () => {
    if (running) return; // never overlap
    running = true;
    try {
      // Degraded-work backfill FIRST, before anything else that spends the model (owner ask
      // 2026-08-05: "when my Gemini credits refill it should go back and fix the stuff it
      // couldn't summarize at the time"). Repairs get first claim on a freshly-refilled
      // quota — extraction of new mail can wait a tick; the rough titles already on his
      // screen have been wrong since the outage. Two cheap guards keep this free on the
      // 15-minute tick when there is nothing to do: an indexed prefix scan of the queue and
      // the cached health read. At most one pass per tick.
      try {
        if (llm && listDegraded(db, "commitment").length > 0 && llmHealth(db, secrets).ok) {
          const bf = await backfillDegraded(db, secrets, llm);
          if (bf.repaired > 0) {
            notify?.(
              `Rewrote ${bf.repaired} item${bf.repaired === 1 ? "" : "s"} the AI missed while quota was exhausted`
            );
          }
        }
      } catch (e) {
        console.warn(`workers: degraded backfill failed: ${(e as Error).message}`);
      }

      // An undated commitment can never be scheduled, so it just reappears every morning
      // forever (owner report 2026-08-06). Many of them state their own timing — read it and
      // write it down, so they surface when they matter instead of continuously. Deterministic
      // and local: no LLM call, so this is free to run on every tick.
      try {
        rehydrateCommitmentDates(db);
      } catch (e) {
        console.warn(`workers: commitment date rehydrate failed: ${(e as Error).message}`);
      }

      // Skip silently only when ZERO mail accounts are configured.
      // Two-way Google Tasks: pull the user's phone-side edits/deletions BEFORE any
      // push, so a task deleted in Google is never resurrected on the same tick.
      try {
        const gt = await reconcileGoogleTasks(db, secrets);
        if (gt.pulled || gt.completedLocally || gt.deletedLocally) {
          notify?.(
            `Google Tasks: ${gt.pulled} updated, ${gt.completedLocally} completed, ${gt.deletedLocally} removed`
          );
        }
      } catch (e) {
        console.warn(`gtasks reconcile failed: ${(e as Error).message}`);
      }

      // Auto-push: any accepted plan Google doesn't have yet goes out now. Silent when
      // auto-push is off, Google isn't connected, or the grant is too narrow.
      try {
        const ap = await sweepAutoPush(db, secrets);
        if (ap.plans > 0) {
          notify?.(
            `Pushed ${ap.pushed} block${ap.pushed === 1 ? "" : "s"} to Google (${ap.plans} plan${ap.plans === 1 ? "" : "s"})`
          );
        }
      } catch (e) {
        console.warn(`workers: auto-push sweep failed: ${(e as Error).message}`);
      }

      // Objective outcomes from yesterday, after midday so his own answers win.
      try {
        if (getSetting(db, "screentime_enabled") === "1" && new Date().getHours() >= 12) {
          const target = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
          const key = `screentime_autocapture_${target}`;
          if (!getSetting(db, key) && screenTimeAvailable().ok) {
            const res = autoCaptureOutcomes(db, target);
            if (!res.error) {
              setSetting(db, key, new Date().toISOString());
              if (res.captured > 0) notify?.(`Screen Time: filled in ${res.captured} outcome(s) for ${target}`);
            }
          }
        }
      } catch (e) {
        console.warn(`screen time auto-capture failed: ${(e as Error).message}`);
      }

      // The calendar moving under a plan re-solves it — today AND the next two days, since
      // he plans ahead (local only; the regenerated plan is un-accepted, so nothing reaches
      // Google until he says so).
      try {
        const r = await replanUpcoming(db, resolveDoctrineDir(), secrets, llm);
        for (const d of r.replanned) {
          const hit = r.displaced[d];
          notify?.(
            hit?.length
              ? `Replanned ${d} around: ${hit.join(", ")}`
              : `Replanned ${d} — freed time from: ${(r.freed[d] ?? []).join(", ")}`
          );
        }
      } catch (e) {
        console.warn(`replan sweep failed: ${(e as Error).message}`);
      }

      // An engine FIX is the other reason a stored plan is wrong, and the fingerprint check
      // above cannot see it — the calendar has not moved, the solver has. Without this a
      // corrected bug stays on his screen until something unrelated happens to re-plan.
      try {
        const se = await replanStaleEngine(db, resolveDoctrineDir(), secrets, llm);
        for (const d of se.replanned) notify?.(`Re-solved ${d} on the updated planner`);
        if (se.lockedSkipped.length > 0) {
          notify?.(
            `${se.lockedSkipped.join(", ")} ${se.lockedSkipped.length === 1 ? "was" : "were"} planned by an older ` +
              `version — unlock to re-solve`
          );
        }
      } catch (e) {
        console.warn(`stale-engine sweep failed: ${(e as Error).message}`);
      }

      if (gmailConfigured({ secrets })) {
        announce(await runSync(db, secrets, llm, "gmail"));
        // Same accounts, LinkedIn notification mail only (invites/accepts → people).
        announce(await runSync(db, secrets, llm, "linkedin-email"));
      }
      // Morning capture: runs when there's any source for self-messages (a mail account
      // or configured self iMessage handles).
      if (gmailConfigured({ secrets }) || (getSetting(db, "capture_self_handles") ?? "").trim()) {
        announce(await runSync(db, secrets, llm, "capture"));
      }
      if (imessageAvailable()) {
        // FDA can still be revoked between the precheck and the copy — announce() stays
        // quiet on any error, so that failure mode is silent too.
        announce(await runSync(db, secrets, llm, "imessage"));
        // Plans from messages. Same precheck (unreadable chat.db / missing FDA is skipped
        // silently); the connector itself reports 'full_disk_access' if it's revoked mid-run.
        announce(await runSync(db, secrets, llm, "msgplans"));
      }
      // Notion — gated on token + parent page so an unconfigured integration never
      // writes error rows to sync_run.
      if (notionConfigured(db, secrets)) {
        announce(await runSync(db, secrets, llm, "notion"));
      }
      // Morning digest: once per day, from doctrine wake_time + 15 min on, gated on
      // digest_enabled. Errors are contained here — a failed send never stops the tick.
      try {
        if (getSetting(db, "digest_enabled") === "1") {
          const wake = loadDoctrine(resolveDoctrineDir()).chronotype.wake_time;
          if (shouldSendDigest(db, wake)) {
            const res = await sendMorningDigest(db, secrets);
            if (res.sent) {
              notify?.(`Morning digest sent — ${res.items} item${res.items === 1 ? "" : "s"} to confirm`);
            } else if (res.reason === "automation_denied" || res.reason === "send_failed") {
              console.warn(`workers: morning digest failed: ${res.reason}${res.detail ? ` (${res.detail})` : ""}`);
            }
          }
        }
      } catch (e) {
        console.warn(`workers: morning digest failed: ${(e as Error).message}`);
      }
      // Weekly worklog distillation: from Friday on, once per ISO week (the setting
      // key makes re-checks free; skipped silently without an LLM).
      const dow = new Date().getDay();
      if ((dow === 5 || dow === 6 || dow === 0) && !getSetting(db, distillWeekKey())) {
        const d = await distillWeek(db, llm);
        if (d.inserted > 0) notify?.(`Worklog: distilled ${d.inserted} entr${d.inserted === 1 ? "y" : "ies"} for the week`);
      }
      // Profile synthesis + bio-mining: once per day. The daily LLM budget lives in
      // enrich.ts (enrichment_attempt ledger); the setting key just keeps the pass
      // from re-running on every 15-minute tick. Skipped silently without an LLM.
      try {
        if (llm && !getSetting(db, enrichDayKey())) {
          const e = await runEnrichment(db, llm);
          setSetting(db, enrichDayKey(), new Date().toISOString());
          if (e.synthesized > 0 || e.mined > 0) {
            notify?.(
              `Profiles: ${e.synthesized} synthesized, ${e.mined} bio${e.mined === 1 ? "" : "s"} enriched`
            );
          }
        }
      } catch (e) {
        console.warn(`workers: enrichment failed: ${(e as Error).message}`);
      }
    } catch (e) {
      console.warn(`workers: scheduled sync failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };

  // A newly-installed build is exactly when a stale plan is most likely and least excusable
  // — the owner has just been told a scheduling bug is fixed. Waiting up to fifteen minutes
  // for the first tick means opening the app and seeing the bug anyway, which is how this
  // whole class of failure gets reported twice. Cheap and local: a version comparison that
  // costs one indexed query when nothing is stale.
  void (async () => {
    try {
      const se = await replanStaleEngine(db, resolveDoctrineDir(), secrets, llm);
      for (const d of se.replanned) notify?.(`Re-solved ${d} on the updated planner`);
    } catch (e) {
      console.warn(`workers: startup stale-engine sweep failed: ${(e as Error).message}`);
    }
  })();

  const task = cron.schedule("*/15 * * * *", tick);
  // Nudges run on their own 5-minute cadence: the reality window is 10 minutes, so a
  // 15-minute tick would leave blind gaps, and a call-out shouldn't queue behind Gmail.
  const nudgeTask = cron.schedule("*/5 * * * *", async () => {
    const n = await runNudgeCheck(db, secrets); // never throws
    if (n.sent) console.log(`nudge: ${n.kind}`);
  });
  return { stop: () => { task.stop(); nudgeTask.stop(); } };
}

export interface SourceStatus {
  source: SyncSource;
  last_run: {
    started_at: string | null;
    finished_at: string | null;
    records_ingested: number;
    error: string | null;
  } | null;
  cursor: string | null;
  last_sync_at: string | null;
}

/** Per-source status for the settings UI: latest sync_run + sync_state cursor. */
export function syncStatus(db: Db): SourceStatus[] {
  const lastRun = db.prepare(
    `SELECT started_at, finished_at, records_ingested, error
     FROM sync_run WHERE source = ? ORDER BY id DESC LIMIT 1`
  );
  const state = db.prepare("SELECT cursor, last_sync_at FROM sync_state WHERE source = ?");

  return (["gmail", "imessage", "linkedin", "linkedin-email", "mailfile", "msgplans", "notion"] as SyncSource[]).map((source) => {
    const run = lastRun.get(source) as SourceStatus["last_run"] | undefined;
    const st = state.get(source) as { cursor: string | null; last_sync_at: string | null } | undefined;
    return {
      source,
      last_run: run ?? null,
      cursor: st?.cursor ?? null,
      last_sync_at: st?.last_sync_at ?? null,
    };
  });
}
