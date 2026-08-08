// Doctrine validation.
//
// The doctrine drives the entire day, and Settings → Doctrine lets him edit the file by hand.
// A value the schema waves through does not fail visibly; it produces a wrong or empty
// calendar with nothing on screen explaining why.

import { describe, it, expect } from "vitest";
import { parseDoctrine, dayBounds, DEFAULT_DOCTRINE_YAML } from "../../main/engine/doctrine.ts";

describe("doctrine time validation", () => {
  const withChrono = (wake: string, sleep = "23:00") =>
    DEFAULT_DOCTRINE_YAML.replace(/wake_time:.*/, `wake_time: "${wake}"`).replace(
      /sleep_onset:.*/,
      `sleep_onset: "${sleep}"`
    );

  it("rejects a time that is shaped right but is not a time", () => {
    // "99:99" matched \d{2}:\d{2} and became minute 6039 — past the end of any day, so the
    // grid had no usable slots and every task came back unplaced, unexplained.
    for (const t of ["99:99", "24:00", "23:60", "88:88", "07:99"]) {
      expect(() => parseDoctrine(withChrono(t)), t).toThrow();
    }
  });

  it("accepts every real time, including the edges", () => {
    for (const t of ["00:00", "07:30", "09:05", "23:59"]) {
      expect(() => parseDoctrine(withChrono(t)), t).not.toThrow();
    }
  });

  it("a past-midnight sleep onset is legitimate and still yields a sane day", () => {
    // Someone who sleeps at 01:00 is not a malformed doctrine. dayBounds rolls it forward a
    // day, and the shutdown ritual — not sleep — is what caps the work day, so no block ever
    // lands past midnight.
    const d = parseDoctrine(withChrono("07:30", "01:00"));
    const { wakeMin, sleepMin } = dayBounds(d);
    expect(wakeMin).toBe(7 * 60 + 30);
    expect(sleepMin).toBeGreaterThan(wakeMin);
    expect(sleepMin).toBe(24 * 60 + 60);
  });
});
