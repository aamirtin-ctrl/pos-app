// Doctrine-adherence nudges. Everything here is DB + pure logic: Screen Time is a fake
// object implementing the ScreenTimeApi surface, delivery is an injected notifier + an
// injected script runner. No electron, no osascript, no network.
//
// The bias under test is SILENCE: every case gets a "fires on its trigger" and a "stays
// quiet just below it", and the rate-limit block is the largest section in the file
// because over-nudging is the way this feature dies.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, setSetting, type Db } from "../main/db/db.ts";
import type { SecretStore } from "../main/secrets.ts";
import { parseDoctrine, DEFAULT_DOCTRINE_YAML, type Doctrine } from "../main/engine/doctrine.ts";
import {
  currentBlock,
  evaluateNudge,
  hhmm,
  MAX_NUDGES_PER_DAY,
  minutesSinceLastNudge,
  MIN_MINUTES_BETWEEN_NUDGES,
  nudgeChannels,
  nudgeCountKey,
  nudgeCountToday,
  nudgeSentBlockKey,
  NUDGE_LAST_AT_KEY,
  NUDGES_ENABLED_KEY,
  NUDGE_CHANNEL_KEY,
  runNudgeCheck,
  sendNudge,
  summarizeUsage,
  withinAwakeWindow,
  type Nudge,
  type ScreenTimeApi,
  type UsageSample,
} from "../main/nudge.ts";

const noSecrets = { get: () => null } as unknown as SecretStore;

// Default doctrine: wake 07:30, sleep 23:00 ⇒ shutdown ritual at 20:30, bedtime lead 22:30.
const doctrine: Doctrine = parseDoctrine(DEFAULT_DOCTRINE_YAML);
const SHUTDOWN = 20 * 60 + 30;
const SLEEP = 23 * 60;

const DAY = "2026-08-05";
/** A local-time Date on DAY. Local throughout — the doctrine is a local-time object. */
const at = (h: number, m = 0) => new Date(2026, 7, 5, h, m, 0, 0);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-nudge-"));
  db = openDb(path.join(dir, "pos.db"));
  setSetting(db, "capture_self_handles", "+15125550123, backup@example.com");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, "focus" | "communication" | "distraction" | "neutral"> = {
  "com.apple.mail": "communication",
  "com.tinyspeck.slackmacgap": "communication",
  "com.apple.dt.Xcode": "focus",
  "com.microsoft.VSCode": "focus",
  "com.burbn.instagram": "distraction",
  "com.zhiliaoapp.musically": "distraction",
  "com.apple.Preview": "neutral",
};

const APP_NAMES: Record<string, string> = {
  "com.apple.mail": "Mail",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.apple.dt.Xcode": "Xcode",
  "com.microsoft.VSCode": "VS Code",
  "com.burbn.instagram": "Instagram",
  "com.zhiliaoapp.musically": "TikTok",
  "com.apple.Preview": "Preview",
};

/** startMin/endMin are minutes since local midnight, as screentime.ts reports them. */
const use = (bundleId: string, startMin: number, endMin: number): UsageSample => ({
  bundleId,
  appName: APP_NAMES[bundleId] ?? bundleId,
  startMin,
  endMin,
  seconds: (endMin - startMin) * 60,
});

interface FakeOpts {
  available?: boolean;
  /** Report availability the way the real module does — a `{ ok }` status object. */
  availableAsStatus?: boolean;
  /** undefined ⇒ the module exposes NO awake signal at all (idle case must be skipped). */
  awake?: boolean;
  idleSeconds?: number;
  /** Backlit spans, the real module's signal. `backlitAvailable: false` ⇒ no signal. */
  backlit?: { startMin: number; endMin: number }[] | "unavailable";
  throwOnUsage?: boolean;
  omitCategoryMap?: boolean;
}

function fakeScreenTime(samples: UsageSample[], opts: FakeOpts = {}): ScreenTimeApi {
  const ok = opts.available !== false;
  const api: ScreenTimeApi = {
    screenTimeAvailable: () => (opts.availableAsStatus ? { ok } : ok),
    usageForRange: () => {
      if (opts.throwOnUsage) throw new Error("full_disk_access");
      return samples;
    },
  };
  if (!opts.omitCategoryMap) api.CATEGORY_MAP = CATEGORY_MAP;
  if (opts.backlit !== undefined) {
    api.readSnapshot = () =>
      opts.backlit === "unavailable"
        ? { awake: [], backlitAvailable: false }
        : { awake: opts.backlit as { startMin: number; endMin: number }[], backlitAvailable: true };
  }
  if (opts.awake !== undefined) api.displayAwake = () => opts.awake!;
  if (opts.idleSeconds !== undefined) api.idleSeconds = () => opts.idleSeconds!;
  return api;
}

