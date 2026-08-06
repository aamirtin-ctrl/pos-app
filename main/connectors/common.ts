// Shared connector plumbing. The NEW architecture has no staging table: every connector
// resolves identity inline (crm/identity.ts) and writes directly to `interaction`.
// UNIQUE(channel, external_id) + INSERT OR IGNORE make every connector idempotent.
// Privacy contract (ported from PersonalCRM2 Doc 2 §0): store a ≤200-char snippet in
// body_summary, NEVER the full body.

import type { Db } from "../db/db.ts";
import type { SecretStore } from "../secrets.ts";
import type { LlmClient } from "../llm/provider.ts";
import { isAutomatedSender } from "./email-utils.ts";

export interface ConnectorDeps {
  db: Db;
  secrets: SecretStore;
  llm?: LlmClient | null;
}

export interface SyncReport {
  source: string;
  /** New interaction rows written this run (dedupe-ignored rows count as skipped). */
  ingested: number;
  /** Everything not inserted: automated senders, unmatched/ambiguous, dupes, unparseable. */
  skipped: number;
  /** New person rows created this run. */
  created: number;
  /** % of resolution attempts that matched a person (omitted when nothing to resolve). */
  resolvedPct?: number;
  /** Subset of `skipped` that isBulkMail() rejected (newsletters, ESP blasts, no-reply). */
  skippedBulk?: number;
  error?: string;
}

export const SNIPPET_MAX = 200;

/** Collapse whitespace and cap at SNIPPET_MAX. Null when there's no usable text. */
export function snippet(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, SNIPPET_MAX) : null;
}

export interface NewInteraction {
  personId: number;
  channel: string;
  direction: "inbound" | "outbound" | "mutual" | null;
  occurredAt: string | null; // ISO
  subject?: string | null;
  bodySummary?: string | null;
  externalId: string;
  threadExternalId?: string | null;
}

/** INSERT OR IGNORE into interaction. Returns true when a NEW row was written. */
export function insertInteraction(db: Db, r: NewInteraction): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO interaction
         (person_id, channel, direction, occurred_at, subject, body_summary, external_id, thread_external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.personId,
      r.channel,
      r.direction,
      r.occurredAt,
      r.subject ?? null,
      r.bodySummary ?? null,
      r.externalId,
      r.threadExternalId ?? null
    );
  return res.changes > 0;
}

/** sync_state cursor for a source, or null on first run. */
export function getCursor(db: Db, source: string): string | null {
  const row = db.prepare("SELECT cursor FROM sync_state WHERE source = ?").get(source) as
    | { cursor: string | null }
    | undefined;
  return row?.cursor ?? null;
}

/** Upsert the sync_state cursor + last_sync_at for a source. */
export function setCursor(db: Db, source: string, cursor: string): void {
  db.prepare(
    `INSERT INTO sync_state (source, last_sync_at, cursor, updated_at)
     VALUES (?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(source) DO UPDATE SET
       last_sync_at = excluded.last_sync_at,
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`
  ).run(source, cursor);
}

/** Create a person row; returns its id. */
export function createPerson(
  db: Db,
  p: { displayName: string; org?: string | null; role?: string | null }
): number {
  const res = db
    .prepare("INSERT INTO person (display_name, org, role) VALUES (?, ?, ?)")
    .run(p.displayName, p.org ?? null, p.role ?? null);
  return Number(res.lastInsertRowid);
}

/** Add an alias if the (kind, value) pair isn't already claimed — never steals. */
export function addAlias(db: Db, personId: number, kind: string, value: string, source: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO alias (person_id, kind, value, source) VALUES (?, ?, ?, ?)"
  ).run(personId, kind, value, source);
}

/** Rounded match percentage, or undefined when nothing was attempted. */
export function resolvedPct(matched: number, attempted: number): number | undefined {
  if (attempted <= 0) return undefined;
  return Math.round((matched / attempted) * 100);
}

