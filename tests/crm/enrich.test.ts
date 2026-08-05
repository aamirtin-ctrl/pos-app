// Profile synthesis + bio-mining (GAP_REPORT #13/#14). DB-only: the LlmClient is a
// fake, so nothing here touches the network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import type { LlmClient } from "../../main/llm/provider.ts";
import {
  synthesizeProfiles,
  mineBios,
  runEnrichment,
  splitBio,
  composeBio,
  isContent,
  MINED_MARKER,
  SYNTHESIS_SOURCE,
  MINING_SOURCE,
} from "../../main/crm/enrich.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-enrich-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function addPerson(name: string, fields: { bio?: string | null; rel?: string | null } = {}): number {
  return Number(
    db
      .prepare("INSERT INTO person (display_name, bio, relationship_summary) VALUES (?, ?, ?)")
      .run(name, fields.bio ?? null, fields.rel ?? null).lastInsertRowid
  );
}

/** N days before now, as an ISO timestamp (matches what the connectors write). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

let extSeq = 0;
function addInteraction(
  personId: number,
  body: string,
  o: { channel?: string; direction?: string; occurredAt?: string; subject?: string | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        personId,
        o.channel ?? "imessage",
        o.direction ?? "inbound",
        o.occurredAt ?? daysAgo(3),
        o.subject ?? null,
        body,
        `ext-${extSeq++}`
      ).lastInsertRowid
  );
}

/** Three content-bearing messages — the minimum that makes a person a candidate. */
function seedConversation(personId: number, extra: string[] = []): void {
  const msgs = [
    "Just closed the seed round for the solar analytics company.",
    "Moving the research lab to Austin next month, it has been a haul.",
    "Teaching a materials science seminar at UVA this fall.",
    ...extra,
  ];
  msgs.forEach((m, i) =>
    addInteraction(personId, m, { occurredAt: daysAgo(10 - i), direction: i % 2 ? "outbound" : "inbound" })
  );
}

/** Fake LlmClient: records prompts, replies with the queued JSON payloads. */
function fakeLlm(replies: unknown[] | (() => unknown)): LlmClient & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const client = {
    calls,
    call: async (_feature: string, _tier: string, prompt: string) => {
      calls.push(prompt);
      const reply = typeof replies === "function" ? replies() : replies[Math.min(i++, replies.length - 1)];
      if (reply === null) return null;
      return { text: JSON.stringify(reply), model: "fake", inputTokens: 0, outputTokens: 0 };
    },
  };
  return client as unknown as LlmClient & { calls: string[] };
}

const ledger = (source?: string) =>
  db
    .prepare(
      source
        ? "SELECT person_id, source, status, detail FROM enrichment_attempt WHERE source = ? ORDER BY id"
        : "SELECT person_id, source, status, detail FROM enrichment_attempt ORDER BY id"
    )
    .all(...(source ? [source] : [])) as {
    person_id: number; source: string; status: string; detail: string | null;
  }[];

const personRow = (id: number) =>
  db
    .prepare("SELECT bio, relationship_summary, profile_synthesized_at FROM person WHERE id = ?")
    .get(id) as { bio: string | null; relationship_summary: string | null; profile_synthesized_at: string | null };

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("splitBio / composeBio", () => {
  it("round-trips a user-authored head plus mined bullets", () => {
    const composed = composeBio("Met at YC. Runs a solar startup.", ["Raising a seed round.", "Based in Austin."]);
    expect(composed).toContain(MINED_MARKER);
    expect(splitBio(composed)).toEqual({
      head: "Met at YC. Runs a solar startup.",
      bullets: ["Raising a seed round.", "Based in Austin."],
    });
  });

  it("treats a bio with no marker as all head, and drops the marker when there are no facts", () => {
    expect(splitBio("Just a note")).toEqual({ head: "Just a note", bullets: [] });
    expect(composeBio("Just a note", [])).toBe("Just a note");
    expect(composeBio("", [])).toBeNull();
    expect(composeBio("", ["Only mined."])).toBe(`${MINED_MARKER}\n• Only mined.`);
  });

  it("is idempotent: recomposing an already-composed bio changes nothing", () => {
    const once = composeBio("Head text.", ["Fact one.", "Fact two."])!;
    const { head, bullets } = splitBio(once);
    expect(composeBio(head, bullets)).toBe(once);
  });
});

