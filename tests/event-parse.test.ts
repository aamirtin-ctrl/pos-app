import { describe, it, expect } from "vitest";
import { deterministicEvent } from "../main/assistant.ts";

// Wednesday 2026-08-05, 09:00 local — a fixed "now" so weekday math is assertable.
const NOW = new Date(2026, 7, 5, 9, 0, 0);

describe("deterministicEvent (LLM-off fallback)", () => {
  it("parses a weekday + 12h time and infers a meeting", () => {
    const e = deterministicEvent("lunch with Raj Thursday 1pm", NOW)!;
    expect(e.date).toBe("2026-08-06"); // the Thursday after Wed the 5th
    expect(e.start).toBe("13:00");
    expect(e.minutes).toBe(60);
    expect(e.blockType).toBe("meeting");
    expect(e.title).toMatch(/lunch with Raj/i);
  });

  it("treats the same weekday as NEXT week, not today", () => {
    expect(deterministicEvent("standup wednesday 10am", NOW)!.date).toBe("2026-08-12");
  });

  it("handles tomorrow + minutes and classifies solo events as personal", () => {
    const e = deterministicEvent("dentist tomorrow at 9:30am 45 min", NOW)!;
    expect(e.date).toBe("2026-08-06");
    expect(e.start).toBe("09:30");
    expect(e.minutes).toBe(45);
    expect(e.blockType).toBe("personal");
  });

  it("rolls a time already past today forward to tomorrow", () => {
    expect(deterministicEvent("call mom 7am", NOW)!.date).toBe("2026-08-06");
  });

  it("keeps a later time on the same day", () => {
    expect(deterministicEvent("review 4pm", NOW)!.date).toBe("2026-08-05");
  });

  it("reads hour durations and 24h times", () => {
    const e = deterministicEvent("deep work block 14:00 2 hours", NOW)!;
    expect(e.start).toBe("14:00");
    expect(e.minutes).toBe(120);
  });

  it("returns null when there is no time at all", () => {
    expect(deterministicEvent("buy milk", NOW)).toBeNull();
  });

  it("clamps absurd durations", () => {
    expect(deterministicEvent("marathon 8am 900 min", NOW)!.minutes).toBe(480);
  });
});