// ─────────────────────────── bulk / newsletter detection ───────────────────────────
// Newsletters were leaking into the CRM as `unverified` contacts because the old gate
// (isAutomatedSender) only looked at local-parts like noreply@ / notifications@. Real
// senders evade that trivially: newsletters@nytimes.com, info@x.com, no-reply-alexa@…
//
// The canonical signal is the RFC headers bulk mail carries and person-to-person mail
// never does — List-Unsubscribe above all (CAN-SPAM/GDPR practice means every legitimate
// sender sets it). Checks run cheapest/strongest first and the reason string names which
// one fired, so a false positive is always traceable to a rule.
//
// Ordering is deliberate: header evidence (1–5) is near-certain; envelope evidence (6) is
// strong; address shape (7–8) is the last resort and the only heuristic that can plausibly
// misfire on a real human at a small company.

export interface BulkVerdict {
  bulk: boolean;
  /** Which check fired — empty string when not bulk. */
  reason: string;
}

/**
 * Anything shaped like mailparser's ParsedMail as far as this module cares: a
 * `headers` Map (or plain object) with lowercase keys, and/or raw `headerLines`.
 * Keeping the input structural is what makes isBulkMail unit-testable without IMAP.
 */
export interface BulkMailInput {
  headers?: unknown;
  headerLines?: unknown;
  from?: unknown;
}

/** Presence of ANY of these means the message was sent to a list. Strongest signal. */
const LIST_HEADERS = [
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-id",
  "list-post",
  "list-help",
  "list-subscribe",
  "list-owner",
  "list-archive",
];

const PRECEDENCE_BULK = /^\s*(bulk|list|junk|auto[_ -]?reply)\b/i;
/** RFC 3834: anything other than "no" means a machine composed the message. */
const AUTO_SUBMITTED_BULK = /^\s*auto-(generated|replied|notified|submitted)\b/i;

/** Header NAMES only ESPs / campaign tooling emit. Prefix match on the lowercase key. */
const ESP_HEADER_PREFIXES = [
  "x-campaign",
  "x-mailchimp",
  "x-mc-",
  "x-mandrill",
  "x-sg-",
  "x-sendgrid",
  "x-mailgun",
  "x-ses-",
  "x-amazonses",
  "x-braze",
  "x-iterable",
  "x-customerio",
  "x-cio-",
  "x-marketo",
  "x-mktomid",
  "x-sailthru",
  "x-substack",
  "x-klaviyo",
  "x-emarsys",
  "x-responsys",
  "x-eloqua",
  "x-sfmc",
  "x-cm-",
  "x-constantcontact",
  "x-postmark",
  "x-mailjet",
  "x-beehiiv",
  "x-convertkit",
  "x-msfbl",
  "x-newsletter",
  "x-bulkmail",
  "x-complaints-to",
  "x-csa-complaints",
  "x-report-abuse",
  "feedback-id",
  "x-feedback-id",
];

/**
 * ESP fingerprints checked against header VALUES (never names): X-Mailer is set by Apple
 * Mail and Outlook too, so only the value can tell a campaign apart from a human's client.
 */
const ESP_VALUE = /(mailchimp|mandrill|sendgrid|sparkpost|mailgun|amazon\s?ses|braze|iterable|customer\.?io|marketo|sailthru|substack|klaviyo|hubspot|exacttarget|salesforce marketing|responsys|eloqua|emarsys|constant\s?contact|campaign\s?monitor|mailjet|beehiiv|convertkit|postmark|sendinblue|brevo|activecampaign|listrak|dotdigital|silverpop|acoustic|pardot|blueshift|cheetahmail|mailerlite|omnisend|newsletter|bulk\s?mail|campaign)/i;
/** Header values carrying an ESP fingerprint are only trusted from these keys. */
const ESP_VALUE_HEADERS = ["x-mailer", "x-mailer-version", "x-originating-client", "x-ses-outgoing"];

