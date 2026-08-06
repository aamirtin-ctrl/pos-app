// Re-planning when the calendar moves under a plan (owner case, 2026-08-06).
//
// He added a "hangout" 16:00–19:00 in Google AFTER POS had generated that day's plan, and a
// focused_work block stayed sitting at 17:15–18:30 inside it. These tests are DB-backed —
// real SQLite, real solver, real persistence — with the anchor reader injected, so the whole
// decision path runs without a network or a Google account.
//
// The properties being defended, beyond the scenarios themselves: it cannot loop, locked
// blocks survive, and the same inputs always produce the same day.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import type { Anchor } from "../main/engine/grid.ts";
import {
  generatePlan,
  getPlan,
  replanIfConflicted,
  replanUpcoming,
  displacedByNewAnchors,
  freedByRemovedAnchors,
  tasksAwaitingPlan,
  ANCHOR_FINGERPRINT_PREFIX,
  type PlannedSpan,
  type ReplanDeps,
} from "../main/planner.ts";

const DATE = "2026-08-06";
const HANGOUT_START = 16 * 60;
const HANGOUT_END = 19 * 60;

let dir: string;
let db: Db;
let doctrineDir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-replan-"));
  db = openDb(path.join(dir, "pos.db"));
  doctrineDir = path.join(dir, "doctrine"); // loadDoctrine writes the default on first read
  secrets = new SecretStore(path.join(dir, "secrets")); // no Google token → never touches the network
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

/** The injected calendar. No network, and the check and the re-solve see one view of the day. */
// A FIXED clock, early on the day under test.
//
// DATE is 2026-08-06, which was the real date when these were written — so once the wall clock
// passed each fixture's hours, the now-floor started treating them as history and the
// past-block carry-forward pinned them where they stood. Two tests began failing in the
// evening and would have passed again tomorrow, which is the worst kind of flake.
//
// These tests are about re-planning, not about what time it is. Pinning the clock at 06:00
// keeps the whole day ahead of "now", which is the condition they were written under.
const AT_0600 = new Date(`${DATE}T06:00:00`);

const calendar = (anchors: Anchor[]): ReplanDeps => ({ anchors: async () => anchors, now: AT_0600 });

const anchor = (
  startMin: number,
  endMin: number,
  title: string,
  flexibility: Anchor["flexibility"] = "fixed"
): Anchor => ({ startMin, endMin, blockType: "personal", title, flexibility });

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const iso = (min: number, dateISO = DATE) => `${dateISO}T${hhmm(min)}:00`;
const minutesOf = (isoText: string) => {
  const d = new Date(isoText);
  return d.getHours() * 60 + d.getMinutes();
};

function addTask(p: {
  title: string;
  blockType?: string;
  minutes?: number;
  status?: string;
  dateISO?: string;
}): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, is_mit, status, plan_date)
       VALUES (?, ?, 3, ?, 0, ?, ?)`
    )
    .run(p.title, p.blockType ?? "focused_work", p.minutes ?? 75, p.status ?? "planned", p.dateISO ?? DATE);
  return Number(lastInsertRowid);
}

interface SeedBlock {
  title: string;
  startMin: number;
  endMin: number;
  taskId?: number;
  blockType?: string;
  isAnchor?: boolean;
  isLocked?: boolean;
  gcalEventId?: string;
}

/**
 * Hand-build the plan that was already on disk. Deliberately not generated: these tests are
 * about what happens to a plan that already exists, and his real DB row is the fixture.
 * `generated_at` is backdated so any plan produced by a re-solve sorts after it.
 */
function seedPlan(p: {
  accepted: boolean;
  blocks: SeedBlock[];
  unplaced?: { taskId: number; title: string; reason: string }[];
  dateISO?: string;
}): number {
  const dateISO = p.dateISO ?? DATE;
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO plan (plan_date, generated_at, engine_version, doctrine_snapshot, narration,
         unplaced_tasks, accepted_at)
       VALUES (?, datetime('now','-1 hour'), 'test', '{}', 'seeded', ?, ?)`
    )
    .run(dateISO, JSON.stringify(p.unplaced ?? []), p.accepted ? "2026-08-06 08:00:00" : null);
  const planId = Number(lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, is_locked,
       plan_id, gcal_event_id, flexibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const b of p.blocks) {
    ins.run(
      b.taskId ?? null,
      b.blockType ?? "focused_work",
      b.title,
      iso(b.startMin, dateISO),
      iso(b.endMin, dateISO),
      b.isAnchor ? 1 : 0,
      b.isLocked ? 1 : 0,
      planId,
      b.gcalEventId ?? null,
      b.isAnchor ? "fixed" : "flexible"
    );
  }
  return planId;
}