function addPlan(opts: { accepted?: boolean; dateISO?: string } = {}): number {
  const r = db
    .prepare(
      `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, accepted_at)
       VALUES (?, 'test', '{}', ?)`
    )
    .run(opts.dateISO ?? DAY, opts.accepted === false ? null : "2026-08-05T07:45:00");
  return Number(r.lastInsertRowid);
}

function addBlock(
  planId: number,
  blockType: string,
  title: string | null,
  startMin: number,
  endMin: number,
  isAnchor = 0,
  dateISO = DAY
): number {
  const iso = (m: number) =>
    `${dateISO}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  const r = db
    .prepare(
      `INSERT INTO block (block_type, title, starts_at, ends_at, is_anchor, plan_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(blockType, title, iso(startMin), iso(endMin), isAnchor, planId);
  return Number(r.lastInsertRowid);
}

/** Enable nudges + a capture handle: the standard "opted in" state. */
function optIn() {
  setSetting(db, NUDGES_ENABLED_KEY, "1");
}

interface Sent {
  scripts: string[];
  notifications: { title: string; body: string }[];
}
function recorder(): Sent & { runScript: (s: string) => Promise<void>; notify: (t: string, b: string) => boolean } {
  const sent: Sent = { scripts: [], notifications: [] };
  return {
    ...sent,
    runScript: async (s: string) => void sent.scripts.push(s),
    notify: (title: string, body: string) => {
      sent.notifications.push({ title, body });
      return true;
    },
  };
}

// ── currentBlock ─────────────────────────────────────────────────────────────

describe("currentBlock", () => {
  it("returns the accepted plan's block containing now", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Physics pset", 14 * 60, 15 * 60 + 30);
    const b = currentBlock(db, at(14, 25));
    expect(b?.block_type).toBe("deep_work");
    expect(b?.startMin).toBe(840);
    expect(b?.endMin).toBe(930);
  });

  it("returns null outside every block, and for unaccepted plans", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Pset", 14 * 60, 15 * 60);
    expect(currentBlock(db, at(16, 0))).toBeNull();

    const draft = addPlan({ accepted: false });
    addBlock(draft, "admin", "Draft admin", 16 * 60, 17 * 60);
    expect(currentBlock(db, at(16, 30))).toBeNull();
  });

  it("prefers the non-anchor block when an anchor overlaps it", () => {
    const p = addPlan();
    addBlock(p, "meeting", "Standing sync", 14 * 60, 16 * 60, 1);
    const work = addBlock(p, "deep_work", "Pset", 14 * 60, 15 * 60, 0);
    expect(currentBlock(db, at(14, 30))?.id).toBe(work);
  });

  it("uses only the most recently accepted plan for the day", () => {
    const older = addPlan();
    addBlock(older, "admin", "Stale", 14 * 60, 15 * 60);
    const newer = db
      .prepare(
        `INSERT INTO plan (plan_date, engine_version, doctrine_snapshot, accepted_at)
         VALUES (?, 'test', '{}', '2026-08-05T13:00:00')`
      )
      .run(DAY);
    const newerId = Number(newer.lastInsertRowid);
    const fresh = addBlock(newerId, "deep_work", "Replanned", 14 * 60, 15 * 60);
    expect(currentBlock(db, at(14, 30))?.id).toBe(fresh);
  });
});

// ── usage accounting ─────────────────────────────────────────────────────────