/** ESP / bounce-handling domains. A person never sends personal mail from these. */
const BULK_DOMAIN_SUFFIXES = [
  "mailchimp.com",
  "mailchimpapp.net",
  "mcsv.net",
  "mcdlv.net",
  "rsgsv.net",
  "sendgrid.net",
  "sendgrid.com",
  "substack.com",
  "beehiiv.com",
  "amazonses.com",
  "mailgun.org",
  "sparkpostmail.com",
  "createsend.com",
  "cmail19.com",
  "klaviyomail.com",
  "braze.com",
  "iterable.com",
  "customeriomail.com",
  "mktomail.com",
  "sailthru.com",
  "exct.net",
  "exacttarget.com",
  "hubspotemail.net",
  "convertkit-mail.com",
  "sendinblue.com",
  "postmarkapp.com",
  "bounce.linkedin.com",
];

/**
 * Sending subdomains. Humans live at the apex (sarah@acme.com); campaigns live one label
 * down (mail.instagram.com, e.nytimes.com, news.x.com) to isolate their sending reputation.
 */
const BULK_SUBDOMAIN =
  /^(mail|email|e|em|news|newsletter|newsletters|mailer|mailing|notify|notification|notifications|alert|alerts|reply|noreply|no-reply|bounce|bounces|marketing|campaign|campaigns|updates|list|lists|send|smtp|link|links|click|clicks)\./;

/**
 * Last-resort local-parts (owner request 2026-08-05). Deliberately broader than
 * email-utils' DENY_LOCALPARTS, which stays conservative for the other connectors:
 * role addresses like info@/support@ ARE sometimes a real human at a small company, but
 * the owner would rather lose those than keep ingesting X, Instagram and Alexa blasts.
 */
const BULK_LOCALPARTS = new Set([
  // existing automated set, restated so token matching covers compounds (store-news@…)
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "notification",
  "notifications",
  "mailer-daemon",
  "postmaster",
  // owner's extension
  "newsletter",
  "newsletters",
  "news",
  "update",
  "updates",
  "digest",
  "digests",
  "marketing",
  "promo",
  "promos",
  "promotion",
  "promotions",
  "deal",
  "deals",
  "offer",
  "offers",
  "alert",
  "alerts",
  "info",
  "hello",
  "team",
  "support",
  "billing",
  "receipt",
  "receipts",
  "invoice",
  "invoices",
  "notify",
  "mailer",
  "mailers",
  "bounce",
  "bounces",
  "nreply",
  "unsubscribe",
]);

/** Display names that only ever belong to a sending robot (used by the CRM purge). */
const BULK_DISPLAY_NAME =
  /\b(newsletters?|digests?|notifications?|no[-\s.]?reply|do[-\s]?not[-\s]?reply|donotreply|mailer[-\s]?daemon|mailing list|mailer|marketing|promotions?|billing|receipts?|invoices?|alerts?|unsubscribe|support team|customer care)\b/i;

/** Collapse a mailparser HeaderValue (string | array | Date | Address | Structured) to text. */
function flattenHeaderValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(flattenHeaderValue).filter(Boolean).join("; ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text; // AddressObject
    if (typeof o.value === "string") {
      // StructuredHeader — keep the params, ESP fingerprints often hide in them
      const params =
        o.params && typeof o.params === "object"
          ? Object.entries(o.params as Record<string, unknown>)
              .map(([k, pv]) => `${k}=${String(pv)}`)
              .join("; ")
          : "";
      return params ? `${o.value}; ${params}` : o.value;
    }
    if (Array.isArray(o.value)) return flattenHeaderValue(o.value);
    if (typeof o.address === "string") {
      return o.name ? `${String(o.name)} <${o.address}>` : o.address;
    }
  }
  return "";
}

/**
 * One lowercase-keyed map from whichever header representation the caller has: a
 * mailparser `headers` Map, a plain object, and/or raw `headerLines`. Repeated headers
 * join with "; " so a value scan sees them all; a header present but empty still `has()`.
 */
