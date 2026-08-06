// Google push: scope classification + the automatic push paths.
//
// The bug this covers: GOOGLE_SCOPES was widened to the full .../auth/calendar scope so
// POS could create its own "POS — Planned" calendar. Tokens minted before that change
// still refresh happily but are refused with HTTP 403 "Insufficient Permission" on
// calendars.insert — so "Push to Google" did nothing and said nothing useful.
//
// No network: the calendar/tasks surface is injected exactly as tests/gtasks-sync.test.ts
// injects GoogleTasksDeps, against a real SQLite file.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, setSetting, type Db } from "../main/db/db.ts";
import {
  needsReconsent,
  grantedScopes,
  hasCalendarWriteScope,
  googleScopeStatus,
  RECONSENT_REQUIRED,
} from "../main/gcal/auth.ts";
import { pushPlan, pushTasks, reconcileDayEvents, type GcalPushDeps, type PushCalendarApi, type PushTasksApi } from "../main/gcal/sync.ts";
import { acceptPlan, pushPlanToGoogle, autoPushEnabled, AUTO_PUSH_KEY } from "../main/planner.ts";
import { plansNeedingPush, sweepAutoPush } from "../main/workers.ts";
import type { SecretStore } from "../main/secrets.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const WIDE_SCOPE = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks";
const OLD_SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks";

/** A secret store holding one Google token set with the given scope string. */
function store(scope: string | null, opts: { creds?: boolean; tokens?: boolean } = {}): SecretStore {
  const tokens = opts.tokens ?? true;
  const creds = opts.creds ?? true;
  const token = JSON.stringify(scope === null ? { access_token: "a" } : { access_token: "a", scope });
  return {
    get: (name: string) => {
      if (name === "GOOGLE_OAUTH_TOKENS") return tokens ? token : null;
      if (name === "GOOGLE_OAUTH_CLIENT_ID" || name === "GOOGLE_OAUTH_CLIENT_SECRET") return creds ? "x" : null;
      return null;
    },
  } as unknown as SecretStore;
}

const connected = store(WIDE_SCOPE);

/** The 403 googleapis actually throws when the grant is missing calendars.insert. */
function insufficientPermission(): Error {
  const err = new Error("Insufficient Permission") as Error & { code: number; response: unknown; errors: unknown };
  err.code = 403;
  err.errors = [{ domain: "global", reason: "insufficientPermissions", message: "Insufficient Permission" }];
  err.response = {
    status: 403,
    data: {
      error: {
        code: 403,
        message: "Insufficient Permission",
        status: "PERMISSION_DENIED",
        errors: [{ domain: "global", reason: "insufficientPermissions", message: "Insufficient Permission" }],
      },
    },
  };
  return err;
}

function notFound(): Error {
  const err = new Error("Not Found") as Error & { code: number; response: unknown };
  err.code = 404;
  err.response = { status: 404, data: { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } } };
  return err;
}

function networkError(): Error {
  const err = new Error("getaddrinfo ENOTFOUND www.googleapis.com") as Error & { code: string };
  err.code = "ENOTFOUND";
  return err;
}

interface FakeCalls {
  calendarsGet: number;
  calendarsInsert: number;
  eventsInsert: number;
  eventsUpdate: number;
  eventsDelete: number;
  tasksInsert: number;
}

/**
 * Fake Google surface. `throwOn` names the first call that should fail, so a test can put
 * the 403 exactly where the real one lands (calendars.insert, or events.insert once the
 * calendar already exists).
 */
