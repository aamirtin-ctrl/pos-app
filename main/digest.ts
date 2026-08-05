// Morning digest — the task-confirmation text loop. Once a day, ~15 min after the
// doctrine wake time, POS texts the user's own note-to-self iMessage thread a numbered
// list of everything awaiting a decision (unconfirmed commitments, today's tentative
// tasks, reconnect-due people). The user replies "confirm all" / "confirm 1 3" /
// "drop 2" in the same thread; capture.ts routes those replies here instead of the
// assistant. Every outbound digest starts with the literal prefix "POS — " so
// capture.ts can recognize (and never re-ingest) the app's own messages.
//
// Send transport: the same AppleScript program messaging.ts uses (iMessageScript is
// imported, escaping included). The osascript runner itself is private to
// messaging.ts, so a minimal equivalent lives here with the identical
// automation_denied mapping. Tests inject `runScript` — no osascript, no network.

import { execFile } from "node:child_process";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { iMessageScript } from "./messaging.ts";
import { confirmCommitment } from "./crm/commitments.ts";
import { commitmentToTask, dropCommitmentCascade, closeGoogleTask } from "./gcal/sync.ts";
import { reconnectDue } from "./crm/reconnect.ts";
import { hhmmToMin } from "./engine/doctrine.ts";

// ── constants + pure helpers ─────────────────────────────────────────────────

/** Every message the app sends to the self thread starts with this. */
export const DIGEST_PREFIX = "POS — ";
/** Max numbered items in one digest. */
export const DIGEST_MAX_ITEMS = 8;
/** Minutes after doctrine wake_time before the digest may fire. */
export const DIGEST_DELAY_MIN = 15;

/** True when a captured self-message is one of the app's own digests — never re-ingest. */
export function isDigestMessage(text: string | null | undefined): boolean {
  return (text ?? "").trimStart().startsWith(DIGEST_PREFIX);
}

/** True when a captured self-message looks like a confirm/drop reply to the digest. */
export function isDigestReply(text: string | null | undefined): boolean {
  return /^\s*(confirm|drop)\b/i.test(text ?? "");
}

/** "YYYY-MM-DD" for the digest_* setting keys (UTC, matching the rest of the codebase). */
export function digestDateISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── compose ──────────────────────────────────────────────────────────────────

export type DigestItemKind = "commitment" | "task" | "reconnect";

export interface DigestMappingEntry {
  n: number;
  kind: DigestItemKind;
  /** commitment.id / task.id / person.id depending on kind. */
  id: number;
}

export interface ComposedDigest {
  text: string;
  mapping: DigestMappingEntry[];
}

const FOOTER = 'Reply "confirm all", "confirm 1 3", "drop 2", or just braindump tasks.';

/** "gmail" → "email", "imessage" → "texts" — the human word for where a commitment came from. */
function channelMedium(channel: string | null): string | null {
  if (!channel) return null;
  if (channel === "imessage") return "texts";
  if (["gmail", "outlook", "icloud", "imap", "mail", "mailfile"].includes(channel)) return "email";
  if (channel.startsWith("linkedin")) return "LinkedIn";
  return channel;
}

