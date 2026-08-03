import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { listPeople, getPerson, patchPerson, mergePeople } from "../../main/crm/people.ts";

const NOW = new Date("2026-08-03T00:00:00Z");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-people-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  db.prepare(
    "INSERT INTO person (id, display_name, org, role, last_contact_at) VALUES (1, 'Cory Levy', 'ZFellows', 'Founder', '2026-07-24 00:00:00')"
  ).run();
  db.prepare("INSERT INTO person (id, display_name, org) VALUES (2, 'KP Reddy', 'Shadow Ventures')").run();
  db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (1, 'investor')").run();
  db.prepare("INSERT INTO grp (id, name) VALUES (1, 'Mentors')").run();
  db.prepare("INSERT INTO person_group (person_id, group_id) VALUES (1, 1)").run();
}

describe("listPeople", () => {
  it("includes tags, groups, and freshness", () => {
    seed();
    const all = listPeople(db, undefined, NOW);
    expect(all).toHaveLength(2);
    const cory = all.find((p) => p.id === 1)!;
    expect(cory.tags).toEqual(["investor"]);
    expect(cory.groups).toEqual(["Mentors"]);
    expect(cory.freshness_days).toBe(10);
    expect(all.find((p) => p.id === 2)!.freshness_days).toBeNull();
  });

  it("filters by LIKE on name/org/role", () => {
    seed();
    expect(listPeople(db, "shadow", NOW).map((p) => p.id)).toEqual([2]);
    expect(listPeople(db, "founder", NOW).map((p) => p.id)).toEqual([1]);
    expect(listPeople(db, "cory", NOW).map((p) => p.id)).toEqual([1]);
    expect(listPeople(db, "nobody", NOW)).toEqual([]);
  });
});

describe("getPerson", () => {
  it("returns detail with aliases, interactions, open commitments", () => {
    seed();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'cory@corylevy.com')").run();
    db.prepare(
      "INSERT INTO interaction (person_id, channel, occurred_at, subject, external_id) VALUES (1, 'gmail', '2026-07-24 00:00:00', 'Hello', 'x1')"
    ).run();
    db.prepare(
      "INSERT INTO commitment (person_id, description, status) VALUES (1, 'Send deck', 'open')"
    ).run();
    db.prepare(
      "INSERT INTO commitment (person_id, description, status) VALUES (1, 'Old ask', 'done')"
    ).run();

    const p = getPerson(db, 1, NOW)!;
    expect(p.display_name).toBe("Cory Levy");
    expect(p.aliases).toHaveLength(1);
    expect(p.interactions).toHaveLength(1);
    expect(p.open_commitments.map((c) => c.description)).toEqual(["Send deck"]);
    expect(p.tags).toEqual(["investor"]);
    expect(getPerson(db, 999, NOW)).toBeNull();
  });

  it("caps interactions at 50, newest first", () => {
    seed();
    const ins = db.prepare(
      "INSERT INTO interaction (person_id, channel, occurred_at, external_id) VALUES (1, 'gmail', ?, ?)"
    );
    for (let i = 0; i < 60; i++) ins.run(`2026-06-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`, `e${i}`);
    expect(getPerson(db, 1, NOW)!.interactions).toHaveLength(50);
  });
});

describe("patchPerson", () => {
  it("updates whitelisted fields only", () => {
    seed();
    expect(patchPerson(db, 1, { role: "GP", tier: 0, id: 99, created_at: "hack" })).toBe(true);
    const row = db.prepare("SELECT id, role, tier FROM person WHERE id = 1").get() as {
      id: number;
      role: string;
      tier: number;
    };
    expect(row).toEqual({ id: 1, role: "GP", tier: 0 });
  });

  it("returns false when no whitelisted fields are present", () => {
    seed();
    expect(patchPerson(db, 1, { id: 5, nonsense: true })).toBe(false);
  });
});

describe("mergePeople", () => {
  it("keeps lowest id, moves aliases/interactions/commitments/tags/groups, deletes the rest", () => {
    seed();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'cory@corylevy.com')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (2, 'email', 'kp@zero-rfi.ai')").run();
    db.prepare(
      "INSERT INTO interaction (person_id, channel, external_id) VALUES (2, 'gmail', 'm1')"
    ).run();
    db.prepare("INSERT INTO commitment (person_id, description) VALUES (2, 'Intro to KP')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (2, 'construction-tech')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (2, 'investor')").run(); // dup with p1
    db.prepare("INSERT INTO person_group (person_id, group_id) VALUES (2, 1)").run(); // dup with p1

    const kept = mergePeople(db, [2, 1]);
    expect(kept).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM alias WHERE person_id = 1").get()).toEqual({ c: 2 });
    expect(db.prepare("SELECT COUNT(*) c FROM interaction WHERE person_id = 1").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM commitment WHERE person_id = 1").get()).toEqual({ c: 1 });
    const tags = getPerson(db, 1, NOW)!.tags;
    expect(tags).toEqual(["construction-tech", "investor"]);
    expect(getPerson(db, 1, NOW)!.groups).toEqual(["Mentors"]);
  });

  it("fewer than two distinct ids → null, no change", () => {
    seed();
    expect(mergePeople(db, [1])).toBeNull();
    expect(mergePeople(db, [1, 1])).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 2 });
  });
});
