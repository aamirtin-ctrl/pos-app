// Unified-inbox tests — pure/DB only. No network, no osascript: SMTP mapping and
// AppleScript escaping are tested as exported helpers, and sendEmail runs against
// an injected transport.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  listInbox,
  isTapback,
  DEFAULT_CONVERSATION_LIMIT,
  personHandles,
  escapeAppleScript,
  iMessageScript,
  iMessageChatScript,
  smtpConfigFor,
  sendEmail,
  findReplyTarget,
  normalizeMessageId,
  type MailTransport,
} from "../main/messaging.ts";
import { deletePerson } from "../main/crm/people.ts";
import { bulkContactCandidates, purgeBulkContacts } from "../main/crm/review.ts";

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
  o: {
    channel?: string;
    direction: string;
    occurredAt: string;
    subject?: string | null;
    body?: string | null;
    threadExternalId?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id, thread_external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        personId,
        o.channel ?? "gmail",
        o.direction,
        o.occurredAt,
        o.subject ?? null,
        o.body ?? null,
        `ext-${Math.random().toString(36).slice(2)}`,
        o.threadExternalId ?? null
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

  it("collapses a person's messages into one conversation and respects the limit option", () => {
    const p = addPerson("Many");
    for (let i = 0; i < 6; i++) {
      addInteraction(p, { direction: "inbound", occurredAt: `2026-08-01T0${i}:00:00Z`, body: `m${i}` });
    }
    // one 1:1 conversation, represented by the newest inbound
    const collapsed = listInbox(db);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].body_summary).toBe("m5");
    // limit counts CONVERSATIONS, not scanned rows: the 6-message thread is one of them
    for (const name of ["P2", "P3", "P4"]) {
      addInteraction(addPerson(name), { direction: "inbound", occurredAt: "2026-08-02T10:00:00Z", body: "hi" });
    }
    expect(listInbox(db, { limit: 3 })).toHaveLength(3);
    expect(listInbox(db)).toHaveLength(4);
  });
});

// The bug the owner reported: "texts from friends who ARE in my contacts don't show up".
// The old query LIMITed the scanned inbound ROWS and did unanswered-first ordering in SQL,
// so (a) chatty threads ate the whole budget and (b) anything he had already replied to
// sorted behind every unanswered row in 30k interactions and fell off the end.
describe("listInbox is conversation-complete", () => {
  function seedOneChattyThreadAndFiveQuietPeople() {
    const chatty = addPerson("Chatty");
    for (let i = 0; i < 30; i++) {
      addInteraction(chatty, {
        channel: "imessage", direction: "inbound",
        occurredAt: `2026-08-04T12:${String(i).padStart(2, "0")}:00Z`, body: `spam ${i}`,
      });
    }
    const quiet = ["Ada", "Bob", "Cleo", "Dee", "Eli"];
    quiet.forEach((name, i) => {
      const p = addPerson(name);
      addInteraction(p, {
        channel: "imessage", direction: "inbound",
        occurredAt: `2026-08-03T09:0${i}:00Z`, body: "hey",
      });
      // Two of them he already replied to — under the old ordering these were the first
      // conversations to vanish, which is exactly the "my friends aren't there" complaint.
      if (i < 2) {
        addInteraction(p, {
          channel: "imessage", direction: "outbound",
          occurredAt: `2026-08-03T10:0${i}:00Z`, body: "replied from my phone",
        });
      }
    });
    return { chatty, quiet };
  }

  it("shows all 6 conversations when one thread has 30 inbound and five people have one each", () => {
    const { quiet } = seedOneChattyThreadAndFiveQuietPeople();
    const names = listInbox(db).map((i) => i.person_name).sort();
    expect(names).toEqual([...quiet, "Chatty"].sort());
    // exactly once each — the 30-message thread collapses to a single row
    expect(new Set(names).size).toBe(6);
  });

  it("cuts by conversation, not by message: limit 6 still yields all 6", () => {
    seedOneChattyThreadAndFiveQuietPeople();
    expect(listInbox(db, { limit: 6 })).toHaveLength(6);
  });

  it("keeps answered-but-recent conversations in the list, sorted after the unanswered ones", () => {
    seedOneChattyThreadAndFiveQuietPeople();
    const items = listInbox(db);
    const answered = items.filter((i) => i.unanswered === 0).map((i) => i.person_name);
    expect(answered.sort()).toEqual(["Ada", "Bob"]);
    // unanswered-first is a SORT, not a filter
    expect(items.slice(0, 4).every((i) => i.unanswered === 1)).toBe(true);
    expect(items.slice(-2).every((i) => i.unanswered === 0)).toBe(true);
  });

  it("defaults to 60 conversations", () => {
    expect(DEFAULT_CONVERSATION_LIMIT).toBe(60);
    for (let i = 0; i < 70; i++) {
      addInteraction(addPerson(`P${i}`), {
        channel: "imessage", direction: "inbound",
        occurredAt: `2026-08-0${(i % 4) + 1}T10:${String(i % 60).padStart(2, "0")}:00Z`, body: "hi",
      });
    }
    expect(listInbox(db)).toHaveLength(60);
  });
});