describe("summarizeUsage", () => {
  const st = fakeScreenTime([]);

  it("counts each minute once even when two apps claim it", () => {
    const u = summarizeUsage(
      [use("com.burbn.instagram", 600, 610), use("com.zhiliaoapp.musically", 605, 615)],
      st,
      600,
      610
    );
    expect(u.byCategory.distraction).toBe(10); // not 15
    expect(u.activeMinutes).toBe(10);
  });

  it("clips samples to the window and ranks apps by minutes", () => {
    const u = summarizeUsage(
      [use("com.apple.mail", 590, 605), use("com.burbn.instagram", 605, 607)],
      st,
      600,
      610
    );
    expect(u.byCategory.communication).toBe(5);
    expect(u.byCategory.distraction).toBe(2);
    expect(u.byApp[0].name).toBe("Mail");
  });

  it("treats apps outside CATEGORY_MAP as neutral — active, but never a trigger", () => {
    const u = summarizeUsage([use("com.acme.unknown", 600, 610)], st, 600, 610);
    expect(u.activeMinutes).toBe(10);
    expect(u.byCategory.neutral).toBe(10);
    expect(u.byCategory.distraction).toBe(0);
    expect(u.byCategory.focus).toBe(0);
  });
});

// ── the five cases ───────────────────────────────────────────────────────────

const evalAt = (now: Date, st: ScreenTimeApi) => evaluateNudge(db, now, { screenTime: st, doctrine });

describe("past_shutdown", () => {
  it("fires when ≥5 of the last 10 minutes are work apps after the shutdown time", () => {
    const now = at(21, 40); // 1300
    const st = fakeScreenTime([use("com.apple.mail", SHUTDOWN + 20, SHUTDOWN + 28), use("com.apple.mail", 1292, 1300)]);
    const n = evalAt(now, st);
    expect(n?.kind).toBe("past_shutdown");
    expect(n?.message).toContain("21:40");
    expect(n?.message).toContain("20:30");
    expect(n?.message).toContain("Mail");
    expect(n?.message).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emoji
  });

  it("stays quiet before the shutdown time", () => {
    const now = at(19, 40);
    const st = fakeScreenTime([use("com.apple.mail", 1170, 1180)]);
    expect(evalAt(now, st)).toBeNull();
  });

  it("stays quiet at 4 minutes of work in the window", () => {
    const now = at(21, 40);
    const st = fakeScreenTime([use("com.apple.mail", 1296, 1300)]);
    expect(evalAt(now, st)).toBeNull();
  });

  it("stays quiet when the after-hours usage is neutral, not work", () => {
    const now = at(21, 40);
    const st = fakeScreenTime([use("com.apple.Preview", 1290, 1300)]);
    expect(evalAt(now, st)).toBeNull();
  });
});

describe("winding_down_but_scrolling", () => {
  it("fires on ≥7 distraction minutes after shutdown", () => {
    const now = at(21, 40);
    const st = fakeScreenTime([use("com.burbn.instagram", 1293, 1300)]);
    const n = evalAt(now, st);
    expect(n?.kind).toBe("winding_down_but_scrolling");
    expect(n?.message).toContain("7 of the last 10 minutes were Instagram");
  });

  it("stays quiet at 6 distraction minutes", () => {
    const now = at(21, 40);
    const st = fakeScreenTime([use("com.burbn.instagram", 1294, 1300)]);
    expect(evalAt(now, st)).toBeNull();
  });

  it("stays quiet before shutdown even when scrolling hard", () => {
    const now = at(16, 0);
    const st = fakeScreenTime([use("com.burbn.instagram", 950, 960)]);
    expect(evalAt(now, st)).toBeNull();
  });
});

describe("distracted_in_deep_work", () => {
  it("fires when ≥40% of the elapsed deep-work block was distraction", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Physics pset", 14 * 60, 15 * 60 + 30);
    const now = at(14, 25);
    const st = fakeScreenTime([use("com.zhiliaoapp.musically", 843, 854)]); // 11 of 25 min
    const n = evalAt(now, st);
    expect(n?.kind).toBe("distracted_in_deep_work");
    expect(n?.message).toContain("25 minutes");
    expect(n?.message).toContain("11 of them were TikTok");
    expect(n?.message).toContain("Physics pset");
  });

  it("stays quiet below 40%", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Physics pset", 14 * 60, 15 * 60 + 30);
    const st = fakeScreenTime([
      use("com.zhiliaoapp.musically", 843, 852), // 9 of 25 = 36%
      use("com.microsoft.VSCode", 852, 865),
    ]);
    expect(evalAt(at(14, 25), st)).toBeNull();
  });

  it("does not apply to non-deep block types", () => {
    const p = addPlan();
    addBlock(p, "comms", "Inbox", 14 * 60, 15 * 60);
    const st = fakeScreenTime([use("com.zhiliaoapp.musically", 840, 865)]);
    expect(evalAt(at(14, 25), st)).toBeNull();
  });

  it("waits until the block has run long enough for the ratio to mean anything", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Physics pset", 14 * 60, 15 * 60 + 30);
    const st = fakeScreenTime([use("com.zhiliaoapp.musically", 840, 845)]);
    expect(evalAt(at(14, 6), st)).toBeNull(); // 6 minutes elapsed
  });
});

