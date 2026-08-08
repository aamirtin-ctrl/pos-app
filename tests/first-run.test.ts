// A brand-new, empty database must not break anything.
//
// Nobody exercises this path after day one, which is exactly why it rots — and it is not
// hypothetical here: this database has been lost once already (the ~/Library case-insensitivity
// incident) and rebuilt from scratch. Every read below runs against a schema with no rows at
// all: no people, no tasks, no plans, no settings, no doctrine on disk.
//
// The bar is "returns something sensible", not "returns data". A first run that throws is a
// first run that cannot recover.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { generatePlan, tasksAwaitingPlan, tasksUnaccountedFor, upcomingDates } from "../main/planner.ts";
import { plansOnStaleEngine, mirrorAppleSweep } from "../main/workers.ts";
import { loadDoctrine } from "../main/engine/doctrine.ts";
import { materializeRecurringTasks } from "../main/crm/recurring.ts";
import { todayISO } from "../main/dates.ts";
import { reconcileGoogleTasks } from "../main/gtasks-sync.ts";
import { enrichAgenticCurriculumTasks } from "../main/notion.ts";

const DATE = "2026-08-12";
const NOW = new Date(`${DATE}T06:00:00`);

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-first-run-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine"); // deliberately does NOT exist yet
  secrets = new SecretStore(path.join(dir, "secrets")); // no keys at all
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a first run against an empty database", () => {
  it("seeds a usable doctrine from nothing on disk", () => {
    const d = loadDoctrine(doctrineDir);
    expect(d.chronotype.wake_time).toMatch(/^\d{2}:\d{2}$/);
    expect(d.energy_curve.length).toBeGreaterThan(1);
  });

  it("plans an empty day without throwing, and produces a real day", async () => {
    await generatePlan(db, doctrineDir, secrets, null, DATE, { anchors: async () => [], now: NOW });
    const plan = db.prepare("SELECT id, unplaced_tasks FROM plan WHERE plan_date = ?").get(DATE) as
      | { id: number; unplaced_tasks: string }
      | undefined;
    expect(plan, "an empty day still gets a plan — the rituals are the day").toBeTruthy();
    expect(JSON.parse(plan!.unplaced_tasks)).toEqual([]);
    const blocks = db.prepare("SELECT COUNT(*) n FROM block WHERE plan_id = ?").get(plan!.id) as { n: number };
    expect(blocks.n, "morning routine, comms, lunch, shutdown…").toBeGreaterThan(0);
  });

  it("every read-side helper answers on an empty database", () => {
    expect(tasksAwaitingPlan(db, DATE)).toBe(0);
    expect(tasksUnaccountedFor(db, DATE)).toBe(0);
    expect(plansOnStaleEngine(db, NOW)).toEqual([]);
    expect(materializeRecurringTasks(db, DATE, todayISO(NOW))).toBe(0);
    expect(upcomingDates(todayISO(NOW), 3)).toHaveLength(3);
  });

  it("the integrations no-op rather than throw when nothing is configured", async () => {
    // No Google token, no Notion token, no Apple permission — the first-run state.
    await expect(reconcileGoogleTasks(db, secrets)).resolves.toMatchObject({ error: "not_connected" });
    await expect(mirrorAppleSweep(db, secrets)).resolves.toMatchObject({ skipped: "not_connected" });
    await expect(enrichAgenticCurriculumTasks(db, secrets, DATE)).resolves.toEqual({ enriched: 0 });
  });

  it("planning the same empty day twice is stable", async () => {
    const opts = { anchors: async () => [], now: NOW };
    await generatePlan(db, doctrineDir, secrets, null, DATE, opts);
    const first = db.prepare("SELECT COUNT(*) n FROM block").get() as { n: number };
    await generatePlan(db, doctrineDir, secrets, null, DATE, opts);
    const second = db.prepare("SELECT COUNT(*) n FROM block").get() as { n: number };
    expect(second.n, "a re-plan must not accumulate blocks").toBe(first.n);
  });
});
