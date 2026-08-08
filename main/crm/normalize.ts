// Normalization rules (ported verbatim from PersonalCRM2 lib/normalize.ts — Doc 1 §4). Enforce on every write, from every source.
// Matching only works if the seed, Gmail, iMessage, and LinkedIn all normalize
// identically. Each helper returns null when the input can't be trusted; callers
// must leave the field blank and flag rather than guess.

export type NormResult = { raw: string; norm: string };

/** Email: trim + lowercase; value_norm strips +tag aliases. */
export function normalizeEmail(input: string | null | undefined): NormResult | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // minimal shape check: local@domain.tld
  const m = lower.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!m) return null;
  const local = m[1].split("+")[0];
  const domain = m[2];
  if (!local) return null;
  return { raw, norm: `${local}@${domain}` };
}

/** Pull just the email's domain (for the name+domain corroborator in Layer 2). */
export function emailDomain(input: string | null | undefined): string | null {
  const e = normalizeEmail(input);
  return e ? e.norm.split("@")[1] : null;
}

// Free/consumer email providers. A shared domain here is NOT corroborating evidence —
// two different people named "John Smith" can both have gmail.com addresses. Used by
// Layer 2 to avoid false name+domain matches (Doc 1 §6.5: a wrong link is worse than none).
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com",
  "yandex.com",
  "pm.me",
]);

/** True if the domain is a consumer email provider (not a corroborating signal). */
export function isGenericEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return GENERIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Phone → E.164 in value_norm. US (10 digits, or 11 starting with 1) → +1XXXXXXXXXX.
 * International (already has +) kept as +CC… . Unparseable → null (never guess).
 */
export function normalizePhone(input: string | null | undefined): NormResult | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // An EXTENSION is not part of the number. Every non-digit was being stripped, so
  // "+1 (214) 908-8938 ext 5" became +121490889385 — a confidently wrong 13-digit number that
  // matches nobody, splitting one contact into two and attributing their messages to neither.
  // The whole point of this module is that a wrong link is worse than no link, so the
  // extension is cut before the digits are read (audited 2026-08-08).
  // No word boundaries on the "x" at all — "5551234x99" and "x200" are both ordinary written
  // forms and neither has one. Over-matching is prevented by a CONSEQUENCE check instead of a
  // boundary: the strip only stands if what remains is still a plausible number. So "fax
  // 2149088938" — where the "x" is part of a label and the digits after it ARE the number —
  // strips down to nothing usable and the original is kept.
  const withoutExt = raw.replace(/\s*(?:,|;|ext(?:ension)?\.?|x|#)\s*\d{1,5}\s*$/i, "").trim();
  const base = withoutExt.replace(/\D/g, "").length >= 7 ? withoutExt : raw;

  // "00" is the international prefix the rest of the world dials; it means the same thing as
  // "+". Treating it as ordinary digits made every such number unparseable — safe, but a
  // contact silently unlinkable.
  const normalizedPrefix = base.replace(/^\s*00(?=\d)/, "+");
  const hasPlus = normalizedPrefix.trimStart().startsWith("+");
  const digits = normalizedPrefix.replace(/[^\d]/g, "");
  if (!digits) return null;

  let e164: string | null = null;
  if (hasPlus) {
    // International, already E.164-ish. Valid lengths 8–15 digits.
    if (digits.length >= 8 && digits.length <= 15) e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = `+${digits}`;
  }
  if (!e164) return null;
  return { raw, norm: e164 };
}

/** Display form. US (+1, 10 nat. digits) → (XXX) XXX-XXXX; else return E.164 as-is. */
export function formatPhoneDisplay(norm: string | null | undefined): string {
  if (!norm) return "";
  const m = norm.match(/^\+1(\d{10})$/);
  if (m) {
    const d = m[1];
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return norm;
}

/** LinkedIn → canonical "linkedin.com/in/<slug>" (lowercase, no protocol/www/query). */
export function normalizeLinkedin(input: string | null | undefined): NormResult | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  let s = raw.toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  // Accept a bare slug, "in/slug", or a full host path.
  const inMatch = s.match(/linkedin\.com\/in\/([^/]+)/);
  if (inMatch) return { raw, norm: `linkedin.com/in/${inMatch[1]}` };
  const pathMatch = s.match(/^in\/([^/]+)/);
  if (pathMatch) return { raw, norm: `linkedin.com/in/${pathMatch[1]}` };
  // Other linkedin paths (company, etc.) — canonicalize host+path, still usable.
  if (s.startsWith("linkedin.com/")) return { raw, norm: s };
  // A bare token with no domain: treat as a profile slug.
  if (/^[a-z0-9\-]+$/.test(s)) return { raw, norm: `linkedin.com/in/${s}` };
  return null;
}

/**
 * Date → ISO YYYY-MM-DD. Accepts the seed's mixed inputs. When a source omits the
 * year and context is ambiguous, returns null — never invents a year.
 */
export function normalizeDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // Already ISO
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoIfValid(+m[1], +m[2], +m[3]);

  // MM/DD/YYYY or M/D/YYYY
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return isoIfValid(+m[3], +m[1], +m[2]);

  // "Month D, YYYY" / "Mon D YYYY"
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = raw.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = months[m[1].slice(0, 3).toLowerCase()];
    if (mo) return isoIfValid(+m[3], mo, +m[2]);
  }

  // "D Mon YYYY" (LinkedIn Connections export, e.g. "18 Apr 2024")
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (m) {
    const mo = months[m[2].slice(0, 3).toLowerCase()];
    if (mo) return isoIfValid(+m[3], mo, +m[1]);
  }
  return null; // no trustworthy year → leave NULL
}

function isoIfValid(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d
    .toString()
    .padStart(2, "0")}`;
}

/** Tags → lowercase, spaces→hyphens, comma-separated, trimmed, deduped (order kept). */
export function normalizeTags(input: string | null | undefined): string {
  if (!input) return "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(",")) {
    const tag = part.trim().toLowerCase().replace(/\s+/g, "-");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.join(", ");
}

/** Tags as an array (every read path splits + trims per Doc 1 §2.1 note). */
export function tagsToArray(input: string | null | undefined): string[] {
  return normalizeTags(input)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Collapse a name to a comparison key: lowercase, single-spaced, punctuation-light. */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ");
}