describe("idle_in_work_block", () => {
  const setupAdmin = () => {
    const p = addPlan();
    return addBlock(p, "admin", "Reimbursements", 10 * 60, 11 * 60);
  };

  it("fires when the machine was awake and almost nothing happened", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], { awake: true });
    const n = evalAt(at(10, 20), st);
    expect(n?.kind).toBe("idle_in_work_block");
    expect(n?.message).toContain("20 minutes");
    expect(n?.message).toContain("2 minutes of activity");
    expect(n?.message).toContain("11:00");
  });

  it("is SKIPPED ENTIRELY when the screentime module exposes no awake signal", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)]); // no snapshot, no displayAwake, no idle
    expect(evalAt(at(10, 20), st)).toBeNull();
  });

  it("is skipped when the Knowledge store has no backlit stream at all", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], { backlit: "unavailable" });
    expect(evalAt(at(10, 20), st)).toBeNull();
  });

  it("fires off the real backlit spans when the display was on for the block", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], {
      backlit: [{ startMin: 600, endMin: 620 }],
    });
    expect(evalAt(at(10, 20), st)?.kind).toBe("idle_in_work_block");
  });

  it("stays quiet when the display was mostly off — he stepped away deliberately", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], {
      backlit: [{ startMin: 600, endMin: 604 }], // 4 of 20 minutes lit
    });
    expect(evalAt(at(10, 20), st)).toBeNull();
  });

  it("stays quiet when the machine was asleep — he stepped away deliberately", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], { awake: false });
    expect(evalAt(at(10, 20), st)).toBeNull();
  });

  it("accepts idleSeconds as the fallback awake signal", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 602)], { idleSeconds: 30 });
    expect(evalAt(at(10, 20), st)?.kind).toBe("idle_in_work_block");
  });

  it("stays quiet when the block is actually being worked", () => {
    setupAdmin();
    const st = fakeScreenTime([use("com.apple.mail", 600, 619)], { awake: true });
    expect(evalAt(at(10, 20), st)).toBeNull();
  });

  it("stays quiet before 15 minutes have elapsed", () => {
    setupAdmin();
    const st = fakeScreenTime([], { awake: true });
    expect(evalAt(at(10, 12), st)).toBeNull();
  });

  it("does not apply to non-work blocks", () => {
    const p = addPlan();
    addBlock(p, "break", "Walk", 10 * 60, 11 * 60);
    const st = fakeScreenTime([], { awake: true });
    expect(evalAt(at(10, 20), st)).toBeNull();
  });
});

describe("working_past_bedtime", () => {
  it("fires on any work usage within 30 minutes of sleep onset", () => {
    const now = at(22, 45);
    const st = fakeScreenTime([use("com.tinyspeck.slackmacgap", 1363, 1365)]); // 2 min, under the past_shutdown floor
    const n = evalAt(now, st);
    expect(n?.kind).toBe("working_past_bedtime");
    expect(n?.message).toContain("22:45");
    expect(n?.message).toContain("Slack");
    expect(n?.message).toContain(hhmm(SLEEP));
  });

  it("stays quiet before the bedtime lead-in", () => {
    const now = at(22, 15);
    const st = fakeScreenTime([use("com.tinyspeck.slackmacgap", 1333, 1335)]);
    expect(evalAt(now, st)).toBeNull();
  });

  it("stays quiet when the late usage is not work", () => {
    const now = at(22, 45);
    const st = fakeScreenTime([use("com.apple.Preview", 1360, 1365)]);
    expect(evalAt(now, st)).toBeNull();
  });
});

// ── priority ─────────────────────────────────────────────────────────────────

