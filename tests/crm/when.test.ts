// Ported from PersonalCRM2 lib/when.test.ts (node:test → vitest).
import { describe, it, expect } from "vitest";
import { parseWhen } from "../../main/crm/when.ts";

// anchor = a Wednesday
const ANCHOR = new Date("2025-10-01T12:00:00Z"); // Wed Oct 1 2025
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

describe("parseWhen", () => {
  it("relative: tomorrow / today / day after", () => {
    expect(iso(parseWhen("let's meet tomorrow", ANCHOR))).toBe("2025-10-02");
    expect(iso(parseWhen("lunch today?", ANCHOR))).toBe("2025-10-01");
    expect(iso(parseWhen("call day after tomorrow", ANCHOR))).toBe("2025-10-03");
  });

  it("relative: next week / in N / next month", () => {
    expect(iso(parseWhen("grab coffee next week", ANCHOR))).toBe("2025-10-08");
    expect(iso(parseWhen("ping me in 2 weeks", ANCHOR))).toBe("2025-10-15");
    expect(iso(parseWhen("circle back in 3 days", ANCHOR))).toBe("2025-10-04");
    expect(iso(parseWhen("reconnect next month", ANCHOR))).toBe("2025-11-01");
  });

  it("weekdays anchored to message date", () => {
    // Wed Oct 1 → this Friday = Oct 3
    expect(iso(parseWhen("lunch this friday", ANCHOR))).toBe("2025-10-03");
    // next Friday = Oct 10
    expect(iso(parseWhen("dinner next friday", ANCHOR))).toBe("2025-10-10");
    // Monday (upcoming) = Oct 6
    expect(iso(parseWhen("see you monday", ANCHOR))).toBe("2025-10-06");
  });

  it("absolute month anchored: no year → next upcoming from anchor", () => {
    // anchor Oct 2025; "in September" → Sep 2026 (already passed in 2025)
    expect(iso(parseWhen("let's do lunch in September", ANCHOR))).toBe("2026-09-01");
    // "December" still ahead in 2025
    expect(iso(parseWhen("catch up in December", ANCHOR))).toBe("2025-12-01");
    expect(iso(parseWhen("dinner Oct 20", ANCHOR))).toBe("2025-10-20");
  });

  it("ISO date passes through; no temporal phrase → null", () => {
    expect(iso(parseWhen("meeting on 2025-11-15", ANCHOR))).toBe("2025-11-15");
    expect(iso(parseWhen("great chatting, take care", ANCHOR))).toBeNull();
  });
});
