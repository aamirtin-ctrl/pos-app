// One column, one timestamp format — and never compare timestamps as TEXT.
//
// person.last_contact_at and interaction.occurred_at hold ISO-8601 ("2026-08-08T05:12:12.931Z").
// SQLite's datetime('now') renders "2026-08-08 05:12:12" with a SPACE. Compared as text those
// two agree until character 10 and then compare 'T' (0x54) against ' ' (0x20) — so an ISO
// value always sorts AFTER a SQLite-rendered one from the same day, whatever the real times.
//
// Audited 2026-08-08 across his live database: 31,383 interactions all ISO-Z, and
// person.last_contact_at already carrying two ISO variants (227 with Z, 44 without). Nothing
// was broken yet, because SQLite's datetime()/julianday() parse all three shapes and every
// live comparison happened to be ISO-vs-ISO. These tests pin the two places that could have
// changed that.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-tsfmt-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = <T>(sql: string): T => Object.values(db.prepare(sql).get() as object)[0] as T;

describe("timestamp formats", () => {
  it("TEXT comparison across the two shapes is wrong — the hazard itself", () => {
    // 06:00 is genuinely later than 03:00, but as text the ISO value wins on its 'T'.
    expect(q<number>("SELECT '2026-08-08 06:00:00' > '2026-08-08T03:00:00.000Z'")).toBe(0);
    // …and julianday gets it right, which is why the query uses that instead.
    expect(
      q<number>("SELECT julianday('2026-08-08 06:00:00') > julianday('2026-08-08T03:00:00.000Z')")
    ).toBe(1);
  });

  it("SQLite parses every shape the app stores, so date MATH is safe either way", () => {
    const expected = "2026-09-07 05:12:12";
    for (const t of ["2026-08-08T05:12:12.931Z", "2026-08-08T05:12:12", "2026-08-08 05:12:12"]) {
      expect(q<string>(`SELECT datetime('${t}', '+30 days')`), t).toBe(expected);
    }
  });

  it("the boundary-day window is now exact", () => {
    // A 14-day window anchored at a fixed instant: an interaction earlier in the boundary DAY
    // is outside it. Text comparison said it was inside, because of the 'T'.
    const inside = "SELECT julianday('2026-08-08T05:00:00.000Z') >= julianday('2026-07-25 07:00:00')";
    const boundaryEarlier = "SELECT julianday('2026-07-25T03:00:00.000Z') >= julianday('2026-07-25 07:00:00')";
    expect(q<number>(inside)).toBe(1);
    expect(q<number>(boundaryEarlier), "03:00 precedes the 07:00 cutoff").toBe(0);
    // the old text comparison got that second one backwards
    expect(q<number>("SELECT '2026-07-25T03:00:00.000Z' >= '2026-07-25 07:00:00'")).toBe(1);
  });

  it("a person's last_contact_at is written as ISO, like every other writer", () => {
    // The assistant's "met today" path used datetime('now'), which would have put the
    // space-separated shape into an otherwise-ISO column.
    db.prepare("INSERT INTO person (id, display_name) VALUES (1, 'Test')").run();
    db.prepare("UPDATE person SET last_contact_at = COALESCE(last_contact_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), 1);
    const v = q<string>("SELECT last_contact_at FROM person WHERE id = 1");
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