describe("priority order", () => {
  it("past_shutdown outranks winding_down_but_scrolling", () => {
    const now = at(21, 40);
    const st = fakeScreenTime([
      use("com.apple.mail", 1290, 1295), // 5 work minutes
      use("com.burbn.instagram", 1293, 1300), // 7 distraction minutes
    ]);
    expect(evalAt(now, st)?.kind).toBe("past_shutdown");
  });

  it("past_shutdown outranks working_past_bedtime when both are live", () => {
    const now = at(22, 45);
    const st = fakeScreenTime([use("com.apple.mail", 1355, 1365)]);
    expect(evalAt(now, st)?.kind).toBe("past_shutdown");
  });

  it("the boundary cases outrank an in-block case", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Late pset", 21 * 60, 22 * 60);
    const now = at(21, 40);
    const st = fakeScreenTime([use("com.burbn.instagram", 1260, 1300)]); // 40 min, all distraction
    expect(evalAt(now, st)?.kind).toBe("winding_down_but_scrolling");
  });

  it("distracted_in_deep_work outranks idle_in_work_block", () => {
    const p = addPlan();
    addBlock(p, "deep_work", "Pset", 14 * 60, 15 * 60);
    // 11 distraction minutes of 25 elapsed is ≥40%, and 11 active of 25 is >20% so the idle
    // case would not fire anyway — the assertion is that the distraction case is the one named.
    const st = fakeScreenTime([use("com.zhiliaoapp.musically", 843, 854)], { awake: true });
    expect(evalAt(at(14, 25), st)?.kind).toBe("distracted_in_deep_work");
  });
});

// ── delivery ─────────────────────────────────────────────────────────────────

const NUDGE: Nudge = { kind: "past_shutdown", message: "It's 21:40 and you shut down at 20:30.", blockId: null };

describe("sendNudge", () => {
  it("defaults to both channels and prefixes the iMessage with 'POS — '", async () => {
    const r = recorder();
    const res = await sendNudge(db, noSecrets, NUDGE, r);
    expect(res.sent).toBe(true);
    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0].body).toBe(NUDGE.message);
    expect(r.scripts).toHaveLength(1);
    expect(r.scripts[0]).toContain("POS — It's 21:40");
    expect(r.scripts[0]).toContain("+15125550123");
  });

  it("honours nudge_channel = notify (no iMessage)", async () => {
    setSetting(db, NUDGE_CHANNEL_KEY, "notify");
    expect(nudgeChannels(db)).toEqual(["notify"]);
    const r = recorder();
    await sendNudge(db, noSecrets, NUDGE, r);
    expect(r.scripts).toHaveLength(0);
    expect(r.notifications).toHaveLength(1);
  });

  it("honours nudge_channel = imessage (no notification)", async () => {
    setSetting(db, NUDGE_CHANNEL_KEY, "imessage");
    const r = recorder();
    await sendNudge(db, noSecrets, NUDGE, r);
    expect(r.scripts).toHaveLength(1);
    expect(r.notifications).toHaveLength(0);
  });

  it("maps a denied Automation permission to the typed reason", async () => {
    setSetting(db, NUDGE_CHANNEL_KEY, "imessage");
    const res = await sendNudge(db, noSecrets, NUDGE, {
      runScript: async () => {
        throw new Error("automation_denied");
      },
    });
    expect(res).toEqual({ sent: false, reason: "automation_denied" });
  });

  it("counts as delivered when one channel works and the other does not", async () => {
    const res = await sendNudge(db, noSecrets, NUDGE, {
      notify: () => true,
      runScript: async () => {
        throw new Error("automation_denied");
      },
    });
    expect(res).toEqual({ sent: true, channels: ["notify"] });
  });

  it("reports no_self_handle when capture_self_handles is empty", async () => {
    setSetting(db, "capture_self_handles", "");
    setSetting(db, NUDGE_CHANNEL_KEY, "imessage");
    const res = await sendNudge(db, noSecrets, NUDGE, recorder());
    expect(res).toEqual({ sent: false, reason: "no_self_handle" });
  });
});

// ── the gate + rate limiting ─────────────────────────────────────────────────

/** A state that would nudge (past_shutdown at 21:40) unless a gate stops it. */
function shutdownState() {
  return fakeScreenTime([use("com.apple.mail", 1290, 1300)]);
}

