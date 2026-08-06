import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { refreshNextTouch, reconnectDue, TIER_DAYS } from "../../main/crm/reconnect.ts";

const NOW = new Date("2026-08-03T00:00:00Z");

let dir: string;
let db: Db;

function addPerson(name: string, tier: number, lastContactAt: string | null): number {
  const r = db
    .prepare("INSERT INTO person (display_name, tier, last_contact_at) VALUES (?, ?, ?)")
    .run(name, tier, lastContactAt);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-reconnect-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("refreshNextTouch", () => {
  it("sets next_touch_due_at = last_contact_at + tier threshold", () => {
    expect(TIER_DAYS).toEqual({ 0: 90, 1: 90, 2: 120, 3: Infinity });
    // owner rule: never suggest reconnecting before 3 months
    for (const [t, d] of Object.entries(TIER_DAYS)) if (t !== "3") expect(d).toBeGreaterThanOrEqual(90);
    const inner = addPerson("Inner", 0, "2026-07-01 00:00:00");
    const network = addPerson("Network", 2, "2026-07-01 00:00:00");
    refreshNextTouch(db);
    const get = (id: number) =>
      (db.prepare("SELECT next_touch_due_at n FROM person WHERE id = ?").get(id) as { n: string | null }).n;
    expect(get(inner)).toBe("2026-09-29 00:00:00");
    expect(get(network)).toBe("2026-10-29 00:00:00");
  });

  it("tier 3 and never-contacted persons get NULL", () => {
    const archived = addPerson("Archived", 3, "2020-01-01 00:00:00");
    const fresh = addPerson("Never", 1, null);
    refreshNextTouch(db);
    const get = (id: number) =>
      (db.prepare("SELECT next_touch_due_at n FROM person WHERE id = ?").get(id) as { n: string | null }).n;
    expect(get(archived)).toBeNull();
    expect(get(fresh)).toBeNull();
  });
});

describe("reconnectDue", () => {
  it("lists overdue persons ordered by tier, then most overdue", () => {
    // NOW = 2026-08-03. Overdue: inner (due 07-15), two network people with different lateness.
    addPerson("Inner Overdue", 0, "2026-04-01 00:00:00"); // due 06-30, 34d overdue
    addPerson("Network Barely", 2, "2026-03-30 00:00:00"); // due 07-28, 6d overdue
    addPerson("Network Very", 2, "2026-01-01 00:00:00"); // due 05-01, 94d overdue
    addPerson("Active Fresh", 1, "2026-07-20 00:00:00"); // due 08-19, not yet
    addPerson("Archive", 3, "2020-01-01 00:00:00"); // tier 3 never surfaces
    refreshNextTouch(db);

    // "Network Barely" is 6 days past due and is deliberately NOT here — see the grace band
    // below. Passing graceDays: 0 recovers the pre-2026-08-06 ordering behavior exactly.
    expect(reconnectDue(db, NOW, 0).map((p) => p.display_name)).toEqual([
      "Inner Overdue", "Network Very", "Network Barely",
    ]);

    const due = reconnectDue(db, NOW);
    expect(due.map((p) => p.display_name)).toEqual(["Inner Overdue", "Network Very"]);
    expect(due[0].overdue_days).toBe(34);
    expect(due[1].overdue_days).toBe(94);
  });

  // Owner report 2026-08-06: "it still tells me to reconnect with people that are only, like,
  // zero days over or one day over or eighteen days over. Shouldn't be doing that."
  //
  // A threshold crossing is not an event. Ninety days is his judgement about how long a
  // friendship can go quiet, and treating it as an exact instant re-armed the list every
  // morning with whoever ticked over at midnight — the least urgent people it could show him.
  it("holds someone back until they are meaningfully past due, not one day past arithmetic", () => {
    const barely = addPerson("Just Crossed", 1, "2026-05-05 00:00:00"); // due 08-03 = NOW, 0d over
    const eighteen = addPerson("Eighteen Over", 1, "2026-04-17 00:00:00"); // due 07-16, 18d over
    const properly = addPerson("Long Overdue", 1, "2026-03-01 00:00:00"); // due 05-30, 65d over
    refreshNextTouch(db);

    const names = reconnectDue(db, NOW).map((p) => p.display_name);
    expect(names).toContain("Long Overdue");
    expect(names).not.toContain("Just Crossed"); // the 0-day case he named
    expect(names).not.toContain("Eighteen Over"); // and the 18-day one
    expect([barely, eighteen, properly].length).toBe(3);

    // Nobody is lost — they surface once they are genuinely past time.
    const later = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(reconnectDue(db, later).map((p) => p.display_name)).toContain("Just Crossed");
  });

  // The bug underneath the noise: last_contact_at arrived with the PersonalCRM2 migration and
  // then froze, while every message POS ingested since updated `interaction` alone. In his
  // data Ishaan had texted ten days earlier and still showed as twelve days overdue.
  it("measures the cadence from the last message actually ingested", () => {
    const p = addPerson("Texted Recently", 1, "2026-01-01 00:00:00"); // stale: would be 124d overdue
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary)
       VALUES (?, 'imessage', 'inbound', ?, 'hey')`
    ).run(p, "2026-07-27 12:00:00"); // one week before NOW
    refreshNextTouch(db);

    const lc = (db.prepare("SELECT last_contact_at c FROM person WHERE id = ?").get(p) as { c: string }).c;
    expect(lc).toBe("2026-07-27 12:00:00");
    expect(reconnectDue(db, NOW).map((x) => x.display_name)).not.toContain("Texted Recently");
  });

  it("never moves last_contact_at backwards — a hand-logged coffee has no interaction row", () => {
    const p = addPerson("Met In Person", 1, "2026-07-30 00:00:00");
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary)
       VALUES (?, 'imessage', 'inbound', ?, 'old thread')`
    ).run(p, "2026-01-05 09:00:00");
    refreshNextTouch(db);
    const lc = (db.prepare("SELECT last_contact_at c FROM person WHERE id = ?").get(p) as { c: string }).c;
    expect(lc).toBe("2026-07-30 00:00:00");
  });

  it("excludes stale-dismissed persons (indefinite and future snooze), keeps expired snoozes", () => {
    const indefinite = addPerson("Dismissed Forever", 1, "2026-01-01 00:00:00");
    const snoozedFuture = addPerson("Snoozed Future", 1, "2026-01-01 00:00:00");
    const snoozedPast = addPerson("Snooze Expired", 1, "2026-01-01 00:00:00");
    refreshNextTouch(db);

    const ins = db.prepare("INSERT INTO dismissal (person_id, kind, snooze_until) VALUES (?, 'stale', ?)");
    ins.run(indefinite, null);
    ins.run(snoozedFuture, "2026-12-01 00:00:00");
    ins.run(snoozedPast, "2026-06-01 00:00:00");

    const due = reconnectDue(db, NOW);
    expect(due.map((p) => p.display_name)).toEqual(["Snooze Expired"]);
  });

  it("a non-stale dismissal kind does not suppress", () => {
    const p = addPerson("Followup Dismissed", 1, "2026-01-01 00:00:00");
    refreshNextTouch(db);
    db.prepare("INSERT INTO dismissal (person_id, kind, snooze_until) VALUES (?, 'followup', NULL)").run(p);
    expect(reconnectDue(db, NOW).map((x) => x.display_name)).toEqual(["Followup Dismissed"]);
  });

  const addGroup = (name: string, suppress = 0): number => {
    const r = db.prepare("INSERT INTO grp (name, suppress_follow_ups) VALUES (?, ?)").run(name, suppress);
    return Number(r.lastInsertRowid);
  };
  const assign = (personId: number, groupId: number) =>
    db.prepare("INSERT INTO person_group (person_id, group_id) VALUES (?, ?)").run(personId, groupId);

  it("excludes members of a group with suppress_follow_ups = 1", () => {
    const family = addGroup("family group", 1);
    const friends = addGroup("Friends", 0);
    const mom = addPerson("Mom", 0, "2026-01-01 00:00:00");
    const friend = addPerson("Overdue Friend", 1, "2026-01-01 00:00:00");
    const both = addPerson("Friend And Family", 1, "2026-01-01 00:00:00");
    assign(mom, family);
    assign(friend, friends);
    assign(both, friends);
    assign(both, family); // any suppressed group membership wins
    refreshNextTouch(db);

    expect(reconnectDue(db, NOW).map((x) => x.display_name)).toEqual(["Overdue Friend"]);
  });

  it("returns each row's group names (empty array when ungrouped)", () => {
    const friends = addGroup("Friends");
    const stanford = addGroup("Stanford Peers");
    const grouped = addPerson("Grouped", 1, "2026-01-01 00:00:00");
    addPerson("Ungrouped", 1, "2026-02-01 00:00:00");
    assign(grouped, stanford);
    assign(grouped, friends);
    refreshNextTouch(db);

    const due = reconnectDue(db, NOW);
    const byName = new Map(due.map((r) => [r.display_name, r]));
    expect(byName.get("Grouped")?.groups).toEqual(["Friends", "Stanford Peers"]); // sorted
    expect(byName.get("Ungrouped")?.groups).toEqual([]);
  });
});
