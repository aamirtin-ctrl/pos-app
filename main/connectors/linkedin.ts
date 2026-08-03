// LinkedIn connector — parses the official data export (Connections.csv + messages.csv).
// CSV handling ported from PersonalCRM2 lib/linkedin.ts + connectors/linkedin.ts, adapted
// to the no-staging architecture:
//   - Connections → person (created when new, alias kind 'linkedin' = normalized profile
//     URL) + an interaction (channel 'linkedin', direction 'mutual', external_id conn:<url>).
//   - Messages → interactions attributed by profile-URL alias (snippet only, never the
//     full thread). Anonymized "LinkedIn Member" rows are skipped.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { normalizeDate, normalizeEmail, normalizeLinkedin } from "../crm/normalize.ts";
import { resolveHandle } from "../crm/identity.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  createPerson,
  addAlias,
  resolvedPct,
  SNIPPET_MAX,
} from "./common.ts";

// ── Connections.csv ──────────────────────────────────────────────────────────

export type LinkedinConnection = {
  firstName: string;
  lastName: string;
  url: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  connectedOn: string | null;
  fullName: string;
};

/** Strip LinkedIn's "Notes:" preamble and parse the connection rows. */
export function parseConnectionsCsv(text: string): LinkedinConnection[] {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /first name/i.test(l) && /url/i.test(l));
  const body = headerIdx >= 0 ? lines.slice(headerIdx).join("\n") : text;

  const rows: Record<string, string>[] = parse(body, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of Object.keys(r)) {
      if (keys.some((want) => k.toLowerCase().trim() === want)) {
        const v = (r[k] ?? "").trim();
        if (v) return v;
      }
    }
    return null;
  };

  return rows
    .map((r) => {
      const firstName = pick(r, "first name") ?? "";
      const lastName = pick(r, "last name") ?? "";
      return {
        firstName,
        lastName,
        url: pick(r, "url"),
        email: pick(r, "email address", "email"),
        company: pick(r, "company"),
        position: pick(r, "position"),
        connectedOn: pick(r, "connected on"),
        fullName: `${firstName} ${lastName}`.trim(),
      };
    })
    .filter((c) => c.fullName);
}

// ── messages.csv ─────────────────────────────────────────────────────────────

export interface LinkedInMessage {
  conversationId: string;
  from: string;
  fromUrl: string | null; // normalized
  to: string;
  toUrl: string | null; // normalized (first recipient)
  date: Date | null;
  subject: string | null;
  content: string | null;
}

/** Parse LinkedIn's "2026-05-31 13:27:19 UTC" timestamp → Date (null if unparseable). */
export function parseLinkedInDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return isNaN(dt.getTime()) ? null : dt;
}

const pickFirstUrl = (urls: string | null | undefined): string | null => {
  if (!urls) return null;
  const first = urls.split(/[,\s]+/).find(Boolean) ?? null;
  return normalizeLinkedin(first)?.norm ?? null;
};

/** Parse messages.csv into structured rows (no preamble; header is the first line). */
export function parseMessagesCsv(text: string): LinkedInMessage[] {
  const rows: Record<string, string>[] = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  const get = (r: Record<string, string>, key: string) => {
    for (const k of Object.keys(r)) if (k.toLowerCase().trim() === key) return (r[k] ?? "").trim();
    return "";
  };
  return rows.map((r) => ({
    conversationId: get(r, "conversation id"),
    from: get(r, "from"),
    fromUrl: normalizeLinkedin(get(r, "sender profile url"))?.norm ?? null,
    to: get(r, "to"),
    toUrl: pickFirstUrl(get(r, "recipient profile urls")),
    date: parseLinkedInDate(get(r, "date")),
    subject: get(r, "subject") || null,
    content: get(r, "content") || null,
  }));
}

export interface SelfIdentity {
  url: string | null;
  names: Set<string>;
}

/**
 * Identify "you" in the thread: the most frequent sender profile URL is you (you send the
 * most messages from your own export).
 */
export function detectSelf(messages: LinkedInMessage[]): SelfIdentity {
  const counts = new Map<string, number>();
  for (const m of messages) if (m.fromUrl) counts.set(m.fromUrl, (counts.get(m.fromUrl) ?? 0) + 1);
  let topUrl: string | null = null;
  let top = 0;
  for (const [url, n] of counts) if (n > top) ((top = n), (topUrl = url));

  const names = new Set<string>();
  if (topUrl) for (const m of messages) if (m.fromUrl === topUrl && m.from) names.add(m.from);
  return { url: topUrl, names };
}

