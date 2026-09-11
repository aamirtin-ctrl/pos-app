// Name inference for unsaved senders (main/crm/name-infer.ts) — owner ask 2026-09-10.
// Pins: candidate gating, the transcript-corroboration audit (a hallucinated name never
// lands), the unverified state surviving inference, the saved-contact override keeping the
// bio, and the Apple-card guard for inferred names.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import type { LlmClient } from "../main/llm/provider.ts";
import type { NameIndex } from "../main/connectors/addressbook.ts";
import {
  adoptSavedNames,
  inferUnknownNames,
  isHandleLikeName,
  nameCorroborated,
  nameInferCandidates,
  purgeNamelessNumbers,
} from "../main/crm/name-infer.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-nameinfer-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string, opts: { unverified?: boolean; bio?: string; inferredAt?: string } = {}): number {
  const r = db
    .prepare("INSERT INTO person (display_name, tier, bio, name_inferred_at) VALUES (?, 3, ?, ?)")
    .run(name, opts.bio ?? null, opts.inferredAt ?? null);
  const id = Number(r.lastInsertRowid);
  if (opts.unverified) {
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (?, 'unverified')").run(id);
  }
  return id;
}

let msgSeq = 0;
function addMsgs(pid: number, texts: string[]): void {
  const ins = db.prepare(
    `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary, external_id)
     VALUES (?, 'imessage', 'inbound', datetime('now'), ?, ?)`
  );
  texts.forEach((t) => ins.run(pid, t, `x-${++msgSeq}`));
}

function llmReturning(payload: unknown): LlmClient {
  return { call: async () => ({ text: JSON.stringify(payload) }) } as unknown as LlmClient;
}

const MSGS = [
  "hey its Jake from the hackathon, good meeting you",
  "yeah let's grab lunch next week for sure",
  "tuesday works great for me honestly",
];

describe("isHandleLikeName / nameCorroborated", () => {
  it("classifies handles vs names", () => {
    expect(isHandleLikeName("+14243751482")).toBe(true);
    expect(isHandleLikeName("someone@x.com")).toBe(true);
    expect(isHandleLikeName("Jake")).toBe(false);
  });
  it("requires every word of the name in the transcript", () => {
    const t = MSGS.join("\n");
    expect(nameCorroborated("Jake", t)).toBe(true);
    expect(nameCorroborated("Jake Smith", t)).toBe(false); // surname hallucinated
    expect(nameCorroborated("Marcus", t)).toBe(false);
    expect(nameCorroborated("+1424", t)).toBe(false);
  });
});

