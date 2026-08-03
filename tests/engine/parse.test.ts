import { describe, it, expect } from "vitest";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";
import { deterministicParse, parseBraindump } from "../../main/engine/parse.ts";
import { deterministicNarration } from "../../main/engine/narrate.ts";
import { solve } from "../../main/engine/solver.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);

describe("deterministic parse (LLM-off fallback)", () => {
  it("splits a braindump and classifies block types", () => {
    const tasks = deterministicParse(
      "finish the Novum quote, call the fabricator, 2hrs on the physics pset, gym, reply to Sarah",
      doctrine
    );
    expect(tasks.length).toBe(5);
    const pset = tasks.find((t) => /physics/i.test(t.title))!;
    expect(pset.blockType).toBe("deep_work");
    expect(pset.rawEstimateMinutes).toBe(120);
    expect(pset.estimateSource).toBe("stated");
    expect(pset.estimatedMinutes).toBe(150); // 120 × 1.25
    expect(tasks.find((t) => /gym/i.test(t.title))!.blockType).toBe("gym");
    expect(tasks.find((t) => /reply to sarah/i.test(t.title))!.blockType).toBe("comms");
  });

  it("never assigns times — parse output has no schedule fields", () => {
    const tasks = deterministicParse("write essay, gym", doctrine);
    for (const t of tasks) {
      expect(t).not.toHaveProperty("startMin");
      expect(t).not.toHaveProperty("startsAt");
    }
  });

  it("parseBraindump with llm=null uses the fallback and reports usedLlm=false", async () => {
    const { tasks, usedLlm } = await parseBraindump("write essay", doctrine, null);
    expect(usedLlm).toBe(false);
    expect(tasks.length).toBe(1);
  });
});

describe("full pipeline: braindump → parse → solve → narrate (no LLM)", () => {
  it("produces a plan end-to-end deterministically", async () => {
    const { tasks } = await parseBraindump(
      "3hrs physics pset, reply to Sarah, book dentist, gym, 1h essay outline",
      doctrine
    );
    const planner = tasks.map((t, i) => ({
      id: i + 1,
      title: t.title,
      blockType: t.blockType,
      cognitiveLoad: t.cognitiveLoad,
      estimatedMinutes: t.estimatedMinutes,
      isMit: t.isMit,
      deadlineMin: null,
      project: null,
      splittable: t.splittable,
    }));
    const r = solve(planner, doctrine, []);
    expect(r.blocks.length).toBeGreaterThan(3);
    const narration = deterministicNarration(r);
    expect(narration.length).toBeGreaterThan(20);
    expect(narration).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji
  });
});