/** "Tue" for a sqlite/ISO timestamp; null when unparseable. */
function weekdayOf(occurredAt: string | null): string | null {
  if (!occurredAt) return null;
  const d = new Date(occurredAt.includes("T") ? occurredAt : occurredAt.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

/**
 * Build today's digest: (a) unconfirmed open commitments (the review queue),
 * (b) today's open tentative tasks not waiting on a commitment decision (context),
 * (c) reconnect-due top 3. Numbered 1..n, capped at DIGEST_MAX_ITEMS, header +
 * reply-instruction footer. Returns the text and the n → {kind, id} mapping the
 * reply handler resolves against.
 */
export function composeDigest(db: Db, now: Date = new Date()): ComposedDigest {
  const todayISO = digestDateISO(now);
  const items: { line: string; kind: DigestItemKind; id: number }[] = [];

  // (a) The review queue: open, unconfirmed commitments.
  const commitments = db
    .prepare(
      `SELECT c.id, c.description, i.channel, i.occurred_at
       FROM commitment c
       LEFT JOIN interaction i ON i.id = c.source_interaction_id
       WHERE c.status = 'open' AND c.confirmed_by_user = 0
       ORDER BY c.due_at IS NULL, c.due_at ASC, c.created_at DESC`
    )
    .all() as { id: number; description: string; channel: string | null; occurred_at: string | null }[];
  for (const c of commitments) {
    const wd = weekdayOf(c.occurred_at);
    const medium = channelMedium(c.channel);
    const src = wd && medium ? ` (from ${wd}'s ${medium})` : "";
    items.push({ line: `${c.description}${src}`, kind: "commitment", id: c.id });
  }

  // (b) Today's open tentative tasks awaiting nothing — context, confirm to plan.
  const tasks = db
    .prepare(
      `SELECT t.id, t.title FROM task t
       WHERE t.status = 'inbox' AND t.plan_date = ?
         AND (t.commitment_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM commitment c
           WHERE c.id = t.commitment_id AND c.status = 'open' AND c.confirmed_by_user = 0
         ))
       ORDER BY t.id ASC`
    )
    .all(todayISO) as { id: number; title: string }[];
  for (const t of tasks) {
    items.push({ line: `${t.title} (on today's list)`, kind: "task", id: t.id });
  }

  // (c) Reconnect cadence: the three most pressing quiet relationships.
  for (const p of reconnectDue(db, now).slice(0, 3)) {
    const overdue = p.overdue_days > 0 ? ` (${p.overdue_days} day${p.overdue_days === 1 ? "" : "s"} overdue)` : "";
    items.push({ line: `Reconnect with ${p.display_name}${overdue}`, kind: "reconnect", id: p.id });
  }

  const capped = items.slice(0, DIGEST_MAX_ITEMS);
  if (capped.length === 0) {
    return {
      text: `${DIGEST_PREFIX}Good morning. Nothing needs your confirmation today. Braindump anytime by texting this thread.`,
      mapping: [],
    };
  }

  const mapping: DigestMappingEntry[] = capped.map((it, i) => ({ n: i + 1, kind: it.kind, id: it.id }));
  const lines = capped.map((it, i) => `${i + 1}. ${it.line}`);
  const text = [`${DIGEST_PREFIX}Good morning. Confirm your day:`, ...lines, FOOTER].join("\n");
  return { text, mapping };
}

// ── send ─────────────────────────────────────────────────────────────────────

/** First raw entry of `capture_self_handles` — the AppleScript participant. */
export function firstSelfHandle(db: Db): string | null {
  const csv = getSetting(db, "capture_self_handles") ?? "";
  for (const part of csv.split(",")) {
    const h = part.trim();
    if (h) return h;
  }
  return null;
}

/**
 * Same osascript execution + error mapping as messaging.ts's private runner
 * (-1743 / "not allowed" → the typed 'automation_denied'). The script itself comes
 * from messaging.iMessageScript, so the escaping is never duplicated.
 */
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 15_000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const detail = `${err.message} ${stderr ?? ""}`;
      if (detail.includes("-1743") || /not (allowed|authori[sz]ed)/i.test(detail)) {
        return reject(new Error("automation_denied"));
      }
      reject(new Error(`imessage_failed: ${(stderr || err.message).trim().slice(0, 200)}`));
    });
  });
}

export type DigestSendResult =
  | { sent: true; items: number; handle: string }
  | {
      sent: false;
      reason: "disabled" | "already_sent" | "no_self_handle" | "automation_denied" | "send_failed";
      detail?: string;
    };

export interface SendDigestOpts {
  now?: Date;
  /** Manual "Send now": bypass the once-per-day guard (never the enabled gate). */
  force?: boolean;
  /** Test hook — replaces the osascript runner. */
  runScript?: (script: string) => Promise<void>;
}

/**
 * Compose and text today's digest to the FIRST handle in `capture_self_handles`.
 * Gated on setting digest_enabled = "1"; fires once per day via digest_sent:<date>
 * (bypassable with `force` for the manual Settings button). On success the n → item
 * mapping is stored in setting digest_mapping:<date> for handleDigestReply.
 */