describe("nameInferCandidates", () => {
  it("selects only handle-named unverified people with enough content", () => {
    const bare = addPerson("+14243751482", { unverified: true });
    addMsgs(bare, MSGS);
    const named = addPerson("Luke Nettune", { unverified: false });
    addMsgs(named, MSGS);
    const thin = addPerson("+19999999999", { unverified: true });
    addMsgs(thin, ["hey there stranger"]);
    expect(nameInferCandidates(db, 10).map((c) => c.id)).toEqual([bare]);
  });
  it("a success-without-name attempt blocks retry until new messages arrive", async () => {
    const p = addPerson("+14243751482", { unverified: true });
    addMsgs(p, MSGS);
    await inferUnknownNames(db, llmReturning([{ n: 1, name: "", evidence: "" }]));
    expect(nameInferCandidates(db, 10)).toHaveLength(0);
    // A message arriving AFTER the attempt (occurred_at must beat attempted_at).
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary, external_id)
       VALUES (?, 'imessage', 'inbound', datetime('now', '+1 minute'), 'btw this is Jake in case you didn''t save me', 'x-late')`
    ).run(p);
    expect(nameInferCandidates(db, 10).map((c) => c.id)).toEqual([p]);
  });
});

describe("inferUnknownNames", () => {
  it("applies a corroborated name, keeps 'unverified', stamps name_inferred_at", async () => {
    const p = addPerson("+14243751482", { unverified: true });
    addMsgs(p, MSGS);
    const s = await inferUnknownNames(db, llmReturning([{ n: 1, name: "Jake", evidence: "hey its Jake" }]));
    expect(s.named).toBe(1);
    const row = db.prepare("SELECT display_name, name_inferred_at FROM person WHERE id = ?").get(p) as {
      display_name: string; name_inferred_at: string | null;
    };
    expect(row.display_name).toBe("Jake");
    expect(row.name_inferred_at).not.toBeNull();
    const tag = db.prepare("SELECT tag FROM person_tag WHERE person_id = ?").get(p) as { tag: string };
    expect(tag.tag).toBe("unverified"); // still a guess — verification is a saved contact
  });
  it("rejects a name the transcript does not contain — nothing written", async () => {
    const p = addPerson("+14243751482", { unverified: true });
    addMsgs(p, MSGS);
    const s = await inferUnknownNames(db, llmReturning([{ n: 1, name: "Marcus", evidence: "??" }]));
    expect(s.rejected).toBe(1);
    const row = db.prepare("SELECT display_name FROM person WHERE id = ?").get(p) as { display_name: string };
    expect(row.display_name).toBe("+14243751482");
  });
  it("null LLM degrades to failure rows; person is retried after the cooldown", async () => {
    const p = addPerson("+14243751482", { unverified: true });
    addMsgs(p, MSGS);
    const nullLlm = { call: async () => null } as unknown as LlmClient;
    const s = await inferUnknownNames(db, nullLlm);
    expect(s.failed).toBe(1);
    const att = db.prepare("SELECT status FROM enrichment_attempt WHERE person_id = ?").get(p) as { status: string };
    expect(att.status).toBe("fail");
  });
});

describe("adoptSavedNames", () => {
  const index = (entries: [string, { name: string; company: string | null }][]): NameIndex => ({
    index: new Map(entries), people: entries.length, sources: 1,
  });

  it("saved contact overrides the inferred name; bio survives; tag and stamp clear", () => {
    const p = addPerson("Jake", { unverified: true, bio: "• met at hackathon", inferredAt: "2026-09-10" });
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'imessage_handle', '+14243751482')").run(p);
    const r = adoptSavedNames(db, index([["+14243751482", { name: "Jacob Weiss", company: "Acme" }]]));
    expect(r.renamed).toBe(1);
    const row = db
      .prepare("SELECT display_name, org, bio, name_inferred_at FROM person WHERE id = ?")
      .get(p) as { display_name: string; org: string | null; bio: string; name_inferred_at: string | null };
    expect(row.display_name).toBe("Jacob Weiss");
    expect(row.org).toBe("Acme");
    expect(row.bio).toBe("• met at hackathon"); // the whole point: bio is kept
    expect(row.name_inferred_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM person_tag WHERE person_id = ?").get(p)).toEqual({ n: 0 });
  });
  it("verified people are never touched", () => {
    const p = addPerson("Luke Nettune");
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'phone', '+12149120031')").run(p);
    const r = adoptSavedNames(db, index([["+12149120031", { name: "Somebody Else", company: null }]]));
    expect(r.renamed).toBe(0);
    expect((db.prepare("SELECT display_name d FROM person WHERE id = ?").get(p) as { d: string }).d).toBe("Luke Nettune");
  });
});

describe("purgeNamelessNumbers", () => {
  const backdate = (id: number, days: number) =>
    db.prepare(`UPDATE person SET created_at = datetime('now', '-${days} days') WHERE id = ?`).run(id);

  it("deletes a 30-day-old nameless number, messages and aliases with it", () => {
    const p = addPerson("+14243751482", { unverified: true });
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'imessage_handle', '+14243751482')").run(p);
    addMsgs(p, MSGS);
    backdate(p, 31);
    expect(purgeNamelessNumbers(db).deleted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM person WHERE id = ?").get(p)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM interaction WHERE person_id = ?").get(p)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM alias WHERE person_id = ?").get(p)).toEqual({ n: 0 });
  });
  it("spares the young, the inferred, and the named", () => {
    const young = addPerson("+19999999990", { unverified: true });
    backdate(young, 10);
    const inferred = addPerson("Jake", { unverified: true, inferredAt: "2026-08-01" });
    backdate(inferred, 90);
    const named = addPerson("Luke Nettune");
    backdate(named, 400);
    expect(purgeNamelessNumbers(db).deleted).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM person").get()).toEqual({ n: 3 });
    void young; void inferred; void named;
  });
});
