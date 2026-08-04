// Pure-function coverage for the ported iMessage → Calendar watcher (main/msgplans.ts).
// No network, no osascript, no LLM, no chat.db: only the parts that decide whether tokens
// get spent and whether an event is written.

import { describe, it, expect } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  DEFAULT_EVENT_MINUTES,
  MAX_MSG_CHARS,
  RECENT_CONTEXT,
  STALE_HOURS,
  type RawMessage,
  buildDateReference,
  buildUserPrompt,
  cleanText,
  conversationHasSignal,
  convKey,
  distill,
  ensureEnd,
  gateDecision,
  isAutomatedThread,
  isCandidate,
  localIso,
  parseLocalDateTime,
} from "../main/msgplans.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

let nextRowid = 1;
const msg = (over: Partial<RawMessage> = {}): RawMessage => ({
  rowid: nextRowid++,
  text: "hey",
  isFromMe: false,
  handle: "+15551234567",
  chatGuid: "iMessage;-;+15551234567",
  chatName: null,
  ts: new Date(2026, 5, 5, 13, 0),
  ...over,
});

/** A real scheduling back-and-forth (the case the watcher exists for). */
const SCHEDULING_THREAD: RawMessage[] = [
  msg({ text: "yo you around this week?" }),
  msg({ text: "yeah what's up", isFromMe: true }),
  msg({ text: "wanna grab dinner saturday?" }),
  msg({ text: "down", isFromMe: true }),
  msg({ text: "lets say 8" }),
];

/** Smalltalk with zero scheduling signal. */
const SMALLTALK_THREAD: RawMessage[] = [
  msg({ text: "haha that video was insane" }),
  msg({ text: "right?? I lost it", isFromMe: true }),
  msg({ text: "send me the link" }),
  msg({ text: "ok sent", isFromMe: true }),
];

const OTP_THREAD: RawMessage[] = [
  msg({ handle: "262966", chatGuid: "SMS;-;262966", text: "Your Amazon verification code is 384920. Do not share it with anyone." }),
];

const APPOINTMENT_REMINDER_THREAD: RawMessage[] = [
  msg({
    handle: "+18005550100",
    chatGuid: "SMS;-;+18005550100",
    text: "Reminder: you have an appointment with Dr. Chen on Tuesday at 3:00 PM. Reply C to confirm or STOP to opt out.",
  }),
];

// ── prefilter (ported verbatim from prefilter.py) ────────────────────────────

describe("prefilter — the free gate that decides whether tokens are spent", () => {
  it("passes a scheduling thread", () => {
    expect(conversationHasSignal(SCHEDULING_THREAD)).toBe(true);
  });

  it("rejects a smalltalk thread (zero LLM tokens)", () => {
    expect(conversationHasSignal(SMALLTALK_THREAD)).toBe(false);
  });

  it("rejects an OTP / verification-code thread", () => {
    expect(isAutomatedThread(OTP_THREAD)).toBe(true);
    expect(conversationHasSignal(OTP_THREAD)).toBe(false);
  });

  it("rejects an appointment-reminder thread even though it names a day and a time", () => {
    // The keyword net alone would pass this ("appointment", "tuesday", "3:00") — the
    // automated-sender gate is what stops it.
    expect(APPOINTMENT_REMINDER_THREAD.some((m) => isCandidate(m.text))).toBe(true);
    expect(isAutomatedThread(APPOINTMENT_REMINDER_THREAD)).toBe(true);
    expect(conversationHasSignal(APPOINTMENT_REMINDER_THREAD)).toBe(false);
  });

  it("isCandidate: hint words, digit times, and neither", () => {
    expect(isCandidate("dinner?")).toBe(true);
    expect(isCandidate("tn?")).toBe(true);
    expect(isCandidate("7pm works")).toBe(true);
    expect(isCandidate("meet at 8")).toBe(true);
    expect(isCandidate("6/14 good?")).toBe(true);
    expect(isCandidate("lol")).toBe(false);
    expect(isCandidate("")).toBe(false);
    expect(isCandidate(null)).toBe(false);
  });

  it("matches hints on word boundaries only (no substring false positives)", () => {
    expect(isCandidate("sundae")).toBe(false); // not "sun"
    expect(isCandidate("summon")).toBe(false); // not "sun"/"mon"
    expect(isCandidate("sun")).toBe(true);
  });

  it("an empty window has no signal", () => {
    expect(conversationHasSignal([])).toBe(false);
  });
});