export async function sendMorningDigest(
  db: Db,
  _secrets: SecretStore,
  opts: SendDigestOpts = {}
): Promise<DigestSendResult> {
  const now = opts.now ?? new Date();
  const dateISO = digestDateISO(now);

  if (getSetting(db, "digest_enabled") !== "1") return { sent: false, reason: "disabled" };
  if (!opts.force && getSetting(db, `digest_sent:${dateISO}`)) {
    return { sent: false, reason: "already_sent" };
  }
  const handle = firstSelfHandle(db);
  if (!handle) return { sent: false, reason: "no_self_handle" };

  const { text, mapping } = composeDigest(db, now);
  try {
    await (opts.runScript ?? runOsascript)(iMessageScript(handle, text));
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "automation_denied") return { sent: false, reason: "automation_denied" };
    return { sent: false, reason: "send_failed", detail: msg };
  }

  setSetting(db, `digest_mapping:${dateISO}`, JSON.stringify(mapping));
  setSetting(db, `digest_sent:${dateISO}`, new Date().toISOString());
  return { sent: true, items: mapping.length, handle };
}

/**
 * Cron gate (workers.ts): enabled, not yet sent today, and past wake_time + 15 min.
 * `wakeTime` is doctrine chronotype.wake_time ("HH:MM"), compared in local time.
 */
export function shouldSendDigest(db: Db, wakeTime: string, now: Date = new Date()): boolean {
  if (getSetting(db, "digest_enabled") !== "1") return false;
  if (getSetting(db, `digest_sent:${digestDateISO(now)}`)) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= hhmmToMin(wakeTime) + DIGEST_DELAY_MIN;
}

// ── reply parsing ────────────────────────────────────────────────────────────

export interface DigestReplyCmd {
  op: "confirm" | "drop";
  target: number | "all";
}

/**
 * Parse a confirm/drop reply into an ordered command list. Order-insensitive
 * grammar, commas/"and" tolerated: "confirm all", "Confirm 1, 3 and 4", "drop 2",
 * mixed "confirm 1 drop 2" (applied sequentially). Anything else → null.
 */
export function parseDigestReply(text: string): DigestReplyCmd[] | null {
  const tokens = (text ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, "").replace(/[.!?]+$/, ""))
    .filter((t) => t && t !== "and" && t !== "&" && t !== "then" && t !== "please");
  if (tokens.length === 0) return null;
  if (tokens[0] !== "confirm" && tokens[0] !== "drop") return null;

  const out: DigestReplyCmd[] = [];
  let op: "confirm" | "drop" | null = null;
  for (const tok of tokens) {
    if (tok === "confirm" || tok === "drop") {
      op = tok;
    } else if (tok === "all") {
      if (!op) return null;
      out.push({ op, target: "all" });
    } else if (/^\d+$/.test(tok)) {
      if (!op) return null;
      out.push({ op, target: Number(tok) });
    } else {
      return null; // garbage token — this is not a digest reply
    }
  }
  return out.length > 0 ? out : null;
}

// ── reply handling ───────────────────────────────────────────────────────────

