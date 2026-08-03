// Essential cases ported from PersonalCRM2 lib/message-followups.test.ts, plus coverage of
// the adapted extractFollowups (proposed-commitments output).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  detectMessageFollowUp,
  isPlanMessage,
  plannedDateInWindow,
  extractFollowups,
  type SessionMsg,
} from "../../main/crm/followups.ts";

const NOW = new Date("2026-06-01T00:00:00Z");

// Anchor messages are all sent ~3 days before NOW so resolved weekdays land in the future.
const D = () => new Date("2026-05-29T12:00:00Z"); // a Friday
const win = (...texts: string[]): SessionMsg[] => texts.map((t) => ({ snippet: t, date: D() }));

let dir: string;
let db: Db;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-followups-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("detection primitives", () => {
  it("isPlanMessage: plan vs chatter vs automated", () => {
    expect(isPlanMessage("wanna grab lunch?")).toBe(true);
    expect(isPlanMessage("haha that's hilarious")).toBe(false);
    expect(isPlanMessage("your verification code is 123")).toBe(false); // automated
  });

  it("window: picks the CONFIRMED date among options (anchor Fri 2026-05-29)", () => {
    const w = win("wanna meet up?", "maybe tomorrow?", "or next monday is better", "next monday works", "great");
    const r = plannedDateInWindow(w, NOW);
    expect(r).toBeTruthy();
    expect(r!.date.toISOString().slice(0, 10)).toBe("2026-06-08"); // next monday after 05-29
  });

  it("window: cancellation ('rain check') drops the plan", () => {
    const w = win("dinner next tuesday?", "sounds good", "oh wait I have to cancel, rain check");
    expect(plannedDateInWindow(w, NOW)).toBeNull();
  });

  it("upcoming dated plan → live follow-up with baked-in ISO", () => {
    const r = detectMessageFollowUp("wanna grab lunch next week?", new Date("2026-05-30T00:00:00Z"), NOW);
    expect(r).toBeTruthy();
    expect(r!.dueDate?.toISOString().slice(0, 10)).toBe("2026-06-06");
    expect(r!.text).toMatch(/\(due 2026-06-06\)/);
  });

  it("a plan that already passed is dropped (no past follow-ups)", () => {
    // texted 8 months ago: "lunch next Friday" resolved to last year → past → null
    expect(detectMessageFollowUp("let's grab lunch next friday", new Date("2025-09-10T00:00:00Z"), NOW)).toBeNull();
  });

  it("automated / OTP texts are excluded", () => {
    expect(detectMessageFollowUp("Your verification code is 482913. Do not reply.", D(), NOW)).toBeNull();
    expect(
      detectMessageFollowUp("Reminder: your appointment with Dr. Lee tomorrow", D(), NOW)
    ).toBeNull();
  });

  it("retrospective messages with a topic word but no intent → null", () => {
    expect(detectMessageFollowUp("thanks for lunch, it was great!", D(), NOW)).toBeNull();
  });
});

describe("extractFollowups (proposed commitments)", () => {
  it("future confirmed plan → dated commitment with the right date", () => {
    const out = extractFollowups(
      db,
      7,
      [
        { text: "wanna meet up?", sentAt: "2026-05-29T12:00:00Z", direction: "outbound" },
        { text: "next monday works", sentAt: "2026-05-29T12:05:00Z", direction: "inbound" },
      ],
      NOW
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ personId: 7, dueAt: "2026-06-08" });
  });

  it("past plan is dropped", () => {
    const out = extractFollowups(
      db,
      7,
      [{ text: "let's grab lunch next friday", sentAt: "2025-09-10T00:00:00Z", direction: "outbound" }],
      NOW
    );
    expect(out).toEqual([]);
  });

  it("'rain check' after confirmation cancels the plan", () => {
    const out = extractFollowups(
      db,
      7,
      [
        { text: "dinner next tuesday?", sentAt: "2026-05-29T12:00:00Z" },
        { text: "sounds good", sentAt: "2026-05-29T12:01:00Z" },
        { text: "oh wait I have to cancel, rain check", sentAt: "2026-05-29T12:30:00Z" },
      ],
      NOW
    );
    expect(out.filter((p) => p.dueAt !== null)).toEqual([]);
  });

  it("automated/OTP messages never produce commitments", () => {
    const out = extractFollowups(
      db,
      7,
      [
        { text: "Your verification code is 482913. Do not reply.", sentAt: "2026-05-30T12:00:00Z" },
        { text: "Your package has shipped, arriving tomorrow", sentAt: "2026-05-30T13:00:00Z" },
      ],
      NOW
    );
    expect(out).toEqual([]);
  });

  it("undated forward intent from a recent message → dueAt null", () => {
    const out = extractFollowups(
      db,
      7,
      [{ text: "we should catch up soon!", sentAt: "2026-05-25T00:00:00Z" }],
      NOW
    );
    expect(out).toHaveLength(1);
    expect(out[0].dueAt).toBeNull();
  });
});
