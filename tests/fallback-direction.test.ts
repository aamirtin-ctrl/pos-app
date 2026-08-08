// Who owes whom, when the model is unavailable.
//
// The no-LLM path hard-coded direction "i_owe_them" for every commitment it wrote. That is
// right for the common case — he promises someone something — and plainly wrong for the
// opposite one. On 2026-08-08 his review queue held "EURO 26 🇮🇹🇨🇭🇪🇸 — I will be gone for the
// evening", written by Hudson, listed as something AAMIR owed Hudson.
//
// The interaction row already carries inbound/outbound; the fallback simply never read it.

import { describe, it, expect } from "vitest";
import { fallbackDirection } from "../main/crm/commitments.ts";

describe("fallbackDirection", () => {
  it("a promise THEY made is theirs to keep — his real case", () => {
    expect(fallbackDirection("I will be gone for the evening", "inbound")).toBe("they_owe_me");
    expect(fallbackDirection("I'll ping u in the evening", "inbound")).toBe("they_owe_me");
    expect(fallbackDirection("let me dig up the link", "inbound")).toBe("they_owe_me");
  });

  it("a promise HE made is his to keep — the common case, unchanged", () => {
    expect(fallbackDirection("I'll send the deck tonight", "outbound")).toBe("i_owe_them");
    expect(fallbackDirection("I'm gonna bring the cash tomorrow", "outbound")).toBe("i_owe_them");
  });

  it("a request THEY made lands on him", () => {
    expect(fallbackDirection("can you send me the deck?", "inbound")).toBe("i_owe_them");
    expect(fallbackDirection("please share the notes", "inbound")).toBe("i_owe_them");
  });

  it("a request HE made lands on them", () => {
    expect(fallbackDirection("can you send me the deck?", "outbound")).toBe("they_owe_me");
    expect(fallbackDirection("lmk when you're free", "outbound")).toBe("they_owe_me");
  });

  it("when both appear, the one stated FIRST is the point of the message", () => {
    // Same tie-break the duration parser uses: earliest wins.
    expect(fallbackDirection("can you send the deck? I'll pay you back", "inbound")).toBe("i_owe_them");
    expect(fallbackDirection("I'll pay you back — can you send the deck?", "inbound")).toBe("they_owe_me");
  });

  it("with no signal at all it keeps the old default, changing nothing it cannot justify", () => {
    for (const [text, dir] of [
      ["dinner was great", "inbound"],
      ["ok", "outbound"],
      ["", "inbound"],
    ] as const) {
      expect(fallbackDirection(text, dir)).toBe("i_owe_them");
    }
    expect(fallbackDirection(null, null)).toBe("i_owe_them");
    expect(fallbackDirection("I'll send it", null)).toBe("i_owe_them"); // unknown direction → old default
  });
});