describe("tapbacks never headline a conversation", () => {
  it("recognizes the tapback text shapes and nothing else", () => {
    for (const t of [
      'Liked "Preciate the support shmear"',
      'You liked "Preciate the support shmear"',
      'Loved “dinner at 8”',
      'Laughed at "lol"',
      'Emphasized "yes"',
      'Questioned "really?"',
      'Disliked "nope"',
      'Removed a heart from "hi"',
    ]) {
      expect(isTapback(t)).toBe(true);
    }
    for (const t of [null, "", "I liked your post", 'she loved "it"', "Liked it", "Loved the show"]) {
      expect(isTapback(t)).toBe(false);
    }
  });

  it("picks the newest NON-tapback message as the representative", () => {
    const p = addPerson("Reacty");
    addInteraction(p, {
      channel: "imessage", direction: "inbound",
      occurredAt: "2026-08-01T10:00:00Z", body: "Preciate the support shmear",
    });
    addInteraction(p, {
      channel: "imessage", direction: "inbound",
      occurredAt: "2026-08-01T11:00:00Z", body: 'Liked "Preciate the support shmear"',
    });
    const [item] = listInbox(db);
    expect(item.body_summary).toBe("Preciate the support shmear");
    // the tapback row is NOT deleted — it just can't be the headline
    expect(item.thread).toHaveLength(2);
  });

  it("falls back to the tapback when it is the only inbound there is", () => {
    const p = addPerson("OnlyReacts");
    addInteraction(p, {
      channel: "imessage", direction: "inbound",
      occurredAt: "2026-08-01T11:00:00Z", body: 'Loved "the deck"',
    });
    const [item] = listInbox(db);
    expect(item.person_name).toBe("OnlyReacts");
    expect(item.body_summary).toBe('Loved "the deck"');
  });

  it("does not let a chatty tapback tail hide the conversation itself", () => {
    const p = addPerson("Tappy");
    addInteraction(p, {
      channel: "imessage", direction: "inbound",
      occurredAt: "2026-08-01T09:00:00Z", body: "are we still on for friday?",
    });
    for (let i = 0; i < 5; i++) {
      addInteraction(p, {
        channel: "imessage", direction: "inbound",
        occurredAt: `2026-08-01T1${i}:00:00Z`, body: `Liked "message ${i}"`,
      });
    }
    const [item] = listInbox(db);
    expect(item.body_summary).toBe("are we still on for friday?");
  });
});

