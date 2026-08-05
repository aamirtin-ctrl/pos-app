// Wave 1a parity gaps (GAP_REPORT.md #6/#10/#11/#17/#19/#22):
//   • reachoutLinks — mailto / tel / sms / LinkedIn from aliases (#17)
//   • patchPersonWithExtract — "I just met them" bump (#10) and the About-save
//     deterministic follow-up → commitment (#11, llm = null path)
//   • the NL rules parser + applier — suppress / unsuppress / delete group (#19, #6)
//   • dismissPerson + reconnectDue exclusion, including an expired snooze (#22)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  reachoutLinks,
  patchPersonWithExtract,
  detectNoteFollowUp,
  getPerson,
} from "../../main/crm/people.ts";
import { reconnectDue, refreshNextTouch, dismissPerson, undismissPerson } from "../../main/crm/reconnect.ts";
import { parseRuleDeterministic, applyRule, cleanGroupName } from "../../main/assistant.ts";

const NOW = new Date("2026-08-05T12:00:00Z");

let dir: string;
let db: Db;

function addPerson(name: string, tier = 1, lastContactAt: string | null = null): number {
  const r = db
    .prepare("INSERT INTO person (display_name, tier, last_contact_at) VALUES (?, ?, ?)")
    .run(name, tier, lastContactAt);
  return Number(r.lastInsertRowid);
}

function addGroup(name: string, members: number[] = []): number {
  const g = Number(db.prepare("INSERT INTO grp (name) VALUES (?)").run(name).lastInsertRowid);
  for (const p of members) {
    db.prepare("INSERT INTO person_group (person_id, group_id) VALUES (?, ?)").run(p, g);
  }
  return g;
}

const suppressed = (name: string): number =>
  (db.prepare("SELECT suppress_follow_ups s FROM grp WHERE name = ?").get(name) as { s: number }).s;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-parity1a-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── #17 reach-out links ──────────────────────────────────────────────────────

describe("reachoutLinks", () => {
  it("builds mailto / tel / sms / LinkedIn links in a stable order", () => {
    const links = reachoutLinks([
      { kind: "linkedin", value: "linkedin.com/in/cory-vc", is_primary: 0 },
      { kind: "phone", value: "+14155550123", is_primary: 1 },
      { kind: "email", value: "cory@fund.com", is_primary: 1 },
    ]);
    expect(links.map((l) => l.kind)).toEqual(["email", "call", "sms", "linkedin"]);
    expect(links.map((l) => l.href)).toEqual([
      "mailto:cory@fund.com",
      "tel:+14155550123",
      "sms:+14155550123",
      "https://linkedin.com/in/cory-vc",
    ]);
    expect(links[0].label).toBe("Email");
    // phone display is humanized for the tooltip, the href stays dialable E.164
    expect(links[1].value).toBe("(415) 555-0123");
  });

  it("puts primary aliases first within a kind and collapses duplicate targets", () => {
    const links = reachoutLinks([
      { kind: "email", value: "work@corp.com", is_primary: 0 },
      { kind: "email", value: "me@home.com", is_primary: 1 },
      // the same address also stored as an iMessage handle must not create a second button
      { kind: "imessage_handle", value: "me@home.com", is_primary: 0 },
    ]);
    expect(links.map((l) => l.href)).toEqual(["mailto:me@home.com", "mailto:work@corp.com"]);
  });

  it("treats a phone-shaped iMessage handle as callable and ignores junk", () => {
    const links = reachoutLinks([
      { kind: "imessage_handle", value: "+14155550123" },
      { kind: "slack_id", value: "U12345" },
      { kind: "email", value: "   " },
    ]);
    expect(links.map((l) => l.href)).toEqual(["tel:+14155550123", "sms:+14155550123"]);
    expect(reachoutLinks([])).toEqual([]);
  });

  it("is exposed on getPerson so the renderer needs no alias parsing", () => {
    const id = addPerson("Cory");
    db.prepare("INSERT INTO alias (person_id, kind, value, is_primary) VALUES (?, 'email', ?, 1)")
      .run(id, "cory@fund.com");
    expect(getPerson(db, id, NOW)!.reachout.map((l) => l.href)).toEqual(["mailto:cory@fund.com"]);
  });
});

// ── #10 met-today ────────────────────────────────────────────────────────────

