// The 2026-08-05 duplicate-commitment report, layer by layer:
//   (a) "2 items landed ~4 times" → content-hash skip: identical text is decided ONCE and
//       never re-sent to the LLM, on this run or any future one.
//   (b) "these two events are the same thing albeit from different texts" → dedupe_key:
//       the same normalized title + person + due day collapses to ONE row, both inside a
//       batch and across runs (ON CONFLICT keeps the higher confidence, earlier created_at).
//   (c) near-verbatim passthrough → the two-query pipeline: titles come from query 2, and
//       the whole batch costs exactly TWO LLM calls (the Gemini free-tier quota proof).
// Plus the one-shot backfill sweep that collapses what already landed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import {
  extractCommitmentsLlm,
  listCommitments,
  normalizeContent,
  contentHash,
  contentSeen,
  logExtraction,
  slugifyTitle,
  dedupeKeyFor,
} from "../main/crm/commitments.ts";
import { cleanupDuplicateCommitments, CLEANUP_DUPES_KEY } from "../main/workers.ts";
import type { SecretStore } from "../main/secrets.ts";

// isGoogleConnected() only reads GOOGLE_OAUTH_TOKENS — null = not connected, so every
// Google call short-circuits without touching the network.
const noGoogle = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-dedupe-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
  db.prepare("INSERT INTO person (display_name) VALUES ('Omar Reyes')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function addInteraction(body: string, occurredAt: string = yesterday, personId = 1): number {
  const r = db
    .prepare(
      "INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id) VALUES (?, 'imessage', 'inbound', ?, NULL, ?, ?)"
    )
    .run(personId, occurredAt, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

interface FakeLlm extends LlmClient {
  calls: { feature: string; prompt: string }[];
}

/** Two-query fake: `classify` defaults to "everything is a commitment". */
function twoQueryLlm(handlers: {
  classify?: (prompt: string) => unknown;
  normalize?: (prompt: string) => unknown;
}): FakeLlm {
  const calls: { feature: string; prompt: string }[] = [];
  return {
    calls,
    call: async (feature: string, _tier: string, prompt: string) => {
      calls.push({ feature, prompt });
      const isClassify = feature === "commitments-classify";
      const handler = isClassify ? handlers.classify : handlers.normalize;
      const fallback = () =>
        isClassify
          ? [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => ({ n: Number(m[1]), is_commitment: true, confidence: 0.9 }))
          : [];
      return {
        text: JSON.stringify(handler ? handler(prompt) : fallback()),
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  } as unknown as FakeLlm;
}

/** Query 2 answers every survivor with the same fixed headline. */
const sameTitle = (title: string, extra: Record<string, unknown> = {}) => (prompt: string) =>
  [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => ({
    n: Number(m[1]),
    title,
    direction: "i_owe_them",
    due_at: null,
    kind: "task",
    start_time: null,
    confidence: 0.9,
    ...extra,
  }));

// ── content hashing (pure) ───────────────────────────────────────────────────

describe("normalizeContent + contentHash (pure)", () => {
  it("ignores case, punctuation and whitespace differences", () => {
    expect(normalizeContent("Pick up the dry cleaning!!")).toBe("pick up the dry cleaning");
    expect(contentHash("Pick up the dry cleaning!!")).toBe(contentHash("pick up  the dry cleaning"));
    // The iMessage self-thread echo: same text, different trailing whitespace/newlines.
    expect(contentHash("call the bank\n")).toBe(contentHash("Call the bank."));
  });

  it("keeps genuinely different text apart", () => {
    expect(contentHash("call the bank")).not.toBe(contentHash("call the landlord"));
  });

  it("contentSeen flips only after logExtraction, and logging is idempotent", () => {
    const h = contentHash("book the flight to SFO");
    expect(contentSeen(db, h)).toBe(false);
    logExtraction(db, null, h, "capture");
    expect(contentSeen(db, h)).toBe(true);
    logExtraction(db, 7, h, "commitment"); // re-decision must not create a second row
    const rows = db.prepare("SELECT interaction_id, verdict FROM extraction_log WHERE content_hash = ?").all(h) as {
      interaction_id: number | null;
      verdict: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("commitment");
    expect(rows[0].interaction_id).toBe(7); // the first non-null interaction wins
  });
});

// ── dedupe_key (pure) ────────────────────────────────────────────────────────

describe("slugifyTitle + dedupeKeyFor (pure)", () => {
  it("normalizes casing, punctuation and spacing into one slug", () => {
    expect(slugifyTitle("Send Cory the pitch deck")).toBe("send-cory-the-pitch-deck");
    expect(slugifyTitle("  send CORY the  pitch deck!! ")).toBe("send-cory-the-pitch-deck");
  });

  it("caps the slug at 60 characters with no trailing hyphen", () => {
    const slug = slugifyTitle("Send Cory the extremely long and very detailed pitch deck for the seed round");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("the same commitment phrased differently gets the SAME key", () => {
    const a = dedupeKeyFor("Send Cory the pitch deck", 1, "2026-09-01");
    const b = dedupeKeyFor("send cory the PITCH DECK!", 1, "2026-09-01T00:00:00.000Z");
    expect(a).toBe(b);
  });

  it("different days, different people, and undated are all different keys", () => {
    const base = dedupeKeyFor("Send Cory the pitch deck", 1, "2026-09-01");
    expect(dedupeKeyFor("Send Cory the pitch deck", 1, "2026-09-02")).not.toBe(base);
    expect(dedupeKeyFor("Send Cory the pitch deck", 2, "2026-09-01")).not.toBe(base);
    expect(dedupeKeyFor("Send Cory the pitch deck", 1, null)).toContain(":undated:");
    expect(dedupeKeyFor("Send Cory the pitch deck", 1, null)).not.toBe(base);
  });

  it("a title with no alphanumerics has no key (never collapses)", () => {
    expect(dedupeKeyFor("!!! ???", 1, null)).toBeNull();
    expect(dedupeKeyFor("", 1, null)).toBeNull();
  });
});

// ── (a) content-hash skip ────────────────────────────────────────────────────

describe("content-hash skip (owner report (a): the same self-text landing repeatedly)", () => {
  it("identical text in one batch reaches the LLM once and produces ONE commitment", async () => {
    // The iMessage echo: the same note-to-self text lands as several interactions.
    const ids = [
      addInteraction("pick up the dry cleaning"),
      addInteraction("Pick up the dry cleaning!"),
      addInteraction("pick up the  dry cleaning"),
    ];
    const llm = twoQueryLlm({ normalize: sameTitle("Pick up the dry cleaning") });

    const res = await extractCommitmentsLlm(db, llm, ids);
    expect(res.processed).toBe(3); // all three interactions are done with
    expect(res.inserted).toBe(1);

    // Only ONE snippet was ever sent to the model.
    const snippets = llm.calls[0].prompt.split("SNIPPETS:")[1];
    expect(snippets.match(/^\d+\. \[/gm)).toHaveLength(1);

    // Every interaction is marked extracted, and exactly one hash was logged.
    const unextracted = db.prepare("SELECT COUNT(*) AS c FROM interaction WHERE extracted_at IS NULL").get() as { c: number };
    expect(unextracted.c).toBe(0);
    const log = db.prepare("SELECT COUNT(*) AS c FROM extraction_log").get() as { c: number };
    expect(log.c).toBe(1);
  });

  it("a later run of the same text costs ZERO LLM calls and inserts nothing", async () => {
    const first = addInteraction("pick up the dry cleaning");
    const llm1 = twoQueryLlm({ normalize: sameTitle("Pick up the dry cleaning") });
    await extractCommitmentsLlm(db, llm1, [first]);
    expect(listCommitments(db, "open")).toHaveLength(1);

    // The next sync sees the same text again (a different message row entirely).
    const again = addInteraction("Pick up the dry cleaning.", new Date().toISOString());
    const llm2 = twoQueryLlm({ normalize: sameTitle("Pick up the dry cleaning") });
    const res = await extractCommitmentsLlm(db, llm2, [again]);

    expect(llm2.calls).toHaveLength(0); // never re-queried — the quota is untouched
    expect(res.inserted).toBe(0);
    expect(listCommitments(db, "open")).toHaveLength(1);
    // …and it is still marked extracted, so it never comes back either.
    const row = db.prepare("SELECT extracted_at FROM interaction WHERE id = ?").get(again) as { extracted_at: string | null };
    expect(row.extracted_at).toBeTruthy();
  });

  it("a REJECTED verdict is also remembered — junk text is never re-classified", async () => {
    const id = addInteraction("looking at 345 Westwood Court on Google Maps");
    const llm1 = twoQueryLlm({ classify: () => [{ n: 1, is_commitment: false, confidence: 0.95 }] });
    await extractCommitmentsLlm(db, llm1, [id]);
    const verdict = db.prepare("SELECT verdict FROM extraction_log").get() as { verdict: string };
    expect(verdict.verdict).toBe("rejected");

    const again = addInteraction("Looking at 345 Westwood Court on Google Maps!");
    const llm2 = twoQueryLlm({});
    await extractCommitmentsLlm(db, llm2, [again]);
    expect(llm2.calls).toHaveLength(0);
  });
});

// ── (b) semantic collapse ────────────────────────────────────────────────────

describe("dedupe_key collapse (owner report (b): one thing, two different texts)", () => {
  it("collapses inside a single batch: two different messages, one AI title, ONE row", async () => {
    const a = addInteraction("hey can you send over the pitch deck when you get a sec");
    const b = addInteraction("also don't forget the deck for the seed round");
    // The model recognizes both as the same obligation and titles them identically.
    const llm = twoQueryLlm({ normalize: sameTitle("Send Cory the pitch deck") });

    const res = await extractCommitmentsLlm(db, llm, [a, b]);
    expect(res.inserted).toBe(1);
    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(dedupeKeyFor("Send Cory the pitch deck", 1, null));

    // Both source messages are still logged as commitments — neither is re-queried.
    const log = db.prepare("SELECT verdict FROM extraction_log").all() as { verdict: string }[];
    expect(log).toHaveLength(2);
    expect(log.every((r) => r.verdict === "commitment")).toBe(true);
  });

  it("ON CONFLICT keeps the HIGHER confidence (and its title) and the EARLIER created_at", async () => {
    const first = addInteraction("can you send the deck");
    await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("Send Cory the pitch deck", { confidence: 0.6 }) }),
      [first]
    );
    db.prepare("UPDATE commitment SET created_at = '2020-01-01 00:00:00'").run();

    // A second, differently-worded message about the same thing, extracted with more
    // confidence and a differently-cased (but identically normalizing) title.
    const second = addInteraction("the deck — still need it!", new Date().toISOString());
    const res = await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("SEND CORY THE PITCH DECK", { confidence: 0.95 }) }),
      [second]
    );

    expect(res.inserted).toBe(0); // absorbed, not added
    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].description).toBe("SEND CORY THE PITCH DECK"); // the better row's title wins
    expect(rows[0].created_at).toBe("2020-01-01 00:00:00"); // the original's age is kept
  });

  it("a LOWER-confidence repeat never degrades the stored commitment", async () => {
    const first = addInteraction("send the deck please");
    await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("Send Cory the pitch deck", { confidence: 0.95 }) }),
      [first]
    );
    const second = addInteraction("deck?", new Date().toISOString());
    await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("send cory the pitch deck", { confidence: 0.4 }) }),
      [second]
    );
    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].description).toBe("Send Cory the pitch deck");
  });

  it("the same title for a DIFFERENT person or a DIFFERENT day stays a separate commitment", async () => {
    const cory = addInteraction("send the deck", yesterday, 1);
    const omar = addInteraction("the deck, when you can", yesterday, 2);
    await extractCommitmentsLlm(db, twoQueryLlm({ normalize: sameTitle("Send the pitch deck") }), [cory, omar]);
    expect(listCommitments(db, "open")).toHaveLength(2); // one per person

    const dated = addInteraction("deck by then", new Date().toISOString(), 1);
    await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("Send the pitch deck", { due_at: "2026-12-01" }) }),
      [dated]
    );
    expect(listCommitments(db, "open")).toHaveLength(3); // a different day is a different item
  });
});

