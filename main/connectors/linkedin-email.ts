// LinkedIn-via-email connector. Reads ONLY LinkedIn's own notification emails over IMAP
// (read-only) from EVERY configured mail account (main/connectors/gmail.ts account store —
// no separate LINKEDIN_MAIL_* creds), and turns them into people + timeline interactions:
//   invite_received / invite_accepted → person created (real names only) or updated, plus
//     an inbound 'linkedin' interaction so the connection event shows on the timeline;
//   message_notification → interaction only for an already-known person (never creates).
// The IMAP search is scoped server-side to `FROM linkedin.com`, mailbox INBOX, so no other
// mail is ever fetched. Classification is ported from PersonalCRM2 lib/linkedin-email.ts
// (pure functions, unit-tested); incremental via sync_state source `linkedin-email:<user>`.

import { ImapFlow } from "imapflow";
import { imapTlsOptions } from "./tls-ca.ts";
import { simpleParser } from "mailparser";
import { normalizeLinkedin } from "../crm/normalize.ts";
import { resolveHandle } from "../crm/identity.ts";
import { listMailAccounts, type MailAccount } from "./gmail.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  getCursor,
  setCursor,
  createPerson,
  addAlias,
  snippet,
  resolvedPct,
} from "./common.ts";

const SOURCE = "linkedin-email";
const FIRST_RUN_MONTHS = 12;

// ── classification (ported from PersonalCRM2 lib/linkedin-email.ts) ──────────
// Pure functions — no I/O — so they're unit-testable against the email formats.

export type LinkedInEventKind = "invite_received" | "invite_accepted" | "message_notification";

export interface LinkedInPerson {
  name: string | null;
  role: string | null;
  company: string | null;
  profileUrl: string | null; // raw https URL if found
}

export interface LinkedInEvent {
  kind: LinkedInEventKind;
  person: LinkedInPerson;
}

/** True if an email's From address is a LinkedIn sender (linkedin.com or any subdomain). */
export function isLinkedInSender(fromEmail: string | null | undefined): boolean {
  if (!fromEmail) return false;
  return /@([a-z0-9-]+\.)*linkedin\.com$/i.test(fromEmail.trim().toLowerCase());
}