function headerEntries(input: BulkMailInput | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const put = (rawKey: string, rawValue: string): void => {
    const k = rawKey.trim().toLowerCase();
    if (!k) return;
    const v = rawValue.trim();
    const prev = out.get(k);
    if (!v) {
      if (prev === undefined) out.set(k, "");
      return;
    }
    out.set(k, prev ? `${prev}; ${v}` : v);
  };

  const h = input?.headers as
    | (Map<string, unknown> & { get?: unknown })
    | Record<string, unknown>
    | undefined;
  if (h && typeof h === "object") {
    const maybeMap = h as Partial<Map<string, unknown>>;
    if (typeof maybeMap.get === "function" && typeof maybeMap.forEach === "function") {
      (h as Map<string, unknown>).forEach((v, k) => put(String(k), flattenHeaderValue(v)));
    } else {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
        put(k, flattenHeaderValue(v));
      }
    }
  }

  const lines = input?.headerLines;
  if (Array.isArray(lines)) {
    for (const entry of lines) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as { key?: unknown; line?: unknown };
      const raw = typeof rec.line === "string" ? rec.line : "";
      const colon = raw.indexOf(":");
      const key = typeof rec.key === "string" && rec.key ? rec.key : colon >= 0 ? raw.slice(0, colon) : "";
      if (!key.trim() || out.has(key.trim().toLowerCase())) continue; // parsed map wins
      put(key, colon >= 0 ? raw.slice(colon + 1) : "");
    }
  }
  return out;
}

/** Split one address out of `Name <a@b.com>` / `<a@b.com>` / `a@b.com`. Lowercased. */
function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/[A-Za-z0-9._%+='-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1);
/** Last two labels — so mail.acme.com and acme.com read as the same organisation. */
const registrable = (domain: string): string => domain.split(".").slice(-2).join(".");

/**
 * Envelope local-parts that only exist to catch bounces: bounces+…, sr.bounces,
 * msprvs1=… (Message Systems), em1234567 (SendGrid), prvs=/btv1== (BATV tagging).
 */
function bounceStyleLocal(local: string): boolean {
  const l = local.toLowerCase();
  if (!l) return false;
  if (/^bounces?([+._=-]|$)/.test(l)) return true;
  if (/[._-]bounces?([+._=-]|$)/.test(l)) return true; // sr.bounces, msys-bounce
  if (/^msprvs\d*[=+._-]/.test(l)) return true;
  if (/^(prvs=|btv1==)/.test(l)) return true;
  if (/^em\d{3,}/.test(l)) return true;
  if (/^\d+[._-]?bounces?/.test(l)) return true;
  if (l === "mailer-daemon" || l === "postmaster") return true;
  return false;
}

/** The bulk local-part token an address matches, or null. Splits on . + _ - and strips digits. */
function bulkLocalToken(local: string): string | null {
  const strip = (s: string): string => s.replace(/\d+$/, "");
  const candidates = [local, strip(local), local.split("+")[0], strip(local.split("+")[0])];
  for (const c of candidates) if (c && BULK_LOCALPARTS.has(c)) return c;
  for (const part of local.split(/[._+-]+/)) {
    const tok = strip(part);
    if (tok && BULK_LOCALPARTS.has(tok)) return tok;
  }
  return null;
}

/**
 * Address-only bulk evidence (checks 7–8 of isBulkMail), split out so the CRM cleanup can
 * reuse the exact same rules on stored aliases. Returns the reason, or null when the
 * address looks like it could belong to a human. A missing address is NOT judged here.
 */
export function bulkAddressReason(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (isAutomatedSender(e)) return `automated-sender:${e}`;
  const token = bulkLocalToken(local);
  if (token) return `bulk-localpart:${token}`;
  if (BULK_DOMAIN_SUFFIXES.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return `bulk-domain:${domain}`;
  }
  if (domain.split(".").length > 2 && BULK_SUBDOMAIN.test(domain)) {
    return `bulk-sending-subdomain:${domain}`;
  }
  return null;
}

/** True when a display name could only belong to a sending robot ("NYT Newsletters"). */
export function isBulkDisplayName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  return BULK_DISPLAY_NAME.test(n);
}

