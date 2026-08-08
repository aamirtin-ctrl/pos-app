// Morning digest — compose (numbering/cap/prefix + mapping shape), the reply grammar,
// the reply handler round trip, and the capture skip-prefix rule. Pure/DB only:
// the send path is exercised with an injected runScript stub (no osascript) and a
// no-Google secret store (no network).

import { todayISO as localTodayISO, addDaysISO } from "../main/dates.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, setSetting, type Db } from "../main/db/db.ts";
import { RECONNECT_GRACE_DAYS } from "../main/crm/reconnect.ts";
import type { SecretStore } from "../main/secrets.ts";
import {
  DIGEST_PREFIX,
  DIGEST_MAX_ITEMS,
  composeDigest,
  digestDateISO,
  firstSelfHandle,
  handleDigestReply,
  isDigestMessage,
  isDigestReply,
  parseDigestReply,
  sendMorningDigest,
  shouldSendDigest,
  type DigestMappingEntry,
} from "../main/digest.ts";

// isGoogleConnected() only calls .get("GOOGLE_OAUTH_TOKENS") — null = not connected,
// so every Google push degrades to the local-only path.
const noGoogle = { get: () => null } as unknown as SecretStore;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-digest-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The shared LOCAL helper, not a UTC-based copy. digest.ts computes "today" locally (as the
// owner would), so a test helper thinking in UTC only agrees in zones where the two dates
// happen to coincide — this suite failed outright at UTC-10 (found by running everything
// under Pacific/Honolulu, 2026-08-08).
const todayISO = () => localTodayISO();

// `reconnectDueDaysAgo` must clear RECONNECT_GRACE_DAYS for the person to reach the digest:
// since 2026-08-06 a name only surfaces once it is meaningfully past due, not the instant
// the 90-day threshold ticks over.
function addPerson(name: string, opts: { reconnectDueDaysAgo?: number } = {}): number {
  const r = db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 1)").run(name);
  const id = Number(r.lastInsertRowid);
  if (opts.reconnectDueDaysAgo != null) {
    db.prepare(
      `UPDATE person SET last_contact_at = datetime('now', ?),
         next_touch_due_at = datetime('now', ?) WHERE id = ?`
    ).run(`-${opts.reconnectDueDaysAgo + 90} days`, `-${opts.reconnectDueDaysAgo} days`, id);
  }
  return id;
}

function addInteraction(personId: number, channel: string, occurredAt: string): number {
  const r = db
    .prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id)
       VALUES (?, ?, 'inbound', ?, ?)`
    )
    .run(personId, channel, occurredAt, `ext-${Math.random()}`);
  return Number(r.lastInsertRowid);
}

function addCommitment(
  desc: string,
  opts: { personId?: number; sourceId?: number; confirmed?: number; status?: string } = {}
): number {
  const r = db
    .prepare(
      `INSERT INTO commitment (person_id, description, status, confirmed_by_user, source_interaction_id, confidence)
       VALUES (?, ?, ?, ?, ?, 0.9)`
    )
    .run(opts.personId ?? null, desc, opts.status ?? "open", opts.confirmed ?? 0, opts.sourceId ?? null);
  return Number(r.lastInsertRowid);
}

function addTask(title: string, opts: { status?: string; planDate?: string; commitmentId?: number } = {}): number {
  const r = db
    .prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
         status, plan_date, commitment_id, estimate_source)
       VALUES (?, 'admin', 2, 30, 30, ?, ?, ?, 'inferred')`
    )
    .run(title, opts.status ?? "inbox", opts.planDate ?? todayISO(), opts.commitmentId ?? null);
  return Number(r.lastInsertRowid);
}

// ── composeDigest ────────────────────────────────────────────────────────────