// ── (c) + quota: the two-query pipeline ──────────────────────────────────────

describe("two-query pipeline (quota proof + AI-normalized titles)", () => {
  it("a 10-candidate batch costs exactly TWO llm.call invocations", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(addInteraction(`please send me document number ${i}`));

    const llm = twoQueryLlm({
      normalize: (prompt) =>
        [...prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => ({
          n: Number(m[1]),
          title: `Send Cory document number ${Number(m[1]) - 1}`,
          direction: "i_owe_them",
          due_at: null,
          kind: "task",
          start_time: null,
          confidence: 0.9,
        })),
    });

    await extractCommitmentsLlm(db, llm, ids);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls.map((c) => c.feature)).toEqual(["commitments-classify", "commitments-normalize"]);

    // Every title is the query-2 headline; none is the near-verbatim snippet (report (c)).
    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(r.description).toMatch(/^Send Cory document number \d$/);
      expect(r.description).not.toContain("please send me");
    }
  });
});

// ── backfill sweep ───────────────────────────────────────────────────────────

function addCommitment(
  description: string,
  confidence: number,
  opts: { status?: string; personId?: number; dueAt?: string | null; createdAt?: string } = {}
): number {
  const r = db
    .prepare(
      `INSERT INTO commitment (person_id, direction, description, due_at, status, confidence, confirmed_by_user, created_at)
       VALUES (?, 'i_owe_them', ?, ?, ?, ?, 0, ?)`
    )
    .run(
      opts.personId ?? 1,
      description,
      opts.dueAt ?? null,
      opts.status ?? "open",
      confidence,
      opts.createdAt ?? "2026-08-04 09:00:00"
    );
  return Number(r.lastInsertRowid);
}

