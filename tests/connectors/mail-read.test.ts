// Mail read-state mirror + \Seen write-back + body fill (owner ask 2026-09-11), run against
// a FAKE IMAP client: no network. The fake records every call so the tests can prove the
// pass fetches only what it needs and flags only what it found.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  mirrorMailReadState,
  markSeenOnServer,
  mailBodyText,
  MAIL_BODY_MAX,
  type ImapReadClient,
  type ImapSession,
} from "../../main/connectors/mail-read.ts";
import type { MailAccount } from "../../main/connectors/gmail.ts";
import type { SecretStore } from "../../main/secrets.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-mailread-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (id, display_name) VALUES (1, 'Jane')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const iso = (agoDays: number) => new Date(Date.now() - agoDays * DAY).toISOString();

function addMail(o: { id: string; agoDays?: number; readAt?: string | null; bodyRaw?: string | null; direction?: string }) {
  db.prepare(
    `INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id, read_at, body_raw)
     VALUES (1, 'gmail', ?, ?, ?, ?, ?)`
  ).run(o.direction ?? "inbound", iso(o.agoDays ?? 1), o.id, o.readAt ?? null, o.bodyRaw ?? null);
}
const row = (id: string) =>
  db.prepare("SELECT read_at, body_raw FROM interaction WHERE external_id = ?").get(id) as {
    read_at: string | null;
    body_raw: string | null;
  };

/** A server message: uid + Message-ID + flags + a plain RFC822 source. */
type Srv = { uid: number; messageId: string; seen?: boolean; text?: string };

function fakeClient(server: Srv[]) {
  const calls: { search: unknown[]; fetch: { range: unknown; query: Record<string, unknown> }[]; flagged: { range: number[]; flags: string[] }[] } = {
    search: [], fetch: [], flagged: [],
  };
  const client: ImapReadClient = {
    async search(q) {
      calls.search.push(q);
      const header = (q as { header?: Record<string, string> }).header;
      if (header && header["message-id"]) {
        return server.filter((m) => m.messageId === header["message-id"]).map((m) => m.uid);
      }
      return server.map((m) => m.uid);
    },
    async *fetch(range, query) {
      calls.fetch.push({ range, query: query as Record<string, unknown> });
      const uids = Array.isArray(range) ? (range as number[]) : server.map((m) => m.uid);
      for (const m of server) {
        if (!uids.includes(m.uid)) continue;
        yield {
          uid: m.uid,
          ...(query.flags ? { flags: new Set(m.seen ? ["\\Seen"] : []) } : {}),
          ...(query.envelope ? { envelope: { messageId: m.messageId } } : {}),
          ...(query.source
            ? { source: Buffer.from(`Subject: x\r\nMessage-ID: ${m.messageId}\r\nContent-Type: text/plain\r\n\r\n${m.text ?? "body of " + m.uid}`) }
            : {}),
        };
      }
    },
    async messageFlagsAdd(range, flags) {
      calls.flagged.push({ range: range as number[], flags });
      return true;
    },
  };
  return { client, calls };
}

describe("mirrorMailReadState", () => {
  it("marks POS-unread rows the server shows as \\Seen, leaves unseen rows unread, fills missing bodies", async () => {
    addMail({ id: "<seen@x.com>" });
    addMail({ id: "<unseen@x.com>" });
    addMail({ id: "<has-body@x.com>", bodyRaw: "already here" });
    const { client, calls } = fakeClient([
      { uid: 1, messageId: "<seen@x.com>", seen: true, text: "hello from seen" },
      { uid: 2, messageId: "<unseen@x.com>", seen: false, text: "hello from unseen" },
      { uid: 3, messageId: "<has-body@x.com>", seen: true },
      { uid: 4, messageId: "<not-in-pos@x.com>", seen: true },
    ]);
    const r = await mirrorMailReadState(db, client);
    expect(r).toEqual({ markedRead: 2, bodiesFilled: 2 });
    expect(row("<seen@x.com>").read_at).not.toBeNull();
    expect(row("<seen@x.com>").body_raw).toBe("hello from seen");
    expect(row("<unseen@x.com>").read_at).toBeNull();
    expect(row("<unseen@x.com>").body_raw).toBe("hello from unseen");
    expect(row("<has-body@x.com>").body_raw).toBe("already here");
    // one Message-ID search per POS candidate (never for mail POS doesn't hold), ONE flags
    // fetch for the ones found, then ONE source fetch limited to the rows needing a body
    const searched = calls.search.map((q) => (q as { header: Record<string, string> }).header["message-id"]).sort();
    expect(searched).toEqual(["<has-body@x.com>", "<seen@x.com>", "<unseen@x.com>"]);
    expect(calls.fetch).toHaveLength(2);
    expect(calls.fetch[0].query).toMatchObject({ flags: true });
    expect((calls.fetch[0].range as number[]).sort()).toEqual([1, 2, 3]);
    expect(calls.fetch[1].query).toMatchObject({ source: true });
    expect(calls.fetch[1].range).toEqual([1, 2]);
  });

  it("skips candidates this mailbox does not hold (the other account's mail) without fetching", async () => {
    addMail({ id: "<elsewhere@x.com>" });
    const { client, calls } = fakeClient([{ uid: 1, messageId: "<other@x.com>", seen: true }]);
    const r = await mirrorMailReadState(db, client);
    expect(r).toEqual({ markedRead: 0, bodiesFilled: 0 });
    expect(calls.search).toHaveLength(1);
    expect(calls.fetch).toHaveLength(0);
    expect(row("<elsewhere@x.com>").read_at).toBeNull();
  });

  it("caps the number of Message-ID lookups per pass, newest first", async () => {
    addMail({ id: "<n1@x.com>", agoDays: 1 });
    addMail({ id: "<n2@x.com>", agoDays: 2 });
    addMail({ id: "<n3@x.com>", agoDays: 3 });
    const { client, calls } = fakeClient([]);
    await mirrorMailReadState(db, client, { candidateCap: 2 });
    expect(calls.search).toEqual([
      { header: { "message-id": "<n1@x.com>" } },
      { header: { "message-id": "<n2@x.com>" } },
    ]);
  });

  it("does nothing on the wire when every recent mail row is read and has a body", async () => {
    addMail({ id: "<done@x.com>", readAt: iso(0), bodyRaw: "b" });
    addMail({ id: "<old@x.com>", agoDays: 45 }); // outside the 30-day window
    const { client, calls } = fakeClient([{ uid: 1, messageId: "<done@x.com>", seen: true }]);
    const r = await mirrorMailReadState(db, client);
    expect(r).toEqual({ markedRead: 0, bodiesFilled: 0 });
    expect(calls.search).toHaveLength(0);
    expect(calls.fetch).toHaveLength(0);
  });

  it("never flips a row back to unread, and caps body fills per pass", async () => {
    addMail({ id: "<read-locally@x.com>", readAt: "2026-09-01T00:00:00.000Z" });
    addMail({ id: "<a@x.com>" });
    addMail({ id: "<b@x.com>" });
    const { client, calls } = fakeClient([
      { uid: 1, messageId: "<read-locally@x.com>", seen: false },
      { uid: 2, messageId: "<a@x.com>", seen: false },
      { uid: 3, messageId: "<b@x.com>", seen: false },
    ]);
    const r = await mirrorMailReadState(db, client, { bodyBatch: 2 });
    expect(row("<read-locally@x.com>").read_at).toBe("2026-09-01T00:00:00.000Z");
    expect(r.bodiesFilled).toBe(2);
    expect(calls.fetch[1].range).toHaveLength(2);
    const filled = [row("<read-locally@x.com>"), row("<a@x.com>"), row("<b@x.com>")].filter((x) => x.body_raw !== null);
    expect(filled).toHaveLength(2);
  });
});

