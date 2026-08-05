// Unified inbox — read side (recent inbound + drafts + per-person thread) and the
// USER-INITIATED send paths: email over SMTP (nodemailer) and iMessage over
// osascript. Sending is only ever triggered by an explicit Send click in the
// Messaging surface; nothing here is wired to any automatic/scheduled path.
//
// Typed errors: thrown Error.message is a stable code the renderer matches on —
//   no_email_account | account_not_found | smtp_unsupported_provider |
//   no_recipient | automation_denied | imessage_failed
// (the IPC wrapper turns throws into { ok: false, error: message }).

import { execFile } from "node:child_process";
import nodemailer from "nodemailer";
import type { Db } from "./db/db.ts";
import type { SecretStore } from "./secrets.ts";
import { listMailAccounts, type MailAccount, type MailProvider } from "./connectors/gmail.ts";
import { imapTlsOptions } from "./connectors/tls-ca.ts";
import { insertInteraction, snippet } from "./connectors/common.ts";

type SecretsLike = Pick<SecretStore, "get" | "set" | "delete">;

// ── read side ────────────────────────────────────────────────────────────────

export interface ThreadMessage {
  id: number;
  channel: string;
  direction: string | null;
  subject: string | null;
  body_summary: string | null;
  occurred_at: string | null;
  /** Display name of the interaction's person (the sender for inbound rows). */
  sender_name: string | null;
}

export interface InboxItem {
  id: number;
  person_id: number;
  person_name: string;
  channel: string;
  subject: string | null;
  body_summary: string | null;
  occurred_at: string | null;
  external_id: string | null;
  /** Chat guid for group conversations; null for 1:1. */
  thread_external_id: string | null;
  /** Conversation key: `chat:<thread_external_id>` for groups, else `person:<person_id>`. */
  thread_key: string;
  is_group: 0 | 1;
  /** Group display name (most recent non-null subject in the thread); null for 1:1. */
  group_name: string | null;
  /** 1 when a 'suggested' draft exists for this inbound message. */
  has_draft: 0 | 1;
  draft_id: number | null;
  draft_body: string | null;
  /** 1 when a later outbound to the same person exists. */
  answered: 0 | 1;
  /** has_draft OR not answered — these sort first. */
  unanswered: 0 | 1;
  /** The conversation's recent messages, both directions, oldest → newest. */
  thread: ThreadMessage[];
}

const THREAD_LIMIT = 12;

type InboxRow = Omit<
  InboxItem,
  "unanswered" | "thread" | "thread_key" | "is_group" | "group_name"
>;

/**
 * Recent INBOUND interactions joined to person, collapsed to ONE row per
 * conversation. A conversation is a group chat (`chat:<thread_external_id>`)
 * or a 1:1 (`person:<person_id>`); the newest inbound message represents it.
 * Group rows carry is_group=1 + group_name (latest non-null subject in the
 * thread, fallback "Group chat") and thread by chat guid; 1:1 rows thread by
 * person. Unanswered (has_draft or no later outbound) sort first, then newest.
 */