describe("runNudgeCheck gating", () => {
  it("is OFF by default — nothing is sent without an explicit opt-in", async () => {
    const r = recorder();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), { screenTime: shutdownState(), doctrine, ...r });
    expect(res).toEqual({ sent: false, reason: "disabled" });
    expect(r.scripts).toHaveLength(0);
    expect(r.notifications).toHaveLength(0);
  });

  it("sends once opted in, and records the budget", async () => {
    optIn();
    const r = recorder();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), { screenTime: shutdownState(), doctrine, ...r });
    expect(res.sent).toBe(true);
    expect(res.kind).toBe("past_shutdown");
    expect(nudgeCountToday(db, DAY)).toBe(1);
    expect(getSetting(db, NUDGE_LAST_AT_KEY)).not.toBeNull();
  });

  it("says nothing while he is asleep — the budget must not burn on an unseen nudge", async () => {
    optIn();
    const r = recorder();
    // 03:00 is past sleep+1h and before wake.
    const res = await runNudgeCheck(db, noSecrets, at(3, 0), { screenTime: shutdownState(), doctrine, ...r });
    expect(res).toEqual({ sent: false, reason: "asleep" });
    expect(nudgeCountToday(db, DAY)).toBe(0);
    expect(r.scripts).toHaveLength(0);
  });

  it("says nothing before the wake time", async () => {
    optIn();
    expect(withinAwakeWindow(db, at(6, 30), doctrine)).toBe(false);
    expect(withinAwakeWindow(db, at(21, 40), doctrine)).toBe(true);
    expect(withinAwakeWindow(db, at(23, 59), doctrine)).toBe(true); // sleep + 1h
  });

  it("does nothing when Screen Time is unavailable", async () => {
    optIn();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: fakeScreenTime([use("com.apple.mail", 1290, 1300)], { available: false }),
      doctrine,
      ...recorder(),
    });
    expect(res).toEqual({ sent: false, reason: "screentime_unavailable" });
  });

  it("accepts the real module's `{ ok }` status object, not just a boolean", async () => {
    optIn();
    const denied = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: fakeScreenTime([use("com.apple.mail", 1290, 1300)], {
        available: false,
        availableAsStatus: true,
      }),
      doctrine,
      ...recorder(),
    });
    expect(denied).toEqual({ sent: false, reason: "screentime_unavailable" });

    const granted = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: fakeScreenTime([use("com.apple.mail", 1290, 1300)], { availableAsStatus: true }),
      doctrine,
      ...recorder(),
    });
    expect(granted.sent).toBe(true);
  });
});

describe("runNudgeCheck rate limiting", () => {
  const deepWorkDay = () => {
    const p = addPlan();
    return addBlock(p, "deep_work", "Physics pset", 14 * 60, 17 * 60);
  };
  const distracted = (untilMin: number) =>
    fakeScreenTime([use("com.zhiliaoapp.musically", 840, untilMin)]);

  it("sends at most one nudge per block", async () => {
    optIn();
    const blockId = deepWorkDay();
    const first = await runNudgeCheck(db, noSecrets, at(14, 25), {
      screenTime: distracted(851),
      doctrine,
      ...recorder(),
    });
    expect(first.sent).toBe(true);
    expect(getSetting(db, nudgeSentBlockKey(blockId))).not.toBeNull();

    // 55 minutes later: past the 45-minute floor, still the same block, still distracted.
    const second = await runNudgeCheck(db, noSecrets, at(15, 20), {
      screenTime: distracted(890),
      doctrine,
      ...recorder(),
    });
    expect(second).toEqual({ sent: false, reason: "block_already_nudged", kind: "distracted_in_deep_work" });
    expect(nudgeCountToday(db, DAY)).toBe(1);
  });

  it("enforces the 45-minute floor between nudges", async () => {
    optIn();
    setSetting(db, NUDGE_LAST_AT_KEY, at(21, 20).toISOString()); // 20 minutes ago
    expect(minutesSinceLastNudge(db, at(21, 40))).toBeCloseTo(20, 5);
    const r = recorder();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), { screenTime: shutdownState(), doctrine, ...r });
    expect(res).toEqual({ sent: false, reason: "too_soon" });
    expect(r.notifications).toHaveLength(0);

    // …and lets one through the moment the floor has passed.
    const ok = await runNudgeCheck(db, noSecrets, at(21, 20 + MIN_MINUTES_BETWEEN_NUDGES), {
      screenTime: fakeScreenTime([use("com.apple.mail", 1290, 1325)]),
      doctrine,
      ...recorder(),
    });
    expect(ok.sent).toBe(true);
  });

  it("suppresses the 4th nudge of the day", async () => {
    optIn();
    setSetting(db, nudgeCountKey(DAY), String(MAX_NUDGES_PER_DAY));
    const r = recorder();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), { screenTime: shutdownState(), doctrine, ...r });
    expect(res).toEqual({ sent: false, reason: "daily_cap" });
    expect(r.scripts).toHaveLength(0);
  });

  it("keeps the daily budget per calendar day", async () => {
    optIn();
    setSetting(db, nudgeCountKey("2026-08-04"), "3");
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: shutdownState(),
      doctrine,
      ...recorder(),
    });
    expect(res.sent).toBe(true);
  });

  it("stays silent — and spends nothing — when there is nothing to say", async () => {
    optIn();
    const res = await runNudgeCheck(db, noSecrets, at(14, 0), {
      screenTime: fakeScreenTime([use("com.microsoft.VSCode", 830, 840)]),
      doctrine,
      ...recorder(),
    });
    expect(res).toEqual({ sent: false, reason: "nothing_to_say" });
    expect(nudgeCountToday(db, DAY)).toBe(0);
  });
});

