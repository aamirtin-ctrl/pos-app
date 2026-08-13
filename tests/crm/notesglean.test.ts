import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { MINED_MARKER } from "../../main/crm/enrich.ts";
import {
  parseGleanChunks,
  uniqueNameMatch,
  applyChunk,
  createPersonFromChunk,
} from "../../main/crm/notesglean.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-notesglean-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string, fields: { org?: string; bio?: string } = {}): number {
  const r = db
    .prepare("INSERT INTO person (display_name, org, bio) VALUES (?, ?, ?)")
    .run(name, fields.org ?? null, fields.bio ?? null);
  return Number(r.lastInsertRowid);
}
const person = (id: number) =>
  db.prepare("SELECT * FROM person WHERE id = ?").get(id) as Record<string, unknown>;

describe("parseGleanChunks", () => {
  it("keeps well-formed chunks, all fields optional, facts default []", () => {
    const out = parseGleanChunks([
      { name: "Abdeali Diwan", facts: ["met at the gym", "into climbing"] },
      { phone: "555-111-2222", facts: ["said call about apt"] },
      { name: "Sara" },
    ]);
    expect(out).toEqual([
      { name: "Abdeali Diwan", facts: ["met at the gym", "into climbing"] },
      { phone: "555-111-2222", facts: ["said call about apt"] },
      { name: "Sara", facts: [] },
    ]);
  });
  it("drops junk: non-arrays, non-objects, empty chunks, non-string facts", () => {
    expect(parseGleanChunks("nope")).toEqual([]);
    expect(parseGleanChunks([null, 5, {}, { facts: [] }, { name: "X", facts: [1, "ok", ""] }])).toEqual([
      { name: "X", facts: ["ok"] },
    ]);
  });
});

describe("uniqueNameMatch", () => {
  it("exactly one normalized-name hit → that id", () => {
    const id = addPerson("Abdeali Diwan");
    addPerson("Someone Else");
    expect(uniqueNameMatch(db, "abdeali  diwan")).toBe(id);
  });
  it("zero or multiple hits → null", () => {
    expect(uniqueNameMatch(db, "Nobody Here")).toBeNull();
    addPerson("Jay Shah");
    addPerson("Jay Shah");
    expect(uniqueNameMatch(db, "Jay Shah")).toBeNull();
  });
});

describe("applyChunk", () => {
  it("appends facts under MINED_MARKER without touching the user-authored head", () => {
    const id = addPerson("Abdeali Diwan", { bio: "My climbing friend." });
    applyChunk(db, { name: "Abdeali Diwan", facts: ["works at Stripe", "moving to SF"] }, id);
    const bio = person(id).bio as string;
    expect(bio.startsWith("My climbing friend.")).toBe(true);
    expect(bio).toContain(MINED_MARKER);
    expect(bio).toContain("works at Stripe");
    // idempotent: same facts again do not duplicate
    applyChunk(db, { name: "Abdeali Diwan", facts: ["works at Stripe"] }, id);
    expect((person(id).bio as string).match(/works at Stripe/g)).toHaveLength(1);
  });
  it("fills empty org/role, never overwrites, adds phone/email aliases", () => {
    const id = addPerson("Abdeali Diwan", { org: "Stripe" });
    applyChunk(
      db,
      { name: "Abdeali Diwan", org: "Airbnb", role: "engineer", phone: "+1 (555) 111-2222", email: "AD@x.com", facts: [] },
      id
    );
    expect(person(id).org).toBe("Stripe"); // existing wins
    expect(person(id).role).toBe("engineer"); // empty filled
    const aliases = db
      .prepare("SELECT kind, value FROM alias WHERE person_id = ? ORDER BY kind")
      .all(id);
    expect(aliases).toEqual([
      { kind: "email", value: "ad@x.com" },
      { kind: "phone", value: "+15551112222" },
    ]);
  });
  it("records a channel='notes' interaction carrying the chunk text", () => {
    const id = addPerson("Abdeali Diwan");
    applyChunk(db, { name: "Abdeali Diwan", facts: ["met at gym"] }, id);
    const i = db.prepare("SELECT channel, body_raw FROM interaction WHERE person_id = ?").get(id) as {
      channel: string;
      body_raw: string;
    };
    expect(i.channel).toBe("notes");
    expect(i.body_raw).toContain("met at gym");
  });
});

describe("createPersonFromChunk", () => {
  it("creates tier-2, no unverified tag, applies the chunk", () => {
    const id = createPersonFromChunk(db, { name: "New Guy", org: "Acme", facts: ["met at conf"] });
    expect(person(id).tier).toBe(2);
    expect(person(id).org).toBe("Acme");
    const tag = db.prepare("SELECT 1 FROM person_tag WHERE person_id = ? AND tag = 'unverified'").get(id);
    expect(tag).toBeUndefined();
    expect(person(id).bio as string).toContain("met at conf");
  });
  it("throws without a name", () => {
    expect(() => createPersonFromChunk(db, { facts: ["x"] })).toThrow();
  });
});