function fakeDeps(
  opts: { throwOn?: keyof FakeCalls; error?: () => Error } = {}
): GcalPushDeps & { calls: FakeCalls; deleted: string[]; listed: { id: string; summary: string }[] } {
  const calls: FakeCalls = {
    calendarsGet: 0, calendarsInsert: 0, eventsInsert: 0, eventsUpdate: 0, eventsDelete: 0, tasksInsert: 0,
  };
  /** Event ids the fake Google has been asked to delete, in order. */
  const deleted: string[] = [];
  /** What the fake calendar currently holds, for the orphan reconcile. */
  const listed: { id: string; summary: string }[] = [];
  const boom = opts.error ?? insufficientPermission;
  const guard = (k: keyof FakeCalls) => {
    calls[k]++;
    if (opts.throwOn === k) throw boom();
  };
  let eventSeq = 0;
  const calendar: PushCalendarApi = {
    calendars: {
      async get() {
        guard("calendarsGet");
        return { data: { id: "POS_CAL", summary: "POS — Planned" } };
      },
      async insert() {
        guard("calendarsInsert");
        return { data: { id: "POS_CAL" } };
      },
    },
    calendarList: {
      async list() {
        return { data: { items: [] } };
      },
    },
    events: {
      async insert() {
        guard("eventsInsert");
        return { data: { id: `ev${++eventSeq}` } };
      },
      async update() {
        guard("eventsUpdate");
        return { data: { id: "ev" } };
      },
      async delete(args: { calendarId: string; eventId: string }) {
        guard("eventsDelete");
        deleted.push(args.eventId);
        return {};
      },
      async list() {
        return { data: { items: listed } };
      },
    },
  };
  const tasks: PushTasksApi = {
    tasklists: {
      async get() {
        return { data: { id: "POS_LIST" } };
      },
      async list() {
        return { data: { items: [] } };
      },
      async insert() {
        return { data: { id: "POS_LIST" } };
      },
    },
    tasks: {
      async list() {
        return { data: { items: [] } };
      },
      async insert() {
        guard("tasksInsert");
        return { data: { id: `t${++eventSeq}` } };
      },
      async update() {
        return { data: { id: "t" } };
      },
    },
  };
  return { calls, deleted, listed, calendar: () => calendar, tasks: () => tasks };
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-gcal-push-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A plan with `blocks` non-anchor blocks, none of them pushed yet. */
function addPlan(opts: { accepted?: boolean; pushedAt?: string | null; blocks?: number; date?: string } = {}): number {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const planId = Number(
    db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, narration, unplaced_tasks, accepted_at, pushed_at)
         VALUES (?, 'test', '{}', '', '[]', ?, ?)`
      )
      .run(date, opts.accepted ? "2026-08-05 09:00:00" : null, opts.pushedAt ?? null).lastInsertRowid
  );
  const ins = db.prepare(
    `INSERT INTO block (task_id, block_type, title, starts_at, ends_at, is_anchor, plan_id)
     VALUES (NULL, 'deep_work', ?, ?, ?, 0, ?)`
  );
  for (let i = 0; i < (opts.blocks ?? 2); i++) {
    const h = String(9 + i).padStart(2, "0");
    ins.run(`Block ${i}`, `${date}T${h}:00:00`, `${date}T${h}:50:00`, planId);
  }
  return planId;
}

const plan = (id: number) => db.prepare("SELECT * FROM plan WHERE id = ?").get(id) as any;

// ── 1. classification ────────────────────────────────────────────────────────

describe("needsReconsent", () => {
  it("classifies the 403 insufficientPermissions Google actually returns", () => {
    expect(needsReconsent(insufficientPermission())).toBe(true);
  });

  it("classifies the API-gateway and OAuth wordings too", () => {
    expect(needsReconsent(new Error("Request had insufficient authentication scopes."))).toBe(true);
    expect(needsReconsent(new Error("invalid_grant"))).toBe(true);
    expect(needsReconsent({ response: { data: { error: "insufficient_scope" } } })).toBe(true);
    expect(needsReconsent({ errors: [{ reason: "insufficientPermissions" }] })).toBe(true);
  });

  it("does NOT classify a 404", () => {
    expect(needsReconsent(notFound())).toBe(false);
  });

  it("does NOT classify a transport failure", () => {
    expect(needsReconsent(networkError())).toBe(false);
  });

  it("does NOT classify a 403 that is about something else", () => {
    const quota = new Error("Rate Limit Exceeded") as Error & { code: number };
    quota.code = 403;
    expect(needsReconsent(quota)).toBe(false);
    expect(needsReconsent(null)).toBe(false);
    expect(needsReconsent(undefined)).toBe(false);
  });
});

describe("grantedScopes / hasCalendarWriteScope", () => {
  it("reads the scope string off the stored token JSON", () => {
    expect(grantedScopes(store(WIDE_SCOPE))).toEqual([
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/tasks",
    ]);
    expect(grantedScopes(store(null, { tokens: false }))).toEqual([]);
  });

  it("rejects the pre-widening grant and accepts the widened one", () => {
    expect(hasCalendarWriteScope(store(OLD_SCOPE))).toBe(false); // calendar.events is NOT enough
    expect(hasCalendarWriteScope(store(WIDE_SCOPE))).toBe(true);
  });

  it("treats a token with no scope string as writable (unknowable — the API decides)", () => {
    expect(hasCalendarWriteScope(store(null))).toBe(true);
  });

  it("is false when nothing is connected at all", () => {
    expect(hasCalendarWriteScope(store(WIDE_SCOPE, { tokens: false }))).toBe(false);
  });

  it("googleScopeStatus reports connected / hasCreds / canWrite together", () => {
    expect(googleScopeStatus(store(OLD_SCOPE))).toEqual({ connected: true, hasCreds: true, canWrite: false });
    expect(googleScopeStatus(store(WIDE_SCOPE))).toEqual({ connected: true, hasCreds: true, canWrite: true });
    expect(googleScopeStatus(store(WIDE_SCOPE, { tokens: false, creds: false }))).toEqual({
      connected: false,
      hasCreds: false,
      canWrite: false,
    });
  });
});

describe("push entry points map scope failures to the typed string", () => {
  it("pushPlan surfaces reconsent_required instead of Google's message", async () => {
    const planId = addPlan({ accepted: true });
    await expect(pushPlan(db, connected, planId, fakeDeps({ throwOn: "calendarsInsert" }))).rejects.toThrow(
      RECONSENT_REQUIRED
    );
  });

  it("pushTasks surfaces reconsent_required too", async () => {
    db.prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes, status)
       VALUES ('Ship it', 'admin', 2, 30, 30, 'inbox')`
    ).run();
    await expect(pushTasks(db, connected, fakeDeps({ throwOn: "tasksInsert" }))).rejects.toThrow(RECONSENT_REQUIRED);
  });

  it("leaves a non-scope failure alone", async () => {
    const planId = addPlan({ accepted: true });
    await expect(
      pushPlan(db, connected, planId, fakeDeps({ throwOn: "calendarsInsert", error: networkError }))
    ).rejects.toThrow(/ENOTFOUND/);
  });
});