describe("isContent", () => {
  it("drops tapbacks, filler, automated mail, and duplicates", () => {
    const seen = new Set<string>();
    expect(isContent("Loved “see you then”", seen)).toBe(false);
    expect(isContent("ok", seen)).toBe(false);
    expect(isContent("Your verification code is 123456", seen)).toBe(false);
    expect(isContent("👍👍👍👍👍👍👍👍👍👍👍👍", seen)).toBe(false);
    expect(isContent("Closed the seed round yesterday", seen)).toBe(true);
    expect(isContent("Closed the seed round yesterday", seen)).toBe(false); // duplicate
  });
});

// ── no LLM ───────────────────────────────────────────────────────────────────

describe("no LLM", () => {
  it("returns zeros and writes nothing", async () => {
    const p = addPerson("Ada", { bio: "Original bio." });
    seedConversation(p);

    const res = await runEnrichment(db, null);
    expect(res.synthesized).toBe(0);
    expect(res.mined).toBe(0);
    expect(res.calls).toBe(0);
    expect(res.synthesis).toMatchObject({ attempted: 0, updated: 0 });
    expect(res.mining).toMatchObject({ attempted: 0, mined: 0 });

    expect(personRow(p)).toEqual({
      bio: "Original bio.",
      relationship_summary: null,
      profile_synthesized_at: null,
    });
    expect(ledger()).toHaveLength(0);
  });
});

// ── synthesis ────────────────────────────────────────────────────────────────

