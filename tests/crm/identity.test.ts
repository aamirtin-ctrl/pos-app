import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { resolveHandle } from "../../main/crm/identity.ts";

let dir: string;
let db: Db;

function addPerson(name: string, org: string | null = null): number {
  const r = db.prepare("INSERT INTO person (display_name, org) VALUES (?, ?)").run(name, org);
  return Number(r.lastInsertRowid);
}
function addAlias(personId: number, kind: string, value: string): void {
  db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, ?, ?)").run(personId, kind, value);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-identity-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveHandle", () => {
  it("matches by exact normalized email (case + +tag stripped)", () => {
    const id = addPerson("Cory Levy");
    addAlias(id, "email", "cory@corylevy.com");
    const r = resolveHandle(db, { email: "  Cory+news@CoryLevy.com " });
    expect(r).toEqual({ status: "matched", personId: id, matchedBy: "email" });
  });

  it("matches by normalized phone (US formats → E.164)", () => {
    const id = addPerson("Imad Mokadem");
    addAlias(id, "phone", "+14693433111");
    const r = resolveHandle(db, { phone: "(469) 343-3111" });
    expect(r).toEqual({ status: "matched", personId: id, matchedBy: "phone" });
  });

  it("matches by canonical linkedin slug", () => {
    const id = addPerson("JB Straubel");
    addAlias(id, "linkedin", "linkedin.com/in/jbstraubel");
    const r = resolveHandle(db, { linkedin: "https://www.linkedin.com/in/JBStraubel/" });
    expect(r).toEqual({ status: "matched", personId: id, matchedBy: "linkedin" });
  });

  it("matches name + org corroborator", () => {
    addPerson("John Smith", "Acme Corp");
    const id = addPerson("John Smith", "Redwood Materials");
    const r = resolveHandle(db, { name: "john smith", org: "Redwood Materials" });
    expect(r).toEqual({ status: "matched", personId: id, matchedBy: "name+corroborator" });
  });

  it("matches name + non-generic email-domain corroborator", () => {
    const id = addPerson("Aidan Biggins");
    addAlias(id, "email", "aidan.biggins@redwoodmaterials.com");
    // Different local-part, same company domain — corroborates the name.
    const r = resolveHandle(db, { name: "Aidan Biggins", email: "abiggins@redwoodmaterials.com" });
    expect(r).toEqual({ status: "matched", personId: id, matchedBy: "name+corroborator" });
  });

  it("name alone NEVER matches (single candidate, no corroborator → unmatched)", () => {
    addPerson("Grace Kasten");
    expect(resolveHandle(db, { name: "Grace Kasten" })).toEqual({ status: "unmatched" });
  });

  it("two same-name candidates → ambiguous with candidateIds", () => {
    const a = addPerson("John Smith", "Acme Corp");
    const b = addPerson("John Smith", "Globex");
    const r = resolveHandle(db, { name: "John Smith" });
    expect(r.status).toBe("ambiguous");
    expect(r.candidateIds?.sort()).toEqual([a, b].sort());
  });

  it("generic email domain does NOT corroborate a name", () => {
    const id = addPerson("Jane Doe");
    addAlias(id, "email", "jane.doe@gmail.com");
    const r = resolveHandle(db, { name: "Jane Doe", email: "totally.other.jane@gmail.com" });
    expect(r).toEqual({ status: "unmatched" });
  });

  it("no signals at all → unmatched", () => {
    expect(resolveHandle(db, {})).toEqual({ status: "unmatched" });
  });
});
