import { describe, it, expect } from "vitest";
import { FIELD_SEP } from "../../main/applecal.ts";
import {
  parseNoteRead,
  shouldCapture,
  buildReadScript,
  buildWipeScript,
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
