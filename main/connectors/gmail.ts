// Mail connector — read-only IMAP (INBOX + sent folder) for any number of accounts:
// Gmail, Outlook, or custom IMAP. Ported from PersonalCRM2 connectors/gmail.ts; adapted
// to the no-staging architecture: each message's counterpart is resolved inline via
// resolveHandle and, when matched, written directly to `interaction`. Unmatched
// counterparts are skipped (mail never creates people — email alone isn't enough
// evidence of a real relationship).
//
// Accounts: JSON array under secret MAIL_ACCOUNTS (id/provider/user/password/host/port).
// Back-compat: legacy GMAIL_USER / GMAIL_APP_PASSWORD secrets are synthesized into the
// list as account id "legacy" until an explicit account claims that address.
// Incremental: sync_state(source=`gmail:<user>`).cursor = last internalDate ISO; the
// pre-multi-account cursor under source 'gmail' migrates on first per-account run.
// First run backfills 12 months. Idempotent via UNIQUE(channel, external_id) on the
// Message-ID. Stores a ≤200-char snippet only — never the full body.

import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import type { SecretStore } from "../secrets.ts";
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

// ── account store ────────────────────────────────────────────────────────────

export type MailProvider = "gmail" | "outlook" | "imap";

export interface MailAccount {
  id: string;
  provider: MailProvider;
  user: string;
  password: string;
  host: string;
  port: number;
}

const MAIL_ACCOUNTS_SECRET = "MAIL_ACCOUNTS";

/** Host/port + sent-folder defaults per provider ("imap" host/port come from the user). */
const PROVIDER_PRESETS: Record<MailProvider, { host: string; port: number; sentFolder: string }> = {
  gmail: { host: "imap.gmail.com", port: 993, sentFolder: "[Gmail]/Sent Mail" },
  outlook: { host: "outlook.office365.com", port: 993, sentFolder: "Sent" },
  imap: { host: "", port: 993, sentFolder: "Sent" },
};

type SecretsLike = Pick<SecretStore, "get" | "set" | "delete">;

/** Stored accounts only (no legacy synthesis). Tolerates a missing/corrupt secret. */
function readStoredAccounts(secrets: SecretsLike): MailAccount[] {
  const raw = secrets.get(MAIL_ACCOUNTS_SECRET);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is MailAccount =>
        !!a && typeof a === "object" &&
        typeof a.id === "string" &&
        (a.provider === "gmail" || a.provider === "outlook" || a.provider === "imap") &&
        typeof a.user === "string" &&
        typeof a.password === "string" &&
        typeof a.host === "string" &&
        typeof a.port === "number"
    );
  } catch {
    return [];
  }
}

function writeStoredAccounts(secrets: SecretsLike, accounts: MailAccount[]): void {
  secrets.set(MAIL_ACCOUNTS_SECRET, JSON.stringify(accounts));
}

/**
 * Every mail account. Back-compat: when the legacy GMAIL_USER/GMAIL_APP_PASSWORD secrets
 * exist and no stored account claims that address, a gmail account (id "legacy") is
 * synthesized so pre-multi-account setups keep syncing untouched.
 */
export function listMailAccounts(secrets: SecretsLike): MailAccount[] {
  const accounts = readStoredAccounts(secrets);
  const legacyUser = secrets.get("GMAIL_USER");
  const legacyPass = secrets.get("GMAIL_APP_PASSWORD");
  if (
    legacyUser && legacyPass &&
    !accounts.some((a) => a.user.trim().toLowerCase() === legacyUser.trim().toLowerCase())
  ) {
    accounts.unshift({
      id: "legacy",
      provider: "gmail",
      user: legacyUser,
      password: legacyPass,
      host: PROVIDER_PRESETS.gmail.host,
      port: PROVIDER_PRESETS.gmail.port,
    });
  }
  return accounts;
}

/** Add an account: generates a short random id and applies the provider host preset. */
export function addMailAccount(
  secrets: SecretsLike,
  acct: { provider: MailProvider; user: string; password: string; host?: string; port?: number }
): MailAccount {
  const preset = PROVIDER_PRESETS[acct.provider];
  if (!preset) throw new Error(`unknown mail provider: ${acct.provider}`);
  const user = acct.user.trim();
  if (!user || !acct.password) throw new Error("email and password are required");
  const host = acct.provider === "imap" ? (acct.host ?? "").trim() : preset.host;
  if (!host) throw new Error("host is required for custom IMAP accounts");
  const account: MailAccount = {
    id: crypto.randomBytes(4).toString("hex"),
    provider: acct.provider,
    user,
    password: acct.password,
    host,
    port: acct.provider === "imap" ? (acct.port ?? preset.port) : preset.port,
  };
  writeStoredAccounts(secrets, [...readStoredAccounts(secrets), account]);
  return account;
}

