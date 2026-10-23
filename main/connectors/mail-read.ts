// Mail read state — the three IMAP-side pieces of the owner's 2026-09-11 ask that the
// Messaging dot mean UNREAD and that mail look like mail:
//
//   1. mirrorMailReadState — every sync tick, unread → read only. POS rows the server shows
//      as \Seen get read_at; rows the server still shows unseen stay unread. Nothing here
//      ever clears read_at (un-reading in Gmail is rare and not worth two-way sync). The
//      same pass fills body_raw for recent rows that predate full-body storage, a bounded
//      batch per tick, so the existing inbox fills in over the first few syncs.
//   2. markSeenOnServer — the write-back. When he opens a mail conversation in POS the
//      Message-IDs come here and get \Seen added on the server, so Gmail/Outlook agree
//      with POS. Fire-and-forget from the IPC handler: never blocks the UI, failures log.
//   3. mailBodyText — the ONE rule for what "the body" is (text part, else stripped HTML,
//      capped) so ingest and the fill pass can never disagree.
//
// Everything takes a minimal client interface so tests inject a fake — no network.

import { simpleParser } from "mailparser";
import type { Db } from "../db/db.ts";
import type { SecretStore } from "../secrets.ts";
import { EMAIL_CHANNELS, normalizeMessageId } from "../messaging.ts";
import { listMailAccounts, openImapClient, type MailAccount } from "./gmail.ts";

/** Plain-text body cap. A 64 KB email is already a document, not a message. */
export const MAIL_BODY_MAX = 64_000;
/** body_raw fills per tick — bounded so one sync never downloads a month of mail at once. */
export const BODY_FILL_BATCH = 150;
/** Message-ID lookups per tick — bounds the pass on a mailbox with a backlog of unread. */
export const MIRROR_CANDIDATE_CAP = 200;
/** How far back the mirror looks. Matches listInbox's recent window: what the inbox shows. */
export const MIRROR_WINDOW_DAYS = 30;

/** The slice of ImapFlow the mirror + write-back use. Tests implement it directly. */
export interface ImapReadClient {
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>;
  fetch(
    range: number[] | string,
    query: { uid?: boolean; flags?: boolean; envelope?: boolean; source?: boolean },
    options?: { uid?: boolean }
  ): AsyncIterable<{
    uid: number;
    flags?: Set<string>;
    envelope?: { messageId?: string };
    source?: Buffer;
  }>;
  messageFlagsAdd(range: number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>;
}

/** A client that also owns its connection — what markSeenOnServer opens per account. */
export interface ImapSession extends ImapReadClient {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  logout(): Promise<void>;
}

// ── body text ────────────────────────────────────────────────────────────────

/**
 * The body a mail row stores: the text part when there is one, else the HTML with tags
 * stripped to lines. Line endings normalized, trailing whitespace trimmed, capped at
 * MAIL_BODY_MAX. Null when nothing usable remains.
 */
export function mailBodyText(parsed: { text?: string; html?: string | false }): string | null {
  let text = parsed.text?.trim() ? parsed.text : "";
  if (!text && typeof parsed.html === "string") {
    text = parsed.html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/[ \t]+/g, " ");
  }
  const out = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out ? out.slice(0, MAIL_BODY_MAX) : null;
}

// ── mirror (unread → read, plus body fill) ───────────────────────────────────

/**
 * Bring POS's recent inbound mail rows up to date with the server. The caller has the
 * INBOX lock (syncMailAccount runs this right after ingest, on the same connection).
 *
 * Bounded by what POS needs, never by the size of the mailbox: only rows in the window
 * that are unread or bodiless are looked up, each by a server-side Message-ID search
 * (the same lookup the write-back uses), then ONE flags fetch for the ones found and one
 * bounded source fetch for those still missing a body. A row the other account owns simply
 * isn't found here. Nothing here touches the wire when POS has nothing to ask.
 */