const ACCEPTED_RE = /(accepted your (?:connection )?invitation|is now a connection|you(?:'re| are) now connected|you are now connected with)/i;
const RECEIVED_RE = /(would like to connect|wants? to connect|invitation to connect|sent you an invitation|invited you to connect|add (?:me|you) to (?:my|your)[^.]*network)/i;
// Message notifications are matched against the SUBJECT only (digest bodies mention
// "sent you a message" too), and only after the invite patterns have had their shot.
const MESSAGE_RE = /(just messaged you|sent you a (?:new )?message|new message from|messaged you)/i;

/** Strip "via LinkedIn", trailing "on LinkedIn", emojis, and tidy whitespace/punctuation. */
function cleanName(s: string | null): string | null {
  if (!s) return null;
  const n = s
    .replace(/\s+via\s+LinkedIn\s*$/i, "")
    .replace(/\s+on\s+LinkedIn\b/i, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // emoji
    .replace(/["“”]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.,!:;]+$/, "")
    .trim();
  // Reject obvious non-names (LinkedIn, empty, too long)
  if (!n || /^linkedin$/i.test(n) || n.length > 80) return null;
  return n;
}

/** Pull the person's name out of the subject line for each event type. */
function nameFromSubject(subject: string, kind: LinkedInEventKind): string | null {
  const s = subject.trim();
  const tries =
    kind === "invite_accepted"
      ? [
          /^(?:congrats[,!]?\s*)?(.+?)\s+(?:has\s+)?accepted your/i,
          /^(.+?)\s+is now a connection/i,
          /you(?:'re| are) now connected with\s+(.+?)$/i,
        ]
      : kind === "message_notification"
        ? [
            /^(.+?)\s+just messaged you/i,
            /^(.+?)\s+sent you a (?:new )?message/i,
            /new message from\s+(.+?)$/i,
            /^(.+?)\s+messaged you/i,
          ]
        : [
            /^invitation to connect from\s+(.+?)$/i,
            /^(.+?)\s+would like to connect/i,
            /^(.+?)\s+wants? to connect/i,
            /^(.+?)\s+sent you an invitation/i,
            /^(.+?)\s+invited you to connect/i,
          ];
  for (const re of tries) {
    const m = s.match(re);
    if (m && m[1]) {
      const n = cleanName(m[1]);
      if (n) return n;
    }
  }
  return null;
}

/** First LinkedIn /in/ profile URL in the body (handles /comm/in/ tracking links). */
function profileUrlFrom(body: string): string | null {
  const m = body.match(/https?:\/\/[^\s"'<>]*linkedin\.com\/(?:comm\/)?in\/([A-Za-z0-9\-_%.]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/\/$/, "");
  return `https://www.linkedin.com/in/${slug}`;
}

/** Best-effort headline → {role, company} from a "Role at Company" line near the name. */
function headlineFrom(body: string, name: string | null): { role: string | null; company: string | null } {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 25);
  const first = name ? name.split(/\s+/)[0] : null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 80 || /https?:\/\//i.test(l) || /@/.test(l)) continue;
    // A headline like "Software Engineer at Acme Corp"
    const m = l.match(/^([A-Za-z][^@]{1,58}?)\s+(?:at|@)\s+([^@]{2,58})$/);
    if (!m) continue;
    // Prefer a headline that sits right after the person's name (reduces false positives).
    const prev = lines[i - 1] ?? "";
    const near = !first || prev.includes(name!) || l.includes(name!) || i <= 3;
    if (near) return { role: m[1].trim(), company: m[2].trim().replace(/[.,]$/, "") };
  }
  return { role: null, company: null };
}

/**
 * Classify a LinkedIn email. Returns an event for invitations sent-to-you, invitations
 * accepted-by-someone, or (subject-only) message notifications; null for everything else
 * (digests, jobs, news, reactions). `fromName` is the From display name
 * (e.g. "Jane Doe via LinkedIn").
 */
export function classifyLinkedInEmail(input: {
  subject: string | null;
  fromName: string | null;
  text: string | null;
  html: string | null;
}): LinkedInEvent | null {
  const subject = (input.subject ?? "").trim();
  const body = `${input.text ?? ""}\n${(input.html ?? "").replace(/<[^>]+>/g, " ")}`;
  const hay = `${subject}\n${body}`;

  let kind: LinkedInEventKind | null = null;
  if (ACCEPTED_RE.test(hay)) kind = "invite_accepted";
  else if (RECEIVED_RE.test(hay)) kind = "invite_received";
  else if (MESSAGE_RE.test(subject)) kind = "message_notification";
  if (!kind) return null;

  let name = nameFromSubject(subject, kind);
  if (!name) name = cleanName(input.fromName); // "Jane Doe via LinkedIn"
  const profileUrl = profileUrlFrom(body);
  const { role, company } = headlineFrom(body, name);

  // Need at least a name or a profile URL to make a useful contact.
  if (!name && !profileUrl) return null;
  return { kind, person: { name, role, company, profileUrl } };
}

/** Humanize a LinkedIn slug into a fallback name when the email gave none. */
export function nameFromSlug(profileUrl: string | null): string | null {
  if (!profileUrl) return null;
  const m = profileUrl.match(/\/in\/([^/?#]+)/);
  if (!m) return null;
  const slug = m[1]
    .replace(/-[0-9a-f]{6,}$/i, "") // trailing hash
    .replace(/-?\d+$/, "") // trailing digits
    .replace(/[-_]+/g, " ")
    .trim();
  if (!slug) return null;
  return slug.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Timeline label for an event kind — stored as the interaction subject. */
export function eventLabel(kind: LinkedInEventKind): string {
  return kind === "invite_received"
    ? "LinkedIn — sent you an invite"
    : kind === "invite_accepted"
      ? "LinkedIn — accepted your invite"
      : "LinkedIn — sent you a message";
}

// ── sync ─────────────────────────────────────────────────────────────────────

interface Tally {
  ingested: number;
  skipped: number;
  created: number;
  matched: number;
  attempted: number;
}

/** Apply one classified event to the spine. Mutates the tally. */
function applyEvent(
  db: ConnectorDeps["db"],
  ev: LinkedInEvent,
  when: Date,
  externalId: string,
  bodySummary: string | null,
  t: Tally
): void {
  const { role, company, profileUrl } = ev.person;
  // Guard rails ported from PersonalCRM2: anonymized "LinkedIn Member" is unattributable.
  const name =
    ev.person.name && ev.person.name !== "LinkedIn Member"
      ? ev.person.name
      : nameFromSlug(profileUrl);
  const li = normalizeLinkedin(profileUrl);
  if (!name && !li) {
    t.skipped++;
    return;
  }

  t.attempted++;
  const res = resolveHandle(db, { linkedin: profileUrl, name, org: company });
  let personId: number;
  if (res.status === "matched" && res.personId) {
    personId = res.personId;
    t.matched++;
    // Backfill org/role when empty (same policy as the LinkedIn-export connector).
    if (role || company) {
      db.prepare(
        `UPDATE person SET
           org = COALESCE(org, ?), role = COALESCE(role, ?), updated_at = datetime('now')
         WHERE id = ? AND (org IS NULL OR role IS NULL)`
      ).run(company, role, personId);
    }
  } else if (res.status === "ambiguous") {
    t.skipped++; // never auto-pick between candidates
    return;
  } else {
    // Create only for a connection event with a real name — a message notification (or a
    // nameless invite) is not enough evidence to mint a person.
    if (ev.kind === "message_notification" || !name || name === "LinkedIn Member") {
      t.skipped++;
      return;
    }
    personId = createPerson(db, { displayName: name, org: company, role });
    t.created++;
    t.matched++;
  }

  // alias kind 'linkedin' with the profile URL when present. (No 'email' alias: LinkedIn
  // notification mail comes from linkedin.com — the person's own address is never exposed.)
  if (li) addAlias(db, personId, "linkedin", li.norm, SOURCE);

  const inserted = insertInteraction(db, {
    personId,
    channel: "linkedin",
    direction: "inbound",
    occurredAt: when.toISOString(),
    subject: eventLabel(ev.kind),
    bodySummary,
    externalId,
  });
  if (inserted) t.ingested++;
  else t.skipped++; // already ingested — idempotent via UNIQUE(channel, external_id)
}

/** Scan one account's INBOX for LinkedIn notification mail since the per-account cursor. */
async function scanAccount(db: ConnectorDeps["db"], account: MailAccount, t: Tally): Promise<void> {
  const user = account.user.trim();
  const cursorSource = `${SOURCE}:${user}`;
  const cursor = getCursor(db, cursorSource);
  const since =
    cursor && !Number.isNaN(Date.parse(cursor))
      ? new Date(cursor)
      : new Date(Date.now() - FIRST_RUN_MONTHS * 30 * 86_400_000);

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user, pass: account.password },
    logger: false,
    tls: imapTlsOptions(),
  });

  let maxDate = since.getTime();

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Server-side filter: ONLY messages from LinkedIn, since the cursor. Other mail is
      // never fetched.
      const uids = (await client.search({ from: "linkedin.com", since }, { uid: true })) || [];
      if (uids.length) {
        for await (const msg of client.fetch(
          uids,
          { uid: true, source: true, internalDate: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source as Buffer);
          const fromAddr = parsed.from?.value?.[0]?.address ?? null;
          if (!isLinkedInSender(fromAddr)) continue; // belt-and-suspenders

          const internal = msg.internalDate ? new Date(msg.internalDate) : null;
          const when = new Date(parsed.date ?? internal ?? Date.now());
          if (internal && internal.getTime() > maxDate) maxDate = internal.getTime();
          else if (!internal && when.getTime() > maxDate) maxDate = when.getTime();

          const ev = classifyLinkedInEmail({
            subject: parsed.subject ?? null,
            fromName: parsed.from?.value?.[0]?.name ?? null,
            text: parsed.text ?? null,
            html: typeof parsed.html === "string" ? parsed.html : null,
          });
          if (!ev) {
            t.skipped++; // digest / jobs / reactions — not our two-and-a-half events
            continue;
          }

          const externalId = parsed.messageId ?? `${SOURCE}:${user}:${msg.uid}`;
          const bodyText =
            parsed.text ||
            (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          applyEvent(db, ev, when, externalId, snippet(bodyText), t);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  if (maxDate > since.getTime()) setCursor(db, cursorSource, new Date(maxDate).toISOString());
}

/**
 * Sync LinkedIn notification email across EVERY configured mail account, continuing past
 * per-account failures (errors joined into `error`, prefixed with the account address).
 */
export async function syncLinkedinEmail(deps: ConnectorDeps): Promise<SyncReport> {
  const { db, secrets } = deps;
  const report: SyncReport = { source: SOURCE, ingested: 0, skipped: 0, created: 0 };
  const accounts = listMailAccounts(secrets);
  if (accounts.length === 0) return { ...report, error: "not-configured" };

  const t: Tally = { ingested: 0, skipped: 0, created: 0, matched: 0, attempted: 0 };
  const errors: string[] = [];
  for (const account of accounts) {
    try {
      await scanAccount(db, account, t);
    } catch (e) {
      errors.push(`${account.user}: ${(e as Error).message}`);
    }
  }

  report.ingested = t.ingested;
  report.skipped = t.skipped;
  report.created = t.created;
  report.resolvedPct = resolvedPct(t.matched, t.attempted);
  if (errors.length) report.error = errors.join("; ");
  return report;
}