describe("synthesizeProfiles", () => {
  it("writes bio + relationship_summary, stamps the timestamp, logs the ledger", async () => {
    const p = addPerson("Ada");
    seedConversation(p);
    const llm = fakeLlm([
      { bio: "Runs a solar analytics company. Teaches at UVA.", relationship_summary: "Met at YC; you advise on fundraising." },
    ]);

    const res = await synthesizeProfiles(db, llm);
    expect(res).toMatchObject({ attempted: 1, updated: 1, failed: 0 });

    const row = personRow(p);
    expect(row.bio).toBe("Runs a solar analytics company. Teaches at UVA.");
    expect(row.relationship_summary).toBe("Met at YC; you advise on fundraising.");
    expect(row.profile_synthesized_at).toBeTruthy();

    expect(ledger(SYNTHESIS_SOURCE)).toEqual([
      { person_id: p, source: SYNTHESIS_SOURCE, status: "success", detail: "updated 2 fields" },
    ]);
  });

  it("carries the anti-hallucination discipline into the prompt", async () => {
    const p = addPerson("Ada", { bio: "Known bio." });
    seedConversation(p);
    const llm = fakeLlm([{ bio: "Known bio.", relationship_summary: "" }]);
    await synthesizeProfiles(db, llm);
    const prompt = llm.calls[0];
    expect(prompt).toContain("STRICT JSON ONLY");
    expect(prompt).toContain("repeat the existing bio verbatim");
    expect(prompt).toMatch(/Leave a field EMPTY rather than infer/);
    expect(prompt).toContain("Known bio.");
  });

  it("never overwrites a good record with empty output, but still stamps and logs", async () => {
    const p = addPerson("Ada", { bio: "Hand-written bio.", rel: "Old summary." });
    seedConversation(p);
    const llm = fakeLlm([{ bio: "", relationship_summary: "" }]);

    const res = await synthesizeProfiles(db, llm);
    expect(res).toMatchObject({ attempted: 1, updated: 0 });
    const row = personRow(p);
    expect(row.bio).toBe("Hand-written bio.");
    expect(row.relationship_summary).toBe("Old summary.");
    expect(row.profile_synthesized_at).toBeTruthy();
    expect(ledger(SYNTHESIS_SOURCE)[0]).toMatchObject({ status: "success", detail: "no change" });
  });

  it("logs a fail row (and spends budget) when the LLM returns null", async () => {
    const p = addPerson("Ada");
    seedConversation(p);
    const res = await synthesizeProfiles(db, fakeLlm([null]));
    expect(res).toMatchObject({ attempted: 1, updated: 0, failed: 1 });
    expect(personRow(p).profile_synthesized_at).toBeNull();
    expect(ledger(SYNTHESIS_SOURCE)[0]).toMatchObject({ status: "fail" });
  });

  it("skips people with fewer than 3 content-bearing interactions without calling the LLM", async () => {
    const thin = addPerson("Thin");
    addInteraction(thin, "Something genuinely substantive happened today.");
    addInteraction(thin, "ok"); // filler, and too short
    addInteraction(thin, "Loved “that works for me”"); // tapback
    addInteraction(thin, "Another sentence with actual content in it.");

    const llm = fakeLlm([{ bio: "should not happen", relationship_summary: "" }]);
    const res = await synthesizeProfiles(db, llm);
    expect(llm.calls).toHaveLength(0);
    expect(res).toMatchObject({ attempted: 0, skippedThin: 1 });
  });

  it("re-picks a person only after new interactions land past profile_synthesized_at", async () => {
    const p = addPerson("Ada");
    seedConversation(p);
    await synthesizeProfiles(db, fakeLlm([{ bio: "First pass.", relationship_summary: "" }]));

    const second = fakeLlm([{ bio: "Second pass.", relationship_summary: "" }]);
    expect(await synthesizeProfiles(db, second)).toMatchObject({ attempted: 0 });
    expect(second.calls).toHaveLength(0);

    addInteraction(p, "New development: acquired by a bigger solar firm.", {
      occurredAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const third = fakeLlm([{ bio: "Third pass.", relationship_summary: "" }]);
    expect(await synthesizeProfiles(db, third)).toMatchObject({ attempted: 1, updated: 1 });
    expect(personRow(p).bio).toBe("Third pass.");
  });

  it("preserves mined bullets when synthesis rewrites the head", async () => {
    const p = addPerson("Ada", { bio: composeBio("Old head.", ["Raising a seed round."]) });
    seedConversation(p);
    await synthesizeProfiles(db, fakeLlm([{ bio: "New head.", relationship_summary: "" }]));
    expect(splitBio(personRow(p).bio)).toEqual({ head: "New head.", bullets: ["Raising a seed round."] });
  });

  it("respects the daily budget: no calls past the cap", async () => {
    for (const name of ["A", "B", "C"]) seedConversation(addPerson(name));
    const llm = fakeLlm(() => ({ bio: "Synthesized.", relationship_summary: "Summary." }));

    const first = await synthesizeProfiles(db, llm, { budget: 2 });
    expect(first).toMatchObject({ attempted: 2, updated: 2, budgetLeft: 0 });
    expect(llm.calls).toHaveLength(2);

    // Budget is counted from today's ledger rows, so a second pass adds nothing.
    const second = await synthesizeProfiles(db, llm, { budget: 2 });
    expect(second).toMatchObject({ attempted: 0, budgetLeft: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(ledger(SYNTHESIS_SOURCE)).toHaveLength(2);

    // Raising the cap lets the third person through.
    const third = await synthesizeProfiles(db, llm, { budget: 3 });
    expect(third).toMatchObject({ attempted: 1 });
    expect(ledger(SYNTHESIS_SOURCE)).toHaveLength(3);
  });

  it("honours the limit option independently of the budget", async () => {
    for (const name of ["A", "B", "C"]) seedConversation(addPerson(name));
    const llm = fakeLlm(() => ({ bio: "Synthesized.", relationship_summary: "" }));
    const res = await synthesizeProfiles(db, llm, { limit: 1, budget: 10 });
    expect(res.attempted).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });
});

// ── mining ───────────────────────────────────────────────────────────────────

describe("mineBios", () => {
  it("appends facts under the marker, keeping the user-authored head intact", async () => {
    const p = addPerson("Ada", { bio: "Met at YC 2024. My favourite person to argue with." });
    seedConversation(p);
    const llm = fakeLlm([{ facts: ["Raising a seed round for solar analytics.", "Teaching at UVA this fall."] }]);

    const res = await mineBios(db, llm);
    expect(res).toMatchObject({ attempted: 1, mined: 1, failed: 0 });

    const bio = personRow(p).bio!;
    expect(bio.startsWith("Met at YC 2024. My favourite person to argue with.")).toBe(true);
    expect(bio).toContain(MINED_MARKER);
    expect(splitBio(bio)).toEqual({
      head: "Met at YC 2024. My favourite person to argue with.",
      bullets: ["Raising a seed round for solar analytics.", "Teaching at UVA this fall."],
    });
    expect(ledger(MINING_SOURCE)).toEqual([
      { person_id: p, source: MINING_SOURCE, status: "success", detail: "2 facts" },
    ]);
  });

  it("replaces the mined section (consolidation) without touching the head", async () => {
    const p = addPerson("Ada", { bio: composeBio("Hand-written head.", ["Stale fact."]) });
    seedConversation(p);
    await mineBios(db, fakeLlm([{ facts: ["Consolidated fact."] }]));
    expect(splitBio(personRow(p).bio)).toEqual({
      head: "Hand-written head.",
      bullets: ["Consolidated fact."],
    });
  });

  it("feeds the transcript and existing bullets to the prompt, minus filler", async () => {
    const p = addPerson("Ada", { bio: composeBio("Head.", ["Existing fact."]) });
    seedConversation(p);
    addInteraction(p, "ok"); // filler must not reach the model
    const llm = fakeLlm([{ facts: ["Existing fact."] }]);
    await mineBios(db, llm);
    const prompt = llm.calls[0];
    expect(prompt).toContain("- Existing fact.");
    expect(prompt).toContain("closed the seed round");
    expect(prompt).not.toMatch(/: ok$/m);
    expect(prompt).toContain("Head.");
  });

  it("skips thin conversations before spending a call", async () => {
    const p = addPerson("Thin");
    addInteraction(p, "A real sentence with content.");
    addInteraction(p, "Another real sentence with content.");
    addInteraction(p, "ok");
    const llm = fakeLlm([{ facts: ["nope"] }]);
    expect(await mineBios(db, llm)).toMatchObject({ attempted: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it("ignores conversation older than the 6-month window", async () => {
    const p = addPerson("Stale");
    seedConversation(p);
    db.prepare("UPDATE interaction SET occurred_at = ? WHERE person_id = ?").run(daysAgo(400), p);
    const llm = fakeLlm([{ facts: ["nope"] }]);
    expect(await mineBios(db, llm)).toMatchObject({ attempted: 0 });
    expect(llm.calls).toHaveLength(0);
  });

  it("does not re-mine before the cadence elapses", async () => {
    const p = addPerson("Ada");
    seedConversation(p);
    await mineBios(db, fakeLlm([{ facts: ["First fact."] }]));
    const again = fakeLlm([{ facts: ["Second fact."] }]);
    expect(await mineBios(db, again)).toMatchObject({ attempted: 0 });
    expect(again.calls).toHaveLength(0);
    expect(splitBio(personRow(p).bio).bullets).toEqual(["First fact."]);
  });

  it("respects the daily budget: no calls past the cap", async () => {
    for (const name of ["A", "B", "C"]) seedConversation(addPerson(name));
    const llm = fakeLlm(() => ({ facts: ["A durable fact."] }));

    expect(await mineBios(db, llm, { budget: 2 })).toMatchObject({ attempted: 2, mined: 2, budgetLeft: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(await mineBios(db, llm, { budget: 2 })).toMatchObject({ attempted: 0 });
    expect(llm.calls).toHaveLength(2);
    expect(ledger(MINING_SOURCE)).toHaveLength(2);
  });

  it("logs a fail row when the LLM returns unparseable output", async () => {
    const p = addPerson("Ada", { bio: "Head." });
    seedConversation(p);
    const llm = {
      call: async () => ({ text: "sorry, I cannot help with that", model: "fake", inputTokens: 0, outputTokens: 0 }),
    } as unknown as LlmClient;
    expect(await mineBios(db, llm)).toMatchObject({ attempted: 1, failed: 1, mined: 0 });
    expect(personRow(p).bio).toBe("Head.");
    expect(ledger(MINING_SOURCE)[0]).toMatchObject({ status: "fail", detail: "unparseable JSON" });
  });
});

// ── entry point ──────────────────────────────────────────────────────────────

describe("runEnrichment", () => {
  it("runs both passes and reports combined counts", async () => {
    const p = addPerson("Ada", { bio: "Head." });
    seedConversation(p);
    const llm = fakeLlm(() => ({
      bio: "Synthesized head.",
      relationship_summary: "Long-time collaborator.",
      facts: ["Raising a seed round."],
    }));

    const res = await runEnrichment(db, llm);
    expect(res).toMatchObject({ synthesized: 1, mined: 1, calls: 2 });

    const row = personRow(p);
    expect(splitBio(row.bio)).toEqual({ head: "Synthesized head.", bullets: ["Raising a seed round."] });
    expect(row.relationship_summary).toBe("Long-time collaborator.");
    expect(ledger().map((l) => l.source)).toEqual([SYNTHESIS_SOURCE, MINING_SOURCE]);
  });
});
