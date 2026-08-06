// Recognising that a task and a calendar event are the same commitment.
//
// Owner ask 2026-08-06: "beware alot of times there might be duplicates that are worded very
// differently. like i might have scheduled a google task and also added a calendar event, so
// the system should be able to relate those two."
//
// His own screenshot is the case under test: a Google Task "Take math diagnostic" above a
// calendar holding "Take Stanford math test". One obligation, two records, no shared id.
//
// The bar these tests hold the matcher to is asymmetric on purpose. A MISSED match costs him a
// duplicate block he can delete. A WRONG match silently removes real work from his day — so
// every case below that could plausibly be a false positive is asserted as a non-match.

import { describe, it, expect } from "vitest";
import {
  contentTokens,
  fuzzyWordScore,
  titleSimilarity,
  scoreMatch,
  proposeLinks,
  CONFIRM_AT,
  PROPOSE_AT,
} from "../../main/crm/taskmatch.ts";

const DAY = "2026-08-06";

describe("contentTokens", () => {
  it("keeps what identifies the work and drops the rest", () => {
    expect(contentTokens("Take the math diagnostic for Stanford")).toEqual([
      "math", "diagnostic", "stanford",
    ]);
  });

  it("survives punctuation and casing", () => {
    expect(contentTokens("Go to DFW startup!!")).toEqual(["dfw", "startup"]);
  });

  it("is empty for a title made only of filler", () => {
    expect(contentTokens("do the thing")).toEqual(["thing"]);
    expect(contentTokens("to the")).toEqual([]);
  });
});

describe("fuzzyWordScore", () => {
  it("treats a word and its inflection as near-identical", () => {
    expect(fuzzyWordScore("diagnostic", "diagnostics")).toBeGreaterThan(0.9);
    expect(fuzzyWordScore("meeting", "meetings")).toBeGreaterThan(0.85);
  });

  it("keeps genuinely different words apart", () => {
    expect(fuzzyWordScore("dentist", "diagnostic")).toBeLessThan(0.5);
    expect(fuzzyWordScore("gym", "grocery")).toBeLessThan(0.5);
  });
});

describe("titleSimilarity", () => {
  // The shape his duplicates actually take: the calendar event is more verbose than the task.
  it("scores on the shorter title, so extra detail is not punished", () => {
    expect(titleSimilarity("math diagnostic", "Take Stanford math diagnostic 2h")).toBe(1);
  });

  it("is symmetric — argument order is not a signal", () => {
    const a = titleSimilarity("Gym session", "Go to the gym");
    const b = titleSimilarity("Go to the gym", "Gym session");
    expect(a).toBe(b);
  });

  it("gives nothing for titles that share no content words", () => {
    expect(titleSimilarity("Dentist appointment", "Stanford math test")).toBe(0);
  });

  it("does not match on filler alone", () => {
    expect(titleSimilarity("do the thing", "take the other")).toBe(0);
  });
});

describe("scoreMatch", () => {
  const ev = (title: string, date = DAY) => ({ id: "e1", title, date });

  it("links his actual duplicate — task and event worded differently", () => {
    // "Take math diagnostic" vs "Take Stanford math test": 'math' is shared, 'diagnostic' and
    // 'test' are not, so this is deliberately NOT auto-confirmed — it is a proposal.
    const s = scoreMatch({ id: 1, title: "Take math diagnostic", planDate: DAY }, ev("Take Stanford math test"));
    expect(s).toBeGreaterThanOrEqual(PROPOSE_AT);
    expect(s).toBeLessThan(CONFIRM_AT);
  });

  it("auto-confirms when the wording really is the same thing", () => {
    const s = scoreMatch(
      { id: 1, title: "Stanford math test", planDate: DAY },
      ev("Take Stanford math test")
    );
    expect(s).toBeGreaterThanOrEqual(CONFIRM_AT);
  });

  it("counts the same day as a nudge, never as the reason", () => {
    // A PARTIAL textual match, so the nudge has room to show — an already-perfect match is
    // capped at 1 and would hide the difference.
    const same = scoreMatch({ id: 1, title: "Gym workout", planDate: DAY }, ev("Gym session"));
    const other = scoreMatch({ id: 1, title: "Gym workout", planDate: "2026-08-09" }, ev("Gym session"));
    expect(same).toBeGreaterThan(other);
    expect(other).toBeGreaterThan(0); // a real textual match still stands on its own
    expect(same - other).toBeLessThanOrEqual(0.2); // a nudge, not a verdict
  });

  // The failure that matters: a wrong link silently removes real work from his day.
  it("refuses two unrelated things that merely share a day", () => {
    expect(scoreMatch({ id: 1, title: "Dentist appointment", planDate: DAY }, ev("Stanford math test"))).toBe(0);
    expect(scoreMatch({ id: 2, title: "Unpack travel bag", planDate: DAY }, ev("Comms window 2"))).toBe(0);
    expect(scoreMatch({ id: 3, title: "Lunch", planDate: DAY }, ev("Shutdown ritual"))).toBe(0);
  });

  it("refuses a single shared filler-ish word", () => {
    // "Go to DFW startup" vs "Go to the gym" share only stopwords.
    expect(scoreMatch({ id: 1, title: "Go to DFW startup", planDate: DAY }, ev("Go to the gym"))).toBe(0);
  });
});

describe("proposeLinks", () => {
  const tasks = [
    { id: 1, title: "Take math diagnostic", planDate: DAY },
    { id: 2, title: "Unpack travel bag", planDate: DAY },
    { id: 3, title: "Stanford math test", planDate: DAY },
  ];
  const events = [
    { id: "e1", title: "Take Stanford math test", date: DAY },
    { id: "e2", title: "Comms window 2", date: DAY },
  ];

  it("gives the event to the strongest claimant, not the first one seen", () => {
    const links = proposeLinks(tasks, events);
    const forE1 = links.find((l) => l.eventId === "e1")!;
    // Task 3 is a near-exact match; task 1 is only a partial one.
    expect(forE1.taskId).toBe(3);
  });

  it("never links one event to two tasks, or one task to two events", () => {
    const links = proposeLinks(tasks, [...events, { id: "e3", title: "Stanford math test", date: DAY }]);
    expect(new Set(links.map((l) => l.taskId)).size).toBe(links.length);
    expect(new Set(links.map((l) => l.eventId)).size).toBe(links.length);
  });

  it("leaves unrelated work alone", () => {
    const links = proposeLinks(tasks, events);
    expect(links.some((l) => l.taskId === 2)).toBe(false); // travel bag matches nothing
    expect(links.some((l) => l.eventId === "e2")).toBe(false); // comms window claims nothing
  });

  it("is deterministic — same input twice, same links", () => {
    expect(proposeLinks(tasks, events)).toEqual(proposeLinks(tasks, events));
  });

  it("returns nothing when there is nothing to link", () => {
    expect(proposeLinks([], events)).toEqual([]);
    expect(proposeLinks(tasks, [])).toEqual([]);
  });
});
