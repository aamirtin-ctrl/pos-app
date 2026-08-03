// Mail-export connector — ingests a user-provided mailbox export (.mbox / .eml / folder).
// Ported from PersonalCRM2 connectors/mailfile.ts; adapted to the no-staging architecture
// (resolve inline, write directly to `interaction`). For mailboxes we can't read via API —
// gated Microsoft 365 tenants, iCloud mail — the user exports mail to a file and this
// parses it. Only ever reads the export file; never touches a live mailbox. Stores a
// ≤200-char snippet, never the full body. Idempotent via UNIQUE(channel, external_id)
// keyed on the Message-ID (content hash fallback).
//
// Direction: setting 'mailfile_user_email' (comma-separated addresses), falling back to
// the GMAIL_USER secret. Unknown self → everything is inbound.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { simpleParser, type ParsedMail } from "mailparser";
import { getSetting } from "../db/db.ts";
import { normalizeEmail } from "../crm/normalize.ts";
import { resolveHandle } from "../crm/identity.ts";
import { isAutomatedSender } from "./email-utils.ts";
import {
  type ConnectorDeps,
  type SyncReport,
  insertInteraction,
  resolvedPct,
  SNIPPET_MAX,
} from "./common.ts";

export interface ParsedMessage {
  fromName: string | null;
  fromEmail: string | null;
  toName: string | null;
  toEmail: string | null;
  subject: string | null;
  date: Date | null;
  messageId: string | null;
  text: string | null;
}

export interface MailRow {
  externalId: string;
  direction: "inbound" | "outbound";
  occurredAt: Date | null;
  counterpartEmail: string | null;
  counterpartName: string | null;
  subject: string | null;
  snippet: string | null;
}

/**
 * Split an mbox file into individual RFC822 messages. Each message begins with an mbox
 * "From " separator line (`From sender <weekday month ... year>`); we drop that line and
 * keep the message that follows. A non-mbox single message (no separators) yields one chunk.
 */
export function splitMbox(raw: string): string[] {
  const sep = /^From .*\d{4}/; // mbox From_ line ends with a 4-digit year
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (sep.test(line)) {
      if (cur) out.push(cur.join("\n"));
      cur = []; // start a fresh message, discarding the separator line itself
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push(cur.join("\n"));
  return out.map((m) => m.trim()).filter((m) => m.length > 0);
}

function messagesFromFile(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".eml") return [raw];
  if (extname(path).toLowerCase() === ".mbox" || /^From .*\d{4}/m.test(raw)) {
    const parts = splitMbox(raw);
    return parts.length ? parts : [raw];
  }
  return [raw];
}

function gatherMessages(inputPath: string): string[] {
  if (statSync(inputPath).isDirectory()) {
    const out: string[] = [];
    for (const f of readdirSync(inputPath).sort()) {
      const lower = f.toLowerCase();
      if (lower.endsWith(".eml") || lower.endsWith(".mbox")) {
        out.push(...messagesFromFile(join(inputPath, f)));
      }
    }
    return out;
  }
  return messagesFromFile(inputPath);
}

/** Flatten mailparser's address shape (AddressObject | AddressObject[]) to the first address. */
function firstAddress(
  a: ParsedMail["from"] | ParsedMail["to"]
): { name: string | null; email: string | null } {
  const obj = Array.isArray(a) ? a[0] : a;
  const v = obj?.value?.[0];
  return { name: v?.name?.trim() || null, email: v?.address ? v.address.toLowerCase() : null };
}

export function normalizeParsed(parsed: ParsedMail): ParsedMessage {
  const from = firstAddress(parsed.from);
  const to = firstAddress(parsed.to);
  return {
    fromName: from.name,
    fromEmail: from.email,
    toName: to.name,
    toEmail: to.email,
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    messageId: parsed.messageId ?? null,
    text: parsed.text ?? null,
  };
}

/**
 * Map a parsed message to an insertable row, or null if it should be skipped (automated
 * sender). `selfSet` holds the user's own lowercased addresses; a message FROM one of
 * them is outbound. `fallbackId` is used when there's no Message-ID.
 */
export function buildRow(msg: ParsedMessage, selfSet: Set<string>, fallbackId: string): MailRow | null {
  const outbound = !!msg.fromEmail && selfSet.has(msg.fromEmail);
  const cpName = outbound ? msg.toName : msg.fromName;
  const cpEmail = outbound ? msg.toEmail : msg.fromEmail;
  if (isAutomatedSender(cpEmail)) return null;

  const norm = normalizeEmail(cpEmail);
  const text = msg.text ? msg.text.replace(/\s+/g, " ").trim() : "";
  return {
    externalId: msg.messageId ?? fallbackId,
    direction: outbound ? "outbound" : "inbound",
    occurredAt: msg.date,
    counterpartEmail: norm ? norm.norm : cpEmail,
    counterpartName: cpName,
    subject: msg.subject,
    snippet: text ? text.slice(0, SNIPPET_MAX) : null,
  };
}

export async function syncMailfile(deps: ConnectorDeps, filePath: string): Promise<SyncReport> {
  const { db, secrets } = deps;
  const report: SyncReport = { source: "mailfile", ingested: 0, skipped: 0, created: 0 };
  if (!filePath || !existsSync(filePath)) return { ...report, error: "not-found" };

  // Self addresses: setting 'mailfile_user_email' (comma-separated) → GMAIL_USER fallback.
  const selfRaw = getSetting(db, "mailfile_user_email") ?? secrets.get("GMAIL_USER") ?? "";
  const selfSet = new Set(
    selfRaw
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  let matched = 0;
  let attempted = 0;

  try {
    for (const raw of gatherMessages(filePath)) {
      const parsed = await simpleParser(raw);
      const msg = normalizeParsed(parsed);
      const fallbackId = `mailfile:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
      const row = buildRow(msg, selfSet, fallbackId);
      if (!row || !row.counterpartEmail) {
        report.skipped++; // automated sender / no usable counterpart
        continue;
      }

      attempted++;
      const res = resolveHandle(db, { email: row.counterpartEmail, name: row.counterpartName });
      if (res.status !== "matched" || !res.personId) {
        report.skipped++; // unmatched/ambiguous → no person, no row
        continue;
      }
      matched++;

      const inserted = insertInteraction(db, {
        personId: res.personId,
        channel: "mailfile",
        direction: row.direction,
        occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
        subject: row.subject,
        bodySummary: row.snippet,
        externalId: row.externalId,
      });
      if (inserted) report.ingested++;
      else report.skipped++; // already ingested — idempotent
    }
  } catch (e) {
    return { ...report, resolvedPct: resolvedPct(matched, attempted), error: (e as Error).message };
  }

  report.resolvedPct = resolvedPct(matched, attempted);
  return report;
}
