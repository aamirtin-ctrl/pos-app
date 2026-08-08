// What the planner produces when Gemini is DOWN.
//
// Owner ask 2026-08-07: "work on edge cases when the gemini credits are down (especially the
// calendar system)." parseBraindump falls back to deterministicParse whenever the model is
// unavailable, out of quota, or returns unusable JSON — and whatever that fallback produces
// goes straight onto his real calendar and out to Google and Apple. It is not a degraded
// nice-to-have; on an outage day it IS the planner.
//
// Auditing it against his own real sentences found four defects, each of which had already
// reached his calendar or was one phrasing away from doing so. Every case below is a real
// input, and the numbers are what the block must actually be.

import { describe, it, expect } from "vitest";
import { deterministicParse, statedMinutes, workSegments, titleFromFragment } from "../../main/engine/parse.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const TODAY = "2026-08-07";
const parse = (t: string) => deterministicParse(t, doctrine, TODAY);
const byTitle = (t: string, needle: string) =>
  parse(t).find((p) => p.title.toLowerCase().includes(needle.toLowerCase()));

// ── 1. two durations in one sentence ─────────────────────────────────────────
//
// THE bug he reported on 2026-08-07: "it put gym at 1 hr 45 mins and has two different
// events/tasks for filming and then editing… nowhere near the time i said they should take."
// Two causes met here. The " and " splitter required a LETTER after "and", so "… and 1.25
// hrs to gym" never split; and statedMinutes checked hours before minutes and returned on the
// first hit, so unit precedence beat word order and the insta clause was handed the gym's 75.
describe("a sentence naming two durations", () => {
  const HIS_SENTENCE = "slot 30 mins to edit/film insta content and 1.25 hrs to gym everyday";

  it("gives each half its OWN duration — his exact sentence", () => {
    const insta = byTitle(HIS_SENTENCE, "insta");
    const gym = parse(HIS_SENTENCE).find((p) => p.blockType === "gym");
    expect(insta, "the insta task must exist").toBeTruthy();
    expect(gym, "the gym task must exist").toBeTruthy();
    expect(insta!.rawEstimateMinutes).toBe(30);
    expect(gym!.rawEstimateMinutes).toBe(75);
    // ONE insta task, not the film/edit pair he complained about
    expect(parse(HIS_SENTENCE).filter((p) => /insta|film|edit/i.test(p.title))).toHaveLength(1);
  });

  it("both halves inherit the sentence-wide 'everyday'", () => {
    for (const p of parse(HIS_SENTENCE)) expect(p.recurrence, p.title).toBe("daily");
  });

  it("splits before a digit, which is what 'and 1.25 hrs' needs", () => {
    expect(workSegments("30 mins on email and 2 hrs on the deck").length).toBeGreaterThan(1);
  });

  it("the EARLIEST duration wins, not the one whose unit is checked first", () => {
    // "30 mins" precedes "1.25 hrs"; hours must not win merely for being hours.
    expect(statedMinutes("30 mins of email then 1.25 hrs of gym")).toBe(30);
    expect(statedMinutes("1.25 hrs of gym then 30 mins of email")).toBe(75);
  });

  it("a work clause's own duration outranks one borrowed from merged context", () => {
    // The gym fragment carries the whole sentence as context so "everyday" still reaches it;
    // that context must not also donate a neighbour's minutes.
    const gym = parse("30 mins on insta and 1.25 hrs to gym")!.find((p) => p.blockType === "gym");
    expect(gym!.rawEstimateMinutes).toBe(75);
  });

  it("reads the duration through whichever connector he typed", () => {
    for (const [text, want] of [
      ["1.25 hrs to gym", 75],
      ["45 min of gym", 45],
      ["an hour at the gym", 60],
      ["2 hrs for the gym", 120],
    ] as const) {
      const gym = parse(text).find((p) => p.blockType === "gym");
      expect(gym?.rawEstimateMinutes, text).toBe(want);
    }
  });
});

// ── 2. "and a half" is a duration, never a conjunction ───────────────────────
describe("half-hour phrasing survives segmentation", () => {
  it("'an hour and a half' is ONE 90-minute task, not 60 + 90", () => {
    const tasks = parse("spend an hour and a half on the deck");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].rawEstimateMinutes).toBe(90);
  });

  it("'two and a half hours' keeps its number", () => {
    // Splitting at " and " severed the "two", and the orphan fell back to a block default —
    // a 150-minute intent became a 50-minute task.
    const tasks = parse("two and a half hours of deep work");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].rawEstimateMinutes).toBe(150);
  });

  it("still splits a genuine conjunction of two jobs", () => {
    const tasks = parse("45 minutes on email and two hours on the report");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.rawEstimateMinutes).sort((a, b) => a - b)).toEqual([45, 120]);
  });
});

// ── 3. fragments that name no work are not tasks ─────────────────────────────
//
// namesWork treated any word absent from SCHEDULING_WORDS as evidence of work, which made the
// rule "anything I forgot to list is a task". "this can be whenever" became a 75-minute
// focused_work block purely because "be" was missing — the same phantom shape as the "Just
// woke up" block, arriving by a different route.
describe("phantom fragments", () => {
  it("a trailing 'this can be whenever' produces nothing", () => {
    const tasks = parse("also schedule 15 mins some day for me to call family. this can be whenever");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].rawEstimateMinutes).toBe(15);
  });

  it("bare grammar and pure scheduling talk never become blocks", () => {
    for (const t of ["this can be whenever", "it should be fine", "maybe later this week", "sometime tomorrow"]) {
      expect(parse(t), t).toHaveLength(0);
    }
  });

  it("a leftover recurrence adverb is not a task", () => {
    // Lifting the gym out of "…1.25 hrs to gym everyday" left a bare "everyday" behind, which
    // became its own 75-minute block.
    for (const p of parse("slot 30 mins to edit insta and 1.25 hrs to gym everyday")) {
      expect(p.title.trim().toLowerCase(), "a bare adverb is not work").not.toBe("everyday");
    }
  });

  it("still recognises real work in a short fragment", () => {
    expect(parse("email Sarah").length).toBe(1);
    expect(parse("gym").length).toBe(1);
  });
});

