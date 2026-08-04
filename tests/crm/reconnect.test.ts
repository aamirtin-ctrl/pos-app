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

    const due = reconnectDue(db, NOW);
    expect(due.map((p) => p.display_name)).toEqual(["Inner Overdue", "Network Very", "Network Barely"]);
    expect(due[0].overdue_days).toBe(34);
    expect(due[1].overdue_days).toBe(94);
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
});
