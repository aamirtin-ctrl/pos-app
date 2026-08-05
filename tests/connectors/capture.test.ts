// Morning-capture helpers — self-address matching (case-insensitive, +tag normalization),
// self-handle normalization, first-run 24h window math, the text cap, and the third-party
// sender allowlist (Alexa routines / IFTTT applets). The captureFromEmail cases run against
// a real tmpdir DB with the IMAP read injected: no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../../main/db/db.ts";
import { SecretStore } from "../../main/secrets.ts";
import { addMailAccount } from "../../main/connectors/gmail.ts";
import { isAutomatedSender } from "../../main/connectors/email-utils.ts";
import { isDigestMessage } from "../../main/digest.ts";
import {
  isSelfAddress,
  parseSelfHandles,
  matchesSelfHandle,
  captureWindowStart,
  captureText,
  captureFromEmail,
  captureSenderKind,
  parseAllowedSenders,
  stripRelayBoilerplate,
  unixMsToAppleNs,
  FIRST_RUN_MS,
  CAPTURE_MAX_CHARS,
  ALLOWED_SENDERS_KEY,
  type RawMailMessage,
} from "../../main/capture.ts";

describe("isSelfAddress", () => {
  it("matches the account's own address case-insensitively", () => {
    expect(isSelfAddress("Aamir@Gmail.com", "aamir@gmail.com")).toBe(true);
    expect(isSelfAddress("aamir@gmail.com", "AAMIR@GMAIL.COM")).toBe(true);
  });

  it("normalizes +tag aliases away on either side", () => {
    expect(isSelfAddress("aamir+notes@gmail.com", "aamir@gmail.com")).toBe(true);
    expect(isSelfAddress("aamir@gmail.com", "aamir+morning@gmail.com")).toBe(true);
  });

  it("rejects other people, other domains, and garbage", () => {
    expect(isSelfAddress("someoneelse@gmail.com", "aamir@gmail.com")).toBe(false);
    expect(isSelfAddress("aamir@icloud.com", "aamir@gmail.com")).toBe(false);
    expect(isSelfAddress("not-an-email", "aamir@gmail.com")).toBe(false);
    expect(isSelfAddress(null, "aamir@gmail.com")).toBe(false);
    expect(isSelfAddress("aamir@gmail.com", null)).toBe(false);
  });
});

describe("parseSelfHandles + matchesSelfHandle", () => {
  it("parses a comma-separated mix of phones and emails into normalized forms", () => {
    const set = parseSelfHandles(" +1 (214) 555-0100 , You@iCloud.com,, junk");
    expect(set.has("+12145550100")).toBe(true);
    expect(set.has("you@icloud.com")).toBe(true);
    expect(set.size).toBe(2); // "junk" is neither a phone nor an email — dropped
  });

  it("matches iMessage handles in any raw format against the set", () => {
    const set = parseSelfHandles("+1 (214) 555-0100, you@icloud.com");
    expect(matchesSelfHandle("+12145550100", set)).toBe(true);
    expect(matchesSelfHandle("2145550100", set)).toBe(true); // 10-digit US → +1…
    expect(matchesSelfHandle("You@icloud.com", set)).toBe(true);
    expect(matchesSelfHandle("you+x@icloud.com", set)).toBe(true); // +tag strips
  });

  it("rejects handles that aren't the user's own", () => {
    const set = parseSelfHandles("+12145550100");
    expect(matchesSelfHandle("+15551234567", set)).toBe(false);
    expect(matchesSelfHandle("other@icloud.com", set)).toBe(false);
    expect(matchesSelfHandle("", set)).toBe(false);
    expect(matchesSelfHandle(null, set)).toBe(false);
    expect(matchesSelfHandle("+12145550100", new Set())).toBe(false); // empty config
  });
});

describe("captureWindowStart (first-run 24h window math)", () => {
  const now = Date.parse("2026-08-04T09:00:00.000Z");

  it("first run (no cursor) → exactly now − 24h", () => {
    expect(captureWindowStart(null, now).toISOString()).toBe("2026-08-03T09:00:00.000Z");
    expect(captureWindowStart(undefined, now).getTime()).toBe(now - FIRST_RUN_MS);
  });

  it("a valid cursor wins over the 24h window", () => {
    expect(captureWindowStart("2026-08-01T12:00:00.000Z", now).toISOString()).toBe(
      "2026-08-01T12:00:00.000Z"
    );
  });

  it("an unparseable cursor falls back to the 24h window", () => {
    expect(captureWindowStart("not-a-date", now).getTime()).toBe(now - FIRST_RUN_MS);
  });
});