describe("patchPersonWithExtract — metToday", () => {
  it("bumps last_contact_at to now and pushes next_touch_due_at out", async () => {
    const id = addPerson("Stale Sam", 1, "2026-01-01 00:00:00");
    refreshNextTouch(db);
    const before = db
      .prepare("SELECT last_contact_at l, next_touch_due_at n FROM person WHERE id = ?")
      .get(id) as { l: string; n: string };
    expect(before.n).toBe("2026-04-01 00:00:00"); // tier 1 = 90 days
    expect(reconnectDue(db, NOW).map((r) => r.id)).toContain(id);

    const res = await patchPersonWithExtract(db, null, id, {}, { metToday: true, now: NOW });
    expect(res.metToday).toBe(true);

    const after = db
      .prepare("SELECT last_contact_at l, next_touch_due_at n FROM person WHERE id = ?")
      .get(id) as { l: string; n: string };
    expect(after.l).toBe("2026-08-05 12:00:00"); // a real bump, not COALESCE
    expect(after.n).toBe("2026-11-03 12:00:00"); // refreshed cadence
    expect(reconnectDue(db, NOW).map((r) => r.id)).not.toContain(id);
  });

  it("overwrites an existing last_contact_at (COALESCE semantics are gone)", async () => {
    const id = addPerson("Recent Rita", 1, "2026-07-01 00:00:00");
    await patchPersonWithExtract(db, null, id, {}, { metToday: true, now: NOW });
    const l = (db.prepare("SELECT last_contact_at l FROM person WHERE id = ?").get(id) as { l: string }).l;
    expect(l).toBe("2026-08-05 12:00:00");
  });
});

// ── #11 About-save extraction (deterministic path) ───────────────────────────

describe("patchPersonWithExtract — bio save without an LLM", () => {
  it("creates a confirmed open commitment from the detected follow-up", async () => {
    const id = addPerson("Nina");
    const res = await patchPersonWithExtract(
      db,
      null,
      id,
      { bio: "Met at the AI dinner. She runs infra at Stripe. Send her the deck on Friday." },
      { now: NOW }
    );

    expect(res.patched).toBe(true);
    expect(res.detectedFollowUp).not.toBeNull();
    expect(res.detectedFollowUp!.source).toBe("deterministic");
    expect(res.detectedFollowUp!.created).toBe(true);
    expect(res.detectedFollowUp!.description).toContain("Send her the deck");
    expect(res.lastDiscussed).toContain("deck");

    const rows = db
      .prepare("SELECT person_id, description, due_at, status, confidence, confirmed_by_user FROM commitment")
      .all() as {
      person_id: number;
      description: string;
      due_at: string | null;
      status: string;
      confidence: number;
      confirmed_by_user: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(id);
    expect(rows[0].status).toBe("open");
    expect(rows[0].confidence).toBe(1);
    expect(rows[0].confirmed_by_user).toBe(1);
    expect(rows[0].due_at).toBe("2026-08-07"); // "on Friday" resolved against NOW (Wed 2026-08-05)
    // the bio itself still saved verbatim
    expect((db.prepare("SELECT bio FROM person WHERE id = ?").get(id) as { bio: string }).bio).toContain("Stripe");
  });

  it("does not duplicate the commitment when the same bio is saved again", async () => {
    const id = addPerson("Nina");
    const bio = "Grab coffee with her next week.";
    await patchPersonWithExtract(db, null, id, { bio }, { now: NOW });
    // unchanged bio → no second extraction at all
    const again = await patchPersonWithExtract(db, null, id, { bio }, { now: NOW });
    expect(again.detectedFollowUp).toBeNull();
    // changed bio that still detects the same sentence → existing row is reused
    const third = await patchPersonWithExtract(db, null, id, { bio: `${bio}\nShe likes tea.` }, { now: NOW });
    expect(third.detectedFollowUp!.created).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM commitment").get()).toEqual({ c: 1 });
  });

  it("stays quiet for a bio with no action cue", async () => {
    const id = addPerson("Quiet Quinn");
    const res = await patchPersonWithExtract(db, null, id, { bio: "Lives in Austin. Two kids." }, { now: NOW });
    expect(res.detectedFollowUp).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM commitment").get()).toEqual({ c: 0 });
  });

  it("detectNoteFollowUp picks the strongest sentence and dates it", () => {
    const d = detectNoteFollowUp("Nice guy. We should grab lunch on Friday. He has a dog.", NOW);
    expect(d!.text).toBe("We should grab lunch on Friday.");
    expect(d!.dueDate!.toISOString().slice(0, 10)).toBe("2026-08-07");
    expect(detectNoteFollowUp("Just a plain fact about him.", NOW)).toBeNull();
    expect(detectNoteFollowUp("", NOW)).toBeNull();
  });
});

// ── #19 / #6 NL rules ────────────────────────────────────────────────────────

describe("rule parsing", () => {
  it("reads suppress phrasings", () => {
    for (const s of [
      "my family group shouldn't show as follow-ups",
      "people in the Family group should not show up in follow-ups",
      "stop follow-ups for family",
      "mute follow-ups for the family group",
      "don't show me follow-ups for family",
    ]) {
      expect(parseRuleDeterministic(s), s).toEqual({ action: "suppress_followups", group: "family" });
    }
  });

  it("reads unsuppress phrasings", () => {
    for (const s of [
      "re-enable follow-ups for family",
      "turn on follow-ups for the family group",
      "unmute follow-ups for family",
    ]) {
      expect(parseRuleDeterministic(s), s).toEqual({ action: "unsuppress_followups", group: "family" });
    }
  });

  it("reads delete phrasings", () => {
    expect(parseRuleDeterministic("delete the recruiters group")).toEqual({
      action: "delete_group",
      group: "recruiters",
    });
    expect(parseRuleDeterministic("remove my recruiters group")).toEqual({
      action: "delete_group",
      group: "recruiters",
    });
  });

  it("returns null for anything unsupported, and cleans group names", () => {
    expect(parseRuleDeterministic("plan my day")).toBeNull();
    expect(parseRuleDeterministic("who should I talk to about solar")).toBeNull();
    expect(parseRuleDeterministic("")).toBeNull();
    expect(cleanGroupName("the Family group")).toBe("family");
    expect(cleanGroupName('"Investors"')).toBe("investors");
    expect(cleanGroupName("  ")).toBeNull();
  });
});

describe("applyRule against a seeded db", () => {
  let alice: number;
  let bob: number;

  beforeEach(() => {
    alice = addPerson("Alice", 1, "2026-01-01 00:00:00");
    bob = addPerson("Bob", 1, "2026-01-01 00:00:00");
    addGroup("Family", [alice, bob]);
    refreshNextTouch(db);
  });

  it("suppresses follow-ups and drops the members out of Reconnect", () => {
    expect(reconnectDue(db, NOW).map((r) => r.id).sort()).toEqual([alice, bob].sort());

    const res = applyRule(db, parseRuleDeterministic("stop follow-ups for family")!);
    expect(res.kind).toBe("rule");
    expect(res.reply).toContain("Family");
    expect(res.reply).toContain("2 people");
    expect(suppressed("Family")).toBe(1);
    expect(reconnectDue(db, NOW)).toEqual([]);
  });

  it("un-suppresses again", () => {
    applyRule(db, { action: "suppress_followups", group: "family" });
    const res = applyRule(db, parseRuleDeterministic("re-enable follow-ups for family")!);
    expect(res.kind).toBe("rule");
    expect(suppressed("Family")).toBe(0);
    expect(reconnectDue(db, NOW)).toHaveLength(2);
  });

  it("deletes a group without touching the people", () => {
    const res = applyRule(db, parseRuleDeterministic("delete the family group")!);
    expect(res.kind).toBe("rule");
    expect(db.prepare("SELECT COUNT(*) c FROM grp").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM person_group").get()).toEqual({ c: 0 }); // cascaded
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 2 });
  });

  it("declines politely for unknown groups and unsupported asks", () => {
    const missing = applyRule(db, { action: "suppress_followups", group: "colleagues" });
    expect(missing.kind).toBe("error");
    expect(missing.reply).toContain("colleagues");

    const nope = applyRule(db, { action: "none", group: null });
    expect(nope.kind).toBe("error");
    expect(nope.reply).toContain("can't do that one yet");
  });
});