export interface LinkedInMsgRow {
  externalId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  occurredAt: Date | null;
  counterpartName: string;
  counterpartLinkedin: string;
  subject: string | null;
  snippet: string | null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Build an insertable row from one message. Returns null when the counterpart can't be
 * attributed (anonymized "LinkedIn Member" / no profile URL) or there's no usable content.
 */
export function buildMessageRow(m: LinkedInMessage, self: SelfIdentity): LinkedInMsgRow | null {
  const isOutbound = (!!m.fromUrl && m.fromUrl === self.url) || self.names.has(m.from);
  const counterpartLinkedin = isOutbound ? m.toUrl : m.fromUrl;
  const counterpartName = isOutbound ? m.to : m.from;
  if (!counterpartLinkedin || counterpartName === "LinkedIn Member" || !counterpartName) return null;
  if (counterpartLinkedin === self.url) return null; // note-to-self / odd row

  const body = collapse(m.content ?? "") || collapse(m.subject ?? "");
  if (!body) return null;
  const snippet = body.slice(0, SNIPPET_MAX);

  const stamp = m.date ? m.date.toISOString() : "nodate";
  const hash = createHash("sha1").update(`${m.content ?? ""}`).digest("hex").slice(0, 8);
  const externalId = `linkedin-msg:${m.conversationId}:${stamp}:${hash}`;

  return {
    externalId,
    conversationId: m.conversationId,
    direction: isOutbound ? "outbound" : "inbound",
    occurredAt: m.date,
    counterpartName,
    counterpartLinkedin,
    subject: m.subject,
    snippet,
  };
}

// ── sync ─────────────────────────────────────────────────────────────────────

/** Resolve the export path to { connections, messages } file paths (folder or single file). */
function resolveInputs(input: string): { connections: string | null; messages: string | null } {
  const p = resolve(input);
  if (statSync(p).isDirectory()) {
    const conn = join(p, "Connections.csv");
    const msg = join(p, "messages.csv");
    return {
      connections: existsSync(conn) ? conn : null,
      messages: existsSync(msg) ? msg : null,
    };
  }
  if (/messages\.csv$/i.test(basename(p))) return { connections: null, messages: p };
  return { connections: p, messages: null };
}

export async function syncLinkedin(deps: ConnectorDeps, exportPath: string): Promise<SyncReport> {
  const { db } = deps;
  const report: SyncReport = { source: "linkedin", ingested: 0, skipped: 0, created: 0 };
  if (!exportPath || !existsSync(exportPath)) return { ...report, error: "not-found" };

  let matched = 0;
  let attempted = 0;

  try {
    const { connections: connPath, messages: msgPath } = resolveInputs(exportPath);
    if (!connPath && !msgPath) return { ...report, error: "no-csv-found" };

    // 1. Connections → person (+ linkedin/email aliases) + a 'mutual' connection interaction.
    if (connPath) {
      for (const c of parseConnectionsCsv(readFileSync(connPath, "utf8"))) {
        if (c.fullName === "LinkedIn Member") {
          report.skipped++; // anonymized — unattributable
          continue;
        }
        const linkedin = normalizeLinkedin(c.url);
        const email = normalizeEmail(c.email);
        const iso = normalizeDate(c.connectedOn);

        attempted++;
        const res = resolveHandle(db, {
          linkedin: c.url,
          email: c.email,
          name: c.fullName,
          org: c.company,
        });
        let personId: number;
        if (res.status === "matched" && res.personId) {
          personId = res.personId;
          matched++;
          // Backfill org/role when empty (ported from applyLinkedinToMatched).
          db.prepare(
            `UPDATE person SET
               org = COALESCE(org, ?), role = COALESCE(role, ?), updated_at = datetime('now')
             WHERE id = ? AND (org IS NULL OR role IS NULL)`
          ).run(c.company, c.position, personId);
        } else if (res.status === "ambiguous") {
          report.skipped++; // never auto-pick between candidates
          continue;
        } else {
          personId = createPerson(db, { displayName: c.fullName, org: c.company, role: c.position });
          report.created++;
          matched++;
        }
        if (linkedin) addAlias(db, personId, "linkedin", linkedin.norm, "linkedin");
        if (email) addAlias(db, personId, "email", email.norm, "linkedin");

        const externalId = linkedin ? `conn:${linkedin.norm}` : `conn:${c.fullName}|${iso ?? "?"}`;
        const inserted = insertInteraction(db, {
          personId,
          channel: "linkedin",
          direction: "mutual",
          occurredAt: iso ? `${iso}T00:00:00.000Z` : null,
          subject: "LinkedIn connection",
          externalId,
        });
        if (inserted) report.ingested++;
        else report.skipped++; // already imported — idempotent
      }
    }

    // 2. Messages → interactions attributed by profile-URL alias (no person creation here;
    //    connections above already created aliases for everyone attributable).
    if (msgPath) {
      const messages = parseMessagesCsv(readFileSync(msgPath, "utf8"));
      const self = detectSelf(messages);
      for (const m of messages) {
        const row = buildMessageRow(m, self);
        if (!row) {
          report.skipped++; // LinkedIn Member / no URL / empty content
          continue;
        }
        attempted++;
        const res = resolveHandle(db, { linkedin: row.counterpartLinkedin, name: row.counterpartName });
        if (res.status !== "matched" || !res.personId) {
          report.skipped++;
          continue;
        }
        matched++;
        const inserted = insertInteraction(db, {
          personId: res.personId,
          channel: "linkedin",
          direction: row.direction,
          occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
          subject: row.subject,
          bodySummary: row.snippet,
          externalId: row.externalId,
          threadExternalId: row.conversationId || null,
        });
        if (inserted) report.ingested++;
        else report.skipped++;
      }
    }
  } catch (e) {
    return { ...report, resolvedPct: resolvedPct(matched, attempted), error: (e as Error).message };
  }

  report.resolvedPct = resolvedPct(matched, attempted);
  return report;
}
