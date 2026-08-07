// The sparkle box must hear a wake report (owner case, 2026-08-07).
//
// He typed "just woke up" into the assistant and the deterministic fallback created a
// 50-minute focused_work task titled "Just woke up" — then scheduled it 10:45–12:00. The
// capture worker (email/iMessage) has routed wake pings correctly since 2026-08-05; the
// sparkle box simply never ran the same check. DB-backed like tests/replan.test.ts: real
// SQLite, real solver, anchors injected, no network, no LLM.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { handleCommand } from "../main/assistant.ts";
import { wakeSettingKey } from "../main/wake.ts";

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-assistant-wake-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine");
  secrets = new SecretStore(path.join(dir, "secrets"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 08:30 local, today — a real morning, whatever hour the suite happens to run at. */
function thisMorning(): Date {
  const d = new Date();
  d.setHours(8, 30, 0, 0);
  return d;
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const deps = () => ({
  db,
  doctrineDir,
  secrets,
  llm: null,
  now: () => thisMorning(),
  planDeps: { anchors: async () => [], now: thisMorning() },
});

describe("handleCommand — wake reports", () => {
  it("'just woke up' records the wake and creates NO task — his exact input", async () => {
    const res = await handleCommand(deps(), "just woke up");
    expect(res.kind).toBe("plan");
    expect(res.reply).toContain("08:30");
    // The wake is on file for today…
    expect(getSetting(db, wakeSettingKey(todayISO()))).toBe("08:30");
    // …and no task was fabricated from the phrase.
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("a repeat wake ping the same morning is acknowledged, not re-planned", async () => {
    await handleCommand(deps(), "just woke up");
    const res = await handleCommand(deps(), "morning!");
    expect(res.kind).toBe("answer");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("a recurring time dedication routes to the planner, never to a note — his exact input", async () => {
    // 2026-08-07: "can u dedicate 30 mins a day to learning agentic coding" was filed as a
    // note by the model. The deterministic read (duration + a-day recurrence) must win.
    const res = await handleCommand(deps(), "can u dedicate 30 mins a day to learning agentic coding");
    expect(res.kind).toBe("plan");
    const row = db.prepare("SELECT * FROM task ORDER BY id DESC LIMIT 1").get() as any;
    expect(row.recurrence).toBe("daily");
    expect(row.raw_estimate_minutes).toBe(30);
  });

  it("a braindump that merely MENTIONS waking still schedules work", async () => {
    const res = await handleCommand(
      deps(),
      "after I wake up tomorrow I need 2 hours to write the physics lab report"
    );
    expect(res.kind).toBe("plan");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
  });
});