// ── 2. auto-push on accept ───────────────────────────────────────────────────

describe("acceptPlan pushes automatically", () => {
  it("accepts, pushes every block and records pushed_at", async () => {
    const planId = addPlan({ blocks: 3 });
    const deps = fakeDeps();
    const res = await acceptPlan(db, planId, connected, deps);

    expect(res.accepted).toBe(true);
    expect(res.push).toEqual({ pushed: 3, tasks: 0, withdrawn: 0 });
    expect(deps.calls.eventsInsert).toBe(3);
    expect(plan(planId).accepted_at).toBeTruthy();
    expect(plan(planId).pushed_at).toBeTruthy();
    // every block now carries its Google event id
    const linked = db.prepare("SELECT COUNT(*) c FROM block WHERE gcal_event_id IS NOT NULL").get() as { c: number };
    expect(linked.c).toBe(3);
    expect(getSetting(db, "pos_calendar_id")).toBe("POS_CAL");
  });

  it("skips the push when auto_push is '0' — but still accepts", async () => {
    setSetting(db, AUTO_PUSH_KEY, "0");
    expect(autoPushEnabled(db)).toBe(false);
    const planId = addPlan();
    const deps = fakeDeps();
    const res = await acceptPlan(db, planId, connected, deps);

    expect(res.accepted).toBe(true);
    expect(res.push).toEqual({ pushed: 0, tasks: 0, withdrawn: 0, error: "auto_push_off" });
    expect(deps.calls.eventsInsert).toBe(0);
    expect(plan(planId).accepted_at).toBeTruthy();
    expect(plan(planId).pushed_at).toBeNull();
  });

  it("auto_push defaults to on when the setting was never written", () => {
    expect(autoPushEnabled(db)).toBe(true);
  });

  it("a reconsent_required failure leaves pushed_at NULL and returns the typed error", async () => {
    const planId = addPlan({ blocks: 2 });
    const res = await acceptPlan(db, planId, connected, fakeDeps({ throwOn: "calendarsInsert" }));

    expect(res.accepted).toBe(true);
    expect(res.push).toEqual({ pushed: 0, tasks: 0, withdrawn: 0, error: RECONSENT_REQUIRED });
    expect(plan(planId).accepted_at).toBeTruthy();
    expect(plan(planId).pushed_at).toBeNull(); // still pending, so the sweep retries it
  });

  it("short-circuits to reconsent_required when the stored grant is the old one", async () => {
    const planId = addPlan();
    const deps = fakeDeps();
    const res = await pushPlanToGoogle(db, store(OLD_SCOPE), planId, deps);

    expect(res).toEqual({ pushed: 0, tasks: 0, withdrawn: 0, error: RECONSENT_REQUIRED });
    expect(deps.calls.calendarsInsert).toBe(0); // no doomed round-trip at all
  });

  it("reports not_connected without touching Google", async () => {
    const planId = addPlan();
    const deps = fakeDeps();
    const res = await pushPlanToGoogle(db, store(WIDE_SCOPE, { tokens: false }), planId, deps);
    expect(res).toEqual({ pushed: 0, tasks: 0, withdrawn: 0, error: "not_connected" });
    expect(deps.calls.eventsInsert).toBe(0);
  });
});

