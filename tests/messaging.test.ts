// Unified-inbox tests — pure/DB only. No network, no osascript: SMTP mapping and
// AppleScript escaping are tested as exported helpers.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  listInbox,
  personHandles,
  escapeAppleScript,
  iMessageScript,
  smtpConfigFor,
} from "../main/messaging.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-messaging-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string): number {
  return Number(db.prepare("INSERT INTO person (display_name) VALUES (?)").run(name).lastInsertRowid);
}
function addInteraction(
  personId: number,
  o: { channel?: string; direction: string; occurredAt: string; subject?: string | null; body?: string | null }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        personId,
        o.channel ?? "gmail",
        o.direction,
        o.occurredAt,
        o.subject ?? null,
        o.body ?? null,
        `ext-${Math.random().toString(36).slice(2)}`
      ).lastInsertRowid
  );
}
function addDraft(interactionId: number, personId: number, body: string, status = "suggested"): void {
  db.prepare(
    "INSERT INTO draft (interaction_id, person_id, channel, body, status) VALUES (?, ?, 'gmail', ?, ?)"
  ).run(interactionId, personId, body, status);
}

describe("listInbox", () => {
  it("returns inbound items with person info, draft flag/body, and a thread", () => {
    const p = addPerson("Ada");
    const inbound = addInteraction(p, {
      direction: "inbound", occurredAt: "2026-08-01T10:00:00Z",
      subject: "Coffee?", body: "Free Thursday?",
    });
    addDraft(inbound, p, "Thursday works — 10am?");

    const items = listInbox(db);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0).toMatchObject({
      person_id: p,
      person_name: "Ada",
      channel: "gmail",
      subject: "Coffee?",
      body_summary: "Free Thursday?",
      has_draft: 1,
      draft_body: "Thursday works — 10am?",
      answered: 0,
      unanswered: 1,
    });
    expect(it0.thread).toHaveLength(1);
    expect(it0.thread[0].direction).toBe("inbound");
  });

  it("excludes non-suggested drafts from has_draft", () => {
    const p = addPerson("Bob");
    const inbound = addInteraction(p, { direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", body: "hey" });
    addDraft(inbound, p, "old draft", "dismissed");
    const [item] = listInbox(db);
    expect(item.has_draft).toBe(0);
    expect(item.draft_body).toBeNull();
  });

  it("only returns inbound interactions, but threads carry both directions oldest-first", () => {
    const p = addPerson("Cleo");
    addInteraction(p, { direction: "inbound", occurredAt: "2026-08-01T09:00:00Z", body: "ping" });
    addInteraction(p, { direction: "outbound", occurredAt: "2026-08-01T10:00:00Z", body: "pong" });
    const items = listInbox(db);
    expect(items).toHaveLength(1); // the outbound row is not a top-level item
    expect(items[0].thread.map((t) => t.direction)).toEqual(["inbound", "outbound"]);
    expect(items[0].answered).toBe(1);
    expect(items[0].unanswered).toBe(0);
  });

  it("sorts unanswered first, then newest first", () => {
    const answered = addPerson("Answered-Newer");
    const iAns = addInteraction(answered, { direction: "inbound", occurredAt: "2026-08-03T10:00:00Z", body: "new but replied" });
    addInteraction(answered, { direction: "outbound", occurredAt: "2026-08-03T11:00:00Z", body: "my reply" });

    const unansweredOld = addPerson("Unanswered-Old");
    addInteraction(unansweredOld, { direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", body: "still waiting" });

    const unansweredNew = addPerson("Unanswered-New");
    addInteraction(unansweredNew, { direction: "inbound", occurredAt: "2026-08-02T10:00:00Z", body: "also waiting" });

    const names = listInbox(db).map((i) => i.person_name);
    expect(names).toEqual(["Unanswered-New", "Unanswered-Old", "Answered-Newer"]);

    // a suggested draft counts as unanswered even when a later outbound exists
    addDraft(iAns, answered, "drafted reply");
    const withDraft = listInbox(db);
    expect(withDraft[0].person_name).toBe("Answered-Newer");
    expect(withDraft[0].unanswered).toBe(1);
  });

  it("respects the limit option", () => {
    const p = addPerson("Many");
    for (let i = 0; i < 6; i++) {
      addInteraction(p, { direction: "inbound", occurredAt: `2026-08-01T0${i}:00:00Z`, body: `m${i}` });
    }
    expect(listInbox(db, { limit: 3 })).toHaveLength(3);
  });
});

describe("personHandles", () => {
  const alias = (personId: number, kind: string, value: string, primary = 0) =>
    db.prepare("INSERT INTO alias (person_id, kind, value, is_primary) VALUES (?, ?, ?, ?)")
      .run(personId, kind, value, primary);

  it("prefers the primary email over earlier non-primary ones", () => {
    const p = addPerson("Ada");
    alias(p, "email", "old@x.com");
    alias(p, "email", "main@x.com", 1);
    expect(personHandles(db, p).email).toBe("main@x.com");
  });

  it("prefers imessage_handle over phone, regardless of insert order", () => {
    const p = addPerson("Bob");
    alias(p, "phone", "+15551234567", 1);
    alias(p, "imessage_handle", "bob@icloud.com");
    expect(personHandles(db, p).imessage).toBe("bob@icloud.com");
  });

  it("falls back to phone for imessage, and returns nulls when nothing is on file", () => {
    const p = addPerson("Cleo");
    alias(p, "phone", "+15559876543");
    expect(personHandles(db, p)).toEqual({ email: null, imessage: "+15559876543" });
    const empty = addPerson("Nobody");
    expect(personHandles(db, empty)).toEqual({ email: null, imessage: null });
  });

  it("ignores non-address alias kinds (linkedin, slack_id)", () => {
    const p = addPerson("Dee");
    alias(p, "linkedin", "https://linkedin.com/in/dee");
    alias(p, "slack_id", "U123");
    expect(personHandles(db, p)).toEqual({ email: null, imessage: null });
  });
});

describe("escapeAppleScript", () => {
  it("escapes double quotes", () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
  });
  it("escapes backslashes before quotes (no double-escaping)", () => {
    expect(escapeAppleScript('c:\\path and a "q"')).toBe('c:\\\\path and a \\"q\\"');
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });
  it("converts newlines (LF, CR, CRLF) to \\n escapes", () => {
    expect(escapeAppleScript("a\nb\r\nc\rd")).toBe("a\\nb\\nc\\nd");
  });
  it("produces a script with no raw newlines or unescaped quotes", () => {
    const script = iMessageScript("+1555", 'line1\nhe said "sure" \\ done');
    expect(script).not.toMatch(/\n/);
    expect(script).toContain('send "line1\\nhe said \\"sure\\" \\\\ done"');
    expect(script).toContain('to participant "+1555"');
    expect(script).toContain('service type = iMessage');
  });
});

describe("smtpConfigFor", () => {
  it("maps gmail to smtp.gmail.com:465 implicit TLS", () => {
    expect(smtpConfigFor("gmail")).toEqual({ host: "smtp.gmail.com", port: 465, secure: true });
  });
  it("maps outlook to smtp-mail.outlook.com:587 STARTTLS", () => {
    expect(smtpConfigFor("outlook")).toEqual({ host: "smtp-mail.outlook.com", port: 587, secure: false });
  });
  it("maps icloud to smtp.mail.me.com:587 STARTTLS", () => {
    expect(smtpConfigFor("icloud")).toEqual({ host: "smtp.mail.me.com", port: 587, secure: false });
  });
  it("throws the typed error for custom imap providers", () => {
    expect(() => smtpConfigFor("imap")).toThrow(/^smtp_unsupported_provider$/);
  });
});