/** Remove by id. Removing the synthesized "legacy" account deletes the legacy secrets. */
export function removeMailAccount(secrets: SecretsLike, id: string): void {
  if (id === "legacy") {
    secrets.delete("GMAIL_USER");
    secrets.delete("GMAIL_APP_PASSWORD");
    return;
  }
  writeStoredAccounts(secrets, readStoredAccounts(secrets).filter((a) => a.id !== id));
}

/** True when at least one mail account exists — the scheduler's "should I even try" check. */
export function gmailConfigured(deps: Pick<ConnectorDeps, "secrets">): boolean {
  return listMailAccounts(deps.secrets).length > 0;
}

/** First address from a mailparser From/To field (single object or array). */
function firstAddr(field: AddressObject | AddressObject[] | undefined): EmailAddress | null {
  if (!field) return null;
  const obj = Array.isArray(field) ? field[0] : field;
  return obj?.value?.[0] ?? null;
}

/**
 * Sync one IMAP account (INBOX + its provider's sent folder). Per-account cursor lives
 * under sync_state source `gmail:<user>`; the legacy single-account cursor 'gmail'
 * migrates on first run (copied when the per-account cursor is missing).
 */
export async function syncMailAccount(
  deps: Pick<ConnectorDeps, "db">,
  account: MailAccount
): Promise<SyncReport> {
  const { db } = deps;
  const report: SyncReport = { source: "gmail", ingested: 0, skipped: 0, created: 0 };

  const user = account.user.trim();
  if (!user || !account.password) return { ...report, error: "not-configured" };
  // Your own address — used to classify direction and never treat yourself as counterpart.
  const selfSet = new Set([user.toLowerCase()]);

  const cursorSource = `gmail:${user}`;
  let cursor = getCursor(db, cursorSource);
  if (!cursor) {
    const legacy = getCursor(db, "gmail"); // pre-multi-account cursor
    if (legacy) {
      setCursor(db, cursorSource, legacy);
      cursor = legacy;
    }
  }
  const since =
    cursor && !Number.isNaN(Date.parse(cursor))
      ? new Date(cursor)
      : new Date(Date.now() - FIRST_RUN_MONTHS * 30 * 86_400_000);

  const mailboxes = ["INBOX", PROVIDER_PRESETS[account.provider].sentFolder];

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: account.password },
    logger: false,
  });

  let matched = 0;
  let attempted = 0;
  let maxDate = since.getTime();

  try {
    await client.connect();
    try {
      for (const box of mailboxes) {
        let lock;
        try {
          lock = await client.getMailboxLock(box);
        } catch {
          continue; // mailbox missing (localized sent-folder name) — skip it
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

  if (maxDate > since.getTime()) setCursor(db, cursorSource, new Date(maxDate).toISOString());
  report.resolvedPct = resolvedPct(matched, attempted);
  return report;
}

/**
 * Legacy single-account path (kept for tests + direct callers): syncs the account
 * described by the GMAIL_USER / GMAIL_APP_PASSWORD secrets.
 */
export async function syncGmail(deps: ConnectorDeps): Promise<SyncReport> {
  const user = deps.secrets.get("GMAIL_USER");
  const pass = deps.secrets.get("GMAIL_APP_PASSWORD");
  if (!user || !pass)
    return { source: "gmail", ingested: 0, skipped: 0, created: 0, error: "not-configured" };
  return syncMailAccount(deps, {
    id: "legacy",
    provider: "gmail",
    user,
    password: pass,
    host: PROVIDER_PRESETS.gmail.host,
    port: PROVIDER_PRESETS.gmail.port,
  });
}

/**
 * Sync EVERY configured mail account, continuing past per-account failures. Returns one
 * combined report under source 'gmail' (the scheduler's sync_run source for mail);
 * per-account errors are joined into `error`, prefixed with the account address.
 */
export async function syncAllMail(deps: ConnectorDeps): Promise<SyncReport> {
  const accounts = listMailAccounts(deps.secrets);
  const report: SyncReport = { source: "gmail", ingested: 0, skipped: 0, created: 0 };
  if (accounts.length === 0) return { ...report, error: "not-configured" };

  const errors: string[] = [];
  for (const account of accounts) {
    let r: SyncReport;
    try {
      r = await syncMailAccount(deps, account);
    } catch (e) {
      r = { source: "gmail", ingested: 0, skipped: 0, created: 0, error: (e as Error).message };
    }
    report.ingested += r.ingested;
    report.skipped += r.skipped;
    report.created += r.created;
    if (r.error) errors.push(`${account.user}: ${r.error}`);
  }
  if (errors.length) report.error = errors.join("; ");
  return report;
}