// Deletion is a ✕ click and nothing else. The bulk-mail purge is the only automatic
// delete in the app, so it is the one that has to prove it can't touch a texter.
describe("purgeBulkContacts never removes someone he has texted with", () => {
  function addUnverified(name: string): number {
    const id = addPerson(name);
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (?, 'unverified')").run(id);
    return id;
  }

  it("still purges an inbound-mail-only newsletter contact", () => {
    const nyt = addUnverified("NYT Newsletters");
    addInteraction(nyt, { channel: "gmail", direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", subject: "Your daily digest" });
    expect(bulkContactCandidates(db).map((c) => c.id)).toEqual([nyt]);
    expect(purgeBulkContacts(db)).toBe(1);
  });

  it("spares the identical contact the moment ONE iMessage interaction exists", () => {
    const nyt = addUnverified("NYT Newsletters");
    addInteraction(nyt, { channel: "gmail", direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", subject: "Your daily digest" });
    addInteraction(nyt, { channel: "imessage", direction: "inbound", occurredAt: "2026-08-02T10:00:00Z", body: "hey it's me" });

    expect(bulkContactCandidates(db)).toEqual([]);
    expect(purgeBulkContacts(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM person WHERE id = ?").get(nyt)).toEqual({ n: 1 });
  });

  it("spares an unverified auto-created texter with a handle-shaped name", () => {
    const unknown = addUnverified("+15551234567");
    addInteraction(unknown, { channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", body: "yo" });
    expect(purgeBulkContacts(db)).toBe(0);
    expect(listInbox(db).map((i) => i.person_name)).toEqual(["+15551234567"]);
  });

  it("spares an outbound-only iMessage relationship too", () => {
    const friend = addUnverified("Newsletter Bot");
    addInteraction(friend, { channel: "imessage", direction: "outbound", occurredAt: "2026-08-01T10:00:00Z", body: "hi" });
    expect(purgeBulkContacts(db)).toBe(0);
  });
});

describe("listInbox group threading", () => {
  const GUID = "iMessage;+;chat123";

  function seedGroupAndOneToOne() {
    const ada = addPerson("Ada");
    const bob = addPerson("Bob");
    const cleo = addPerson("Cleo");
    // 3-sender group chat: same thread_external_id, subject carries the chat name
    addInteraction(ada, {
      channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T09:00:00Z",
      body: "who's in?", threadExternalId: GUID, subject: "Ski Trip",
    });
    addInteraction(bob, {
      channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T10:00:00Z",
      body: "me", threadExternalId: GUID, subject: "Ski Trip",
    });
    addInteraction(cleo, {
      channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T11:00:00Z",
      body: "same", threadExternalId: GUID, subject: null, // renamed rows can lack a subject
    });
    // 1:1 with one of the same senders, no thread_external_id
    addInteraction(ada, {
      channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T12:00:00Z", body: "just us",
    });
    return { ada, bob, cleo };
  }

  it("returns one conversation per key: the group collapses to a single row, the 1:1 stays separate", () => {
    const { ada, cleo } = seedGroupAndOneToOne();
    const items = listInbox(db);
    expect(items).toHaveLength(2);
    const keys = items.map((i) => i.thread_key).sort();
    expect(keys).toEqual([`chat:${GUID}`, `person:${ada}`]);
    const group = items.find((i) => i.thread_key === `chat:${GUID}`)!;
    // newest inbound (Cleo's) represents the group conversation
    expect(group.person_id).toBe(cleo);
    expect(group.is_group).toBe(1);
    expect(group.thread_external_id).toBe(GUID);
  });

  it("titles the group from the most recent non-null subject in the thread", () => {
    seedGroupAndOneToOne();
    const group = listInbox(db).find((i) => i.is_group === 1)!;
    expect(group.group_name).toBe("Ski Trip");
  });

  it("falls back to 'Group chat' when no row in the thread carries a subject", () => {
    const p = addPerson("Solo");
    addInteraction(p, {
      channel: "imessage", direction: "inbound", occurredAt: "2026-08-01T09:00:00Z",
      body: "hi", threadExternalId: "iMessage;+;noname", subject: null,
    });
    const group = listInbox(db).find((i) => i.is_group === 1)!;
    expect(group.group_name).toBe("Group chat");
  });

  it("threads the group by chat guid with per-message sender_name, across all senders", () => {
    seedGroupAndOneToOne();
    const group = listInbox(db).find((i) => i.is_group === 1)!;
    expect(group.thread.map((m) => m.sender_name)).toEqual(["Ada", "Bob", "Cleo"]);
    expect(group.thread.map((m) => m.body_summary)).toEqual(["who's in?", "me", "same"]);
  });

  it("keeps the 1:1 conversation in today's shape: is_group 0, threaded by person only", () => {
    const { ada } = seedGroupAndOneToOne();
    const solo = listInbox(db).find((i) => i.thread_key === `person:${ada}`)!;
    expect(solo.is_group).toBe(0);
    expect(solo.group_name).toBeNull();
    expect(solo.thread_external_id).toBeNull();
    expect(solo.person_name).toBe("Ada");
    // Ada's 1:1 thread excludes her group messages
    expect(solo.thread).toHaveLength(1);
    expect(solo.thread[0].body_summary).toBe("just us");
    expect(solo.thread[0].sender_name).toBe("Ada");
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

describe("iMessageChatScript", () => {
  it("targets the chat by id instead of a participant", () => {
    const script = iMessageChatScript("iMessage;+;chat123", "hello all");
    expect(script).toBe(
      'tell application "Messages" to send "hello all" to chat id "iMessage;+;chat123"'
    );
  });

  it("escapes the body and the guid with the same rules as the 1:1 script", () => {
    const script = iMessageChatScript('guid"with\\quirks', 'line1\nhe said "sure" \\ done');
    expect(script).not.toMatch(/\n/);
    expect(script).toContain('send "line1\\nhe said \\"sure\\" \\\\ done"');
    expect(script).toContain('to chat id "guid\\"with\\\\quirks"');
  });
});

describe("people.delete (IPC shape)", () => {
  // Mirrors the ipc.ts wrapper: throws → { ok: false, error }, results → { ok: true, data }.
  const h =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    async (...args: A) => {
      try {
        return { ok: true as const, data: await fn(...args) };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    };
  const del = h((id: number) => ({ deleted: deletePerson(db, id) }));

  const count = (table: string, personId: number | null): number =>
    (
      db
        .prepare(
          personId === null
            ? `SELECT COUNT(*) AS n FROM ${table} WHERE person_id IS NULL`
            : `SELECT COUNT(*) AS n FROM ${table} WHERE person_id = ?`
        )
        .get(...(personId === null ? [] : [personId])) as { n: number }
    ).n;

  it("cascades interactions and aliases; commitments survive with person_id NULL", async () => {
    const p = addPerson("Doomed");
    const other = addPerson("Bystander");
    const inbound = addInteraction(p, { direction: "inbound", occurredAt: "2026-08-01T10:00:00Z", body: "hi" });
    addInteraction(p, { direction: "outbound", occurredAt: "2026-08-01T11:00:00Z", body: "yo" });
    addDraft(inbound, p, "drafted reply");
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'email', 'doomed@x.com')").run(p);
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'phone', '+15551234567')").run(p);
    db.prepare("INSERT INTO commitment (person_id, description) VALUES (?, 'send the deck')").run(p);
    addInteraction(other, { direction: "inbound", occurredAt: "2026-08-01T12:00:00Z", body: "unrelated" });

    expect(count("interaction", p)).toBe(2);
    expect(count("alias", p)).toBe(2);

    const res = await del(p);
    expect(res).toEqual({ ok: true, data: { deleted: true } });

    expect(db.prepare("SELECT COUNT(*) AS n FROM person WHERE id = ?").get(p)).toEqual({ n: 0 });
    expect(count("interaction", p)).toBe(0);
    expect(count("alias", p)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM draft").get() as { n: number }).n).toBe(0);
    // commitment row survives, person ref nulled
    const c = db.prepare("SELECT person_id, description FROM commitment").all();
    expect(c).toEqual([{ person_id: null, description: "send the deck" }]);
    // bystander untouched
    expect(count("interaction", other)).toBe(1);
    expect(listInbox(db).map((i) => i.person_name)).toEqual(["Bystander"]);
  });

  it("reports deleted: false for an unknown id", async () => {
    const res = await del(99999);
    expect(res).toEqual({ ok: true, data: { deleted: false } });
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

describe("normalizeMessageId", () => {
  it("adds angle brackets and trims, idempotently", () => {
    expect(normalizeMessageId("abc123@mail.gmail.com")).toBe("<abc123@mail.gmail.com>");
    expect(normalizeMessageId("<abc123@mail.gmail.com>")).toBe("<abc123@mail.gmail.com>");
    expect(normalizeMessageId("  <<abc123@mail.gmail.com>>  ")).toBe("<abc123@mail.gmail.com>");
  });

  it("rejects values that are not Message-IDs", () => {
    for (const bad of [null, undefined, "", "   ", "sent:1754390000000", "gmail:INBOX:42",
      "iMessage;+;chat123", "no-at-sign", "two@ats@x.com", "user@localhost", "has space@x.com"]) {
      expect(normalizeMessageId(bad)).toBeNull();
    }
  });
});

describe("sendEmail reply threading", () => {
  const secrets = {
    get: (k: string) =>
      k === "MAIL_ACCOUNTS"
        ? JSON.stringify([
            { id: "a1", provider: "gmail", user: "me@gmail.com", password: "app-pw", host: "imap.gmail.com", port: 993 },
          ])
        : null,
    set: () => {},
    delete: () => {},
  };

  /** Capture the options handed to nodemailer instead of connecting to SMTP. */
  function captureTransport() {
    const sent: Record<string, unknown>[] = [];
    const deps = {
      createTransport: (): MailTransport => ({
        sendMail: async (opts: Record<string, unknown>) => {
          sent.push(opts);
          return { messageId: "<outbound-1@mail.gmail.com>" };
        },
      }),
    };
    return { sent, deps };
  }

  function addInbound(
    personId: number,
    externalId: string | null,
    o: { channel?: string; occurredAt?: string; threadExternalId?: string | null } = {}
  ): void {
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id, thread_external_id)
       VALUES (?, ?, 'inbound', ?, 'Coffee?', 'free thursday?', ?, ?)`
    ).run(
      personId,
      o.channel ?? "gmail",
      o.occurredAt ?? "2026-08-01T10:00:00Z",
      externalId,
      o.threadExternalId ?? null
    );
  }

  const send = (personId: number, deps: { createTransport: () => MailTransport }, extra: Record<string, unknown> = {}) =>
    sendEmail(db, secrets, { personId, to: "ada@x.com", subject: "Re: Coffee?", body: "Thursday works", ...extra }, deps);

  it("derives inReplyTo/references from the person's most recent inbound message", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<older@mail.gmail.com>", { occurredAt: "2026-07-01T10:00:00Z" });
    addInbound(p, "<newest@mail.gmail.com>", { occurredAt: "2026-08-01T10:00:00Z" });
    const { sent, deps } = captureTransport();

    const res = await send(p, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].inReplyTo).toBe("<newest@mail.gmail.com>");
    expect(sent[0].references).toBe("<newest@mail.gmail.com>");
    expect(res.inReplyTo).toBe("<newest@mail.gmail.com>");

    // POS threads the conversation itself via the outbound row.
    const out = db
      .prepare("SELECT thread_external_id FROM interaction WHERE direction = 'outbound'")
      .get() as { thread_external_id: string | null };
    expect(out.thread_external_id).toBe("<newest@mail.gmail.com>");
  });

  it("normalizes a bare Message-ID on the inbound row to angle brackets", async () => {
    const p = addPerson("Ada");
    addInbound(p, "bare-id@mail.gmail.com");
    const { sent, deps } = captureTransport();
    await send(p, deps);
    expect(sent[0].inReplyTo).toBe("<bare-id@mail.gmail.com>");
    expect(sent[0].references).toBe("<bare-id@mail.gmail.com>");
  });

  it("puts the thread root first in References and uses it as thread_external_id", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<reply-3@mail.gmail.com>", { threadExternalId: "<root-1@mail.gmail.com>" });
    const { sent, deps } = captureTransport();
    await send(p, deps);
    expect(sent[0].references).toBe("<root-1@mail.gmail.com> <reply-3@mail.gmail.com>");
    expect(sent[0].inReplyTo).toBe("<reply-3@mail.gmail.com>");
    const out = db
      .prepare("SELECT thread_external_id FROM interaction WHERE direction = 'outbound'")
      .get() as { thread_external_id: string | null };
    expect(out.thread_external_id).toBe("<root-1@mail.gmail.com>");
  });

  it("sends no threading headers when there is no prior inbound message", async () => {
    const p = addPerson("Nobody");
    const { sent, deps } = captureTransport();
    const res = await send(p, deps);
    expect(sent[0]).not.toHaveProperty("inReplyTo");
    expect(sent[0]).not.toHaveProperty("references");
    expect(res.inReplyTo).toBeNull();
    const out = db
      .prepare("SELECT thread_external_id FROM interaction WHERE direction = 'outbound'")
      .get() as { thread_external_id: string | null };
    expect(out.thread_external_id).toBeNull();
  });

  it("sends no threading headers when the inbound external_id is not a Message-ID", async () => {
    const p = addPerson("Ada");
    addInbound(p, "gmail:INBOX:42");
    const { sent, deps } = captureTransport();
    await send(p, deps);
    expect(sent[0]).not.toHaveProperty("inReplyTo");
  });

  it("ignores inbound messages on non-email channels", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<im@mail.gmail.com>", { channel: "imessage" });
    expect(findReplyTarget(db, p)).toBeNull();
    const { sent, deps } = captureTransport();
    await send(p, deps);
    expect(sent[0]).not.toHaveProperty("inReplyTo");
  });

  it("prefers an explicit replyTo argument and normalizes its references chain", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<derived@mail.gmail.com>");
    const { sent, deps } = captureTransport();
    await send(p, deps, {
      replyTo: { messageId: "explicit@mail.gmail.com", references: "<root@mail.gmail.com> mid@mail.gmail.com" },
    });
    expect(sent[0].inReplyTo).toBe("<explicit@mail.gmail.com>");
    expect(sent[0].references).toBe("<root@mail.gmail.com> <mid@mail.gmail.com> <explicit@mail.gmail.com>");
  });

  it("replyTo: null forces a fresh thread even when a prior inbound exists", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<derived@mail.gmail.com>");
    const { sent, deps } = captureTransport();
    await send(p, deps, { replyTo: null });
    expect(sent[0]).not.toHaveProperty("inReplyTo");
  });

  it("keeps the threaded reply visible in the person's 1:1 inbox thread", async () => {
    const p = addPerson("Ada");
    addInbound(p, "<newest@mail.gmail.com>");
    const { deps } = captureTransport();
    await send(p, deps);
    const [item] = listInbox(db);
    expect(item.thread.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(item.answered).toBe(1);
  });
});
