// Observed wake time (owner request 2026-08-05): he texts his own number / has Alexa mail
// him when he gets up, and POS plans the day against that instead of the doctrine's 07:30.
//
// Timestamps here are deliberately ZONELESS ISO ("2026-08-05T06:40:00") so Date parses them
// as local time and the tests hold in any timezone — which is also exactly how the feature
// behaves: the day key and the HH:MM are the owner's wall clock.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, setSetting, type Db } from "../main/db/db.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML } from "../main/engine/doctrine.ts";
import {
  WAKE_SETTING_PREFIX,
  detectWakeFromText,
  isWakeMessage,
  observedWake,
  recordWake,
  wakeSettingKey,
  wakeTimeFor,
} from "../main/wake.ts";

const doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const DAY = "2026-08-05";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-wake-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("recording an observed wake", () => {
  it("round-trips a wake through the per-day setting", () => {
    const rec = recordWake(db, `${DAY}T06:40:00`);
    expect(rec).toEqual({ dateISO: DAY, hhmm: "06:40", stored: true });
    expect(observedWake(db, DAY)).toBe("06:40");
    // stored where the key contract says it is
    expect(getSetting(db, `${WAKE_SETTING_PREFIX}${DAY}`)).toBe("06:40");
    expect(wakeSettingKey(DAY)).toBe("wake_observed:2026-08-05");
  });

  it("keys off the message's own local day, not today", () => {
    recordWake(db, "2026-08-03T05:15:00");
    expect(observedWake(db, "2026-08-03")).toBe("05:15");
    expect(observedWake(db, DAY)).toBeNull(); // a different day is untouched
  });

  it("keeps the EARLIEST ping of a day — a later 'good morning' can't drag wake forward", () => {
    recordWake(db, `${DAY}T06:40:00`);
    const second = recordWake(db, `${DAY}T10:30:00`);
    expect(second).toEqual({ dateISO: DAY, hhmm: "06:40", stored: false });
    expect(observedWake(db, DAY)).toBe("06:40");
    // …but an earlier one does correct the record
    expect(recordWake(db, `${DAY}T05:55:00`)?.stored).toBe(true);
    expect(observedWake(db, DAY)).toBe("05:55");
  });

  it("returns null on an unparseable timestamp and writes nothing", () => {
    expect(recordWake(db, "not a timestamp")).toBeNull();
    expect(observedWake(db, DAY)).toBeNull();
  });

  it("pads single-digit hours and rejects hand-edited garbage", () => {
    recordWake(db, `${DAY}T07:05:00`);
    expect(observedWake(db, DAY)).toBe("07:05");
    setSetting(db, wakeSettingKey(DAY), "bananas");
    expect(observedWake(db, DAY)).toBeNull(); // degrades to "not reported", never to a bad plan
    setSetting(db, wakeSettingKey(DAY), "25:00");
    expect(observedWake(db, DAY)).toBeNull();
  });
});

describe("wakeTimeFor", () => {
  it("uses the observed wake when one was reported", () => {
    recordWake(db, `${DAY}T06:40:00`);
    expect(wakeTimeFor(db, DAY, doctrine)).toBe("06:40");
  });

  it("falls back to the doctrine when nothing was reported", () => {
    expect(wakeTimeFor(db, DAY, doctrine)).toBe("07:30");
    expect(wakeTimeFor(db, DAY, doctrine)).toBe(doctrine.chronotype.wake_time);
  });

  it("is per-day — yesterday's report does not leak into today", () => {
    recordWake(db, "2026-08-04T06:00:00");
    expect(wakeTimeFor(db, "2026-08-04", doctrine)).toBe("06:00");
    expect(wakeTimeFor(db, DAY, doctrine)).toBe("07:30");
  });
});

describe("detectWakeFromText", () => {
  it("recognizes explicit wake pings", () => {
    for (const text of [
      "just woke up",
      "Just woke up!",
      "awake",
      "Awake.",
      "morning!",
      "Morning",
      "good morning",
      "Good morning!",
      "up now",
      "I'm up",
      "im awake",
      "woke up",
      "gm",
    ]) {
      expect(detectWakeFromText(text), text).toBe(true);
    }
  });

  it("does NOT classify a task that merely contains a wake word", () => {
    for (const text of [
      "morning meeting with Raj", // the one that must never be eaten
      "good morning call with Sarah",
      "prep the morning standup deck",
      "email Raj about the awake-hours study",
      "wake up the staging server",
      "book gym for tomorrow morning",
      "",
      "   ",
    ]) {
      expect(detectWakeFromText(text), text).toBe(false);
    }
  });

  it("gives up the ping when the message carries real content", () => {
    // A false positive is CONSUMED and never reaches the assistant, so a wake ping with a
    // task attached must lose: the task is worth more than the timestamp.
    expect(detectWakeFromText("just woke up, remind me to call the dentist at 3")).toBe(false);
    expect(detectWakeFromText("morning — draft the investor update and send it")).toBe(false);
  });
});

describe("isWakeMessage — the predicate main/capture.ts consumes on", () => {
  it("accepts a wake ping sent in the morning", () => {
    expect(isWakeMessage("just woke up", `${DAY}T06:40:00`)).toBe(true);
    expect(isWakeMessage("morning!", `${DAY}T07:59:00`)).toBe(true);
    expect(isWakeMessage("awake", `${DAY}T11:59:00`)).toBe(true);
  });

  it("ignores an afternoon 'awake' — it is not a wake report", () => {
    expect(isWakeMessage("awake", `${DAY}T12:00:00`)).toBe(false);
    expect(isWakeMessage("just woke up", `${DAY}T15:20:00`)).toBe(false);
    expect(isWakeMessage("morning!", `${DAY}T21:00:00`)).toBe(false);
  });

  it("ignores a non-wake message whatever the hour", () => {
    expect(isWakeMessage("morning meeting with Raj", `${DAY}T06:40:00`)).toBe(false);
  });

  it("needs a usable timestamp — no timestamp, no consumption", () => {
    expect(isWakeMessage("awake", null)).toBe(false);
    expect(isWakeMessage("awake", "nonsense")).toBe(false);
  });

  it("uses the MESSAGE's timestamp, not now() — a 06:40 text read at 07:15 still reads 06:40", () => {
    // The whole point of carrying sentAt through capture: capture runs on a worker tick.
    expect(isWakeMessage("just woke up", `${DAY}T06:40:00`)).toBe(true);
    expect(recordWake(db, `${DAY}T06:40:00`)?.hhmm).toBe("06:40");
  });
});
