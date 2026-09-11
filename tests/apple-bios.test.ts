// Pure pieces of the Apple Contacts bio mirror (main/crm/apple-bios.ts). The JXA I/O is not
// tested here — these pin the block splicing and the create-eligibility rules.
import { describe, it, expect } from "vitest";
import {
  spliceBlock, splitName, isCreatableName, composeCardBio, wasUserEdited,
  BLOCK_START, BLOCK_END, INFERRED_MARKER,
} from "../main/crm/apple-bios.ts";

describe("spliceBlock", () => {
  it("empty note → just the block", () => {
    expect(spliceBlock(null, "Bio.")).toBe(`${BLOCK_START}\nBio.\n${BLOCK_END}`);
  });
  it("owner-written note is preserved, block appended", () => {
    const out = spliceBlock("my own note", "Bio.");
    expect(out.startsWith("my own note")).toBe(true);
    expect(out).toContain(`${BLOCK_START}\nBio.\n${BLOCK_END}`);
  });
  it("re-run replaces only the block (idempotent)", () => {
    const v1 = spliceBlock("mine", "Old bio.");
    const v2 = spliceBlock(v1, "New bio.");
    expect(v2).toContain("mine");
    expect(v2).toContain("New bio.");
    expect(v2).not.toContain("Old bio.");
    expect(v2.match(new RegExp(BLOCK_START, "g"))).toHaveLength(1);
    expect(spliceBlock(v2, "New bio.")).toBe(v2); // stable
  });
});

describe("splitName", () => {
  it("first + rest", () => {
    expect(splitName("Abdeali Diwan")).toEqual({ first: "Abdeali", last: "Diwan" });
    expect(splitName("Behlul Uncle Poonawala")).toEqual({ first: "Behlul", last: "Uncle Poonawala" });
    expect(splitName("Harnoor")).toEqual({ first: "Harnoor", last: "" });
  });
});

describe("isCreatableName", () => {
  it("real names yes; bare numbers/emails no", () => {
    expect(isCreatableName("Roland Salatino")).toBe(true);
    expect(isCreatableName("+12149088938")).toBe(false);
    expect(isCreatableName("+1 (214) 908-8938")).toBe(false);
    expect(isCreatableName("someone@x.com")).toBe(false);
    expect(isCreatableName("  ")).toBe(false);
  });
});

describe("composeCardBio", () => {
  it("inferred people get the marker as the LAST line; verified people never do", () => {
    expect(composeCardBio("Met at hackathon.", true)).toBe(`Met at hackathon.\n\n${INFERRED_MARKER}`);
    expect(composeCardBio("Met at hackathon.", false)).toBe("Met at hackathon.");
    expect(composeCardBio(null, true)).toBe(INFERRED_MARKER); // card exists before any bio is mined
    expect(composeCardBio(null, false)).toBe("");
  });
  it("marker sits inside the managed block and survives re-splice", () => {
    const v1 = spliceBlock("owner note", composeCardBio("Bio.", true));
    expect(v1.endsWith(`${INFERRED_MARKER}\n${BLOCK_END}`)).toBe(true);
    const v2 = spliceBlock(v1, composeCardBio("Bio.", false)); // verified → marker drops
    expect(v2).not.toContain(INFERRED_MARKER);
    expect(v2).toContain("owner note");
  });
});

describe("wasUserEdited", () => {
  it("true only when the card changed well after POS's own write", () => {
    expect(wasUserEdited("2026-09-11T10:10:00Z", "2026-09-11T10:00:00Z")).toBe(true);
    expect(wasUserEdited("2026-09-11T10:00:30Z", "2026-09-11T10:00:00Z")).toBe(false); // save latency slack
    expect(wasUserEdited("2026-09-11T09:00:00Z", "2026-09-11T10:00:00Z")).toBe(false);
    expect(wasUserEdited(null, "2026-09-11T10:00:00Z")).toBe(false);
    expect(wasUserEdited("2026-09-11T10:10:00Z", null)).toBe(false); // no baseline → never assume
  });
});
