import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { MINED_MARKER } from "../../main/crm/enrich.ts";
import {
  isFullName,
  pdlEvidence,
  runWebEnrichment,
  webCandidates,
  type PdlFetch,
  type SearchFetch,
} from "../../main/crm/webenrich.ts";
import type { LlmClient } from "../../main/llm/provider.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-webenrich-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string, f: { org?: string; bio?: string; linkedin?: string; inferred?: boolean } = {}): number {
  const id = Number(
    db
      .prepare("INSERT INTO person (display_name, org, bio, name_inferred_at) VALUES (?, ?, ?, ?)")
      .run(name, f.org ?? null, f.bio ?? null, f.inferred ? "2026-10-01" : null).lastInsertRowid
  );
  if (f.linkedin) db.prepare("INSERT INTO alias (person_id, kind, value, source) VALUES (?, 'linkedin', ?, 't')").run(id, f.linkedin);
  return id;
}
const person = (id: number) => db.prepare("SELECT * FROM person WHERE id = ?").get(id) as Record<string, any>;

/** Fake LLM: answers each call with the next canned payload, records prompts. */
function fakeLlm(...payloads: unknown[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async call(_f: string, _t: string, prompt: string) {
      prompts.push(prompt);
      const p = payloads.shift();
      return p === undefined ? null : { text: JSON.stringify(p), model: "fake", inputTokens: 0, outputTokens: 0 };
    },
  } as unknown as LlmClient & { prompts: string[] };
}

const PDL_HIT = {
  status: 200,
  data: {
    job_title: "senior director of alumni engagement",
    job_company_name: "st. mark's school of texas",
    location_name: true, // free-tier redaction
    education: [{ school: { name: "the university of kansas" }, majors: [] }],
    linkedin_url: "linkedin.com/in/alex-e",
  },
};

describe("isFullName", () => {
  it("needs two real name words", () => {
    expect(isFullName("Miles Bliey")).toBe(true);
    expect(isFullName("Wyatt")).toBe(false);
    expect(isFullName("+1 415 555 0100")).toBe(false);
    expect(isFullName("Mom ❤️")).toBe(false);
  });
});

describe("pdlEvidence", () => {
  it("summarizes the record and drops redacted (boolean) fields", () => {
    const ev = pdlEvidence(PDL_HIT)!;
    expect(ev).toContain("current: senior director of alumni engagement at st. mark's school of texas");
    expect(ev).toContain("education: the university of kansas");
    expect(ev).not.toContain("location");
  });
  it("null for no data", () => {
    expect(pdlEvidence(null)).toBeNull();
    expect(pdlEvidence({ status: 404 })).toBeNull();
  });
});

describe("webCandidates", () => {
  it("LinkedIn-holders first; skips first-name-only, inferred names, and recent lookups", () => {
    const named = addPerson("Miles Bliey");
    const li = addPerson("Alex Eshelbrenner", { linkedin: "https://www.linkedin.com/in/alex-e" });
    addPerson("Wyatt");
    addPerson("Jake Guess", { inferred: true });
    const done = addPerson("Done Already");
    db.prepare("INSERT INTO enrichment_attempt (person_id, source, status, detail) VALUES (?, 'web', 'success', 'x')").run(done);
    const llmDown = addPerson("Retry Me");
    db.prepare("INSERT INTO enrichment_attempt (person_id, source, status, detail) VALUES (?, 'web', 'fail', 'llm unavailable (search)')").run(llmDown);
    expect(webCandidates(db, 10).map((c) => c.id)).toEqual([li, named, llmDown]);
  });
});

