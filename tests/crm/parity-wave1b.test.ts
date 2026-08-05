// Wave 1b parity: merge semantics (#1), groups module + hide-with-contacts (#2/#4/#5),
// CSV export (#20).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { mergePeople, getPerson } from "../../main/crm/people.ts";
import {
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setHidden,
  setHideContacts,
  setSuppressFollowUps,
  assignToGroup,
  removeFromGroup,
  hiddenPersonIds,
} from "../../main/crm/groups.ts";
import { exportContactsCsv, csvField, CSV_COLUMNS, defaultCsvFilename } from "../../main/crm/export.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-wave1b-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const person = (id: number, name: string, fields: Record<string, string | number | null> = {}) => {
  const cols = ["id", "display_name", ...Object.keys(fields)];
  db.prepare(
    `INSERT INTO person (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
  ).run(id, name, ...Object.values(fields));
};

// ── #1 merge semantics ────────────────────────────────────────────────────────

describe("mergePeople survivor selection", () => {
  it("keeps the RICHEST record, not the lowest id", () => {
    person(1, "Cory Levy"); // no rich fields at all
    person(2, "Cory Levy", { org: "ZFellows", role: "Founder", location: "Austin" });
    expect(mergePeople(db, [1, 2])).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
  });

  it("breaks a richness tie on alias count, then on lowest id", () => {
    person(1, "A", { org: "Acme" });
    person(2, "A", { org: "Acme" });
    person(3, "A", { org: "Acme" });
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (2, 'email', 'a@x.com')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (2, 'phone', '+15125550000')").run();
    expect(mergePeople(db, [1, 2, 3])).toBe(2); // most aliases wins

    person(10, "B", { role: "GP" });
    person(11, "B", { role: "GP" });
    expect(mergePeople(db, [11, 10])).toBe(10); // all else equal → lowest id
  });

  it("returns null for fewer than two distinct ids and changes nothing", () => {
    person(1, "Solo");
    expect(mergePeople(db, [1])).toBeNull();
    expect(mergePeople(db, [1, 1])).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
  });

  it("throws (and rolls back) when an id does not exist", () => {
    person(1, "A", { org: "Acme" });
    person(2, "A");
    expect(() => mergePeople(db, [1, 2, 999])).toThrow(/not found/);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 2 });
  });
});

describe("mergePeople field merge", () => {
  it("backfills the survivor's blanks from the losers and keeps its own values", () => {
    person(1, "Cory", { org: "ZFellows", role: "Founder", bio: "Runs ZFellows." });
    person(2, "Cory", { org: "Other Co", location: "Austin", given_name: "Cory" });
    const keep = mergePeople(db, [1, 2])!;
    expect(keep).toBe(1);
    const p = getPerson(db, keep)!;
    expect(p.org).toBe("ZFellows"); // survivor's own value wins
    expect(p.role).toBe("Founder");
    expect(p.location).toBe("Austin"); // backfilled from the loser
    expect(p.given_name).toBe("Cory");
  });

  it("treats whitespace-only fields as blank when backfilling", () => {
    person(1, "X", { org: "Acme", role: "   ", location: "Austin" });
    person(2, "X", { role: "CTO" });
    const p = getPerson(db, mergePeople(db, [1, 2])!)!;
    expect(p.role).toBe("CTO");
  });

  it("concatenates distinct bio paragraphs with a blank line and dedupes identical ones", () => {
    person(1, "X", { org: "Acme", bio: "Met at EarthX.", relationship_summary: "Warm." });
    person(2, "X", { bio: "Met at EarthX.\n\nBuilding a solar startup." });
    person(3, "X", { bio: "  met   at earthx.  ", relationship_summary: "Warm.\n\nIntroduced by KP." });
    const p = getPerson(db, mergePeople(db, [1, 2, 3])!)!;
    expect(p.bio).toBe("Met at EarthX.\n\nBuilding a solar startup.");
    expect(p.relationship_summary).toBe("Warm.\n\nIntroduced by KP.");
  });

  it("takes the most recent last_contact_at across the merged records", () => {
    person(1, "X", { org: "Acme", last_contact_at: "2026-01-01 00:00:00" });
    person(2, "X", { last_contact_at: "2026-07-24 00:00:00" });
    person(3, "X", { last_contact_at: null });
    const keep = mergePeople(db, [1, 2, 3])!;
    const row = db.prepare("SELECT last_contact_at FROM person WHERE id = ?").get(keep) as {
      last_contact_at: string;
    };
    expect(row.last_contact_at).toBe("2026-07-24 00:00:00");
  });
});

describe("mergePeople sidecar movement", () => {
  it("moves aliases/interactions/commitments/tags/groups and deletes the losers", () => {
    person(1, "Cory", { org: "ZFellows", role: "Founder" });
    person(2, "Cory");
    db.prepare("INSERT INTO grp (id, name) VALUES (1, 'Mentors')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'a@x.com')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (2, 'email', 'b@x.com')").run();
    db.prepare("INSERT INTO interaction (person_id, channel, external_id) VALUES (2, 'gmail', 'm1')").run();
    db.prepare("INSERT INTO interaction (person_id, channel, external_id) VALUES (2, 'gmail', 'm2')").run();
    db.prepare("INSERT INTO commitment (person_id, description) VALUES (2, 'Intro to KP')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (1, 'investor')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (2, 'investor')").run(); // dup
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (2, 'solar')").run();
    db.prepare("INSERT INTO person_group (person_id, group_id) VALUES (2, 1)").run();

    expect(mergePeople(db, [2, 1])).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM person WHERE id = 2").get()).toEqual({ c: 0 });
    const p = getPerson(db, 1)!;
    expect(p.aliases.map((a) => a.value).sort()).toEqual(["a@x.com", "b@x.com"]);
    expect(p.interactions).toHaveLength(2);
    expect(p.open_commitments.map((c) => c.description)).toEqual(["Intro to KP"]);
    expect(p.tags).toEqual(["investor", "solar"]);
    expect(p.groups).toEqual(["Mentors"]);
  });

  // alias.UNIQUE(kind, value) is global, so the same value can never sit on two people
  // at once; the same *value* under two kinds can, and both must survive the move.
  it("moves same-value aliases of different kinds without tripping UNIQUE(kind, value)", () => {
    person(1, "X", { org: "Acme" });
    person(2, "X");
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'x@y.com')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (2, 'imessage_handle', 'x@y.com')").run();
    expect(mergePeople(db, [1, 2])).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM alias WHERE person_id = 1").get()).toEqual({ c: 2 });
  });

  it("carries drafts across so the loser's cascade cannot take them", () => {
    person(1, "X", { org: "Acme" });
    person(2, "X");
    db.prepare("INSERT INTO interaction (id, person_id, channel, external_id) VALUES (7, 2, 'gmail', 'm1')").run();
    db.prepare("INSERT INTO draft (interaction_id, person_id, channel, body) VALUES (7, 2, 'gmail', 'hi')").run();
    expect(mergePeople(db, [1, 2])).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM draft WHERE person_id = 1").get()).toEqual({ c: 1 });
  });
});

// ── #2 / #4 / #5 groups ───────────────────────────────────────────────────────

describe("groups module", () => {
  it("creates idempotently and lists with member counts", () => {
    const a = createGroup(db, "  Mentors  ");
    expect(a.created).toBe(true);
    const again = createGroup(db, "Mentors");
    expect(again.created).toBe(false);
    expect(again.id).toBe(a.id);

    person(1, "A");
    person(2, "B");
    expect(assignToGroup(db, [1, 2, 1], "Mentors")).toBe(2);
    const rows = listGroups(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Mentors",
      hidden: 0,
      hide_contacts: 0,
      suppress_follow_ups: 0,
      members: 2,
    });
    expect(removeFromGroup(db, [2], "Mentors")).toBe(1);
    expect(listGroups(db)[0].members).toBe(1);
    expect(() => createGroup(db, "   ")).toThrow(/empty/);
  });

  it("round-trips hidden and hide_contacts, with hide+contacts implying hidden", () => {
    createGroup(db, "Family");
    expect(setHidden(db, "Family", true)).toBe(true);
    expect(listGroups(db)[0]).toMatchObject({ hidden: 1, hide_contacts: 0 });

    expect(setHideContacts(db, "Family", true)).toBe(true);
    expect(listGroups(db)[0]).toMatchObject({ hidden: 1, hide_contacts: 1 });

    // unhide is the full way back — it clears hide_contacts too
    expect(setHidden(db, "Family", false)).toBe(true);
    expect(listGroups(db)[0]).toMatchObject({ hidden: 0, hide_contacts: 0 });

    expect(setSuppressFollowUps(db, "Family", true)).toBe(true);
    expect(listGroups(db)[0].suppress_follow_ups).toBe(1);
  });

  it("renames and deletes, cascading memberships but never people", () => {
    person(1, "A");
    assignToGroup(db, [1], "Mentors");
    expect(renameGroup(db, "Mentors", "Advisors")).toBe(true);
    expect(listGroups(db)[0]).toMatchObject({ name: "Advisors", members: 1 });

    createGroup(db, "Family");
    expect(() => renameGroup(db, "Advisors", "Family")).toThrow(/already exists/);

    expect(deleteGroup(db, "Advisors")).toBe(true);
    expect(listGroups(db).map((g) => g.name)).toEqual(["Family"]);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM person_group").get()).toEqual({ c: 0 });
    expect(deleteGroup(db, "Nope")).toBe(false);
  });

  it("hiddenPersonIds tracks members of hide_contacts groups only", () => {
    person(1, "A");
    person(2, "B");
    person(3, "C");
    assignToGroup(db, [1, 2], "Family");
    assignToGroup(db, [3], "Mentors");
    expect(hiddenPersonIds(db).size).toBe(0);

    setHideContacts(db, "Family", true);
    expect([...hiddenPersonIds(db)].sort()).toEqual([1, 2]);

    // merely hiding the chip must NOT archive anybody
    setHidden(db, "Family", false);
    setHidden(db, "Mentors", true);
    expect(hiddenPersonIds(db).size).toBe(0);

    // membership changes are reflected without any reconcile step
    setHideContacts(db, "Mentors", true);
    assignToGroup(db, [1], "Mentors");
    expect([...hiddenPersonIds(db)].sort()).toEqual([1, 3]);
    removeFromGroup(db, [1], "Mentors");
    expect([...hiddenPersonIds(db)]).toEqual([3]);
  });
});

// ── #20 CSV export ────────────────────────────────────────────────────────────

describe("csvField", () => {
  it("quotes only when required and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(2)).toBe("2");
    expect(csvField("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("exportContactsCsv", () => {
  it("emits the columns in order and escapes commas, quotes and newlines", () => {
    person(1, "Levy, Cory", {
      org: 'Z"Fellows"',
      role: "Founder",
      location: "Austin",
      tier: 1,
      last_contact_at: "2026-07-24 00:00:00",
      next_touch_due_at: "2026-08-24 00:00:00",
      bio: "Line one\n\nLine two, with a comma",
      relationship_summary: "Warm",
    });
    db.prepare("INSERT INTO alias (person_id, kind, value, is_primary) VALUES (1, 'email', 'cory@z.com', 1)").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'alt@z.com')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'phone', '+15125550000')").run();
    db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (1, 'linkedin', 'in/corylevy')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (1, 'investor')").run();
    db.prepare("INSERT INTO person_tag (person_id, tag) VALUES (1, 'solar')").run();
    assignToGroup(db, [1], "Mentors");

    const csv = exportContactsCsv(db);
    const header = csv.split("\r\n")[0];
    expect(header).toBe(
      "name,org,role,location,tier,last_contact_at,next_touch_due_at,emails,phones,linkedin,tags,groups,bio,relationship_summary"
    );
    expect(header.split(",")).toEqual([...CSV_COLUMNS]);

    expect(csv).toContain('"Levy, Cory"');
    expect(csv).toContain('"Z""Fellows"""');
    expect(csv).toContain('"Line one\n\nLine two, with a comma"');
    expect(csv).toContain("cory@z.com; alt@z.com"); // primary first, semicolon-joined
    expect(csv).toContain("investor; solar");
    expect(csv).toContain("Mentors");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes one record per person, name-ordered, with blanks for nulls", () => {
    person(2, "Zed");
    person(1, "Abe", { org: "Acme" });
    const lines = exportContactsCsv(db).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("Abe,Acme,,,2,,,,,,,,,");
    expect(lines[2]).toBe("Zed,,,,2,,,,,,,,,");
  });

  it("header only when there are no contacts", () => {
    expect(exportContactsCsv(db)).toBe(
      "name,org,role,location,tier,last_contact_at,next_touch_due_at,emails,phones,linkedin,tags,groups,bio,relationship_summary\r\n"
    );
  });

  it("names the file pos-contacts-<date>.csv", () => {
    expect(defaultCsvFilename(new Date(2026, 7, 5))).toBe("pos-contacts-2026-08-05.csv");
  });
});