const planCount = (dateISO = DATE) =>
  (db.prepare("SELECT COUNT(*) AS n FROM plan WHERE plan_date = ?").get(dateISO) as { n: number }).n;

/** The current plan's blocks, as the conflict scan sees them. */
function currentSpans(dateISO = DATE): PlannedSpan[] {
  const view = getPlan(db, dateISO)!;
  return (view.blocks as Record<string, unknown>[]).map((b) => ({
    title: (b.title as string) ?? "(untitled)",
    startMin: minutesOf(b.starts_at as string),
    endMin: minutesOf(b.ends_at as string),
    isAnchor: b.is_anchor === 1,
    isLocked: b.is_locked === 1,
    isExternal: !!b.gcal_event_id,
  }));
}

const overlaps = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) =>
  a.startMin < b.endMin && a.endMin > b.startMin;

// ── 1. the owner's case ─────────────────────────────────────────────────────

describe("his actual Aug 6: a hangout added after the plan was generated", () => {
  const hangout = anchor(HANGOUT_START, HANGOUT_END, "hangout");

  function seedHisDay(accepted: boolean) {
    const taskId = addTask({ title: "Ship the deck", minutes: 75 });
    seedPlan({
      accepted,
      blocks: [{ title: "Ship the deck", startMin: 17 * 60 + 15, endMin: 18 * 60 + 30, taskId }],
    });
    return taskId;
  }

  it("re-solves an UN-ACCEPTED plan, and the work block no longer sits inside the hangout", async () => {
    const taskId = seedHisDay(false);

    const r = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]));

    expect(r.replanned).toBe(true);
    expect(r.displaced).toEqual(["Ship the deck"]);

    const view = getPlan(db, DATE)!;
    const blocks = view.blocks as Record<string, unknown>[];

    // the hangout is now part of the day, exactly where Google has it
    const placed = blocks.filter((b) => b.title === "hangout");
    expect(placed).toHaveLength(1);
    expect(minutesOf(placed[0].starts_at as string)).toBe(HANGOUT_START);
    expect(minutesOf(placed[0].ends_at as string)).toBe(HANGOUT_END);
    expect(placed[0].is_anchor).toBe(1);

    // …and nothing the planner placed is inside it any more
    for (const b of blocks) {
      if (b.is_anchor === 1) continue;
      const span = { startMin: minutesOf(b.starts_at as string), endMin: minutesOf(b.ends_at as string) };
      expect(overlaps(span, hangout), `"${b.title}" is still inside the hangout`).toBe(false);
    }

    // the task itself was re-seated, not dropped
    const work = blocks.find((b) => b.task_id === taskId);
    expect(work, "the task kept its place in the day").toBeTruthy();
    expect(overlaps(
      { startMin: minutesOf(work!.starts_at as string), endMin: minutesOf(work!.ends_at as string) },
      hangout
    )).toBe(false);
  });

  it("re-solves an ACCEPTED plan too — a hangout is an obligation, not a suggestion", async () => {
    seedHisDay(true);
    const r = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]));
    expect(r.replanned).toBe(true);
    expect(r.displaced).toEqual(["Ship the deck"]);
    // the accepted plan is kept; the re-solve lands as a new, UN-accepted plan he has to read
    expect(planCount()).toBe(2);
    expect((getPlan(db, DATE)!.plan as Record<string, unknown>).accepted_at).toBeNull();
  });

  it("CANNOT LOOP: an immediate second pass over the same calendar does nothing", async () => {
    seedHisDay(false);
    expect((await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]))).replanned).toBe(
      true
    );
    const after = planCount();

    const second = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]));
    expect(second.replanned).toBe(false);
    expect(planCount()).toBe(after);

    // …and not merely because of the recorded fingerprint. Drop it and the SEMANTIC checks
    // still read the regenerated plan as settled: the hangout is part of the day now.
    db.prepare("DELETE FROM setting WHERE key LIKE ?").run(`${ANCHOR_FINGERPRINT_PREFIX}%`);
    const spans = currentSpans();
    expect(displacedByNewAnchors(spans, [hangout], { accepted: false })).toEqual([]);
    expect(freedByRemovedAnchors(spans, [hangout], { accepted: false })).toEqual([]);

    const third = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]));
    expect(third.replanned).toBe(false);
    expect(planCount()).toBe(after);
  });

  it("is deterministic — the same conflict re-solved twice produces the same day", async () => {
    seedHisDay(false);
    await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([hangout]));
    const first = currentSpans();

    // regenerate from the same inputs and compare the shape of the day
    await generatePlan(db, doctrineDir, secrets, null, DATE, calendar([hangout]));
    expect(currentSpans()).toEqual(first);
  });
});

