// Bulk-mail gate (main/connectors/common.ts isBulkMail) + the cleanup for what already
// leaked (main/crm/review.ts purgeBulkContacts).
//
// The gate is header-based on purpose: the owner's newsletters (Half Baked, X, the NYT,
// Instagram, Amazon Alexa) all send from real-looking addresses that the old local-part
// denylist waved through. Every header family below gets a case, and the CRITICAL case is
// the negative one — a colleague's plain email must never be filtered.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../../main/db/db.ts";
import { isBulkMail, bulkAddressReason, isBulkDisplayName, transactionalSubject } from "../../main/connectors/common.ts";
import {
  purgeBulkContacts,
  purgeBulkContactsOnce,
  bulkContactCandidates,
  BULK_CLEANUP_SETTING,
} from "../../main/crm/review.ts";

/** Shape a mailparser-ish `parsed`: lowercase-keyed Map, exactly like ParsedMail.headers. */
function mail(headers: Record<string, unknown>): { headers: Map<string, unknown> } {
  return { headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
}

/** The headers a real person's mail client sends — the baseline every case starts from. */
const HUMAN: Record<string, unknown> = {
  "from": "Sarah Chen <sarah.chen@acme.com>",
  "to": "Aamir Tinwala <aamir@example.com>",
  "subject": "Re: Thursday walkthrough",
  "date": new Date("2026-08-01T15:04:05Z"),
  "message-id": "<CAB1x9@mail.acme.com>",
  "return-path": "sarah.chen@acme.com",
  "mime-version": "1.0",
  "content-type": { value: "text/plain", params: { charset: "UTF-8" } },
  "x-mailer": "Apple Mail (2.3696.120.41.1.1)",
};

describe("isBulkMail — the critical negative", () => {
  it("does NOT flag a normal person-to-person email", () => {
    expect(isBulkMail(mail(HUMAN))).toEqual({ bulk: false, reason: "" });
  });

  it("does not flag a human whose client is Outlook, nor a bare From-only message", () => {
    expect(isBulkMail(mail({ ...HUMAN, "x-mailer": "Microsoft Outlook 16.0" })).bulk).toBe(false);
    expect(isBulkMail(mail({ from: "Dan <dan@smallshop.io>" })).bulk).toBe(false);
  });

  it("does not flag a threaded reply carrying References/In-Reply-To", () => {
    const parsed = mail({
      ...HUMAN,
      references: ["<a@acme.com>", "<b@acme.com>"],
      "in-reply-to": "<b@acme.com>",
      "x-priority": "3",
    });
    expect(isBulkMail(parsed).bulk).toBe(false);
  });

  it("does not flag mail from a personal address at a sending-shaped 2-label domain", () => {
    // news.com is the apex, not a sending subdomain — only mail.news.com would qualify.
    expect(isBulkMail(mail({ from: "Ana <ana.diaz@news.com>" })).bulk).toBe(false);
  });
});

describe("isBulkMail — header families", () => {
  it("List-Unsubscribe (the strongest signal)", () => {
    const v = isBulkMail(
      mail({ ...HUMAN, "list-unsubscribe": "<https://nytimes.com/u/abc>, <mailto:u@nytimes.com>" })
    );
    expect(v).toEqual({ bulk: true, reason: "list-header:list-unsubscribe" });
  });

  it("List-Id and List-Post also classify bulk", () => {
    expect(isBulkMail(mail({ ...HUMAN, "list-id": "<eng.lists.acme.com>" })).reason).toBe(
      "list-header:list-id"
    );
    expect(isBulkMail(mail({ ...HUMAN, "list-post": "<mailto:eng@acme.com>" })).reason).toBe(
      "list-header:list-post"
    );
  });

  it("Precedence: bulk | list | junk", () => {
    for (const p of ["bulk", "list", "junk"]) {
      const v = isBulkMail(mail({ ...HUMAN, precedence: p }));
      expect(v.bulk).toBe(true);
      expect(v.reason).toBe(`precedence:${p}`);
    }
  });

  it("Auto-Submitted and X-Auto-Response-Suppress", () => {
    expect(isBulkMail(mail({ ...HUMAN, "auto-submitted": "auto-generated" })).reason).toBe(
      "auto-submitted:auto-generated"
    );
    expect(isBulkMail(mail({ ...HUMAN, "auto-submitted": "auto-replied" })).reason).toBe(
      "auto-submitted:auto-replied"
    );
    expect(isBulkMail(mail({ ...HUMAN, "x-auto-response-suppress": "OOF, AutoReply" })).reason).toBe(
      "x-auto-response-suppress"
    );
    // RFC 3834: "no" is the explicit human marker and must not trip the check.
    expect(isBulkMail(mail({ ...HUMAN, "auto-submitted": "no" })).bulk).toBe(false);
  });

  it("ESP fingerprints: dedicated header names", () => {
    expect(isBulkMail(mail({ ...HUMAN, "x-campaign-id": "9f2c" })).reason).toBe(
      "esp-header:x-campaign-id"
    );
    expect(isBulkMail(mail({ ...HUMAN, "x-sg-eid": "abc123" })).reason).toBe("esp-header:x-sg-eid");
    expect(isBulkMail(mail({ ...HUMAN, "feedback-id": "1:2:3:braze" })).reason).toBe(
      "esp-header:feedback-id"
    );
  });

  it("ESP fingerprints: X-Mailer VALUES (not the mere presence of X-Mailer)", () => {
    expect(isBulkMail(mail({ ...HUMAN, "x-mailer": "MailChimp Mailer - **CID**" })).reason).toBe(
      "esp-mailer:mailchimp"
    );
    expect(isBulkMail(mail({ ...HUMAN, "x-mailer": "Iterable" })).reason).toBe("esp-mailer:iterable");
    expect(isBulkMail(mail({ ...HUMAN, "x-mailer": "Substack" })).reason).toBe("esp-mailer:substack");
  });

  it("bounce-style Return-Path", () => {
    const cases: [string, string][] = [
      ["bounces+7412-abc=me@em.nytimes.com", "bounces+7412-abc=me"],
      ["sr.bounces@braze.com", "sr.bounces"],
      ["msprvs1=1934=bounce@prod.sparkpost.com", "msprvs1=1934=bounce"],
      ["em4821793@mailer.substack.com", "em4821793"],
    ];
    for (const [rp, local] of cases) {
      const v = isBulkMail(mail({ from: "Sarah Chen <sarah.chen@acme.com>", "return-path": `<${rp}>` }));
      expect(v.bulk).toBe(true);
      expect(v.reason).toContain(`bounce-return-path:${local}`);
      expect(v.reason).toContain("(off-domain)"); // envelope domain ≠ From domain
    }
  });

  it("null reverse-path (Return-Path: <>) is a machine message", () => {
    expect(isBulkMail(mail({ from: "x <x@acme.com>", "return-path": "<>" })).reason).toBe(
      "return-path:null"
    );
  });

  it("a same-domain human Return-Path is left alone", () => {
    expect(
      isBulkMail(mail({ from: "Sarah <sarah.chen@acme.com>", "return-path": "<sarah.chen@acme.com>" }))
        .bulk
    ).toBe(false);
  });
});

describe("isBulkMail — address shape (last resort)", () => {
  it("covers the extended local-part list", () => {
    const locals = [
      "newsletter",
      "news",
      "updates",
      "digest",
      "marketing",
      "promo",
      "deals",
      "offers",
      "alerts",
      "info",
      "hello",
      "team",
      "support",
      "billing",
      "receipts",
      "invoice",
      "notify",
      "mailer",
      "bounce",
      "donotreply",
      "no-reply",
      "nreply",
    ];
    for (const local of locals) {
      const v = isBulkMail(mail({ from: `Someone <${local}@example.com>` }));
      expect(v.bulk, `${local}@ should be bulk`).toBe(true);
      expect(v.reason).toMatch(/^(automated-sender|bulk-localpart):/);
    }
  });

  it("matches compound and suffixed local-parts by token", () => {
    expect(bulkAddressReason("store-news@amazon.com")).toBe("bulk-localpart:news");
    expect(bulkAddressReason("no-reply2@instagram.com")).toBe("bulk-localpart:no-reply");
    expect(bulkAddressReason("newsletter+weekly@substack.com")).toMatch(/^automated-sender:/);
    expect(bulkAddressReason("email.updates@corp.com")).toBe("bulk-localpart:updates");
  });

  it("leaves ordinary human local-parts alone", () => {
    for (const e of ["sarah.chen@acme.com", "hozy@scaleupflex.com", "j.smith+dev@corp.io", "ana@news.com"]) {
      expect(bulkAddressReason(e), e).toBeNull();
    }
  });

  it("flags ESP domains and dedicated sending subdomains", () => {
    // mailchimp.com is already in email-utils' DENY_DOMAINS — isAutomatedSender wins first
    expect(bulkAddressReason("abc123@mailchimp.com")).toBe("automated-sender:abc123@mailchimp.com");
    expect(bulkAddressReason("halfbaked@mail.beehiiv.com")).toBe("bulk-domain:mail.beehiiv.com");
    expect(bulkAddressReason("hi@mail.instagram.com")).toBe("bulk-sending-subdomain:mail.instagram.com");
    expect(bulkAddressReason("x@e.nytimes.com")).toBe("bulk-sending-subdomain:e.nytimes.com");
  });

  it("judges the caller-supplied counterpart, not just the From header", () => {
    // Forwarded mail: the envelope From is the owner, the real sender is resolved upstream.
    const v = isBulkMail(mail({ from: "Aamir <aamir@example.com>" }), {
      fromEmail: "newsletters@nytimes.com",
    });
    expect(v.bulk).toBe(true);
  });
});

describe("isBulkMail — the senders from the owner's report", () => {
  const reported: [string, Record<string, unknown>][] = [
    ["Half Baked", { from: "Half Baked <hello@halfbaked.co>" }],
    ["X / Twitter", { from: "X <info@x.com>" }],
    ["New York Times", { from: "The New York Times <newsletters@nytimes.com>" }],
    [
      "Instagram",
      {
        from: "Instagram <no-reply@mail.instagram.com>",
        "list-unsubscribe": "<https://instagram.com/unsub>",
      },
    ],
    [
      "Amazon Alexa",
      { from: "Amazon Alexa <no-reply@amazon.com>", precedence: "bulk" },
    ],
  ];
  for (const [name, headers] of reported) {
    it(`classifies ${name} as bulk`, () => {
      expect(isBulkMail(mail(headers)).bulk).toBe(true);
    });
  }
});

describe("isBulkMail — input tolerance", () => {
  it("accepts a plain object of headers", () => {
    expect(isBulkMail({ headers: { "list-unsubscribe": "<mailto:u@x.com>" } }).bulk).toBe(true);
  });

  it("accepts raw headerLines when no parsed map exists", () => {
    const v = isBulkMail({
      headerLines: [
        { key: "from", line: "From: Deals <deals@shop.com>" },
        { key: "precedence", line: "Precedence: bulk" },
      ],
    });
    expect(v).toEqual({ bulk: true, reason: "precedence:bulk" });
  });

  it("survives null / empty input without throwing", () => {
    expect(isBulkMail(null).bulk).toBe(false);
    expect(isBulkMail({}).bulk).toBe(false);
    expect(bulkAddressReason(null)).toBeNull();
    expect(bulkAddressReason("not-an-address")).toBeNull();
  });

  it("isBulkDisplayName spots robot names only", () => {
    expect(isBulkDisplayName("NYT Newsletters")).toBe(true);
    expect(isBulkDisplayName("Instagram (no-reply)")).toBe(true);
    expect(isBulkDisplayName("Sarah Chen")).toBe(false);
    expect(isBulkDisplayName("")).toBe(false);
  });
});

// ───────────────────────────── purgeBulkContacts ─────────────────────────────

describe("purgeBulkContacts", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-bulk-purge-"));
    db = openDb(path.join(dir, "pos.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  function contact(
    name: string,
    email: string | null,
    opts: { unverified?: boolean } = {}
  ): number {
    const id = Number(
      db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 3)").run(name).lastInsertRowid
    );
    if (opts.unverified !== false) {
      db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, 'unverified')").run(id);
    }
    if (email) {
      db.prepare("INSERT INTO alias (person_id, kind, value, source) VALUES (?, 'email', ?, 'mail')").run(
        id,
        email
      );
    }
    return id;
  }
  function msg(
    personId: number,
    direction: "inbound" | "outbound",
    subject: string,
    channel = "gmail"
  ): void {
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, external_id)
       VALUES (?, ?, ?, datetime('now'), ?, ?)`
    ).run(personId, channel, direction, subject, `ext-${++seq}`);
  }
  const alive = (id: number) => !!db.prepare("SELECT 1 FROM person WHERE id = ?").get(id);
  const interactionsOf = (id: number) =>
    (db.prepare("SELECT COUNT(*) AS n FROM interaction WHERE person_id = ?").get(id) as { n: number }).n;

  it("removes bulk contacts and leaves a real two-way conversation untouched", () => {
    const nyt = contact("The New York Times", "newsletters@nytimes.com");
    msg(nyt, "inbound", "The Morning: what to know today");
    msg(nyt, "inbound", "The Morning: Tuesday");

    const sarah = contact("Sarah Chen", "sarah.chen@acme.com");
    msg(sarah, "inbound", "Re: Thursday walkthrough");
    msg(sarah, "outbound", "Re: Thursday walkthrough");

    expect(bulkContactCandidates(db).map((c) => c.id)).toEqual([nyt]);
    expect(purgeBulkContacts(db)).toBe(1);

    expect(alive(nyt)).toBe(false);
    expect(interactionsOf(nyt)).toBe(0); // interactions cascaded off person
    expect(db.prepare("SELECT COUNT(*) AS n FROM alias WHERE person_id = ?").get(nyt)).toEqual({ n: 0 });

    expect(alive(sarah)).toBe(true);
    expect(interactionsOf(sarah)).toBe(2);
  });

  it("purges by display name and by subject copy when the address looks human", () => {
    const named = contact("Acme Newsletters", "issues@acmeco.com");
    msg(named, "inbound", "Issue 41");

    const bySubject = contact("Half Baked", "hi@halfbaked.co");
    msg(bySubject, "inbound", "This week in AI: the good bits");
    msg(bySubject, "inbound", "Half Baked — latest issue");

    const human = contact("Dan Ruiz", "dan.ruiz@smallshop.io");
    msg(human, "inbound", "quick question about the lease");

    expect(purgeBulkContacts(db)).toBe(2);
    expect(alive(named)).toBe(false);
    expect(alive(bySubject)).toBe(false);
    expect(alive(human)).toBe(true);
  });

  it("never touches a confirmed contact, a non-email channel, or an outbound reply", () => {
    // same bulk address, but a human confirmed them (no `unverified` tag)
    const confirmed = contact("Team Inbox", "team@partner.com", { unverified: false });
    msg(confirmed, "inbound", "Kickoff");

    // bulk-looking address, but the owner has texted them
    const texted = contact("Support", "support@vendor.com");
    msg(texted, "inbound", "ticket update");
    msg(texted, "inbound", "hey", "imessage");

    // bulk-looking address, but the owner replied by email
    const replied = contact("Billing", "billing@vendor.com");
    msg(replied, "inbound", "invoice attached");
    msg(replied, "outbound", "thanks — paid");

    // unverified with a bulk address but NO history: too little evidence to delete
    const empty = contact("Deals", "deals@shop.com");

    expect(purgeBulkContacts(db)).toBe(0);
    for (const id of [confirmed, texted, replied, empty]) expect(alive(id)).toBe(true);
  });

  it("reports why each candidate qualified", () => {
    const nyt = contact("The New York Times", "newsletters@nytimes.com");
    msg(nyt, "inbound", "The Morning");
    const [c] = bulkContactCandidates(db);
    expect(c).toMatchObject({ id: nyt, display_name: "The New York Times", interactions: 1 });
    expect(c.reason).toContain("newsletters@nytimes.com");
  });

  it("purgeBulkContactsOnce runs exactly once, keyed on cleanup_bulk_v1", () => {
    const nyt = contact("The New York Times", "newsletters@nytimes.com");
    msg(nyt, "inbound", "The Morning");

    expect(purgeBulkContactsOnce(db)).toEqual({ ran: true, purged: 1 });
    expect(getSetting(db, BULK_CLEANUP_SETTING)).toContain('"purged":1');

    // a newsletter that slipped in afterwards is NOT swept by the one-shot
    const x = contact("X", "info@x.com");
    msg(x, "inbound", "New login to X");
    expect(purgeBulkContactsOnce(db)).toEqual({ ran: false, purged: 0 });
    expect(alive(x)).toBe(true);
    // …but the underlying purge is still callable directly
    expect(purgeBulkContacts(db)).toBe(1);
    expect(alive(x)).toBe(false);
  });
});

// ── transactional mail: machine-generated, and not a conversation ────────────
//
// Owner observation 2026-08-06, reading his eight most recent mail interactions: "Your Alexa
// verification code" and "New forwarding email added" had both become interactions — and one
// of them had already produced a contact.
//
// Neither is a newsletter, so every header rule correctly passes them: verification codes and
// account notices are sent one-to-one and almost never carry List-Unsubscribe. That is exactly
// why they slipped through a filter built for campaigns.
describe("transactional subjects", () => {
  it("catches the two he actually saw", () => {
    expect(transactionalSubject("Your Alexa verification code")).toBeTruthy();
    expect(transactionalSubject("New forwarding email added")).toBeTruthy();
  });

  it("catches the rest of the machine-issued family", () => {
    for (const s of [
      "Your security code",
      "123456 is your verification code",
      "Your one-time passcode",
      "Reset your password",
      "Password changed",
      "New sign-in from Chrome on Mac",
      "Verify your email address",
      "Recovery email removed",
    ]) {
      expect(transactionalSubject(s), s).toBeTruthy();
    }
  });

  // The rule reads a subject line rather than an envelope, so it is the one most able to
  // misfire on real mail. These are the cases that must survive.
  it("never touches real correspondence", () => {
    for (const s of [
      "Bailey Orthodontics",
      "Re: Stanford advising — times that work",
      "Invoice #4021 for the Como booking",
      "Your order has shipped",
      "Receipt from the flight",
      "Quick question about the code review",
      "Can you verify these numbers before Friday?",
      "Password protected doc for the deal",
    ]) {
      expect(transactionalSubject(s), s).toBe("");
    }
  });

  it("is empty for a missing subject", () => {
    expect(transactionalSubject(null)).toBe("");
    expect(transactionalSubject("   ")).toBe("");
  });

  it("fires through isBulkMail, and names itself in the reason", () => {
    const v = isBulkMail({ headers: new Map(), subject: "Your Alexa verification code" });
    expect(v.bulk).toBe(true);
    expect(v.reason).toMatch(/^transactional:/);
  });

  it("runs LAST — real header evidence still names the rule that fired", () => {
    const v = isBulkMail({
      headers: new Map([["list-unsubscribe", "<mailto:x@y.z>"]]),
      subject: "Your verification code",
    });
    expect(v.reason).toMatch(/^list-header:/);
  });

  it("leaves ordinary mail alone end to end", () => {
    expect(isBulkMail({ headers: new Map(), subject: "Bailey Orthodontics" }).bulk).toBe(false);
  });
});
