import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { prefilter, inquiryTokens, rank, type RankPerson } from "../../main/crm/ranking.ts";

const P = (
  id: number,
  display_name: string,
  extra: Partial<Omit<RankPerson, "id" | "display_name">> = {}
): RankPerson => ({
  id,
  display_name,
  role: null,
  org: null,
  bio: null,
  relationship_summary: null,
  tags: [],
  ...extra,
});

describe("inquiryTokens", () => {
  it("drops stopwords and short tokens, dedupes", () => {
    expect(inquiryTokens("who can help me find an intro to a robotics investor investor")).toEqual([
      "robotics",
      "investor",
    ]);
    expect(inquiryTokens("the and for")).toEqual([]);
  });
});

describe("prefilter scoring (tags x3 > role/org x2 > bio x1)", () => {
  const people = [
    P(1, "Tag Match", { tags: ["robotics"] }),
    P(2, "Role Match", { role: "Robotics engineer" }),
    P(3, "Org Match", { org: "Robotics Inc" }),
    P(4, "Bio Match", { bio: "Worked on robotics in college" }),
    P(5, "No Match", { bio: "Loves gardening" }),
  ];

  it("weights tag hits over role/org over bio", () => {
    const hits = prefilter("robotics", people);
    expect(hits.map((h) => h.person.id)).toEqual([1, 3, 2, 4]); // 3, 2, 2, 1 (ties alpha)
    expect(hits[0].score).toBe(3);
    expect(hits[1].score).toBe(2);
    expect(hits[3].score).toBe(1);
    expect(hits.find((h) => h.person.id === 5)).toBeUndefined();
  });

  it("accumulates across tokens and reports matchedTags", () => {
    const p = P(9, "Multi", { tags: ["construction-tech", "investor"], role: "GP" });
    const [hit] = prefilter("construction tech investor", [p]);
    expect(hit.score).toBe(9); // construction(3) + tech(3) + investor(3)
    expect(hit.matchedTags).toEqual(["construction-tech", "investor"]);
  });

  it("relationship_summary counts in the bio bucket", () => {
    const p = P(10, "Rel", { relationship_summary: "met at a robotics meetup" });
    expect(prefilter("robotics", [p])[0].score).toBe(1);
  });

  it("empty / all-stopword inquiry → no hits", () => {
    expect(prefilter("", people)).toEqual([]);
    expect(prefilter("can you help", people)).toEqual([]);
  });

  it("caps at 25 hits", () => {
    const many = Array.from({ length: 40 }, (_, i) => P(i + 1, `p${i}`, { tags: ["robotics"] }));
    expect(prefilter("robotics", many)).toHaveLength(25);
  });
});

describe("rank (llm = null → prefilter-order fallback)", () => {
  let dir: string;
  let db: Db;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-rank-"));
    db = openDb(path.join(dir, "pos.db"));
    db.prepare("INSERT INTO person (id, display_name, role) VALUES (1, 'Ada', 'Robotics engineer')").run();
    db.prepare("INSERT INTO person (id, display_name) VALUES (2, 'Bob')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (2, 'robotics')").run();
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns up to 3 results in prefilter order with keyword reasons, usedLlm=false", async () => {
    const out = await rank(db, null, "intro to someone in robotics");
    expect(out.usedLlm).toBe(false);
    expect(out.results.map((r) => r.person.id)).toEqual([2, 1]); // tag beats role
    expect(out.results[0].reason).toContain("robotics");
  });

  it("no token overlap → empty results", async () => {
    const out = await rank(db, null, "quantum finance wizard");
    expect(out.results).toEqual([]);
  });
});