export function listInbox(db: Db, opts: { limit?: number } = {}): InboxItem[] {
  const limit = opts.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT i.id, i.person_id, p.display_name AS person_name, i.channel, i.subject,
              i.body_summary, i.occurred_at, i.external_id, i.thread_external_id,
              d.id AS draft_id, d.body AS draft_body,
              CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS has_draft,
              EXISTS(
                SELECT 1 FROM interaction o
                WHERE o.person_id = i.person_id AND o.direction = 'outbound'
                  AND o.occurred_at > i.occurred_at
              ) AS answered
       FROM interaction i
       JOIN person p ON p.id = i.person_id
       LEFT JOIN draft d ON d.interaction_id = i.id AND d.status = 'suggested'
       WHERE i.direction = 'inbound'
       ORDER BY (CASE WHEN d.id IS NOT NULL OR NOT EXISTS(
                   SELECT 1 FROM interaction o
                   WHERE o.person_id = i.person_id AND o.direction = 'outbound'
                     AND o.occurred_at > i.occurred_at
                 ) THEN 0 ELSE 1 END) ASC,
                i.occurred_at DESC
       LIMIT ?`
    )
    .all(limit) as InboxRow[];

  // Collapse to one representative row (the newest inbound) per conversation key.
  // If an older inbound carries the suggested draft, the draft rides along so the
  // compose box still prefills.
  const byKey = new Map<string, InboxRow>();
  for (const r of rows) {
    const key = r.thread_external_id ? `chat:${r.thread_external_id}` : `person:${r.person_id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
    } else {
      const [newer, older] = (r.occurred_at ?? "") > (prev.occurred_at ?? "") ? [r, prev] : [prev, r];
      if (!newer.has_draft && older.has_draft) {
        byKey.set(key, { ...newer, has_draft: 1, draft_id: older.draft_id, draft_body: older.draft_body });
      } else {
        byKey.set(key, newer);
      }
    }
  }

  const groupNameStmt = db.prepare(
    `SELECT subject FROM interaction
     WHERE thread_external_id = ? AND subject IS NOT NULL AND subject != ''
     ORDER BY occurred_at DESC LIMIT 1`
  );
  // Group threads select by chat guid (NOT person) — every member's messages, each
  // joined to its own person for sender_name. 1:1 threads keep the person query.
  const chatThreadStmt = db.prepare(
    `SELECT i.id, i.channel, i.direction, i.subject, i.body_summary, i.occurred_at,
            p.display_name AS sender_name
     FROM interaction i JOIN person p ON p.id = i.person_id
     WHERE i.thread_external_id = ?
     ORDER BY i.occurred_at DESC LIMIT ${THREAD_LIMIT}`
  );
  const personThreadStmt = db.prepare(
    `SELECT i.id, i.channel, i.direction, i.subject, i.body_summary, i.occurred_at,
            p.display_name AS sender_name
     FROM interaction i JOIN person p ON p.id = i.person_id
     WHERE i.person_id = ? AND i.thread_external_id IS NULL
     ORDER BY i.occurred_at DESC LIMIT ${THREAD_LIMIT}`
  );

  const items: InboxItem[] = [];
  for (const [key, r] of byKey) {
    const isGroup = r.thread_external_id != null;
    const thread = (
      isGroup
        ? (chatThreadStmt.all(r.thread_external_id) as ThreadMessage[])
        : (personThreadStmt.all(r.person_id) as ThreadMessage[])
    ).reverse(); // oldest → newest
    const groupName = isGroup
      ? ((groupNameStmt.get(r.thread_external_id) as { subject: string } | undefined)?.subject ??
        "Group chat")
      : null;
    items.push({
      ...r,
      thread_key: key,
      is_group: isGroup ? 1 : 0,
      group_name: groupName,
      unanswered: r.has_draft || !r.answered ? 1 : 0,
      thread,
    });
  }
  return items.sort((a, b) => {
    if (a.unanswered !== b.unanswered) return b.unanswered - a.unanswered;
    return (b.occurred_at ?? "").localeCompare(a.occurred_at ?? "");
  });
}

// ── recipient resolution ─────────────────────────────────────────────────────

export interface PersonHandles {
  /** Best email alias: kind 'email', is_primary preferred. */
  email: string | null;
  /** Best iMessage target: kind 'imessage_handle' preferred, else 'phone'. */
  imessage: string | null;
}

/** Pick the best send targets for a person from their aliases. */
export function personHandles(db: Db, personId: number): PersonHandles {
  const email = db
    .prepare(
      `SELECT value FROM alias WHERE person_id = ? AND kind = 'email'
       ORDER BY is_primary DESC, id ASC LIMIT 1`
    )
    .get(personId) as { value: string } | undefined;
  const im = db
    .prepare(
      `SELECT value FROM alias WHERE person_id = ? AND kind IN ('imessage_handle', 'phone')
       ORDER BY CASE kind WHEN 'imessage_handle' THEN 0 ELSE 1 END, is_primary DESC, id ASC
       LIMIT 1`
    )
    .get(personId) as { value: string } | undefined;
  return { email: email?.value ?? null, imessage: im?.value ?? null };
}

// ── email send (SMTP) ────────────────────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (465); false = plain connect + STARTTLS (587). */
  secure: boolean;
}

/**
 * SMTP endpoint per provider. Custom-IMAP accounts throw the typed error
 * 'smtp_unsupported_provider': guessing smtp.<domain> from an IMAP host is
 * unreliable, so sending is limited to the known providers.
 */
export function smtpConfigFor(provider: MailProvider): SmtpConfig {
  switch (provider) {
    case "gmail":
      return { host: "smtp.gmail.com", port: 465, secure: true };
    case "outlook":
      return { host: "smtp-mail.outlook.com", port: 587, secure: false };
    case "icloud":
      return { host: "smtp.mail.me.com", port: 587, secure: false };
    default:
      throw new Error("smtp_unsupported_provider");
  }
}

/** Mark the suggested draft on this person's LATEST inbound message as sent. */
function markLatestDraftSent(db: Db, personId: number): void {
  db.prepare(
    `UPDATE draft SET status = 'sent'
     WHERE status = 'suggested' AND person_id = ?
       AND interaction_id = (
         SELECT id FROM interaction
         WHERE person_id = ? AND direction = 'inbound'
         ORDER BY occurred_at DESC LIMIT 1
       )`
  ).run(personId, personId);
}

export interface SendEmailArgs {
  personId: number;
  to: string;
  subject: string;
  body: string;
  /** Match a specific mail account by address; defaults to the first account. */
  accountUser?: string;
}

/**
 * Send an email over SMTP with the stored mail-account credentials, then record
 * an outbound interaction and mark the matching draft sent. User-initiated only.
 */
