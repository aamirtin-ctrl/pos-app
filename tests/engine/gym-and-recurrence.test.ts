// The gym-extraction rule, and "everyday" as a recurrence marker.
//
// Owner report 2026-08-06: "I texted myself I need time to workout and gym everyday. The app
// populated time to film today but not to gym, and it didn't add time for this on any of the
// other days." His exact sentence: "Everyday I need 30 minutes schedule to film, edit, and
// post insta video and 1.25 hrs for the gym."

import { describe, it, expect } from "vitest";
import { workSegments, parseRecurrence, deterministicParse } from "../../main/engine/parse.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const TODAY = "2026-08-06";

describe("parseRecurrence", () => {
  it("hears every phrasing", () => {
    for (const t of ["everyday", "every day", "each day", "daily"]) {
      expect(parseRecurrence(`I need to gym ${t}`), t).toBe("daily");
    }
  });
  it("is null for a one-off", () => {
    expect(parseRecurrence("gym today")).toBeNull();
  });
});

describe("gym extraction", () => {
  it("pulls gym out even when conjoined onto something else", () => {
    const segs = workSegments("post insta video and 1.25 hrs for the gym");
    expect(segs.some((s) => /gym/i.test(s.work))).toBe(true);
    expect(segs.find((s) => /gym/i.test(s.work))!.work).toMatch(/1\.25\s*hrs/i);
  });

  it("still finds gym when it is the whole sentence", () => {
    const segs = workSegments("1.25 hrs for the gym");
    expect(segs).toHaveLength(1);
    expect(segs[0].work).toMatch(/gym/i);
  });

  it("leaves the rest of the sentence intact once gym is pulled", () => {
    const segs = workSegments("edit and post the video, and the gym");
    expect(segs.some((s) => /video/i.test(s.work))).toBe(true);
    expect(segs.some((s) => /gym/i.test(s.work) && !/video/i.test(s.work))).toBe(true);
  });

  it("does not fire on unrelated words containing similar substrings", () => {
    const segs = workSegments("reorganize the gymnasium schedule for next semester");
    // "gymnasium" must not be sliced into "gym" + "nasium" — the whole sentence stays one task.
    expect(segs).toHaveLength(1);
  });
});

describe("his actual sentence, end to end through the no-model path", () => {
  const SAID = "Everyday I need 30 minutes schedule to film, edit, and post insta video and 1.25 hrs for the gym.";

  it("produces a gym task carrying its stated duration and the recurrence", () => {
    const tasks = deterministicParse(SAID, doctrine, TODAY);
    const gym = tasks.find((t) => /gym/i.test(t.title));
    expect(gym, JSON.stringify(tasks.map((t) => t.title))).toBeTruthy();
    expect(gym!.blockType).toBe("gym");
    expect(gym!.rawEstimateMinutes).toBe(75); // 1.25 hrs
    expect(gym!.recurrence).toBe("daily");
  });

  it("the gym task is marked recurring even when the recurrence word sits at the FRONT of the sentence", () => {
    // "Everyday" modifies the whole sentence, not just the film half — the gym segment must
    // still see it even though gym is extracted as its own fragment near the end.
    const tasks = deterministicParse(SAID, doctrine, TODAY);
    const gym = tasks.find((t) => /gym/i.test(t.title))!;
    expect(gym.recurrence).toBe("daily");
  });
});
