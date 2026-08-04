// Morning-capture pure helpers only — self-address matching (case-insensitive, +tag
// normalization), self-handle normalization, first-run 24h window math, and the text cap.
// No network, no DB.
import { describe, it, expect } from "vitest";
import {
  isSelfAddress,
  parseSelfHandles,
  matchesSelfHandle,
  captureWindowStart,
  captureText,
  unixMsToAppleNs,
  FIRST_RUN_MS,
  CAPTURE_MAX_CHARS,
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
});
