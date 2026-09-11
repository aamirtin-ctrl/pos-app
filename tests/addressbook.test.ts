// buildNameIndex (main/connectors/addressbook.ts) against a real AddressBook-shaped SQLite
// fixture. Regression for the 2026-09-11 Eric Gu bug: the better-sqlite3 wrapper was an
// arrow function, `new` on it threw, the per-source catch swallowed it, and the index came
// back EMPTY forever — every saved contact texted as a bare unverified number. This test
// exercises the actual open-copy-read path, so a broken constructor fails loudly here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNameIndex } from "../main/connectors/addressbook.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-abtest-"));
  dbPath = path.join(dir, "AddressBook-v22.abcddb");
  const db = new BetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
    INSERT INTO ZABCDRECORD VALUES (1, 'Eric', 'Gu', NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+1 (626) 497-6868');
    INSERT INTO ZABCDRECORD VALUES (2, 'Priya', NULL, 'Acme');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 2, 'Priya@Example.com');
  `);
  db.close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildNameIndex", () => {
  it("reads a source DB and keys saved contacts by normalized phone and email", () => {
    const ab = buildNameIndex([dbPath]);
    expect(ab.sources).toBe(1); // the regression: the broken constructor made this 0
    expect(ab.index.get("+16264976868")).toEqual({ name: "Eric Gu", company: null });
    expect(ab.index.get("priya@example.com")).toEqual({ name: "Priya", company: "Acme" });
  });
  it("an unreadable source yields sources=0, not a throw", () => {
    const ab = buildNameIndex([path.join(dir, "nope.abcddb")]);
    expect(ab.sources).toBe(0);
    expect(ab.index.size).toBe(0);
  });
});