export async function mirrorMailReadState(
  db: Db,
  client: ImapReadClient,
  opts: { now?: Date; bodyBatch?: number; candidateCap?: number } = {}
): Promise<{ markedRead: number; bodiesFilled: number }> {
  const now = opts.now ?? new Date();
  const bodyBatch = opts.bodyBatch ?? BODY_FILL_BATCH;
  const since = new Date(now.getTime() - MIRROR_WINDOW_DAYS * 86_400_000);

  type Cand = { id: number; external_id: string | null; read_at: string | null; needs_body: number };
  const cands = db
    .prepare(
      `SELECT id, external_id, read_at, (body_raw IS NULL) AS needs_body FROM interaction
       WHERE direction = 'inbound' AND channel IN (${EMAIL_CHANNELS.map(() => "?").join(",")})
         AND occurred_at >= ? AND (read_at IS NULL OR body_raw IS NULL)
       ORDER BY occurred_at DESC LIMIT ?`
    )
    .all(...EMAIL_CHANNELS, since.toISOString(), opts.candidateCap ?? MIRROR_CANDIDATE_CAP) as Cand[];
  if (cands.length === 0) return { markedRead: 0, bodiesFilled: 0 };

  // Message-ID → uid, for the candidates this mailbox actually holds.
  const byUid = new Map<number, Cand>();
  for (const c of cands) {
    const id = normalizeMessageId(c.external_id);
    if (!id) continue;
    const uids = (await client.search({ header: { "message-id": id } }, { uid: true })) || [];
    if (uids.length > 0) byUid.set(uids[0], c);
  }
  if (byUid.size === 0) return { markedRead: 0, bodiesFilled: 0 };

  const markRead = db.prepare("UPDATE interaction SET read_at = ? WHERE id = ? AND read_at IS NULL");
  const setBody = db.prepare("UPDATE interaction SET body_raw = ? WHERE id = ? AND body_raw IS NULL");
  let markedRead = 0;
  const needBody: { uid: number; rowId: number }[] = [];

  for await (const msg of client.fetch([...byUid.keys()], { uid: true, flags: true }, { uid: true })) {
    const c = byUid.get(msg.uid);
    if (!c) continue;
    if (c.read_at === null && msg.flags?.has("\\Seen")) {
      markedRead += markRead.run(now.toISOString(), c.id).changes;
    }
    if (c.needs_body) needBody.push({ uid: msg.uid, rowId: c.id });
  }

  let bodiesFilled = 0;
  const batch = needBody.slice(0, bodyBatch);
  if (batch.length > 0) {
    const rowByUid = new Map(batch.map((b) => [b.uid, b.rowId]));
    for await (const msg of client.fetch(batch.map((b) => b.uid), { uid: true, source: true }, { uid: true })) {
      const rowId = rowByUid.get(msg.uid);
      if (rowId === undefined || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const body = mailBodyText(parsed);
      if (body) bodiesFilled += setBody.run(body, rowId).changes;
    }
  }
  return { markedRead, bodiesFilled };
}

// ── write-back (\Seen) ───────────────────────────────────────────────────────

/**
 * Add \Seen on the server for these Message-IDs. Rows do not record which account they
 * came from, so each configured account's INBOX is searched in turn until every id is
 * found; an account that fails is logged and skipped. One connection per account, opened
 * only while ids remain. Returns how many messages were flagged.
 */
export async function markSeenOnServer(
  secrets: SecretStore,
  mailIds: string[],
  openClient: (account: MailAccount) => Promise<ImapSession> = (a) =>
    openImapClient(secrets, a) as unknown as Promise<ImapSession>
): Promise<{ flagged: number }> {
  const remaining = new Set(mailIds.map((id) => normalizeMessageId(id)).filter((x): x is string => !!x));
  if (remaining.size === 0) return { flagged: 0 };

  let flagged = 0;
  for (const account of listMailAccounts(secrets)) {
    if (remaining.size === 0) break;
    try {
      const client = await openClient(account);
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          for (const id of [...remaining]) {
            const uids = (await client.search({ header: { "message-id": id } }, { uid: true })) || [];
            if (uids.length === 0) continue;
            await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
            flagged += uids.length;
            remaining.delete(id);
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    } catch (e) {
      console.warn(`mail: \\Seen write-back on ${account.user} failed: ${(e as Error).message}`);
    }
  }
  return { flagged };
}
