// One sentence is one task — the deterministic parser's fragmentation bug.
//
// Owner report 2026-08-06, verbatim: "that time later this week and maybe about, like, two
// hours in total — both those events should be the same event, they stem from the same task
// that I'm trying to do."
//
// He was looking at two entries in his planner:
//
//   id 15  "Set time later this week"                                             75 min
//   id 16  "maybe about like two hours in total to go through my Stanford         75 min
//           academic advising stuff."
//
// Both created in the same second, from ONE spoken sentence. Three separate defects stacked:
//
//   1. FRAGMENTATION. The parser split on every comma, so the leading scheduling clause
//      ("set time later this week") became a task of its own — a task that describes no work
//      at all, only when some other work should happen.
//   2. WORD DURATIONS. "two hours" was invisible: the estimate regex only matched digits, so
//      both halves fell back to the generic default and the day was budgeted for 2.5 hours of
//      the wrong shape instead of the 2 hours he actually asked for.
//   3. RAW TRANSCRIPT TITLES. Nothing rewrote the fragment, so his calendar read "maybe about
//      like two hours in total to go through my Stanford academic advising stuff."
//
// The trigger was the LLM parse failing (llm_call has the assistant_route call at 02:52:50 and
// no plan_parse after it) and silently handing over to this fallback. The fallback is supposed
// to be a degraded parse, not a broken one — these tests hold it to that.

import { describe, it, expect } from "vitest";
import { deterministicParse, statedMinutes, workSegments } from "../../main/engine/parse.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";

const REF = "2026-08-06"; // a Thursday
const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

// ── the report, end to end ───────────────────────────────────────────────────

describe("the Stanford advising sentence", () => {
  const SAID =
    "Set time later this week, maybe about like two hours in total to go through my Stanford academic advising stuff.";

  it("produces ONE task, not one per comma", () => {
    const tasks = deterministicParse(SAID, doctrine, REF);
    expect(tasks).toHaveLength(1);
  });

  it("keeps the stated two hours instead of inventing an estimate", () => {
    const [t] = deterministicParse(SAID, doctrine, REF);
    expect(t.rawEstimateMinutes).toBe(120);
    expect(t.estimateSource).toBe("stated");
  });

  it("titles it from the work, not from the transcript", () => {
    const [t] = deterministicParse(SAID, doctrine, REF);
    expect(t.title.toLowerCase()).toContain("stanford");
    expect(t.title.toLowerCase()).toContain("advising");
    // None of the filler that made the old title unreadable on a calendar card.
    expect(t.title.toLowerCase()).not.toMatch(/^(?:set time|maybe|about|like)\b/);
    expect(t.title).not.toMatch(/\btwo hours\b/i);
  });

  it("carries the window off the clause that stated it", () => {
    const [t] = deterministicParse(SAID, doctrine, REF);
    // "later this week" lives in the FRAGMENT, and the work lives in the other one. Merging
    // is what lets a single task hold both — which is the whole point of the report.
    expect(t.flexible).toBe(true);
    expect(t.windowEnd).toBe("2026-08-09"); // the coming Sunday
  });
});

// ── segmentation: which fragments are really tasks ───────────────────────────

describe("workSegments", () => {
  it("merges a scheduling-only clause into the work it refers to", () => {
    const segs = workSegments("Set time later this week, go through my Stanford advising stuff");
    expect(segs).toHaveLength(1);
    expect(segs[0].full).toMatch(/later this week/i); // the window survives
    expect(segs[0].work).toMatch(/stanford/i); // the title comes from the work clause
  });

  it("still splits genuinely separate tasks", () => {
    const segs = workSegments("Finish the problem set, email Priya, gym");
    expect(segs.map((s) => s.work)).toEqual(["Finish the problem set", "email Priya", "gym"]);
  });

  it("merges a trailing scheduling clause backwards", () => {
    const segs = workSegments("Draft the grant proposal, sometime this week");
    expect(segs).toHaveLength(1);
    expect(segs[0].work).toMatch(/grant proposal/i);
    expect(segs[0].full).toMatch(/this week/i);
  });

  it("never returns a segment that describes only timing", () => {
    // Nothing to attach to — a sentence that is PURELY scheduling is not a task at all.
    expect(workSegments("set aside some time later this week")).toEqual([]);
    expect(workSegments("")).toEqual([]);
  });

  it("does not merge two real tasks just because one mentions a time", () => {
    const segs = workSegments("Take the math test today, review the advising packet this week");
    expect(segs).toHaveLength(2);
  });
});

// ── spoken durations ─────────────────────────────────────────────────────────

describe("statedMinutes", () => {
  it("reads digits, the case that always worked", () => {
    expect(statedMinutes("2h of writing")).toBe(120);
    expect(statedMinutes("90 min of email")).toBe(90);
    expect(statedMinutes("1.5 hours on the deck")).toBe(90);
  });

  it("reads the words people actually speak", () => {
    expect(statedMinutes("two hours in total")).toBe(120);
    expect(statedMinutes("about an hour")).toBe(60);
    expect(statedMinutes("half an hour to shower and read")).toBe(30);
    expect(statedMinutes("an hour and a half on the pset")).toBe(90);
    expect(statedMinutes("a couple of hours")).toBe(120);
    expect(statedMinutes("forty five minutes")).toBe(45);
    expect(statedMinutes("twenty minutes")).toBe(20);
  });

  it("is null when no duration was stated", () => {
    expect(statedMinutes("go through the advising stuff")).toBeNull();
    expect(statedMinutes("")).toBeNull();
  });

  it("does not mistake a clock time for a duration", () => {
    // "be back by 5:30" states a deadline, not two-and-a-half of anything.
    expect(statedMinutes("be back here at 5:30 latest")).toBeNull();
    expect(statedMinutes("lunch at 1pm")).toBeNull();
  });
});
