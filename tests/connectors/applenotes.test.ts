import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIELD_SEP } from "../../main/applecal.ts";
import { openDb, setSetting, type Db } from "../../main/db/db.ts";
import {
  parseNoteRead,
  shouldCapture,
  buildReadScript,
  buildWipeScript,
  syncAppleNotes,
  NOTE_TITLE_KEY,
  NOTE_NOT_FOUND,
  MIN_QUIET_SECONDS,
} from "../../main/connectors/applenotes.ts";

describe("parseNoteRead", () => {
  it("parses seconds-since-modified and plaintext", () => {
    const r = parseNoteRead(`400${FIELD_SEP}Abdeali Diwan\nmet at the gym`);
    expect(r).toEqual({ secondsSinceModified: 400, text: "Abdeali Diwan\nmet at the gym" });
  });
  it("splits on the FIRST separator only", () => {
    const r = parseNoteRead(`10${FIELD_SEP}a${FIELD_SEP}b`);
    expect(r).toEqual({ secondsSinceModified: 10, text: `a${FIELD_SEP}b` });
  });
  it("returns null for the not-found marker and for junk", () => {
    expect(parseNoteRead(NOTE_NOT_FOUND)).toBeNull();
    expect(parseNoteRead("")).toBeNull();
    expect(parseNoteRead(`abc${FIELD_SEP}text`)).toBeNull();
  });
});

describe("shouldCapture", () => {
  it("false while the note was modified recently (mid-typing guard)", () => {
    expect(shouldCapture({ secondsSinceModified: 60, text: "stuff" })).toBe(false);
    expect(shouldCapture({ secondsSinceModified: MIN_QUIET_SECONDS - 1, text: "stuff" })).toBe(false);
  });
  it("true once quiet and non-empty", () => {
    expect(shouldCapture({ secondsSinceModified: MIN_QUIET_SECONDS, text: "stuff" })).toBe(true);
  });
  it("false for whitespace-only text", () => {
    expect(shouldCapture({ secondsSinceModified: 9999, text: "  \n " })).toBe(false);
  });
  it("false when the text is just the note title line (empty note shows its name)", () => {
    expect(shouldCapture({ secondsSinceModified: 9999, text: "POS Inbox" }, MIN_QUIET_SECONDS, "POS Inbox")).toBe(false);
  });
});

describe("scripts", () => {
  it("read script targets the exact title, escaped", () => {
    const s = buildReadScript(`My "People" Note`);
    expect(s).toContain(`\\"People\\"`);
    expect(s).toContain("plaintext");
  });
  it("wipe script sets the body to just the title heading", () => {
    const s = buildWipeScript("POS Inbox");
    expect(s).toContain("set body of");
  });
});

// Fake osascript: scripts containing "set body" are wipes, everything else is a read.
function fakeRun(readStdout: string, opts: { failWipe?: boolean } = {}) {
  const calls: string[] = [];
  const run = async (script: string) => {
    if (script.includes("set body")) {
      calls.push("wipe");
      if (opts.failWipe) return { ok: false as const, error: new Error("nope") };
      return { ok: true as const, stdout: "ok" };
    }
    calls.push("read");
    return { ok: true as const, stdout: readStdout };
  };
  return { run, calls };
}

describe("syncAppleNotes", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-applenotes-"));
    db = openDb(path.join(dir, "pos.db"));
    setSetting(db, NOTE_TITLE_KEY, "POS Inbox");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = () => ({ db }) as never;
  const pending = () =>
    db.prepare("SELECT source, raw_text FROM capture_inbox").all() as { source: string; raw_text: string }[];

  it("records the dump into capture_inbox, then wipes", async () => {
    const { run, calls } = fakeRun(`999${FIELD_SEP}POS Inbox\nAbdeali Diwan\nmet at gym`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r).toMatchObject({ source: "applenotes", ingested: 1 });
    expect(r.error).toBeUndefined();
    expect(pending()).toEqual([{ source: "apple_notes", raw_text: "POS Inbox\nAbdeali Diwan\nmet at gym" }]);
    expect(calls).toEqual(["read", "wipe"]);
  });

  it("skips a recently-modified note without wiping", async () => {
    const { run, calls } = fakeRun(`10${FIELD_SEP}POS Inbox\nhalf-typed`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
    expect(pending()).toEqual([]);
    expect(calls).toEqual(["read"]);
  });

  it("same content twice (earlier wipe failed) captures once but still retries the wipe", async () => {
    const stdout = `999${FIELD_SEP}POS Inbox\nAbdeali Diwan`;
    const first = fakeRun(stdout, { failWipe: true });
    const r1 = await syncAppleNotes(deps(), { run: first.run });
    expect(r1.ingested).toBe(1);
    expect(r1.error).toBeTruthy(); // wipe failure is reported, capture stands
    const second = fakeRun(stdout);
    const r2 = await syncAppleNotes(deps(), { run: second.run });
    expect(r2.ingested).toBe(0); // content-hash dedupe
    expect(second.calls).toEqual(["read", "wipe"]); // wipe retried
    expect(pending()).toHaveLength(1);
  });

  it("missing note reports an error naming the title", async () => {
    const run = async () => ({ ok: true as const, stdout: "!NOTENOTFOUND" });
    const r = await syncAppleNotes(deps(), { run });
    expect(r.error).toContain("POS Inbox");
  });

  it("unset title = connector off", async () => {
    setSetting(db, NOTE_TITLE_KEY, "");
    const { run, calls } = fakeRun(`999${FIELD_SEP}x`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r).toMatchObject({ ingested: 0, skipped: 0 });
    expect(calls).toEqual([]);
  });
});