describe("unixMsToAppleNs", () => {
  it("converts Unix ms to Apple-epoch nanoseconds", () => {
    const appleEpochMs = 978307200000; // 2001-01-01T00:00:00Z
    expect(unixMsToAppleNs(appleEpochMs)).toBe(0n);
    expect(unixMsToAppleNs(appleEpochMs + 1000)).toBe(1_000_000_000n);
  });

  it("clamps pre-2001 times to zero instead of going negative", () => {
    expect(unixMsToAppleNs(0)).toBe(0n);
  });
});

describe("captureText", () => {
  it("combines subject + body and caps at CAPTURE_MAX_CHARS", () => {
    expect(captureText("Plan", "gym 1h, deep work 3h")).toBe("Plan\ngym 1h, deep work 3h");
    const long = "x".repeat(2000);
    expect(captureText(null, long)!.length).toBe(CAPTURE_MAX_CHARS);
  });

  it("returns null when the body is empty (message skipped)", () => {
    expect(captureText("Subject only", "")).toBeNull();
    expect(captureText("Subject only", "   \n ")).toBeNull();
    expect(captureText(null, null)).toBeNull();
  });

  it("falls back to the subject for relay mail with an empty/near-empty body", () => {
    expect(captureText("remind me to call the plumber", "", { subjectFallback: true })).toBe(
      "remind me to call the plumber"
    );
    expect(captureText("book gym at 6", "ok", { subjectFallback: true })).toBe("book gym at 6");
    // …but a real body still wins, and a subjectless empty relay mail is still nothing.
    expect(captureText("Alexa note", "call the plumber tomorrow", { subjectFallback: true })).toBe(
      "Alexa note\ncall the plumber tomorrow"
    );
    expect(captureText("", "", { subjectFallback: true })).toBeNull();
  });
});

describe("parseAllowedSenders + captureSenderKind", () => {
  it("parses a comma-separated list into normalized addresses, dropping junk", () => {
    const set = parseAllowedSenders(" Alexa@Amazon.com , action+tag@ifttt.com,, not-an-email ");
    expect([...set].sort()).toEqual(["action@ifttt.com", "alexa@amazon.com"]);
    expect(parseAllowedSenders(null).size).toBe(0);
    expect(parseAllowedSenders("").size).toBe(0);
  });

  it("classifies self mail, allowlisted relays, and everyone else", () => {
    const allowed = parseAllowedSenders("alexa@amazon.com");
    expect(captureSenderKind("aamir@gmail.com", "aamir@gmail.com", allowed)).toBe("self");
    expect(captureSenderKind("Alexa@Amazon.com", "aamir@gmail.com", allowed)).toBe("allowed");
    expect(captureSenderKind("stranger@example.com", "aamir@gmail.com", allowed)).toBeNull();
    // Self still matches with an empty allowlist (today's rule, unchanged).
    expect(captureSenderKind("aamir+notes@gmail.com", "aamir@gmail.com", new Set())).toBe("self");
  });

  it("an allowlisted sender outranks the automated-sender denylist", () => {
    expect(isAutomatedSender("no-reply@amazon.com")).toBe(true); // an Alexa relay looks automated
    const allowed = parseAllowedSenders("no-reply@amazon.com");
    expect(captureSenderKind("no-reply@amazon.com", "aamir@gmail.com", allowed)).toBe("allowed");
    // Not allowlisted → still nothing, automated or not.
    expect(captureSenderKind("no-reply@amazon.com", "aamir@gmail.com", new Set())).toBeNull();
  });
});

describe("stripRelayBoilerplate", () => {
  it("drops relay footers and signature blocks, keeps the message", () => {
    expect(
      stripRelayBoilerplate("call the plumber\n\nSent from my iPhone")
    ).toBe("call the plumber");
    expect(
      stripRelayBoilerplate("gym at 6\nThis email was sent by IFTTT\nUnsubscribe")
    ).toBe("gym at 6");
    expect(
      stripRelayBoilerplate("buy milk\n-- \nAamir\n+1 214 555 0100")
    ).toBe("buy milk");
    expect(
      stripRelayBoilerplate(
        "ship the deck\nThis message was sent from a notification-only address\nAmazon.com, Inc.\n© 2026"
      )
    ).toBe("ship the deck");
  });

  it("leaves ordinary text alone and reports nothing when only boilerplate is left", () => {
    expect(stripRelayBoilerplate("two lines\nof real notes")).toBe("two lines\nof real notes");
    expect(stripRelayBoilerplate("Sent from your Alexa device")).toBe("");
    expect(stripRelayBoilerplate(null)).toBe("");
  });
});

// ── captureFromEmail with the IMAP read injected (real DB, no network) ────────