// ── 2. acceptance sets the threshold ────────────────────────────────────────

describe("acceptance changes the bar, not the eligibility", () => {
  function seedWorkBlock(accepted: boolean) {
    const taskId = addTask({ title: "Ship the deck", minutes: 75 });
    seedPlan({
      accepted,
      blocks: [{ title: "Ship the deck", startMin: 17 * 60 + 15, endMin: 18 * 60 + 30, taskId }],
    });
  }

  it("an ACCEPTED plan re-solves for a 3-hour PREFERRED event on a work block", async () => {
    seedWorkBlock(true);
    // A title POS cannot classify — no attendees, no obligation words. Three hours on top of
    // placed work is a real conflict whatever it is called.
    const r = await replanIfConflicted(
      db,
      doctrineDir,
      secrets,
      null,
      DATE,
      calendar([anchor(HANGOUT_START, HANGOUT_END, "Zayn's place", "preferred")])
    );
    expect(r.replanned).toBe(true);
    expect(r.displaced).toEqual(["Ship the deck"]);
  });

  it("an ACCEPTED plan is NOT rewritten by a 10-minute preferred overlap", async () => {
    seedWorkBlock(true);
    const r = await replanIfConflicted(
      db,
      doctrineDir,
      secrets,
      null,
      DATE,
      calendar([anchor(18 * 60 + 20, 18 * 60 + 40, "Errand", "preferred")])
    );
    expect(r.replanned).toBe(false);
    expect(planCount()).toBe(1);
  });

  it("an UN-ACCEPTED plan re-solves on that same 10-minute overlap — he has not read it", async () => {
    seedWorkBlock(false);
    const r = await replanIfConflicted(
      db,
      doctrineDir,
      secrets,
      null,
      DATE,
      calendar([anchor(18 * 60 + 20, 18 * 60 + 40, "Errand", "preferred")])
    );
    expect(r.replanned).toBe(true);
    expect(r.displaced).toEqual(["Ship the deck"]);
  });
});

// ── 3. a deleted event frees time ───────────────────────────────────────────

describe("a cancelled obligation frees its window", () => {
  it("re-solves into the freed 2 hours and seats the task that had nowhere to go", async () => {
    const seated = addTask({ title: "Morning MIT", minutes: 60 });
    const stranded = addTask({ title: "Write the memo", minutes: 60 });
    seedPlan({
      accepted: true,
      blocks: [
        {
          title: "Dentist appointment",
          startMin: 13 * 60,
          endMin: 15 * 60,
          isAnchor: true,
          blockType: "personal",
          gcalEventId: "ev-dentist",
        },
        { title: "Morning MIT", startMin: 9 * 60, endMin: 10 * 60, taskId: seated },
      ],
      unplaced: [{ taskId: stranded, title: "Write the memo", reason: "no_eligible_slot" }],
    });

    // the appointment is gone from Google
    const r = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([]));

    expect(r.replanned).toBe(true);
    expect(r.freed).toEqual(["Dentist appointment"]);
    expect(r.displaced).toEqual([]);

    const blocks = getPlan(db, DATE)!.blocks as Record<string, unknown>[];
    // he does NOT expect the old arrangement back — he expects the freed time used
    expect(blocks.some((b) => b.task_id === stranded), "the stranded task got seated").toBe(true);
    expect(blocks.some((b) => b.title === "Dentist appointment")).toBe(false);

    // and this settles: the anchor is gone from the plan, so there is nothing left to miss
    const second = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([]));
    expect(second.replanned).toBe(false);
  });

  it("a cancelled 15-minute call does NOT rewrite a day he is reading", async () => {
    const stranded = addTask({ title: "Write the memo", minutes: 60 });
    seedPlan({
      accepted: true,
      blocks: [
        {
          title: "Quick call",
          startMin: 16 * 60,
          endMin: 16 * 60 + 15,
          isAnchor: true,
          blockType: "meeting",
          gcalEventId: "ev-call",
        },
      ],
      unplaced: [{ taskId: stranded, title: "Write the memo", reason: "no_eligible_slot" }],
    });

    const r = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([]));
    expect(r.replanned).toBe(false);
    expect(planCount()).toBe(1);
  });

  // Owner report 2026-08-06: "even though I deleted the Yoga Foundation event from my calendar,
  // it still shows up in the app." This test asserted the behaviour that caused it.
  //
  // The deletion WAS visible — the live anchor set was empty while the plan still held the
  // event — but the re-solve was gated on something waiting to use the freed minutes, and
  // nothing was. So the day kept showing an event he had cancelled.
  //
  // Skipping a re-solve when no work would benefit is right for CHURN and wrong for
  // CORRECTNESS. An empty slot is honest; a cancelled event is not.
  it("removes a cancelled event even when nothing is waiting for its time", async () => {
    seedPlan({
      accepted: false,
      blocks: [
        {
          title: "Dentist appointment",
          startMin: 13 * 60,
          endMin: 15 * 60,
          isAnchor: true,
          blockType: "personal",
          gcalEventId: "ev-dentist",
        },
      ],
    });
    const r = await replanIfConflicted(db, doctrineDir, secrets, null, DATE, calendar([]));
    expect(r.replanned).toBe(true);
    // …and the event is gone from the regenerated day.
    const blocks = (getPlan(db, DATE)!.blocks as Record<string, unknown>[]);
    expect(blocks.some((b) => b.title === "Dentist appointment")).toBe(false);
    // Nothing was waiting, so there is no freed-time news to report — only the removal.
    expect(r.freed).toEqual([]);
  });
});