describe("markSeenOnServer", () => {
  const accounts: MailAccount[] = [
    { id: "a1", provider: "gmail", user: "me@gmail.com", password: "p", host: "imap.gmail.com", port: 993 },
    { id: "a2", provider: "outlook", user: "me@outlook.com", password: "p", host: "outlook.office365.com", port: 993 },
  ];
  const secrets = {
    get: (k: string) => (k === "MAIL_ACCOUNTS" ? JSON.stringify(accounts) : null),
    set: () => {},
    delete: () => {},
  } as unknown as SecretStore;

  function session(server: Srv[]) {
    const { client, calls } = fakeClient(server);
    const life: string[] = [];
    const s: ImapSession = {
      ...client,
      async connect() { life.push("connect"); },
      async getMailboxLock() { life.push("lock"); return { release: () => life.push("release") }; },
      async logout() { life.push("logout"); },
    };
    return { s, calls, life };
  }

  it("searches each id by Message-ID header and adds \\Seen where found; stops once every id is found", async () => {
    const a1 = session([{ uid: 10, messageId: "<m1@x.com>" }, { uid: 11, messageId: "<m2@x.com>" }]);
    const a2 = session([{ uid: 99, messageId: "<m3@x.com>" }]);
    const opened: string[] = [];
    const r = await markSeenOnServer(secrets, ["<m1@x.com>", "<m2@x.com>"], async (acct) => {
      opened.push(acct.user);
      return acct.user === "me@gmail.com" ? a1.s : a2.s;
    });
    expect(r).toEqual({ flagged: 2 });
    expect(opened).toEqual(["me@gmail.com"]); // second account never opened
    expect(a1.calls.search).toEqual([
      { header: { "message-id": "<m1@x.com>" } },
      { header: { "message-id": "<m2@x.com>" } },
    ]);
    expect(a1.calls.flagged).toEqual([
      { range: [10], flags: ["\\Seen"] },
      { range: [11], flags: ["\\Seen"] },
    ]);
    expect(a1.life).toEqual(["connect", "lock", "release", "logout"]);
  });

  it("falls through to the next account for ids the first one does not have, and survives an account that throws", async () => {
    const a2 = session([{ uid: 5, messageId: "<m3@x.com>" }]);
    const r = await markSeenOnServer(secrets, ["<m3@x.com>"], async (acct) => {
      if (acct.user === "me@gmail.com") throw new Error("boom");
      return a2.s;
    });
    expect(r).toEqual({ flagged: 1 });
    expect(a2.calls.flagged).toEqual([{ range: [5], flags: ["\\Seen"] }]);
  });

  it("is a no-op with no ids", async () => {
    let opened = 0;
    const r = await markSeenOnServer(secrets, [], async () => { opened++; throw new Error("never"); });
    expect(r).toEqual({ flagged: 0 });
    expect(opened).toBe(0);
  });
});

describe("mailBodyText", () => {
  it("prefers the text part, falls back to stripped html, caps the length, nulls empties", () => {
    expect(mailBodyText({ text: "  plain\r\nbody  ", html: "<p>x</p>" })).toBe("plain\nbody");
    expect(mailBodyText({ text: "", html: "<p>Hi <b>there</b></p><br>bye" })).toBe("Hi there\n\nbye");
    expect(mailBodyText({ text: "", html: false })).toBeNull();
    expect(mailBodyText({ text: "x".repeat(MAIL_BODY_MAX + 10) })!.length).toBe(MAIL_BODY_MAX);
  });
});