export async function sendEmail(
  db: Db,
  secrets: SecretsLike,
  args: SendEmailArgs
): Promise<{ sent: true; messageId: string; channel: string; account: string }> {
  if (!args.to?.trim()) throw new Error("no_recipient");
  const accounts = listMailAccounts(secrets);
  if (accounts.length === 0) throw new Error("no_email_account");
  let account: MailAccount | undefined;
  if (args.accountUser) {
    account = accounts.find(
      (a) => a.user.trim().toLowerCase() === args.accountUser!.trim().toLowerCase()
    );
    if (!account) throw new Error("account_not_found");
  } else {
    account = accounts[0];
  }
  const cfg = smtpConfigFor(account.provider); // throws smtp_unsupported_provider for 'imap'

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure, // STARTTLS mandatory on 587 — never send creds in the clear
    auth: { user: account.user, pass: account.password },
    // Same trust extension as IMAP: Avast/corporate proxies re-sign SMTP too.
    tls: imapTlsOptions(),
  });
  const info = await transporter.sendMail({
    from: account.user,
    to: args.to,
    subject: args.subject,
    text: args.body,
  });

  const channel = account.provider; // gmail | outlook | icloud (imap can't reach here)
  insertInteraction(db, {
    personId: args.personId,
    channel,
    direction: "outbound",
    occurredAt: new Date().toISOString(),
    subject: args.subject || null,
    bodySummary: snippet(args.body),
    externalId: info.messageId || `sent:${Date.now()}`,
  });
  markLatestDraftSent(db, args.personId);
  return { sent: true, messageId: info.messageId ?? "", channel, account: account.user };
}

// ── iMessage send (osascript) ────────────────────────────────────────────────

/** Escape a JS string for embedding in a double-quoted AppleScript literal. */
export function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** The exact osascript program sendIMessage runs (exported for tests). */
export function iMessageScript(handle: string, body: string): string {
  return (
    `tell application "Messages" to send "${escapeAppleScript(body)}" ` +
    `to participant "${escapeAppleScript(handle)}" of ` +
    `(1st account whose service type = iMessage)`
  );
}

/** The exact osascript program sendIMessageToChat runs (exported for tests). */
export function iMessageChatScript(chatGuid: string, body: string): string {
  return (
    `tell application "Messages" to send "${escapeAppleScript(body)}" ` +
    `to chat id "${escapeAppleScript(chatGuid)}"`
  );
}

function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 15_000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const detail = `${err.message} ${stderr ?? ""}`;
      // -1743 = errAEEventNotPermitted: the user hasn't granted Automation
      // permission for Messages (System Settings → Privacy & Security → Automation).
      if (detail.includes("-1743") || /not (allowed|authori[sz]ed)/i.test(detail)) {
        return reject(new Error("automation_denied"));
      }
      reject(new Error(`imessage_failed: ${(stderr || err.message).trim().slice(0, 200)}`));
    });
  });
}

export interface SendIMessageArgs {
  personId: number;
  handle: string;
  body: string;
}

/**
 * Send an iMessage via Messages.app. USER-INITIATED ONLY — this is called from
 * an explicit Send click and must never be wired to any automatic path.
 */
export async function sendIMessage(
  db: Db,
  args: SendIMessageArgs
): Promise<{ sent: true; channel: "imessage" }> {
  if (!args.handle?.trim()) throw new Error("no_recipient");
  await runOsascript(iMessageScript(args.handle.trim(), args.body));
  insertInteraction(db, {
    personId: args.personId,
    channel: "imessage",
    direction: "outbound",
    occurredAt: new Date().toISOString(),
    bodySummary: snippet(args.body),
    externalId: `sent:${Date.now()}`,
  });
  markLatestDraftSent(db, args.personId);
  return { sent: true, channel: "imessage" };
}

export interface SendIMessageChatArgs {
  /** Messages chat guid — the conversation's thread_external_id. */
  chatGuid: string;
  body: string;
  /**
   * Person to attribute the outbound row to. The caller (renderer) passes the
   * person_id of the thread's most recent sender, so the sent message lands in
   * the same conversation the user replied from.
   */
  personId: number;
}

/**
 * Send an iMessage to a GROUP chat by its chat guid via Messages.app.
 * USER-INITIATED ONLY — called from an explicit Send click, never automatic.
 * On success records an outbound interaction attributed to args.personId with
 * thread_external_id = chatGuid so the group thread stays whole.
 */
export async function sendIMessageToChat(
  db: Db,
  args: SendIMessageChatArgs
): Promise<{ sent: true; channel: "imessage" }> {
  if (!args.chatGuid?.trim()) throw new Error("no_recipient");
  await runOsascript(iMessageChatScript(args.chatGuid.trim(), args.body));
  insertInteraction(db, {
    personId: args.personId,
    channel: "imessage",
    direction: "outbound",
    occurredAt: new Date().toISOString(),
    bodySummary: snippet(args.body),
    externalId: `sent:${Date.now()}`,
    threadExternalId: args.chatGuid.trim(),
  });
  return { sent: true, channel: "imessage" };
}