// ── 4. locked blocks ────────────────────────────────────────────────────────

describe("locked blocks", () => {
  it("survive the re-solve and keep their exact minutes", async () => {
    const taskId = addTask({ title: "Ship the deck", minutes: 75 });
    seedPlan({
      accepted: true,
      blocks: [
        { title: "Ship the deck", startMin: 17 * 60 + 15, endMin: 18 * 60 + 30, taskId },
        {
          title: "Pinned reading",
          startMin: 20 * 60 + 45,
          endMin: 21 * 60 + 30,
          blockType: "personal",
          isLocked: true,
        },
      ],
    });

    const r = await replanIfConflicted(
      db,
      doctrineDir,
      secrets,
      null,
      DATE,
      calendar([anchor(HANGOUT_START, HANGOUT_END, "hangout")])
    );
    expect(r.replanned).toBe(true);

    // the pin itself is untouched in the DB…
    //
    // The ACCEPTED plan keeps its row (it owns the day's outcome history) and the regenerated
    // plan carries the pin forward onto its own block — since 2026-08-06 the pin is written on
    // the new block too, so it survives the NEXT re-solve instead of silently expiring after
    // one. Both rows describe the same reserved minutes, which is what actually matters here.
    const pin = db
      .prepare("SELECT starts_at, ends_at FROM block WHERE is_locked = 1 AND date(starts_at) = ?")
      .all(DATE) as { starts_at: string; ends_at: string }[];
    expect(pin.length).toBeGreaterThanOrEqual(1);
    for (const p of pin) {
      expect(minutesOf(p.starts_at)).toBe(20 * 60 + 45);
      expect(minutesOf(p.ends_at)).toBe(21 * 60 + 30);
    }

    // …and the regenerated day still reserves those minutes
    const kept = (getPlan(db, DATE)!.blocks as Record<string, unknown>[]).find(
      (b) => b.title === "Pinned reading"
    );
    expect(kept, "the pinned block is carried into the new plan").toBeTruthy();
    expect(minutesOf(kept!.starts_at as string)).toBe(20 * 60 + 45);
    expect(minutesOf(kept!.ends_at as string)).toBe(21 * 60 + 30);
  });

  it("are excluded from the conflict scan — an event over a pin is not a reason to re-plan", async () => {
    // Re-planning cannot move a pin (generatePlan re-reads it as an anchor), so counting it
    // as displaced would re-plan the day on every tick, forever.
    seedPlan({
      accepted: false,
      blocks: [
        {
          title: "Pinned call",
          startMin: 17 * 60,
          endMin: 18 * 60,
          blockType: "personal",
          isLocked: true,
        },
      ],
    });
    const r = await replanIfConflicted(
      db,
      doctrineDir,
      secrets,
      null,
      DATE,
      calendar([anchor(HANGOUT_START, HANGOUT_END, "hangout")])
    );
    expect(r.replanned).toBe(false);
  });
});