// ── 4. titles a calendar can display ─────────────────────────────────────────
//
// The duration is stored as a number, so it is stripped from the title — but stripping left
// wreckage: "Spend and a half on the deck", "Of deep work", "U dedicate a day to learning
// agentic coding". These land on his real calendar, and on Google and Apple after that.
describe("titles after the duration is stripped", () => {
  it("no orphaned 'and a half'", () => {
    expect(titleFromFragment("spend an hour and a half on the deck")).not.toMatch(/and a half/i);
  });

  it("no leading preposition left behind by the stripped duration", () => {
    expect(titleFromFragment("45 minutes on email")).toBe("Email");
    expect(titleFromFragment("two and a half hours of deep work")).toBe("Deep work");
  });

  it("no scheduling verb, no assistant address, no recurrence adverb", () => {
    expect(titleFromFragment("slot 30 mins to edit/film insta content")).toBe("Edit/film insta content");
    expect(titleFromFragment("can u dedicate 30 mins a day to learning agentic coding")).toBe(
      "Learning agentic coding"
    );
    expect(titleFromFragment("gym everyday")).toBe("Gym");
  });

  it("drops a trailing WHEN — the date was already captured from it", () => {
    // A block on Saturday titled "… tomorrow" reads as though it belongs on Sunday.
    expect(titleFromFragment("read that essay on making content tonight")).toBe(
      "Read that essay on making content"
    );
    expect(titleFromFragment("call the bank today")).toBe("Call the bank");
    expect(titleFromFragment("finish the deck this week")).toBe("Finish the deck");
    // …but a WHEN in the middle is part of the sentence, not a trailing marker
    expect(titleFromFragment("prep tomorrow's demo")).toMatch(/tomorrow/i);
  });

  it("strips the scheduling verb around a gerund — his errands sentence", () => {
    // "I need to spend 45 minutes doing errands to return stuff tomorrow" was titled
    // "Spend doing errands to return stuff tomorrow" on his real calendar.
    expect(titleFromFragment("I need to spend 45 minutes doing errands to return stuff tomorrow")).toBe(
      "Errands to return stuff"
    );
    expect(titleFromFragment("spend time doing the pset this week")).toBe("The pset");
  });

  it("never returns an empty title", () => {
    // Every strip could in principle consume the whole fragment; the original must come back.
    for (const t of ["30 mins", "an hour", "to", "on the"]) {
      expect(titleFromFragment(t).length, t).toBeGreaterThan(0);
    }
  });
});

// ── durations that are malformed, degenerate or absurd ──────────────────────
//
// The random fuzzer draws from phrasings he actually uses, so it never reaches these. They
// were found by handing the parser deliberately hostile numbers (2026-08-08), and one of them
// was a ten-fold error on input people really do type.
describe("hostile durations", () => {
  it("'.5 hours' is thirty minutes, not five hours", () => {
    // The number regex required a leading digit, so ".5" matched only the 5 — and wordValue
    // rejected ".5" outright, which would have dropped the duration entirely once the regex
    // was widened. Both halves had to move.
    expect(statedMinutes("spend .5 hours on email")).toBe(30);
    expect(statedMinutes("spend .25 hrs on email")).toBe(15);
    expect(statedMinutes("spend 0.5 hrs on email")).toBe(30);
    expect(statedMinutes("spend 1.5 hrs on email")).toBe(90);
    // and the ordinary decimal he actually uses is untouched
    expect(statedMinutes("1.25 hrs to gym")).toBe(75);
  });

  it("a zero duration means he did not really say one", () => {
    // Taken literally it wrote raw 0 / estimated 0 to the task while the solver applied a
    // 15-minute floor anyway, so the card and the calendar disagreed. Falls back to the
    // block-type default instead.
    for (const t of ["spend 0 mins on email", "gym for 00 mins", "0 hours of deep work"]) {
      expect(statedMinutes(t), t).toBeNull();
    }
    const p = parse("spend 0 mins on email")[0];
    expect(p.estimateSource).toBe("inferred");
    expect(p.rawEstimateMinutes).toBeGreaterThan(0);
  });

  it("a duration longer than a day is clamped to one", () => {
    // A 1440-minute grid cannot hold it however the solver is asked, and 599,940 in the UI
    // is a number nobody can act on. It still reports unplaced — just legibly.
    expect(statedMinutes("9999 hours of deep work")).toBe(1440);
    expect(statedMinutes("spend 1000000 minutes on the deck")).toBe(1440);
    expect(statedMinutes("24 hours of gym")).toBe(1440);
  });

  it("every task the parser emits still has a positive, finite estimate", () => {
    for (const t of [
      "spend 0 mins on email", "9999 hours of deep work", "-5 mins on email",
      "1.5.5 hrs on email", "spend .5 hours on email", "gym for 00 mins",
    ]) {
      for (const p of parse(t)) {
        expect(Number.isFinite(p.rawEstimateMinutes), t).toBe(true);
        expect(p.rawEstimateMinutes, t).toBeGreaterThan(0);
        expect(p.estimatedMinutes, t).toBeGreaterThan(0);
      }
    }
  });
});
