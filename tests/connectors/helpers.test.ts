// Pure-helper coverage for the network/FDA-dependent connectors (gmail, imessage):
// automated-sender denylist, forwarded-header unwrapping, attributedBody decoding,
// Apple-epoch dates, mbox splitting.
import { describe, it, expect } from "vitest";
import {
  isAutomatedSender,
  parseForwardedHeaders,
  parseAddress,
  stripFwdPrefix,
} from "../../main/connectors/email-utils.ts";
import { appleDateToDate, decodeAttributedBody } from "../../main/connectors/imessage.ts";
import { splitMbox } from "../../main/connectors/mailfile.ts";

describe("isAutomatedSender", () => {
  it("denies unambiguous machine localparts and blast domains", () => {
    expect(isAutomatedSender("noreply@github.com")).toBe(true);
    expect(isAutomatedSender("no-reply@stripe.com")).toBe(true);
    expect(isAutomatedSender("notifications@linkedin.com")).toBe(true);
    expect(isAutomatedSender("mailer-daemon@google.com")).toBe(true);
    expect(isAutomatedSender("noreply+tag@x.com")).toBe(true);
    expect(isAutomatedSender("news@mail.substack.com")).toBe(true); // subdomain of denied domain
    expect(isAutomatedSender(null)).toBe(true);
  });

  it("keeps humans and role addresses (conservative)", () => {
    expect(isAutomatedSender("cory@levy.com")).toBe(false);
    expect(isAutomatedSender("hello@smallshop.com")).toBe(false);
    expect(isAutomatedSender("support@startup.io")).toBe(false);
  });
});

describe("forwarded-header unwrapping", () => {
  it("pulls the ORIGINAL sender out of a Gmail forward block", () => {
    const body = `FYI, see below

---------- Forwarded message ---------
From: Jane Doe <jane@acme.com>
Date: Mon, Jun 1, 2026 at 9:00 AM
Subject: Fwd: Q3 numbers
To: Me <me@example.com>

Here are the numbers.`;
    const fwd = parseForwardedHeaders(body);
    expect(fwd).toBeTruthy();
    expect(fwd!.from).toEqual({ name: "Jane Doe", email: "jane@acme.com" });
    expect(fwd!.to?.email).toBe("me@example.com");
    expect(fwd!.subject).toBe("Q3 numbers"); // Fwd: prefix stripped
  });

  it("returns null for a normal (non-forwarded) body", () => {
    expect(parseForwardedHeaders("just a normal email body")).toBeNull();
  });

  it("stripFwdPrefix removes stacked prefixes", () => {
    expect(stripFwdPrefix("Fwd: RE: fw: Hello")).toBe("Hello");
  });

  it("parseAddress handles comma display names before the angle address", () => {
    expect(parseAddress('"Doe, Jane" <jane@acme.com>')).toEqual({
      name: "Doe, Jane",
      email: "jane@acme.com",
    });
  });
});

describe("decodeAttributedBody", () => {
  it("extracts length-prefixed text after NSString", () => {
    const text = "Decoded body works";
    const blob = Buffer.concat([
      Buffer.from([0x04, 0x0b]),
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01]),
      Buffer.from([0x2b, text.length]),
      Buffer.from(text, "utf8"),
      Buffer.from([0x86]),
    ]);
    expect(decodeAttributedBody(blob)).toBe(text);
  });

  it("0x81 two-byte length for long text", () => {
    const text = "x".repeat(300);
    const lenLE = Buffer.alloc(2);
    lenLE.writeUInt16LE(text.length, 0);
    const blob = Buffer.concat([
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x2b, 0x81]),
      lenLE,
      Buffer.from(text, "utf8"),
    ]);
    expect(decodeAttributedBody(blob)).toBe(text);
  });

  it("returns null when no NSString marker / empty input", () => {
    expect(decodeAttributedBody(Buffer.from("nothing here"))).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(new Uint8Array(0))).toBeNull();
  });
});

describe("appleDateToDate", () => {
  it("handles nanoseconds and legacy seconds since the 2001 epoch", () => {
    expect(appleDateToDate(770_000_000n * 1_000_000_000n).toISOString()).toBe(
      "2025-05-27T00:53:20.000Z"
    );
    expect(appleDateToDate(770_000_000n).toISOString()).toBe("2025-05-27T00:53:20.000Z");
  });
});

describe("splitMbox", () => {
  it("splits on From_ separator lines and drops them", () => {
    const raw = `From a@b.com Thu Jan 01 00:00:00 2026
Subject: one

body one
From c@d.com Fri Jan 02 00:00:00 2026
Subject: two

body two`;
    const parts = splitMbox(raw);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("Subject: one");
    expect(parts[0]).not.toContain("From a@b.com Thu");
    expect(parts[1]).toContain("body two");
  });

  it("a single non-mbox message yields one chunk only when a separator exists", () => {
    expect(splitMbox("no separators here")).toEqual([]);
  });
});
