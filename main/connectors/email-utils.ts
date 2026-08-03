// Email header parsing + the automated-sender denylist. Ported verbatim from
// PersonalCRM2 lib/email-utils.ts (Doc 2 §1.2).
// Conservative: better to ingest a borderline human than drop a real contact.

export type ParsedAddress = { name: string | null; email: string | null };

/** Parse one address from a From/To header: `Name <a@b.com>`, `<a@b.com>`, or `a@b.com`. */
export function parseAddress(header: string | null | undefined): ParsedAddress {
  if (!header) return { name: null, email: null };
  const h = header.trim();
  // Angle-bracket form: the display name may contain commas ("Last, First" <a@b>), so
  // match the first <...> address BEFORE splitting on commas — splitting first would
  // truncate quoted/unquoted comma names and drop the email entirely.
  const angle = h.match(/^([^<]*)<([^>]+)>/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { name: name || null, email: angle[2].trim().toLowerCase() || null };
  }
  // No angle brackets: a bare address (or comma-separated list). Take the first token.
  const first = h.split(",")[0].trim();
  if (first.includes("@")) return { name: null, email: first.toLowerCase() };
  return { name: first || null, email: null };
}

// ── Forwarded-message parsing ────────────────────────────────────────────────
// When mail is forwarded into the CRM account, the envelope From is the forwarder (you), so
// the REAL sender lives in the quoted header block in the body. Recognize the common
// forwarded markers (Gmail / Apple Mail / Outlook) and pull the original From / To / Subject.

export interface ForwardedHeaders {
  from: ParsedAddress | null;
  to: ParsedAddress | null;
  subject: string | null;
}

const FWD_MARKER = /(-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)/i;

/** Strip leading Fwd:/Fw:/Re: prefixes from a subject. */
export function stripFwdPrefix(s: string | null | undefined): string | null {
  if (!s) return null;
  let t = s.trim();
  let prev;
  do {
    prev = t;
    t = t.replace(/^\s*(fwd?|re)\s*:\s*/i, "").trim();
  } while (t !== prev);
  return t || null;
}

/**
 * Extract the original sender/recipient/subject from a forwarded email's body. Looks for a
 * forwarded marker first; if none, falls back to a header cluster (From: + Subject: + Date/Sent:
 * close together) so Outlook-style forwards without a marker still parse. Returns null if no
 * forwarded header block with a real From/To address is found.
 */
export function parseForwardedHeaders(body: string | null | undefined): ForwardedHeaders | null {
  if (!body) return null;
  let start = body.search(FWD_MARKER);
  if (start === -1) {
    // No explicit marker: look for an Outlook-style header cluster.
    const cluster = body.match(/^\s*from:\s*.+@.+$(?:\r?\n.*){0,4}?\r?\n\s*subject:\s*.+$/im);
    if (!cluster) return null;
    start = cluster.index ?? 0;
  }
  const block = body.slice(start, start + 900);
  const grab = (label: string): string | null => {
    const m = block.match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "im"));
    return m ? m[1].trim() : null;
  };
  const fromRaw = grab("from");
  const toRaw = grab("to");
  const from = fromRaw ? addrFromForwardedLine(fromRaw) : null;
  const to = toRaw ? addrFromForwardedLine(toRaw) : null;
  if (!from?.email && !to?.email) return null; // need at least one real address
  return { from, to, subject: stripFwdPrefix(grab("subject")) };
}

/** Robustly pull a name + email from a forwarded header line, tolerating HTML-stripped Outlook
 *  forwards (`Name<mailto:a@b.com>` / `a@b.com<mailto:a@b.com>`) and plain `Name <a@b.com>`. */
function addrFromForwardedLine(line: string): ParsedAddress {
  const cleaned = line.replace(/mailto:/gi, "");
  const m = cleaned.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const email = m ? m[0].toLowerCase() : null;
  let name: string | null;
  if (email) {
    const before = cleaned.slice(0, cleaned.toLowerCase().indexOf(email)).replace(/["<>]/g, "").trim();
    name = before && !before.includes("@") ? before : null;
  } else {
    name = cleaned.replace(/["<>]/g, "").trim() || null;
  }
  return { name, email };
}

// Conservative (Doc 2 §1.2): only unambiguously automated localparts. Role addresses
// like hello@/info@/team@/support@/marketing@ are often a real person at a small
// company, so we DON'T deny them — better to ingest a borderline human than drop a
// real contact (identity resolution will skip a non-matching one anyway).
const DENY_LOCALPARTS = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
  "newsletter",
  "newsletters",
];

const DENY_DOMAINS = [
  "mailchimp.com",
  "sendgrid.net",
  "substack.com",
  "mailer.netflix.com",
  "amazonses.com",
  "bounce.linkedin.com",
];

/** True if the address looks like an automated / no-reply / newsletter sender. */
export function isAutomatedSender(email: string | null | undefined): boolean {
  if (!email) return true; // no address → can't be a real contact
  const e = email.toLowerCase();
  const [local, domain] = e.split("@");
  if (!local || !domain) return true;
  if (DENY_LOCALPARTS.some((d) => local === d || local.startsWith(d + "+") || local.startsWith(d + "."))) {
    return true;
  }
  if (DENY_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return true;
  return false;
}
