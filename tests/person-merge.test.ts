// mergePersons (main/crm/merge.ts): the explicit join for the named-person / number-person
// split (owner ask 2026-08-20 — Luke Nettune vs +12149120031).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { mergePersons } from "../main/crm/merge.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-merge-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string, over: { org?: string; role?: string; bio?: string; tier?: number } = {}): number {
  const r = db
    .prepare("INSERT INTO person (display_name, tier, org, role, bio) VALUES (?, ?, ?, ?, ?)")
    .run(name, over.tier ?? 2, over.org ?? null, over.role ?? null, over.bio ?? null);
  return Number(r.lastInsertRowid);
}
const addAlias = (pid: number, kind: string, value: string) =>
  db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, ?, ?)").run(pid, kind, value);
const addInteraction = (pid: number, body: string) =>
  db.prepare("INSERT INTO interaction (person_id, channel, occurred_at, body_raw) VALUES (?, 'imessage', datetime('now'), ?)").run(pid, body);

describe("mergePersons", () => {
  it("moves interactions, aliases and commitments; deletes the duplicate", () => {
    const named = addPerson("Luke Nettune", { org: "LAN Tutoring" });
    const number = addPerson("+12149120031", { tier: 3 });
    addAlias(number, "imessage_handle", "+12149120031");
    addInteraction(number, "yo");
    addInteraction(number, "sounds good");
    db.prepare("INSERT INTO commitment (person_id, description) VALUES (?, 'send invoice')").run(number);

    const r = mergePersons(db, named, number);
    expect(r.moved.interaction).toBe(2);
    expect(r.moved.alias).toBe(1);
    expect(r.moved.commitment).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM person WHERE id = ?").get(number)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM interaction WHERE person_id = ?").get(named)).toMatchObject({ n: 2 });
    expect(db.prepare("SELECT person_id FROM alias WHERE value = '+12149120031'").get()).toMatchObject({ person_id: named });
  });

  it("all of the loser's aliases land on the survivor (UNIQUE(kind,value) is global, so no collisions exist)", () => {
    const a = addPerson("A");
    const b = addPerson("B");
    addAlias(a, "email", "x@y.com");
    addAlias(b, "phone", "+15550001111");
    addAlias(b, "linkedin", "linkedin.com/in/b");
    mergePersons(db, a, b);
    const rows = db.prepare("SELECT kind FROM alias WHERE person_id = ? ORDER BY kind").all(a) as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["email", "linkedin", "phone"]);
  });

  it("survivor's fields win; blanks fill; bio bullets union", () => {
    const a = addPerson("A", { role: "Quant", bio: "Head A\n\n— From conversations —\n• Fact one." });
    const b = addPerson("B", { org: "Acme", bio: "Head B\n\n— From conversations —\n• Fact one.\n• Fact two." });
    mergePersons(db, a, b);
    const p = db.prepare("SELECT org, role, bio FROM person WHERE id = ?").get(a) as { org: string; role: string; bio: string };
    expect(p.org).toBe("Acme"); // filled from loser
    expect(p.role).toBe("Quant"); // survivor kept
    expect(p.bio).toContain("Head A"); // survivor's head wins
    expect(p.bio).toContain("Fact two."); // loser's novel bullet joined
    expect(p.bio.match(/Fact one\./g)).toHaveLength(1); // deduped
  });

  it("refuses self-merge and missing people", () => {
    const a = addPerson("A");
    expect(() => mergePersons(db, a, a)).toThrow();
    expect(() => mergePersons(db, a, 9999)).toThrow();
  });
});