// ── distill (prefilter.distill) ──────────────────────────────────────────────

describe("distill — the compact thread handed to the model", () => {
  it("produces {who, when, text} per message, oldest-first, with 'me' for outbound", () => {
    const out = distill(SCHEDULING_THREAD, () => "Sam");
    expect(out).toHaveLength(5);
    expect(Object.keys(out[0]).sort()).toEqual(["text", "when", "who"]);
    expect(out.map((m) => m.who)).toEqual(["Sam", "me", "Sam", "me", "Sam"]);
    expect(out[0].when).toBe("Fri 06/05 13:00");
    expect(out[4].text).toBe("lets say 8");
  });

  it("falls back to 'them' — never a raw phone number — when the counterpart is unknown", () => {
    const out = distill([msg({ text: "dinner?" })]);
    expect(out[0].who).toBe("them");
    expect(JSON.stringify(out)).not.toContain("+1555");
  });

  it("drops empty and attachment-only messages", () => {
    const out = distill([
      msg({ text: "￼" }), // object-replacement char = an attachment
      msg({ text: "   " }),
      msg({ text: null }),
      msg({ text: "dinner?" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("dinner?");
  });

  it("collapses whitespace and truncates a long message to MAX_MSG_CHARS + ellipsis", () => {
    expect(cleanText("a  b\n\nc")).toBe("a b c");
    const long = "x".repeat(MAX_MSG_CHARS + 500);
    const out = distill([msg({ text: long })]);
    expect(out[0].text).toHaveLength(MAX_MSG_CHARS + 1);
    expect(out[0].text.endsWith("…")).toBe(true);
  });

  it("stays inside the ~500-token budget for a full RECENT_CONTEXT window", () => {
    const window = Array.from({ length: RECENT_CONTEXT }, () => msg({ text: "y".repeat(400) }));
    const out = distill(window, () => "Sam");
    expect(out).toHaveLength(RECENT_CONTEXT);
    // Every line is capped, so the whole block is bounded no matter how long the texts are.
    for (const line of out) expect(line.text.length).toBeLessThanOrEqual(MAX_MSG_CHARS + 1);
    const rendered = out.map((m) => `[${m.when}] ${m.who}: ${m.text}`).join("\n");
    expect(rendered.length).toBeLessThanOrEqual(RECENT_CONTEXT * (MAX_MSG_CHARS + 40));
  });
});

// ── date reference table (brain._date_reference) ─────────────────────────────

describe("date reference table — so the model never does weekday math", () => {
  const now = new Date(2026, 5, 5, 14, 0); // Friday 2026-06-05

  it("lists exactly 11 days starting today", () => {
    const parts = buildDateReference(now).split("; ");
    expect(parts).toHaveLength(11);
    expect(parts[0]).toBe("Fri 2026-06-05 (today)");
    expect(parts[1]).toBe("Sat 2026-06-06 (tomorrow)");
    expect(parts[2]).toBe("Sun 2026-06-07");
    expect(parts[10]).toBe("Mon 2026-06-15");
  });

  it("tags only today and tomorrow", () => {
    const parts = buildDateReference(now).split("; ");
    expect(parts.filter((p) => p.includes("("))).toHaveLength(2);
  });

  it("crosses a month boundary correctly", () => {
    const parts = buildDateReference(new Date(2026, 5, 28, 9, 0)).split("; ");
    expect(parts[0]).toBe("Sun 2026-06-28 (today)");
    expect(parts[3]).toBe("Wed 2026-07-01");
  });

  it("is embedded in the user prompt along with the existing event and the thread", () => {
    const prompt = buildUserPrompt(
      distill(SCHEDULING_THREAD, () => "Sam"),
      now,
      { title: "Dinner with Sam", start: "2026-06-06T20:00:00", end: "2026-06-06T21:00:00", all_day: false },
      "Sam"
    );
    expect(prompt).toContain("Date reference (use these EXACT dates; do not compute weekdays yourself)");
    expect(prompt).toContain("Fri 2026-06-05 (today)");
    expect(prompt).toContain("Current date/time: Friday 2026-06-05 14:00");
    expect(prompt).toContain('"title":"Dinner with Sam"');
    expect(prompt).toContain("This conversation is with: Sam.");
    expect(prompt).toContain("[Fri 06/05 13:00] Sam: wanna grab dinner saturday?");
  });

  it("says 'none' and omits the name line when there is no event and no known name", () => {
    const prompt = buildUserPrompt(distill([msg({ text: "dinner?" })]), now, null, null);
    expect(prompt).toContain("Event currently on the calendar for this conversation: none");
    expect(prompt).not.toContain("This conversation is with:");
  });
});

// ── decision gating (watcher.apply_decision) ─────────────────────────────────

describe("decision gating — what may reach the calendar", () => {
  const now = new Date(2026, 5, 5, 14, 0);
  const base = {
    is_plan: true,
    action: "create",
    title: "Dinner with Sam",
    start: "2026-06-06T20:00",
    end: "2026-06-06T21:30",
    all_day: false,
    reason: "they settled on saturday 8",
  };

  it("rejects confidence 0.5 (below the 0.6 threshold)", () => {
    const out = gateDecision({ ...base, confidence: 0.5 }, { hasExisting: false, now });
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason).toContain(String(CONFIDENCE_THRESHOLD));
  });

  it("accepts confidence 0.7", () => {
    const out = gateDecision({ ...base, confidence: 0.7 }, { hasExisting: false, now });
    expect(out.kind).toBe("write");
    if (out.kind !== "write") return;
    expect(out.title).toBe("Dinner with Sam");
    expect(out.confidence).toBe(0.7);
    expect(localIso(out.start)).toBe("2026-06-06T20:00:00");
    expect(localIso(out.end)).toBe("2026-06-06T21:30:00");
  });

  it("accepts exactly at the threshold", () => {
    expect(gateDecision({ ...base, confidence: CONFIDENCE_THRESHOLD }, { hasExisting: false, now }).kind).toBe(
      "write"
    );
  });

  it("rejects a missing / unparseable start", () => {
    expect(gateDecision({ ...base, confidence: 0.9, start: null }, { hasExisting: false, now }).kind).toBe("skip");
    expect(gateDecision({ ...base, confidence: 0.9, start: "saturday" }, { hasExisting: false, now }).kind).toBe(
      "skip"
    );
    const out = gateDecision({ ...base, confidence: 0.9, start: "" }, { hasExisting: false, now });
    expect(out.kind === "skip" && out.reason).toBe("no concrete start");
  });

  it("rejects a NEW event whose start is more than STALE_HOURS in the past", () => {
    const stale = new Date(now.getTime() - (STALE_HOURS + 1) * 3_600_000);
    const out = gateDecision(
      { ...base, confidence: 0.9, start: localIso(stale), end: null },
      { hasExisting: false, now }
    );
    expect(out.kind).toBe("skip");
    expect(out.kind === "skip" && out.reason).toContain("stale");
  });

  it("still allows a slightly-past start inside the staleness window", () => {
    const recent = new Date(now.getTime() - (STALE_HOURS - 1) * 3_600_000);
    expect(
      gateDecision({ ...base, confidence: 0.9, start: localIso(recent), end: null }, { hasExisting: false, now }).kind
    ).toBe("write");
  });

  it("lets an ALREADY-TRACKED event be updated to a past time (the plan is the same plan)", () => {
    const stale = new Date(now.getTime() - (STALE_HOURS + 5) * 3_600_000);
    expect(
      gateDecision(
        { ...base, action: "update", confidence: 0.9, start: localIso(stale), end: null },
        { hasExisting: true, now }
      ).kind
    ).toBe("write");
  });

  it("honors cancel regardless of confidence, and skips action 'none'", () => {
    expect(gateDecision({ action: "cancel", confidence: 0.1 }, { hasExisting: true, now }).kind).toBe("cancel");
    expect(gateDecision({ ...base, action: "none", confidence: 0.95 }, { hasExisting: false, now }).kind).toBe("skip");
  });

  it("defaults the title to 'Plans' and treats a null decision as a skip", () => {
    const out = gateDecision({ ...base, confidence: 0.8, title: "  " }, { hasExisting: false, now });
    expect(out.kind === "write" && out.title).toBe("Plans");
    expect(gateDecision(null, { hasExisting: false, now }).kind).toBe("skip");
  });

  it("parses the naive-local ISO forms the model emits", () => {
    expect(localIso(parseLocalDateTime("2026-06-06T20:00")!)).toBe("2026-06-06T20:00:00");
    expect(localIso(parseLocalDateTime("2026-06-06T20:00:00Z")!)).toBe("2026-06-06T20:00:00");
    expect(localIso(parseLocalDateTime("2026-06-06")!)).toBe("2026-06-06T00:00:00");
    expect(parseLocalDateTime("tomorrow")).toBeNull();
    expect(parseLocalDateTime(null)).toBeNull();
    expect(parseLocalDateTime(42)).toBeNull();
  });
});

// ── the start == end guard (the known bug in the Python version) ─────────────

describe("duration guard — start must always be before end", () => {
  const start = new Date(2026, 5, 6, 20, 0);

  it("gives a zero-length timed event the default duration", () => {
    const end = ensureEnd(start, new Date(start.getTime()), false);
    expect(end.getTime() - start.getTime()).toBe(DEFAULT_EVENT_MINUTES * 60_000);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("fixes an end BEFORE the start", () => {
    const end = ensureEnd(start, new Date(start.getTime() - 3_600_000), false);
    expect(end.getTime() - start.getTime()).toBe(DEFAULT_EVENT_MINUTES * 60_000);
  });

  it("fills in a missing end", () => {
    expect(ensureEnd(start, null, false).getTime() - start.getTime()).toBe(DEFAULT_EVENT_MINUTES * 60_000);
  });

  it("keeps a valid end untouched", () => {
    const good = new Date(2026, 5, 6, 22, 30);
    expect(ensureEnd(start, good, false).getTime()).toBe(good.getTime());
  });

  it("gives a zero-duration all-day event one full day", () => {
    const dayStart = new Date(2026, 5, 6, 0, 0);
    expect(localIso(ensureEnd(dayStart, dayStart, true))).toBe("2026-06-07T00:00:00");
    expect(localIso(ensureEnd(start, null, true))).toBe("2026-06-07T00:00:00");
  });

  it("gating never emits an event with start == end", () => {
    const out = gateDecision(
      { action: "create", confidence: 0.9, title: "Coffee", start: "2026-06-06T20:00", end: "2026-06-06T20:00" },
      { hasExisting: false, now: new Date(2026, 5, 5, 14, 0) }
    );
    expect(out.kind).toBe("write");
    if (out.kind !== "write") return;
    expect(out.end.getTime()).toBeGreaterThan(out.start.getTime());
    expect(localIso(out.end)).toBe("2026-06-06T21:00:00");
  });
});

// ── conversation identity ────────────────────────────────────────────────────

describe("conversation key", () => {
  it("prefers the chat guid, falls back to the handle, then 'unknown'", () => {
    expect(convKey({ chatGuid: "iMessage;+;chat42", handle: "+15551234567" })).toBe("iMessage;+;chat42");
    expect(convKey({ chatGuid: null, handle: "+15551234567" })).toBe("+15551234567");
    expect(convKey({ chatGuid: null, handle: null })).toBe("unknown");
  });
});