/**
 * Is this message bulk mail (newsletter, campaign, notification blast, auto-reply)?
 *
 * Pure over a header-map-like input — no IMAP, no DB — so every rule is unit-testable.
 * `opts.fromEmail` lets the caller judge the resolved COUNTERPART address (which for a
 * forwarded message is not the envelope From) instead of re-deriving it from headers.
 */
export function isBulkMail(
  parsed: BulkMailInput | null | undefined,
  opts?: { fromEmail?: string | null }
): BulkVerdict {
  const h = headerEntries(parsed);
  const get = (k: string): string | null => h.get(k) ?? null;

  // 1. List-* — every legitimate newsletter sets it; person-to-person mail never does.
  for (const key of LIST_HEADERS) {
    if (h.has(key)) return { bulk: true, reason: `list-header:${key}` };
  }

  // 2. Precedence: bulk | list | junk
  const precedence = get("precedence") ?? get("x-precedence");
  if (precedence && PRECEDENCE_BULK.test(precedence)) {
    return { bulk: true, reason: `precedence:${precedence.trim().toLowerCase()}` };
  }

  // 3. Auto-Submitted (RFC 3834) — anything but "no" is machine-composed.
  const autoSubmitted = get("auto-submitted");
  if (autoSubmitted && AUTO_SUBMITTED_BULK.test(autoSubmitted)) {
    return { bulk: true, reason: `auto-submitted:${autoSubmitted.trim().toLowerCase()}` };
  }
  if (h.has("x-auto-response-suppress")) return { bulk: true, reason: "x-auto-response-suppress" };
  if (h.has("x-autoreply") || h.has("x-autorespond")) return { bulk: true, reason: "x-autoreply" };

  // 4. ESP tooling — dedicated header names, then ESP fingerprints inside X-Mailer.
  for (const key of h.keys()) {
    const hit = ESP_HEADER_PREFIXES.find((p) => key === p || key.startsWith(p));
    if (hit) return { bulk: true, reason: `esp-header:${key}` };
  }
  for (const key of ESP_VALUE_HEADERS) {
    const value = get(key);
    const m = value?.match(ESP_VALUE);
    if (m) return { bulk: true, reason: `esp-mailer:${m[1].toLowerCase()}` };
  }

  // 5. Envelope-from: a bounce-farm return path is campaign infrastructure.
  const fromHeader = addressOf(get("from")) ?? addressOf(flattenHeaderValue(parsed?.from));
  const returnRaw =
    get("return-path") ?? get("x-envelope-from") ?? get("envelope-from") ?? get("x-original-from");
  if (returnRaw !== null) {
    const trimmed = returnRaw.trim();
    // Return-Path: <> is the null reverse-path — bounces and auto-replies only.
    if (trimmed === "<>" || trimmed === "") {
      if (h.has("return-path")) return { bulk: true, reason: "return-path:null" };
    }
    const rp = addressOf(trimmed);
    if (rp) {
      const local = rp.slice(0, rp.lastIndexOf("@"));
      if (bounceStyleLocal(local)) {
        const differs =
          !!fromHeader && registrable(domainOf(rp)) !== registrable(domainOf(fromHeader));
        return {
          bulk: true,
          reason: `bounce-return-path:${local}${differs ? " (off-domain)" : ""}`,
        };
      }
    }
  }

  // 6/7. Address shape — the last resort, on the counterpart the caller resolved.
  const candidate = opts?.fromEmail ?? fromHeader;
  const addressReason = bulkAddressReason(candidate);
  if (addressReason) return { bulk: true, reason: addressReason };

  return { bulk: false, reason: "" };
}