describe("captureFromEmail: third-party senders", () => {
  const OWN = "aamirs.automated.crm@gmail.com";
  let dir: string;
  let db: Db;
  let secrets: SecretStore;

  const recent = () => Date.now() - 60_000; // inside the first-run 24h window

  /** Run capture over a canned INBOX. Returns the batch. */
  const run = (messages: RawMailMessage[]) =>
    captureFromEmail({ db, secrets }, { readInbox: async () => messages });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-capture-mail-"));
    db = openDb(path.join(dir, "pos.db"));
    secrets = new SecretStore(path.join(dir, "secrets"));
    addMailAccount(secrets, { provider: "gmail", user: OWN, password: "app-password" });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("captures an allowlisted sender that is not self-addressed", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "alexa@amazon.com");
    const batch = await run([
      { from: "alexa@amazon.com", subject: "Alexa note", body: "call the plumber at 3", timeMs: recent() },
    ]);
    expect(batch.errors).toEqual([]);
    expect(batch.messages.map((m) => m.text)).toEqual(["Alexa note\ncall the plumber at 3"]);
  });

  it("ignores a third party who is not on the allowlist", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "alexa@amazon.com");
    const batch = await run([
      { from: "stranger@example.com", subject: "Hi", body: "want to sell you something", timeMs: recent() },
    ]);
    expect(batch.messages).toEqual([]);
    expect(batch.skipped).toBe(1);
  });

  it("still captures self-addressed mail when the allowlist is empty", async () => {
    const batch = await run([
      { from: OWN, subject: "Braindump", body: "gym 1h, deep work 3h", timeMs: recent() },
    ]);
    expect(batch.messages.map((m) => m.text)).toEqual(["Braindump\ngym 1h, deep work 3h"]);
  });

  it("an allowlisted relay bypasses the automated-sender filter", async () => {
    expect(isAutomatedSender("no-reply@amazon.com")).toBe(true);
    setSetting(db, ALLOWED_SENDERS_KEY, "no-reply@amazon.com");
    const batch = await run([
      { from: "no-reply@amazon.com", subject: "add oat milk to the list", body: "", timeMs: recent() },
    ]);
    expect(batch.messages.map((m) => m.text)).toEqual(["add oat milk to the list"]);
  });

  it("falls back to the subject and strips boilerplate for relay mail", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "action@ifttt.com");
    const batch = await run([
      // body is pure boilerplate → subject wins
      {
        from: "action@ifttt.com",
        subject: "remind me to renew the passport",
        body: "This email was sent by IFTTT\nhttps://ifttt.com/applets\nUnsubscribe",
        timeMs: recent() - 2000,
      },
      // real body → kept, with the footer stripped
      {
        from: "action@ifttt.com",
        subject: "Alexa",
        body: "book the dentist friday\n\nSent from my iPhone",
        timeMs: recent(),
      },
    ]);
    expect(batch.messages.map((m) => m.text)).toEqual([
      "remind me to renew the passport",
      "Alexa\nbook the dentist friday",
    ]);
  });

  it("the digest prefix still wins over the allowlist", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "alexa@amazon.com");
    const batch = await run([
      { from: "alexa@amazon.com", subject: "POS — Good morning. Confirm your day:", body: "", timeMs: recent() },
    ]);
    // The text is produced with the prefix intact, so runCapture's isDigestMessage guard
    // skips it (and advances the cursor) instead of routing it to the assistant.
    expect(batch.messages).toHaveLength(1);
    expect(isDigestMessage(batch.messages[0].text)).toBe(true);
  });

  it("searches the account's own address AND every allowlisted sender", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "alexa@amazon.com, action@ifttt.com");
    let asked: string[] = [];
    await captureFromEmail(
      { db, secrets },
      {
        readInbox: async (_acct, _since, senders) => {
          asked = senders;
          return [];
        },
      }
    );
    expect(asked).toEqual([OWN, "alexa@amazon.com", "action@ifttt.com"]);
  });

  it("advancing a captured message moves the per-account cursor", async () => {
    setSetting(db, ALLOWED_SENDERS_KEY, "alexa@amazon.com");
    const when = recent();
    const first = await run([
      { from: "alexa@amazon.com", subject: "buy milk", body: "", timeMs: when },
    ]);
    expect(first.messages).toHaveLength(1);
    first.messages[0].advance();
    // Same message on the next run: at (not after) the cursor → skipped, never re-routed.
    const second = await run([
      { from: "alexa@amazon.com", subject: "buy milk", body: "", timeMs: when },
    ]);
    expect(second.messages).toEqual([]);
    expect(second.skipped).toBe(1);
  });
});