describe("runWebEnrichment", () => {
  const keys = { pdl: "k", firecrawl: "k" };

  it("PDL identifier match fills empty fields, keeps mined bullets, never overwrites", async () => {
    const id = addPerson("Alex Eshelbrenner", {
      linkedin: "https://www.linkedin.com/in/alex-e",
      org: "St. Mark's",
      bio: `${MINED_MARKER}\n• Runs alumni events`,
    });
    let pdlParams = "";
    const pdl: PdlFetch = async (p) => ((pdlParams = p.toString()), PDL_HIT);
    const search: SearchFetch = async () => {
      throw new Error("search must not run after an identifier match");
    };
    const llm = fakeLlm([
      { n: 1, same_person: true, org: "St. Mark's School of Texas", role: "Senior Director of Alumni Engagement", bio: "Senior Director of Alumni Engagement at St. Mark's School of Texas. Studied at the University of Kansas." },
    ]);
    const r = await runWebEnrichment(db, llm, keys, { io: { pdl, search } });
    expect(pdlParams).toContain("profile=linkedin.com%2Fin%2Falex-e");
    expect(llm.prompts[0]).toContain("identifier match");
    expect(r).toMatchObject({ attempted: 1, enriched: 1, pdlCalls: 1, searches: 0 });
    const p = person(id);
    expect(p.org).toBe("St. Mark's"); // existing value kept
    expect(p.role).toBe("Senior Director of Alumni Engagement");
    expect(p.bio).toContain("Senior Director of Alumni Engagement at St. Mark's School of Texas.");
    expect(p.bio).toContain("• Runs alumni events");
  });

  it("web search: a non-corroborated match writes nothing and cools down", async () => {
    const id = addPerson("Miles Bliey");
    const search: SearchFetch = async (q) => {
      expect(q).toBe('"Miles Bliey"');
      return [{ url: "https://x", title: "Miles Bliey - Somewhere", description: "..." }];
    };
    const llm = fakeLlm([{ n: 1, same_person: false }]);
    const r = await runWebEnrichment(db, llm, keys, { io: { pdl: async () => null, search } });
    expect(r).toMatchObject({ attempted: 1, enriched: 0, noMatch: 1, searches: 1, pdlCalls: 0 });
    expect(person(id).bio).toBeNull();
    expect(webCandidates(db, 10)).toEqual([]); // 30-day cooldown
  });

  it("web search match adds the LinkedIn URL as an alias", async () => {
    const id = addPerson("Miles Bliey", { org: "Stanford" });
    const search: SearchFetch = async () => [
      { url: "https://www.linkedin.com/in/milesbliey", title: "Miles Bliey - Stanford University", description: "" },
    ];
    const llm = fakeLlm([
      { n: 1, same_person: true, role: "Undergraduate, MS&E and Mathematics", linkedin_url: "https://www.linkedin.com/in/milesbliey", bio: "Stanford undergraduate studying Management Science and Engineering and Mathematics." },
    ]);
    await runWebEnrichment(db, llm, keys, { io: { pdl: async () => null, search } });
    const alias = db.prepare("SELECT value FROM alias WHERE person_id = ? AND kind = 'linkedin'").get(id) as { value: string };
    expect(alias.value).toBe("https://www.linkedin.com/in/milesbliey");
    expect(person(id).role).toBe("Undergraduate, MS&E and Mathematics");
  });

  it("LLM down: nothing written, people stay eligible for the next pass", async () => {
    addPerson("Miles Bliey");
    const search: SearchFetch = async () => [{ url: "u", title: "t", description: "d" }];
    const r = await runWebEnrichment(db, fakeLlm(), keys, { io: { pdl: async () => null, search } });
    expect(r.attempted).toBe(1);
    expect(webCandidates(db, 10)).toHaveLength(1);
  });

  it("no keys or no LLM: no network at all", async () => {
    addPerson("Miles Bliey");
    const boom = async () => {
      throw new Error("network");
    };
    expect((await runWebEnrichment(db, null, keys, { io: { pdl: boom, search: boom } })).attempted).toBe(0);
    expect((await runWebEnrichment(db, fakeLlm(), { pdl: null, firecrawl: null }, { io: { pdl: boom, search: boom } })).attempted).toBe(0);
  });
});

describe("daily cap", () => {
  it("a second pass the same day spends nothing once the day's quota is used", async () => {
    addPerson("Miles Bliey");
    addPerson("Abir Chadha");
    let searches = 0;
    const search: SearchFetch = async () => (searches++, [{ url: "u", title: "t", description: "d" }]);
    const llm = fakeLlm([{ n: 1, same_person: false }], [{ n: 1, same_person: false }]);
    await runWebEnrichment(db, llm, { pdl: null, firecrawl: "k" }, { limit: 1, io: { pdl: async () => null, search } });
    await runWebEnrichment(db, llm, { pdl: null, firecrawl: "k" }, { limit: 1, io: { pdl: async () => null, search } });
    expect(searches).toBe(1);
  });
});