describe("composeDigest", () => {
  it("numbers commitments, today's tasks, and reconnects in order, prefixed and mapped", () => {
    const raj = addPerson("Raj");
    // 2026-08-04 was a Tuesday.
    const src = addInteraction(raj, "imessage", "2026-08-04 09:15:00");
    const c1 = addCommitment("Send Raj the deck", { personId: raj, sourceId: src });
    const c2 = addCommitment("Collect the lease from Dev");
    const t1 = addTask("Book flights");
    const sarah = addPerson("Sarah Chen", { reconnectDueDaysAgo: RECONNECT_GRACE_DAYS + 12 });

    const { text, mapping } = composeDigest(db);

    expect(text.startsWith(`${DIGEST_PREFIX}Good morning. Confirm your day:`)).toBe(true);
    expect(text).toContain("1. Send Raj the deck (from Tue's texts)");
    expect(text).toContain("2. Collect the lease from Dev");
    expect(text).toContain("3. Book flights (on today's list)");
    expect(text).toContain("4. Reconnect with Sarah Chen");
    expect(text).toContain('Reply "confirm all", "confirm 1 3", "drop 2"');

    expect(mapping).toEqual([
      { n: 1, kind: "commitment", id: c1 },
      { n: 2, kind: "commitment", id: c2 },
      { n: 3, kind: "task", id: t1 },
      { n: 4, kind: "reconnect", id: sarah },
    ] satisfies DigestMappingEntry[]);
  });

  it("caps at 8 numbered items", () => {
    for (let i = 1; i <= 12; i++) addCommitment(`Chase item number ${i}`);
    const { text, mapping } = composeDigest(db);
    expect(mapping).toHaveLength(DIGEST_MAX_ITEMS);
    expect(text).toContain("8. ");
    expect(text).not.toContain("9. ");
  });

  it("excludes confirmed/dropped commitments, non-today tasks, and non-inbox tasks", () => {
    addCommitment("Already confirmed", { confirmed: 1 });
    addCommitment("Already dropped", { status: "dropped" });
    addTask("Tomorrow's task", { planDate: "2099-01-01" });
    addTask("Done task", { status: "done" });
    const { mapping } = composeDigest(db);
    expect(mapping).toHaveLength(0);
  });

  it("still sends a prefixed nothing-to-confirm message on an empty day", () => {
    const { text, mapping } = composeDigest(db);
    expect(text.startsWith(DIGEST_PREFIX)).toBe(true);
    expect(text).toContain("Nothing needs your confirmation");
    expect(mapping).toEqual([]);
  });
});

// ── reply grammar ────────────────────────────────────────────────────────────

describe("parseDigestReply", () => {
  it('parses "confirm all"', () => {
    expect(parseDigestReply("confirm all")).toEqual([{ op: "confirm", target: "all" }]);
  });

  it('parses "Confirm 1, 3 and 4" (case, commas, "and")', () => {
    expect(parseDigestReply("Confirm 1, 3 and 4")).toEqual([
      { op: "confirm", target: 1 },
      { op: "confirm", target: 3 },
      { op: "confirm", target: 4 },
    ]);
  });

  it('parses "drop 2"', () => {
    expect(parseDigestReply("drop 2")).toEqual([{ op: "drop", target: 2 }]);
  });

  it('treats mixed "confirm 1 drop 2" sequentially', () => {
    expect(parseDigestReply("confirm 1 drop 2")).toEqual([
      { op: "confirm", target: 1 },
      { op: "drop", target: 2 },
    ]);
  });

  it("returns null for garbage and non-reply text", () => {
    expect(parseDigestReply("what's for lunch")).toBeNull();
    expect(parseDigestReply("confirm the thing")).toBeNull();
    expect(parseDigestReply("confirmation bias")).toBeNull();
    expect(parseDigestReply("confirm")).toBeNull(); // verb with no target
    expect(parseDigestReply("1 3")).toBeNull(); // numbers with no verb
    expect(parseDigestReply("")).toBeNull();
  });
});

// ── send (stubbed transport) ─────────────────────────────────────────────────

