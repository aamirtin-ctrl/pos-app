// Sync orchestration. runSync wraps one connector run in a sync_run row (started/finished/
// records/error — errors are recorded, NEVER propagated), then runs the post-ingest hook:
// commitment extraction over the newest unprocessed interactions (LLM optional), forward-only
// last-contact advancement from outbound interactions, and the reconnect-cadence refresh.
// startWorkers schedules gmail + linkedin-email + imessage every 15 minutes while the app is open, guarded by
// a running flag so runs never overlap; sources with missing creds/FDA are skipped silently.

import { createRequire } from "node:module";
import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import type { LlmClient } from "./llm/provider.ts";
import { extractCommitmentsLlm } from "./crm/commitments.ts";
import { refreshNextTouch } from "./crm/reconnect.ts";
import type { ConnectorDeps, SyncReport } from "./connectors/common.ts";
import { syncAllMail, gmailConfigured } from "./connectors/gmail.ts";
import { syncImessage, imessageAvailable } from "./connectors/imessage.ts";
import { syncLinkedin } from "./connectors/linkedin.ts";
import { syncLinkedinEmail } from "./connectors/linkedin-email.ts";
import { syncMailfile } from "./connectors/mailfile.ts";
import { runCapture } from "./capture.ts";
import { getSetting } from "./db/db.ts";

// node-cron ships no type declarations — minimal local surface via createRequire.
interface CronTask {
  stop(): void;
}
interface CronModule {
  schedule(expr: string, fn: () => void | Promise<void>): CronTask;
}
const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

export type SyncSource = "gmail" | "imessage" | "linkedin" | "linkedin-email" | "mailfile" | "capture";

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
 * post-ingest hook runs: commitment extraction (when an LLM client is provided; capped at
 * EXTRACT_CAP newest unprocessed interactions), last-contact advancement, reconnect refresh.
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
      if (llm) {
        const ids = (
          db
            .prepare(
              "SELECT id FROM interaction WHERE extracted_at IS NULL ORDER BY id DESC LIMIT ?"
            )
            .all(EXTRACT_CAP) as { id: number }[]
        ).map((r) => r.id);
        if (ids.length) await extractCommitmentsLlm(db, llm, ids);
      }
      advanceLastContact(db);
      refreshNextTouch(db);
    } catch (e) {
      console.warn(`workers: post-ingest hook failed for ${source}: ${(e as Error).message}`);
    }
  }

  return report;
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

  const announce = (r: SyncReport) => {
    if (r.error || r.ingested === 0) return; // quiet unless something new landed
    const people = r.created > 0 ? `, ${r.created} new ${r.created === 1 ? "person" : "people"}` : "";
    notify?.(`Synced ${r.source}: ${r.ingested} new interaction${r.ingested === 1 ? "" : "s"}${people}`);
  };

  const tick = async () => {
    if (running) return; // never overlap
    running = true;
    try {
      // Skip silently only when ZERO mail accounts are configured.
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
      }
    } catch (e) {
      console.warn(`workers: scheduled sync failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule("*/15 * * * *", tick);
  return { stop: () => task.stop() };
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

  return (["gmail", "imessage", "linkedin", "linkedin-email", "mailfile"] as SyncSource[]).map((source) => {
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