// ── 5. the horizon ──────────────────────────────────────────────────────────

describe("replanUpcoming — today is not the only day he plans", () => {
  const TODAY = "2026-08-05";
  const IN_TWO_DAYS = "2026-08-07";

  function seedFutureConflict() {
    const taskId = addTask({ title: "Ship the deck", minutes: 75, dateISO: IN_TWO_DAYS });
    seedPlan({
      accepted: false,
      dateISO: IN_TWO_DAYS,
      blocks: [{ title: "Ship the deck", startMin: 17 * 60 + 15, endMin: 18 * 60 + 30, taskId }],
    });
  }

  const hangoutOn = (dateISO: string): ReplanDeps => ({
    anchors: async (d) => (d === dateISO ? [anchor(HANGOUT_START, HANGOUT_END, "hangout")] : []),
  });

  it("catches a conflict two days out", async () => {
    seedFutureConflict();
    const r = await replanUpcoming(db, doctrineDir, secrets, null, {
      today: TODAY,
      days: 3,
      deps: hangoutOn(IN_TWO_DAYS),
    });

    expect(r.checked).toEqual(["2026-08-05", "2026-08-06", IN_TWO_DAYS]);
    expect(r.replanned).toEqual([IN_TWO_DAYS]);
    expect(r.displaced).toEqual({ [IN_TWO_DAYS]: ["Ship the deck"] });
    expect(r.freed).toEqual({});
  });

  it("a today-only sweep is exactly the bug that was shipped", async () => {
    seedFutureConflict();
    const r = await replanUpcoming(db, doctrineDir, secrets, null, {
      today: TODAY,
      days: 1,
      deps: hangoutOn(IN_TWO_DAYS),
    });
    expect(r.checked).toEqual([TODAY]);
    expect(r.replanned).toEqual([]);
  });

  it("a date with no plan is checked and skipped, and one bad date never blocks the rest", async () => {
    seedFutureConflict();
    const r = await replanUpcoming(db, doctrineDir, secrets, null, {
      today: TODAY,
      days: 3,
      deps: {
        anchors: async (d) => {
          if (d === TODAY) throw new Error("calendar unreachable");
          return d === IN_TWO_DAYS ? [anchor(HANGOUT_START, HANGOUT_END, "hangout")] : [];
        },
      },
    });
    expect(r.checked).toHaveLength(3);
    expect(r.replanned).toEqual([IN_TWO_DAYS]);
  });
});

// ── a deferral that lands on an unplanned day is a deletion ──────────────────
//
// Owner report 2026-08-06: "Why did you completely delete the Stanford two hour block thing
// from earlier?" It had not been deleted — it was deferred to the next day inside its window,
// exactly as the deadline-window feature intends. But deferral was only half a feature:
// replanIfConflicted returns early when a date has no plan ("that is generatePlan's job"),
// and generatePlan only ran when he braindumped. So the task sat in `inbox` carrying
// tomorrow's date with no block anywhere, and from the calendar that is indistinguishable
// from having been thrown away.
describe("tasksAwaitingPlan", () => {
  it("counts schedulable work on a day that has no plan", () => {
    addTask({ title: "Deferred advising", dateISO: "2026-08-07" });
    expect(tasksAwaitingPlan(db, "2026-08-07")).toBe(1);
  });

  it("is zero once the day has a plan — that is re-planning, not planning", () => {
    addTask({ title: "Deferred advising", dateISO: "2026-08-07" });
    db.prepare(
      `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks)
       VALUES ('2026-08-07', 'test', '{}', '', '[]')`
    ).run();
    expect(tasksAwaitingPlan(db, "2026-08-07")).toBe(0);
  });

  it("never manufactures a plan for an empty day", () => {
    expect(tasksAwaitingPlan(db, "2026-08-07")).toBe(0);
  });

  it("ignores work that is already finished or retired", () => {
    for (const status of ["done", "deferred"]) {
      const id = addTask({ title: `x-${status}`, dateISO: "2026-08-08" });
      db.prepare("UPDATE task SET status = ? WHERE id = ?").run(status, id);
    }
    expect(tasksAwaitingPlan(db, "2026-08-08")).toBe(0);
  });
});