// ── #22 dismiss / snooze ─────────────────────────────────────────────────────

describe("dismissPerson + reconnectDue", () => {
  let sam: number;

  beforeEach(() => {
    sam = addPerson("Stale Sam", 1, "2026-01-01 00:00:00");
    addPerson("Other Olive", 1, "2026-01-01 00:00:00");
    refreshNextTouch(db);
  });

  it("an indefinite dismissal hides the person forever", () => {
    expect(reconnectDue(db, NOW)).toHaveLength(2);
    const d = dismissPerson(db, sam, "stale", null, NOW);
    expect(d.snooze_until).toBeNull();
    expect(reconnectDue(db, NOW).map((r) => r.id)).not.toContain(sam);
    // still hidden a year later
    expect(reconnectDue(db, new Date("2027-08-05T12:00:00Z")).map((r) => r.id)).not.toContain(sam);
  });

  it("a 30-day snooze hides the person until it expires, then they reappear", () => {
    const d = dismissPerson(db, sam, "stale", 30, NOW);
    expect(d.snooze_until).toBe("2026-09-04 12:00:00");
    expect(reconnectDue(db, NOW).map((r) => r.id)).not.toContain(sam);
    // one day before expiry: still hidden
    expect(reconnectDue(db, new Date("2026-09-03T12:00:00Z")).map((r) => r.id)).not.toContain(sam);
    // after expiry: back on the list
    expect(reconnectDue(db, new Date("2026-09-05T12:00:00Z")).map((r) => r.id)).toContain(sam);
  });

  it("keeps one live dismissal per person+kind, so a snooze replaces a dismissal", () => {
    dismissPerson(db, sam, "stale", null, NOW);
    dismissPerson(db, sam, "stale", 90, NOW);
    expect(db.prepare("SELECT COUNT(*) c FROM dismissal").get()).toEqual({ c: 1 });
    expect(reconnectDue(db, new Date("2026-11-05T12:00:00Z")).map((r) => r.id)).toContain(sam);
  });

  it("only affects the dismissed person and the named kind", () => {
    dismissPerson(db, sam, "stale", 90, NOW);
    expect(reconnectDue(db, NOW)).toHaveLength(1);
    dismissPerson(db, sam, "followup", null, NOW); // a different kind does not un-hide 'stale'
    expect(reconnectDue(db, NOW)).toHaveLength(1);
    expect(undismissPerson(db, sam, "stale")).toBe(1);
    expect(reconnectDue(db, NOW)).toHaveLength(2);
  });
});
