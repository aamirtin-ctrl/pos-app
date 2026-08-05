// Deterministic (llm = null) path of the commitment extractor.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  extractCommitmentsLlm,
  confirmCommitment,
  dropCommitment,
  listCommitments,
} from "../../main/crm/commitments.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-commit-"));
  db = openDb(path.join(dir, "pos.db"));
  db.prepare("INSERT INTO person (display_name) VALUES ('Cory Levy')").run();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addInteraction(subject: string | null, body: string | null, occurredAt: string): number {
  const r = db
    .prepare(
      "INSERT INTO interaction (person_id, channel, direction, occurred_at, subject, body_summary, external_id) VALUES (1, 'gmail', 'inbound', ?, ?, ?, ?)"
    )
    .run(occurredAt, subject, body, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

describe("extractCommitmentsLlm (llm = null → deterministic fallback)", () => {
  it("extracts a follow-up as an unconfirmed commitment (confidence capped at 0.5, i_owe_them)", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(1);
    expect(res.needsReview).toBe(1); // 0.5 < REVIEW_CONFIDENCE — always queued for review

    const rows = listCommitments(db, "open");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: 1,
      direction: "i_owe_them",
      confidence: 0.5, // deterministic fragments never clear the autonomy threshold
      confirmed_by_user: 0,
      status: "open",
      source_interaction_id: id,
    });
  });

  it("dated plan yields a due_at; chatter yields nothing", async () => {
    const plan = addInteraction(null, "let's grab coffee next week", yesterday);
    const chatter = addInteraction(null, "haha that's hilarious", yesterday);
    const res = await extractCommitmentsLlm(db, null, [plan, chatter]);
    expect(res.processed).toBe(2);
    const rows = listCommitments(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].due_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].source_interaction_id).toBe(plan);
  });

  it("sets interaction.extracted_at so re-runs skip", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    await extractCommitmentsLlm(db, null, [id]);
    const row = db.prepare("SELECT extracted_at FROM interaction WHERE id = ?").get(id) as {
      extracted_at: string | null;
    };
    expect(row.extracted_at).toBeTruthy();

    const rerun = await extractCommitmentsLlm(db, null, [id]);
    expect(rerun.processed).toBe(0);
    expect(rerun.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(1); // no duplicates
  });

  it("gerund-headed fragments (subject-line status updates) are gated out", async () => {
    // Subject + body join to "Catching up — we should catch up soon!" — a status-update
    // head, not an imperative task, so the sanity gate rejects it before insert.
    const id = addInteraction("Catching up", "we should catch up soon!", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.processed).toBe(1);
    expect(res.inserted).toBe(0);
    expect(listCommitments(db)).toHaveLength(0);
  });

  it("automated/OTP interactions never produce commitments", async () => {
    const id = addInteraction(null, "Your verification code is 482913. Do not reply.", yesterday);
    const res = await extractCommitmentsLlm(db, null, [id]);
    expect(res.inserted).toBe(0);
    expect(res.processed).toBe(1); // still marked extracted
  });

  it("confirm / drop / list lifecycle", async () => {
    const id = addInteraction(null, "we should catch up soon!", yesterday);
    await extractCommitmentsLlm(db, null, [id]);
    const c = listCommitments(db, "open")[0];

    confirmCommitment(db, c.id);
    expect(listCommitments(db, "open")[0].confirmed_by_user).toBe(1);

    dropCommitment(db, c.id);
    expect(listCommitments(db, "open")).toHaveLength(0);
    const dropped = listCommitments(db, "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].resolved_at).toBeTruthy();
  });

  it("empty input is a no-op", async () => {
    expect(await extractCommitmentsLlm(db, null, [])).toEqual({
      inserted: 0,
      needsReview: 0,
      processed: 0,
    });
  });
});