function addTask(commitmentId: number, gtasksId: string | null = null): number {
  const r = db
    .prepare("INSERT INTO task (title, block_type, commitment_id, status, gtasks_id) VALUES ('t', 'admin', ?, 'inbox', ?)")
    .run(commitmentId, gtasksId);
  return Number(r.lastInsertRowid);
}

describe("cleanupDuplicateCommitments (one-shot backfill of what already landed)", () => {
  it("round-trip: keeps the best of each duplicate group, drops the rest, closes their tasks", async () => {
    // The owner's case: the same thing extracted from two different texts, twice over.
    const best = addCommitment("Send Cory the pitch deck", 0.9, { createdAt: "2026-08-04 10:00:00" });
    const dupA = addCommitment("send cory the PITCH DECK", 0.5, { createdAt: "2026-08-04 09:00:00" });
    const dupB = addCommitment("Send Cory the pitch deck!", 0.5, { status: "scheduled", createdAt: "2026-08-04 08:00:00" });
    const dupBTask = addTask(dupB, "g-dup");
    // Same words, different day → a genuinely different commitment; untouched.
    const otherDay = addCommitment("Send Cory the pitch deck", 0.5, { dueAt: "2026-09-01" });
    // Same words, different person → untouched.
    const otherPerson = addCommitment("Send Cory the pitch deck", 0.5, { personId: 2 });
    // Already resolved history is never rewritten.
    const doneDup = addCommitment("Send Cory the pitch deck", 0.99, { status: "done" });
    // A singleton keeps its row and gains a key for future collapses.
    const singleton = addCommitment("Collect the signed lease from Dev", 0.8);

    const res = await cleanupDuplicateCommitments(db, noGoogle);
    expect(res.groups).toBe(1);
    expect(res.dropped).toBe(2);
    expect(res.tasksClosed).toBe(1);

    const statusOf = (id: number) =>
      db.prepare("SELECT status, resolved_at, dedupe_key FROM commitment WHERE id = ?").get(id) as {
        status: string;
        resolved_at: string | null;
        dedupe_key: string | null;
      };

    // The highest-confidence row survives and now owns the key.
    expect(statusOf(best).status).toBe("open");
    expect(statusOf(best).dedupe_key).toBe(dedupeKeyFor("Send Cory the pitch deck", 1, null));
    for (const id of [dupA, dupB]) {
      expect(statusOf(id).status).toBe("dropped");
      expect(statusOf(id).resolved_at).toBeTruthy(); // audit-kept, like dropCommitment
    }
    // The dropped row's task is closed locally (Google is best-effort and not connected).
    const t = db.prepare("SELECT status, completed_at FROM task WHERE id = ?").get(dupBTask) as {
      status: string;
      completed_at: string | null;
    };
    expect(t.status).toBe("done");
    expect(t.completed_at).toBeTruthy();

    // Everything that is NOT a duplicate is untouched, and singletons gain their key.
    for (const id of [otherDay, otherPerson, singleton]) expect(statusOf(id).status).toBe("open");
    expect(statusOf(doneDup).status).toBe("done");
    expect(statusOf(singleton).dedupe_key).toBe(dedupeKeyFor("Collect the signed lease from Dev", 1, null));
  });

  it("is one-shot and idempotent: the flag is set and a rerun touches nothing", async () => {
    addCommitment("Send Cory the pitch deck", 0.9);
    addCommitment("send cory the pitch deck", 0.5);
    const first = await cleanupDuplicateCommitments(db, noGoogle);
    expect(first.dropped).toBe(1);
    expect(getSetting(db, CLEANUP_DUPES_KEY)).toBeTruthy();

    // New duplicates arriving later are the live pipeline's job, not the sweep's.
    const late = addCommitment("Bring Omar cash for the tickets", 0.9);
    const lateDup = addCommitment("bring omar cash for the tickets", 0.4);
    const rerun = await cleanupDuplicateCommitments(db, noGoogle);
    expect(rerun).toEqual({ groups: 0, dropped: 0, tasksClosed: 0 });
    for (const id of [late, lateDup]) {
      expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(id) as { status: string }).status).toBe("open");
    }
  });

  it("stamped keys make the NEXT extraction collapse into the surviving row", async () => {
    const keeper = addCommitment("Send Cory the pitch deck", 0.6);
    addCommitment("send cory the pitch deck!!", 0.5);
    await cleanupDuplicateCommitments(db, noGoogle);

    const fresh = addInteraction("still waiting on that deck");
    const res = await extractCommitmentsLlm(
      db,
      twoQueryLlm({ normalize: sameTitle("Send Cory the pitch deck", { confidence: 0.95 }) }),
      [fresh]
    );
    expect(res.inserted).toBe(0); // merged into the survivor instead of adding a third row
    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(keeper);
    expect(rows[0].confidence).toBe(0.95);
  });
});