// ── 3. the worker sweep ──────────────────────────────────────────────────────

describe("worker auto-push sweep", () => {
  it("picks up an accepted-but-unpushed plan exactly once", async () => {
    const planId = addPlan({ accepted: true, blocks: 2 });
    expect(plansNeedingPush(db)).toEqual([planId]);

    const deps = fakeDeps();
    const first = await sweepAutoPush(db, connected, deps);
    expect(first).toEqual({ plans: 1, pushed: 2, withdrawn: 0 });
    expect(deps.calls.eventsInsert).toBe(2);
    expect(plan(planId).pushed_at).toBeTruthy();

    // Second tick: nothing left to do, and no further Google writes.
    expect(plansNeedingPush(db)).toEqual([]);
    const second = await sweepAutoPush(db, connected, deps);
    expect(second).toEqual({ plans: 0, pushed: 0, withdrawn: 0 });
    expect(deps.calls.eventsInsert).toBe(2);
  });

  // Owner report 2026-08-06, verbatim: "it should automatically populate to my Google
  // Calendar, it shouldn't require me to press a button." It already did not — but only for
  // plans he had ACCEPTED, and accepting was a button. His plan for the day sat with
  // accepted_at NULL and Google stayed empty. This test used to assert the opposite.
  it("pushes a plan the owner never accepted — acceptance is not the gate", async () => {
    const planId = addPlan({ accepted: false, blocks: 2 });
    expect(plansNeedingPush(db)).toEqual([planId]);

    const deps = fakeDeps();
    expect(await sweepAutoPush(db, connected, deps)).toEqual({ plans: 1, pushed: 2, withdrawn: 0 });
    expect(deps.calls.eventsInsert).toBe(2);
    expect(plan(planId).pushed_at).toBeTruthy();
    expect(plan(planId).accepted_at).toBeNull(); // pushing did not silently accept for him
  });

  // Re-planning an accepted day leaves the superseded row behind (generatePlan only deletes
  // un-accepted ones). Pushing both would put two contradictory schedules on one calendar.
  it("pushes only the newest plan when a day has more than one", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const older = addPlan({ accepted: true, blocks: 1, date });
    const newer = addPlan({ accepted: false, blocks: 1, date });
    db.prepare("UPDATE plan SET generated_at = datetime('now', '-1 hour') WHERE id = ?").run(older);
    expect(plansNeedingPush(db)).toEqual([newer]);
  });

  it("re-pushes an accepted plan whose blocks Google does not have", async () => {
    const planId = addPlan({ accepted: true, blocks: 1 });
    // A finished push: pushed_at stamped AFTER the blocks existed, every block linked.
    db.prepare("UPDATE block SET gcal_event_id = 'ev-old' WHERE plan_id = ?").run(planId);
    db.prepare("UPDATE plan SET pushed_at = datetime('now', '+1 second') WHERE id = ?").run(planId);
    expect(plansNeedingPush(db)).toEqual([]);

    // An unlinked block means the push never got that far — pending again.
    db.prepare("UPDATE block SET gcal_event_id = NULL WHERE plan_id = ?").run(planId);
    expect(plansNeedingPush(db)).toEqual([planId]);
  });

  it("re-pushes when a block was added after the last push (the plan changed)", async () => {
    const planId = addPlan({ accepted: true, blocks: 1 });
    db.prepare("UPDATE block SET gcal_event_id = 'ev-old' WHERE plan_id = ?").run(planId);
    db.prepare("UPDATE plan SET pushed_at = datetime('now', '-1 hour') WHERE id = ?").run(planId);
    expect(plansNeedingPush(db)).toEqual([planId]); // block.created_at > pushed_at
  });

  it("skips silently when the grant predates the calendar-write scope", async () => {
    addPlan({ accepted: true });
    const deps = fakeDeps();
    const res = await sweepAutoPush(db, store(OLD_SCOPE), deps);
    expect(res).toEqual({ plans: 0, pushed: 0, withdrawn: 0, skipped: "no_write_scope" });
    expect(deps.calls.calendarsGet + deps.calls.calendarsInsert + deps.calls.eventsInsert).toBe(0);
  });

  it("skips silently when auto_push is off or Google is not connected", async () => {
    addPlan({ accepted: true });
    setSetting(db, AUTO_PUSH_KEY, "0");
    expect(await sweepAutoPush(db, connected, fakeDeps())).toEqual({ plans: 0, pushed: 0, withdrawn: 0, skipped: "auto_push_off" });
    setSetting(db, AUTO_PUSH_KEY, "1");
    expect(await sweepAutoPush(db, store(WIDE_SCOPE, { tokens: false }), fakeDeps())).toEqual({
      plans: 0,
      pushed: 0,
      withdrawn: 0,
      skipped: "not_connected",
    });
  });

  it("reports a push failure without wedging, and leaves the plan pending", async () => {
    const planId = addPlan({ accepted: true });
    const res = await sweepAutoPush(db, connected, fakeDeps({ throwOn: "calendarsInsert" }));
    expect(res.plans).toBe(0);
    expect(res.error).toBe(RECONSENT_REQUIRED);
    expect(plan(planId).pushed_at).toBeNull();
    expect(plansNeedingPush(db)).toEqual([planId]);
  });

  it("ignores accepted plans older than the sweep window", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    addPlan({ accepted: true, date: old });
    expect(plansNeedingPush(db)).toEqual([]);
  });
});