function loadMapping(db: Db, now: Date): DigestMappingEntry[] | null {
  const today = digestDateISO(now);
  const yesterday = digestDateISO(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  for (const key of [today, yesterday]) {
    const raw = getSetting(db, `digest_mapping:${key}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as DigestMappingEntry[];
    } catch {
      /* corrupt mapping — try the older one */
    }
  }
  return null;
}

/** Apply one confirm/drop to one mapped item. Returns a short label, or null when it was a no-op. */
async function applyOne(
  db: Db,
  secrets: SecretStore,
  entry: DigestMappingEntry,
  op: "confirm" | "drop",
  todayISO: string
): Promise<string | null> {
  if (entry.kind === "commitment") {
    const c = db.prepare("SELECT id, description, status FROM commitment WHERE id = ?").get(entry.id) as
      | { id: number; description: string; status: string } | undefined;
    if (!c) return null;
    if (op === "drop") {
      dropCommitmentCascade(db, secrets, entry.id);
      return c.description;
    }
    if (c.status === "dropped") return null; // confirmed after a drop — leave it dropped
    confirmCommitment(db, entry.id);
    await commitmentToTask(db, secrets, entry.id, todayISO); // idempotent: open task reused
    return c.description;
  }

  if (entry.kind === "task") {
    const t = db.prepare("SELECT id, title, status, gtasks_id FROM task WHERE id = ?").get(entry.id) as
      | { id: number; title: string; status: string; gtasks_id: string | null } | undefined;
    if (!t) return null;
    if (op === "confirm") {
      if (!["inbox", "planned"].includes(t.status)) return null;
      db.prepare("UPDATE task SET status = 'planned' WHERE id = ?").run(entry.id);
      return t.title;
    }
    if (!["inbox", "planned", "in_progress"].includes(t.status)) return null;
    db.prepare("UPDATE task SET status = 'deferred' WHERE id = ?").run(entry.id);
    if (t.gtasks_id) await closeGoogleTask(db, secrets, t.gtasks_id); // best-effort
    return t.title;
  }

  // reconnect
  const p = db.prepare("SELECT id, display_name FROM person WHERE id = ?").get(entry.id) as
    | { id: number; display_name: string } | undefined;
  if (!p) return null;
  if (op === "drop") return null; // declining a reconnect suggestion is a quiet no-op
  const title = `Reach out to ${p.display_name}`;
  const existing = db
    .prepare("SELECT 1 FROM task WHERE title = ? AND plan_date = ? AND status IN ('inbox','planned','in_progress')")
    .get(title, todayISO);
  if (existing) return null; // idempotent re-reply
  db.prepare(
    `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
       status, plan_date, estimate_source)
     VALUES (?, 'comms', 2, 25, 25, 'inbox', ?, 'inferred')`
  ).run(title, todayISO);
  return title;
}

/**
 * Handle a confirm/drop reply against today's (or, when absent, yesterday's) stored
 * digest mapping. Commitments: confirm → confirmCommitment + commitmentToTask;
 * drop → dropCommitmentCascade. Tasks: confirm → status 'planned'; drop → 'deferred'
 * + best-effort Google close. Reconnects: confirm → a "Reach out to <name>" comms
 * task for today. Returns a plain-language summary for the capture log.
 */
export async function handleDigestReply(
  db: Db,
  secrets: SecretStore,
  text: string,
  now: Date = new Date()
): Promise<string> {
  const cmds = parseDigestReply(text);
  if (!cmds) return 'Could not read that reply. Use "confirm all", "confirm 1 3", or "drop 2".';

  const mapping = loadMapping(db, now);
  if (!mapping || mapping.length === 0) return "No morning digest on record to confirm against.";
  const byN = new Map(mapping.map((e) => [e.n, e]));
  const todayISO = digestDateISO(now);

  const confirmed: string[] = [];
  const dropped: string[] = [];
  const unknown: number[] = [];
  const seen = new Set<string>();

  for (const cmd of cmds) {
    const targets = cmd.target === "all" ? mapping : ([byN.get(cmd.target)].filter(Boolean) as DigestMappingEntry[]);
    if (cmd.target !== "all" && targets.length === 0) {
      unknown.push(cmd.target as number);
      continue;
    }
    for (const entry of targets) {
      const key = `${cmd.op}:${entry.n}`;
      if (seen.has(key)) continue; // same op repeated in one reply
      seen.add(key);
      const label = await applyOne(db, secrets, entry, cmd.op, todayISO);
      if (label) (cmd.op === "confirm" ? confirmed : dropped).push(label);
    }
  }

  const parts: string[] = [];
  if (confirmed.length) parts.push(`Confirmed ${confirmed.length}: ${confirmed.join("; ")}`);
  if (dropped.length) parts.push(`Dropped ${dropped.length}: ${dropped.join("; ")}`);
  if (unknown.length) parts.push(`No item ${unknown.join(", ")} on the digest`);
  if (parts.length === 0) parts.push("Nothing to change — those items were already handled");
  return `${parts.join(". ")}.`;
}
