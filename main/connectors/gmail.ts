// Gmail connector — read-only IMAP against imap.gmail.com (INBOX + [Gmail]/Sent Mail).
// Ported from PersonalCRM2 connectors/gmail.ts; adapted to the no-staging architecture:
// each message's counterpart is resolved inline via resolveHandle and, when matched,
// written directly to `interaction`. Unmatched counterparts are skipped (gmail never
// creates people — email alone isn't enough evidence of a real relationship).
//
// Creds: secrets GMAIL_USER / GMAIL_APP_PASSWORD (app-specific password, NOT the login).
// Incremental: sync_state(source='gmail').cursor = last internalDate ISO; first run
// backfills 12 months. Idempotent via UNIQUE(channel, external_id) on the Message-ID.
// Stores a ≤200-char snippet only — never the full body.

import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import { resolveHandle } from "../crm/identity.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  getCursor,
  setCursor,
  snippet,
  resolvedPct,
} from "./common.ts";
import { isAutomatedSender, parseForwardedHeaders, stripFwdPrefix } from "./email-utils.ts";

const FIRST_RUN_MONTHS = 12;
const MAILBOXES = ["INBOX", "[Gmail]/Sent Mail"];

/** True when Gmail creds exist — the scheduler's cheap "should I even try" check. */
export function gmailConfigured(deps: Pick<ConnectorDeps, "secrets">): boolean {
  return !!(deps.secrets.get("GMAIL_USER") && deps.secrets.get("GMAIL_APP_PASSWORD"));
}

/** First address from a mailparser From/To field (single object or array). */
function firstAddr(field: AddressObject | AddressObject[] | undefined): EmailAddress | null {
  if (!field) return null;
  const obj = Array.isArray(field) ? field[0] : field;
  return obj?.value?.[0] ?? null;
}

export async function syncGmail(deps: ConnectorDeps): Promise<SyncReport> {
  const { db, secrets } = deps;
  const report: SyncReport = { source: "gmail", ingested: 0, skipped: 0, created: 0 };

  const user = secrets.get("GMAIL_USER");
  const pass = secrets.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return { ...report, error: "not-configured" };
  // Your own address — used to classify direction and never treat yourself as counterpart.
  const selfSet = new Set([user.trim().toLowerCase()]);

  const cursor = getCursor(db, "gmail");
  const since =
    cursor && !Number.isNaN(Date.parse(cursor))
      ? new Date(cursor)
      : new Date(Date.now() - FIRST_RUN_MONTHS * 30 * 86_400_000);

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let matched = 0;
  let attempted = 0;
  let maxDate = since.getTime();

  try {
    await client.connect();
    try {
      for (const box of MAILBOXES) {
        let lock;
        try {
          lock = await client.getMailboxLock(box);
        } catch {
          continue; // mailbox missing (localized Gmail label) — skip it
        }
        try {
          const uids = (await client.search({ since }, { uid: true })) || [];
          if (!uids.length) continue;
          for await (const msg of client.fetch(
            uids,
            { uid: true, source: true, internalDate: true },
            { uid: true }
          )) {
            const parsed = await simpleParser(msg.source as Buffer);
            const body =
              parsed.text ||
              (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");

            // Forwarded email (envelope From is you): the real sender is in the quoted
            // header block in the body — use that instead of the forwarder.
            const fwd = parseForwardedHeaders(body);
            let cpEmail: string | null;
            let cpName: string | null;
            let outbound: boolean;
            let subject: string | null;
            let snippetSrc = body;
            if (fwd && (fwd.from?.email || fwd.to?.email)) {
              const origFromSelf = fwd.from?.email ? selfSet.has(fwd.from.email.toLowerCase()) : false;
              if (origFromSelf && fwd.to?.email) {
                outbound = true;
                cpEmail = fwd.to.email;
                cpName = fwd.to.name;
              } else {
                outbound = false;
                cpEmail = fwd.from?.email ?? null;
                cpName = fwd.from?.name ?? null;
              }
              subject = fwd.subject ?? stripFwdPrefix(parsed.subject);
              // Drop the quoted header lines so the snippet is the actual message content.
              snippetSrc = body
                .replace(/^\s*(from|to|date|sent|subject|cc|reply-to):.*$/gim, "")
                .replace(/-{2,}\s*forwarded message\s*-{2,}/i, "");
            } else {
              const fromAddr = firstAddr(parsed.from);
              const fromEmail = fromAddr?.address?.toLowerCase() ?? null;
              outbound = !!fromEmail && selfSet.has(fromEmail);
              const cp = outbound ? firstAddr(parsed.to) : fromAddr;
              cpEmail = cp?.address ?? null;
              cpName = cp?.name ?? null;
              subject = parsed.subject ?? null;
            }

            if (!cpEmail || selfSet.has(cpEmail.toLowerCase()) || isAutomatedSender(cpEmail)) {
              report.skipped++;
              continue;
            }

            const internal = msg.internalDate ? new Date(msg.internalDate) : null;
            const when = new Date(parsed.date ?? internal ?? Date.now());
            if (internal && internal.getTime() > maxDate) maxDate = internal.getTime();
            else if (!internal && when.getTime() > maxDate) maxDate = when.getTime();

            attempted++;
            const res = resolveHandle(db, { email: cpEmail, name: cpName });
            if (res.status !== "matched" || !res.personId) {
              report.skipped++; // unmatched/ambiguous → no person, no row (no staging table)
              continue;
            }
            matched++;

            const externalId = parsed.messageId ?? `gmail:${box}:${msg.uid}`;
            const inserted = insertInteraction(db, {
              personId: res.personId,
              channel: "gmail",
              direction: outbound ? "outbound" : "inbound",
              occurredAt: when.toISOString(),
              subject,
              bodySummary: snippet(snippetSrc),
              externalId,
            });
            if (inserted) report.ingested++;
            else report.skipped++; // already ingested — idempotent
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout();
    }
  } catch (e) {
    return { ...report, resolvedPct: resolvedPct(matched, attempted), error: (e as Error).message };
  }

  if (maxDate > since.getTime()) setCursor(db, "gmail", new Date(maxDate).toISOString());
  report.resolvedPct = resolvedPct(matched, attempted);
  return report;
}