// ── 4. withdrawing events the plan no longer contains ────────────────────────
//
// The failure automatic pushing would otherwise introduce. Pushing used to be deliberate, so
// a superseded plan never reached Google and left nothing behind. Now every plan pushes, and
// a re-plan deletes the old blocks by CASCADE — invisible to TypeScript. Without the
// migration-10 trigger their events would survive as orphans, and the owner's calendar would
// fill with the ghosts of every schedule the engine ever abandoned.

describe("stale event withdrawal", () => {
  const tombstones = () =>
    (db.prepare("SELECT event_id FROM gcal_tombstone ORDER BY event_id").all() as { event_id: string }[])
      .map((r) => r.event_id);

  it("records a tombstone when a block's plan is deleted (the cascade path)", () => {
    const planId = addPlan({ blocks: 2 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'ev-' || id WHERE plan_id = ?").run(planId);
    const ids = (db.prepare("SELECT gcal_event_id AS e FROM block WHERE plan_id = ?").all(planId) as { e: string }[])
      .map((r) => r.e).sort();

    db.prepare("DELETE FROM plan WHERE id = ?").run(planId); // blocks cascade
    expect(db.prepare("SELECT COUNT(*) AS n FROM block").get()).toEqual({ n: 0 });
    expect(tombstones()).toEqual(ids);
    // The calendar is captured at tombstone time, not resolved later.
    expect(db.prepare("SELECT DISTINCT calendar_id AS c FROM gcal_tombstone").all()).toEqual([{ c: "POS_CAL" }]);
  });

  it("never tombstones a block Google never had", () => {
    const planId = addPlan({ blocks: 2 }); // gcal_event_id all NULL
    db.prepare("DELETE FROM plan WHERE id = ?").run(planId);
    expect(tombstones()).toEqual([]);
  });

  it("withdraws tombstoned events on the next push, then forgets them", async () => {
    const gone = addPlan({ blocks: 2 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'stale-' || id WHERE plan_id = ?").run(gone);
    db.prepare("DELETE FROM plan WHERE id = ?").run(gone);
    const stale = tombstones();
    expect(stale).toHaveLength(2);

    const planId = addPlan({ blocks: 1 });
    const deps = fakeDeps();
    const res = await pushPlanToGoogle(db, connected, planId, deps);
    expect(res.error).toBeUndefined();
    expect(res.withdrawn).toBe(2);
    expect(deps.calls.eventsDelete).toBe(2);
    expect([...deps.deleted].sort()).toEqual(stale); // exactly the orphans, nothing else
    expect(tombstones()).toEqual([]); // debt discharged — never retried

    // A second push has nothing left to withdraw.
    const again = await pushPlanToGoogle(db, connected, planId, deps);
    expect(again.withdrawn).toBe(0);
    expect(deps.calls.eventsDelete).toBe(2);
  });

  it("treats an event already gone from Google as withdrawn", async () => {
    const gone = addPlan({ blocks: 1 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'stale' WHERE plan_id = ?").run(gone);
    db.prepare("DELETE FROM plan WHERE id = ?").run(gone);

    const planId = addPlan({ blocks: 1 });
    // 404 = the user deleted it himself. The goal is that it not be there; it is not there.
    const res = await pushPlanToGoogle(db, connected, planId, fakeDeps({ throwOn: "eventsDelete", error: notFound }));
    expect(res.error).toBeUndefined();
    expect(tombstones()).toEqual([]);
  });

  it("keeps the debt when a withdrawal fails for a reason we cannot dismiss", async () => {
    const gone = addPlan({ blocks: 1 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'stale' WHERE plan_id = ?").run(gone);
    db.prepare("DELETE FROM plan WHERE id = ?").run(gone);

    const planId = addPlan({ blocks: 1 });
    const res = await pushPlanToGoogle(db, connected, planId, fakeDeps({ throwOn: "eventsDelete", error: networkError }));
    expect(res.pushed).toBe(1); // the day still went out
    expect(tombstones()).toEqual(["stale"]); // and the ghost is still owed a deletion
  });

  it("drains on a tick where no plan needs pushing at all", async () => {
    const gone = addPlan({ blocks: 1, pushedAt: null });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'stale' WHERE plan_id = ?").run(gone);
    db.prepare("DELETE FROM plan WHERE id = ?").run(gone);
    expect(plansNeedingPush(db)).toEqual([]); // the day was abandoned; nothing to push

    const deps = fakeDeps();
    expect(await sweepAutoPush(db, connected, deps)).toEqual({ plans: 0, pushed: 0, withdrawn: 1 });
    expect(deps.deleted).toEqual(["stale"]);
    expect(tombstones()).toEqual([]);
  });
});


// ── the calendar must match the plan, not accumulate it ──────────────────────
//
// Owner report 2026-08-06, with a screenshot of his real calendar: two Lunches, two Comms
// window 2s, two math tests, two Breaks, two Shutdown rituals — each pair fifteen minutes
// apart. The tombstone drain withdraws what a re-plan removed, but nothing could clean up an
// event whose block vanished WITHOUT being tombstoned (a plan row deleted outside the app, a
// push that half-landed). This is the backstop that needs no bookkeeping to be right.
describe("reconcileDayEvents", () => {
  it("removes events on the POS calendar that no block claims", async () => {
    const planId = addPlan({ blocks: 2 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'keep-' || id WHERE plan_id = ?").run(planId);
    const kept = (db.prepare("SELECT gcal_event_id AS e FROM block WHERE plan_id = ?").all(planId) as { e: string }[])
      .map((r) => r.e);

    const deps = fakeDeps();
    deps.listed.push(...kept.map((id) => ({ id, summary: "live" })));
    deps.listed.push({ id: "orphan-1", summary: "Lunch" }, { id: "orphan-2", summary: "Lunch" });

    const res = await reconcileDayEvents(db, connected, new Date().toISOString().slice(0, 10), deps);
    expect(res.seen).toBe(4);
    expect(res.removed).toBe(2);
    expect(deps.deleted.sort()).toEqual(["orphan-1", "orphan-2"]);
  });

  it("never deletes an event a block still points at", async () => {
    const planId = addPlan({ blocks: 1 });
    setSetting(db, "pos_calendar_id", "POS_CAL");
    db.prepare("UPDATE block SET gcal_event_id = 'mine' WHERE plan_id = ?").run(planId);
    const deps = fakeDeps();
    deps.listed.push({ id: "mine", summary: "Deep work" });
    const res = await reconcileDayEvents(db, connected, new Date().toISOString().slice(0, 10), deps);
    expect(res.removed).toBe(0);
    expect(deps.deleted).toEqual([]);
  });

  it("does nothing at all when no POS calendar has ever been created", async () => {
    const deps = fakeDeps();
    expect(await reconcileDayEvents(db, connected, "2026-08-06", deps)).toEqual({ seen: 0, removed: 0 });
    expect(deps.calls.eventsDelete).toBe(0);
  });
});