describe("runNudgeCheck failure handling", () => {
  it("a failed delivery does not throw and does not consume the daily budget", async () => {
    optIn();
    setSetting(db, NUDGE_CHANNEL_KEY, "imessage");
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: shutdownState(),
      doctrine,
      runScript: async () => {
        throw new Error("automation_denied");
      },
    });
    expect(res).toEqual({ sent: false, kind: "past_shutdown", reason: "automation_denied" });
    expect(nudgeCountToday(db, DAY)).toBe(0);
    expect(getSetting(db, NUDGE_LAST_AT_KEY)).toBeNull();
    expect(getSetting(db, nudgeCountKey(DAY))).toBeNull();
  });

  it("a throwing Screen Time read is contained as an unavailable source, not a crash", async () => {
    optIn();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: fakeScreenTime([], { throwOnUsage: true }),
      doctrine,
      ...recorder(),
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("screentime_unavailable");
    expect(res.detail).toContain("full_disk_access");
    expect(nudgeCountToday(db, DAY)).toBe(0);
  });

  it("a screentime module with no CATEGORY_MAP simply says nothing", async () => {
    optIn();
    const res = await runNudgeCheck(db, noSecrets, at(21, 40), {
      screenTime: fakeScreenTime([use("com.apple.mail", 1290, 1300)], { omitCategoryMap: true }),
      doctrine,
      ...recorder(),
    });
    expect(res).toEqual({ sent: false, reason: "nothing_to_say" });
  });

  it("never throws even on a closed database", async () => {
    optIn();
    const broken = openDb(path.join(dir, "broken.db"));
    setSetting(broken, NUDGES_ENABLED_KEY, "1");
    broken.close();
    const res = await runNudgeCheck(broken, noSecrets, at(21, 40), { screenTime: shutdownState(), doctrine });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("error");
  });
});

// ── tone ─────────────────────────────────────────────────────────────────────

describe("message copy", () => {
  it("every case is at most two sentences, emoji-free, and carries a real number", () => {
    const cases: Nudge[] = [];
    const p = addPlan();
    addBlock(p, "deep_work", "Physics pset", 14 * 60, 15 * 60 + 30);
    addBlock(p, "admin", "Reimbursements", 10 * 60, 11 * 60);

    cases.push(evalAt(at(21, 40), fakeScreenTime([use("com.apple.mail", 1290, 1300)]))!);
    cases.push(evalAt(at(21, 40), fakeScreenTime([use("com.burbn.instagram", 1293, 1300)]))!);
    cases.push(evalAt(at(14, 25), fakeScreenTime([use("com.zhiliaoapp.musically", 843, 854)]))!);
    cases.push(evalAt(at(10, 20), fakeScreenTime([use("com.apple.mail", 600, 602)], { awake: true }))!);
    cases.push(evalAt(at(22, 45), fakeScreenTime([use("com.tinyspeck.slackmacgap", 1363, 1365)]))!);

    expect(cases.map((c) => c.kind)).toEqual([
      "past_shutdown",
      "winding_down_but_scrolling",
      "distracted_in_deep_work",
      "idle_in_work_block",
      "working_past_bedtime",
    ]);
    for (const c of cases) {
      expect(c.message).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(c.message.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
      expect(c.message).toMatch(/\d/);
      expect(c.message.length).toBeLessThan(200);
    }
  });
});
