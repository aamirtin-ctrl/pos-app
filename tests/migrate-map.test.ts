import { describe, it, expect } from "vitest";
import {
  parseFollowUp,
  splitName,
  commaSplit,
  mapDirection,
  dateToMidnightIso,
  buildBio,
  threadFromRawMeta,
} from "../scripts/migrate-lib.ts";

describe("parseFollowUp", () => {
  it("splits a trailing (due YYYY-MM-DD) into due_at", () => {
    expect(parseFollowUp("Send deck (due 2026-09-01)")).toEqual({
      description: "Send deck",
      due_at: "2026-09-01T00:00:00",
    });
  });

  it("passes through text with no due date", () => {
    expect(parseFollowUp("Reach out ~June 2026")).toEqual({
      description: "Reach out ~June 2026",
      due_at: null,
    });
  });

  it("only strips a TRAILING due marker", () => {
    expect(parseFollowUp("(due 2026-01-01) then ping")).toEqual({
      description: "(due 2026-01-01) then ping",
      due_at: null,
    });
  });

  it("trims whitespace around the description", () => {
    expect(parseFollowUp("  Lunch  (due 2026-09-15) ")).toEqual({
      description: "Lunch",
      due_at: "2026-09-15T00:00:00",
    });
  });
});

describe("splitName", () => {
  it("splits first/last token on two tokens", () => {
    expect(splitName("Aamir Tinwala")).toEqual({ given: "Aamir", family: "Tinwala" });
  });

  it("takes first and LAST token for 3+ tokens", () => {
    expect(splitName("Mary Jane van Dyke")).toEqual({ given: "Mary", family: "Dyke" });
  });

  it("leaves single-token names unsplit", () => {
    expect(splitName("Cher")).toEqual({ given: null, family: null });
  });

  it("handles extra whitespace", () => {
    expect(splitName("  Ada   Lovelace  ")).toEqual({ given: "Ada", family: "Lovelace" });
  });
});

describe("commaSplit", () => {
  it("trims, drops empties, dedups", () => {
    expect(commaSplit(" a, b ,, a , c")).toEqual(["a", "b", "c"]);
  });

  it("preserves case by default (group names)", () => {
    expect(commaSplit("Friends, Stanford Peers")).toEqual(["Friends", "Stanford Peers"]);
  });

  it("lowercases + dedups case-insensitively when asked (tags)", () => {
    expect(commaSplit("VC, vc , Founder", { lowercase: true })).toEqual(["vc", "founder"]);
  });

  it("returns [] for null/empty", () => {
    expect(commaSplit(null)).toEqual([]);
    expect(commaSplit("")).toEqual([]);
    expect(commaSplit("  , ,")).toEqual([]);
  });
});

describe("mapDirection", () => {
  it("maps connection → mutual", () => {
    expect(mapDirection("connection")).toBe("mutual");
  });

  it("carries inbound/outbound", () => {
    expect(mapDirection("inbound")).toBe("inbound");
    expect(mapDirection("outbound")).toBe("outbound");
  });

  it("carries null", () => {
    expect(mapDirection(null)).toBeNull();
  });
});

describe("dateToMidnightIso", () => {
  it("appends midnight to a date string", () => {
    expect(dateToMidnightIso("2026-06-15")).toBe("2026-06-15T00:00:00");
  });
  it("is null-safe", () => {
    expect(dateToMidnightIso(null)).toBeNull();
  });
});

describe("buildBio", () => {
  it("appends Personal: line to existing notes", () => {
    expect(buildBio("Great person.", "Has two dogs")).toBe("Great person.\nPersonal: Has two dogs");
  });
  it("stands alone when notes are null", () => {
    expect(buildBio(null, "Has two dogs")).toBe("Personal: Has two dogs");
  });
  it("passes notes through when no detail", () => {
    expect(buildBio("Great person.", null)).toBe("Great person.");
    expect(buildBio(null, "  ")).toBeNull();
  });
});

describe("threadFromRawMeta", () => {
  it("reads thread_external_id from object", () => {
    expect(threadFromRawMeta({ thread_external_id: "t1" })).toBe("t1");
  });
  it("reads threadId fallback, incl. from JSON string", () => {
    expect(threadFromRawMeta({ threadId: "t2" })).toBe("t2");
    expect(threadFromRawMeta('{"threadId":"t3"}')).toBe("t3");
  });
  it("returns null for missing/garbage", () => {
    expect(threadFromRawMeta(null)).toBeNull();
    expect(threadFromRawMeta({ rowid: 5 })).toBeNull();
    expect(threadFromRawMeta("not json")).toBeNull();
  });
});