describe("sendMorningDigest", () => {
  const okSend = async () => {};

  it("is gated on digest_enabled and on a configured self handle", async () => {
    expect(await sendMorningDigest(db, noGoogle, { runScript: okSend })).toEqual({
      sent: false,
      reason: "disabled",
    });
    setSetting(db, "digest_enabled", "1");
    expect(await sendMorningDigest(db, noGoogle, { runScript: okSend })).toEqual({
      sent: false,
      reason: "no_self_handle",
    });
  });

  it("sends to the FIRST self handle, stores the mapping, and fires once per day", async () => {
    setSetting(db, "digest_enabled", "1");
    setSetting(db, "capture_self_handles", " +12145550100 , me@icloud.com");
    addCommitment("Send Raj the deck");
    expect(firstSelfHandle(db)).toBe("+12145550100");

    const scripts: string[] = [];
    const res = await sendMorningDigest(db, noGoogle, { runScript: async (s) => void scripts.push(s) });
    expect(res).toMatchObject({ sent: true, items: 1, handle: "+12145550100" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('participant "+12145550100"');
    expect(scripts[0]).toContain("POS —");

    const key = digestDateISO();
    expect(getSetting(db, `digest_sent:${key}`)).toBeTruthy();
    const mapping = JSON.parse(getSetting(db, `digest_mapping:${key}`)!) as DigestMappingEntry[];
    expect(mapping).toEqual([{ n: 1, kind: "commitment", id: expect.any(Number) }]);

    // Second run the same day: guarded — unless forced (the manual Settings button).
    expect(await sendMorningDigest(db, noGoogle, { runScript: okSend })).toEqual({
      sent: false,
      reason: "already_sent",
    });
    const forced = await sendMorningDigest(db, noGoogle, { runScript: okSend, force: true });
    expect(forced).toMatchObject({ sent: true });
  });

  it("surfaces automation_denied as a typed result and does not mark the day sent", async () => {
    setSetting(db, "digest_enabled", "1");
    setSetting(db, "capture_self_handles", "+12145550100");
    const res = await sendMorningDigest(db, noGoogle, {
      runScript: async () => {
        throw new Error("automation_denied");
      },
    });
    expect(res).toEqual({ sent: false, reason: "automation_denied" });
    expect(getSetting(db, `digest_sent:${digestDateISO()}`)).toBeNull();
  });

  it("shouldSendDigest waits for wake_time + 15 min and respects the once-per-day flag", () => {
    setSetting(db, "digest_enabled", "1");
    const at = (h: number, m: number) => new Date(2026, 7, 5, h, m); // local time
    expect(shouldSendDigest(db, "07:30", at(7, 40))).toBe(false);
    expect(shouldSendDigest(db, "07:30", at(7, 45))).toBe(true);
    setSetting(db, `digest_sent:${digestDateISO(at(7, 45))}`, "sent");
    expect(shouldSendDigest(db, "07:30", at(9, 0))).toBe(false);
  });
});

// ── reply handling round trip ────────────────────────────────────────────────

async function sendStub(): Promise<void> {}

async function seedAndSend(): Promise<{ raj: number; c1: number; c2: number; t1: number; sarah: number }> {
  const raj = addPerson("Raj");
  const c1 = addCommitment("Send Raj the deck", { personId: raj });
  const c2 = addCommitment("Collect the lease from Dev");
  addTask("Task spawned by c2", { commitmentId: c2, planDate: "2099-01-01" }); // proves the cascade
  const t1 = addTask("Book flights");
  const sarah = addPerson("Sarah Chen", { reconnectDueDaysAgo: RECONNECT_GRACE_DAYS + 12 });
  setSetting(db, "digest_enabled", "1");
  setSetting(db, "capture_self_handles", "+12145550100");
  const res = await sendMorningDigest(db, noGoogle, { runScript: sendStub });
  expect(res).toMatchObject({ sent: true, items: 4 });
  return { raj, c1, c2, t1, sarah };
}

describe("handleDigestReply", () => {
  it("confirm N on a commitment confirms it and creates the task", async () => {
    const { c1 } = await seedAndSend();
    const summary = await handleDigestReply(db, noGoogle, "confirm 1");
    expect(summary).toContain("Confirmed 1: Send Raj the deck");

    const c = db.prepare("SELECT status, confirmed_by_user FROM commitment WHERE id = ?").get(c1) as any;
    expect(c.confirmed_by_user).toBe(1);
    expect(c.status).toBe("scheduled");
    const task = db.prepare("SELECT * FROM task WHERE commitment_id = ?").get(c1) as any;
    expect(task).toBeTruthy();
    expect(task.plan_date).toBe(todayISO());
  });

  it("drop N on a commitment cascades: dropped + linked open task deleted", async () => {
    const { c2 } = await seedAndSend();
    const summary = await handleDigestReply(db, noGoogle, "drop 2");
    expect(summary).toContain("Dropped 1: Collect the lease from Dev");

    const c = db.prepare("SELECT status FROM commitment WHERE id = ?").get(c2) as any;
    expect(c.status).toBe("dropped");
    expect(db.prepare("SELECT COUNT(*) AS n FROM task WHERE commitment_id = ?").get(c2)).toEqual({ n: 0 });
  });

  it("confirm on a task plans it; drop defers it", async () => {
    const { t1 } = await seedAndSend();
    await handleDigestReply(db, noGoogle, "confirm 3");
    expect((db.prepare("SELECT status FROM task WHERE id = ?").get(t1) as any).status).toBe("planned");
    await handleDigestReply(db, noGoogle, "drop 3");
    expect((db.prepare("SELECT status FROM task WHERE id = ?").get(t1) as any).status).toBe("deferred");
  });

  it("confirm on a reconnect creates a comms task for today, idempotently", async () => {
    await seedAndSend();
    await handleDigestReply(db, noGoogle, "confirm 4");
    await handleDigestReply(db, noGoogle, "confirm 4"); // re-reply — no duplicate
    const rows = db
      .prepare("SELECT * FROM task WHERE title = 'Reach out to Sarah Chen'")
      .all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].block_type).toBe("comms");
    expect(rows[0].plan_date).toBe(todayISO());
  });

  it("re-replying confirm on a commitment never duplicates the task", async () => {
    const { c1 } = await seedAndSend();
    await handleDigestReply(db, noGoogle, "confirm 1");
    await handleDigestReply(db, noGoogle, "confirm 1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM task WHERE commitment_id = ?").get(c1)).toEqual({ n: 1 });
  });

  it('"confirm all" applies to every mapped item; mixed replies run sequentially', async () => {
    const { c1, c2, t1 } = await seedAndSend();
    const summary = await handleDigestReply(db, noGoogle, "confirm all");
    expect(summary).toMatch(/^Confirmed 4:/);
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(c1) as any).status).toBe("scheduled");
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(c2) as any).status).toBe("scheduled");
    expect((db.prepare("SELECT status FROM task WHERE id = ?").get(t1) as any).status).toBe("planned");

    const mixed = await handleDigestReply(db, noGoogle, "drop 3 confirm 1");
    expect(mixed).toContain("Dropped 1");
    expect((db.prepare("SELECT status FROM task WHERE id = ?").get(t1) as any).status).toBe("deferred");
  });

  it("falls back to yesterday's mapping and reports unknown numbers", async () => {
    const c1 = addCommitment("Send Raj the deck");
    const yesterday = addDaysISO(new Date(), -1);
    setSetting(db, `digest_mapping:${yesterday}`, JSON.stringify([{ n: 1, kind: "commitment", id: c1 }]));

    const summary = await handleDigestReply(db, noGoogle, "confirm 1 7");
    expect(summary).toContain("Confirmed 1");
    expect(summary).toContain("No item 7 on the digest");
    expect((db.prepare("SELECT status FROM commitment WHERE id = ?").get(c1) as any).status).toBe("scheduled");
  });

  it("says so when no digest mapping exists", async () => {
    expect(await handleDigestReply(db, noGoogle, "confirm 1")).toContain("No morning digest on record");
  });
});

// ── capture routing helpers ──────────────────────────────────────────────────

describe("capture skip/route helpers", () => {
  it("isDigestMessage: the app's own digests are recognized by the literal prefix", () => {
    expect(isDigestMessage("POS — Good morning. Confirm your day:")).toBe(true);
    expect(isDigestMessage("  POS — Good morning.")).toBe(true); // leading whitespace tolerated
    expect(isDigestMessage("POS - hyphen is not the prefix")).toBe(false);
    expect(isDigestMessage("pos — lowercase is not the prefix")).toBe(false);
    expect(isDigestMessage("confirm 1")).toBe(false);
    expect(isDigestMessage(null)).toBe(false);
  });

  it("isDigestReply matches the confirm/drop grammar head only", () => {
    expect(isDigestReply("confirm 1 3")).toBe(true);
    expect(isDigestReply("Drop 2")).toBe(true);
    expect(isDigestReply("  CONFIRM all")).toBe(true);
    expect(isDigestReply("confirmation bias")).toBe(false);
    expect(isDigestReply("dropping by later")).toBe(false);
    expect(isDigestReply("plan my day")).toBe(false);
    expect(isDigestReply(null)).toBe(false);
  });
});
