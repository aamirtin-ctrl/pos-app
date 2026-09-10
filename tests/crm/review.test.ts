import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, getSetting, type Db } from "../../main/db/db.ts";
import {
  pendingContacts,
  keepContacts,
  discardContacts,
  groupContacts,
  duplicateClusters,
  dismissDuplicates,
  mergeCluster,
  recordAmbiguous,
  pendingAmbiguous,
  resolveAmbiguous,
  dismissAmbiguous,
  ambiguousKey,
  reviewQueue,
} from "../../main/crm/review.ts";
import { queueNoteChunk } from "../../main/crm/notesglean.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-review-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function person(id: number, name: string, extra: Partial<{ org: string; role: string; location: string; tier: number; created_at: string }> = {}): void {
  db.prepare(
    `INSERT INTO person (id, display_name, org, role, location, tier, created_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(
    id,
    name,
    extra.org ?? null,
    extra.role ?? null,
    extra.location ?? null,
    extra.tier ?? 2,
    extra.created_at ?? null
  );
}
const unverified = (id: number) =>
  db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, 'unverified')").run(id);
const alias = (personId: number, kind: string, value: string) =>
  db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, ?, ?)").run(personId, kind, value);
const interaction = (personId: number, externalId: string, at: string, summary?: string) =>
  db
    .prepare(
      "INSERT INTO interaction (person_id, channel, occurred_at, external_id, body_summary) VALUES (?, 'imessage', ?, ?, ?)"
    )
    .run(personId, at, externalId, summary ?? null);
const hasTag = (id: number) =>
  !!db.prepare("SELECT 1 FROM person_tag WHERE person_id = ? AND tag = 'unverified'").get(id);

// ── #8 new-contact triage ────────────────────────────────────────────────────

describe("pendingContacts", () => {
  it("returns unverified people newest first with handles, counts and last snippet", () => {
    person(1, "Old Sender", { tier: 3, created_at: "2026-07-01 09:00:00" });
    person(2, "New Sender", { tier: 3, created_at: "2026-08-01 09:00:00" });
    person(3, "Real Contact", { org: "ZFellows" }); // no unverified tag
    unverified(1);
    unverified(2);
    alias(1, "imessage_handle", "+14155550111");
    alias(1, "email", "old@sender.com");
    interaction(1, "m1", "2026-07-02 10:00:00", "first ping");
    interaction(1, "m2", "2026-07-03 10:00:00", "  hey are   you around? ");

    const rows = pendingContacts(db);
    expect(rows.map((r) => r.id)).toEqual([2, 1]); // newest first, tag-filtered
    const old = rows[1];
    expect(old.handles).toEqual([
      { kind: "email", value: "old@sender.com" },
      { kind: "imessage_handle", value: "+14155550111" },
    ]);
    expect(old.interactions).toBe(2);
    expect(old.last_snippet).toBe("hey are you around?"); // newest, whitespace collapsed
    expect(old.last_channel).toBe("imessage");
    expect(rows[0].interactions).toBe(0);
    expect(rows[0].last_snippet).toBeNull();
  });

  it("is empty when nothing carries the tag", () => {
    person(1, "Real Contact");
    expect(pendingContacts(db)).toEqual([]);
  });
});

describe("keep / discard / group round-trips", () => {
  it("keep drops the tag and promotes archive tier", () => {
    person(1, "A Sender", { tier: 3 });
    person(2, "B Sender", { tier: 3 });
    unverified(1);
    unverified(2);

    expect(keepContacts(db, [1, 2, 1])).toBe(2); // dedupes ids
    expect(pendingContacts(db)).toEqual([]);
    expect(hasTag(1)).toBe(false);
    expect(db.prepare("SELECT tier FROM person WHERE id = 1").get()).toEqual({ tier: 2 });
    expect(keepContacts(db, [])).toBe(0);
  });

  it("keep never demotes someone already closer than network tier", () => {
    person(1, "Inner Circle", { tier: 0 });
    unverified(1);
    keepContacts(db, [1]);
    expect(db.prepare("SELECT tier FROM person WHERE id = 1").get()).toEqual({ tier: 0 });
  });

  it("discard hard-deletes the person and cascades aliases/interactions", () => {
    person(1, "Spam Sender", { tier: 3 });
    unverified(1);
    alias(1, "email", "spam@example.com");
    interaction(1, "m1", "2026-07-02 10:00:00");

    expect(discardContacts(db, [1])).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM alias").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM interaction").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM person_tag").get()).toEqual({ c: 0 });
    expect(pendingContacts(db)).toEqual([]);
  });

  it("group creates the group, assigns everyone, and keeps them", () => {
    person(1, "A Sender", { tier: 3 });
    person(2, "B Sender", { tier: 3 });
    unverified(1);
    unverified(2);

    expect(groupContacts(db, [1, 2], "  Founders  ")).toEqual({ added: 2, kept: 2 });
    expect(db.prepare("SELECT name FROM grp").all()).toEqual([{ name: "Founders" }]);
    expect(db.prepare("SELECT COUNT(*) c FROM person_group").get()).toEqual({ c: 2 });
    expect(pendingContacts(db)).toEqual([]); // grouping confirms
    expect(() => groupContacts(db, [1], "   ")).toThrow(/empty/);
  });
});

// ── #9 duplicate clustering ──────────────────────────────────────────────────

describe("duplicateClusters", () => {
  it("clusters same first name + same org, exact names ranked high confidence", () => {
    person(1, "Cory Levy", { org: "ZFellows", role: "Founder" });
    person(2, "Cory Levy", { org: "zfellows", location: "Austin" });

    const clusters = duplicateClusters(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.id)).toEqual([1, 2]);
    expect(clusters[0].confidence).toBe("high");
    expect(clusters[0].reasons).toContain("same org (ZFellows)");
    expect(clusters[0].key).toBe("1-2");
    // the fields that differ are what the UI shows as justification
    const fields = clusters[0].differing.map((d) => d.field);
    expect(fields).toContain("role");
    expect(fields).toContain("location");
    expect(fields).not.toContain("name"); // identical → not a difference
  });

  it("clusters on a shared work email domain or a shared last name (medium confidence)", () => {
    person(1, "Sam Carter", { org: "Alpha" });
    person(2, "Samuel Carter", { org: "Beta" }); // different first-name key
    person(3, "Sam Quinn", { org: "Beta" });
    alias(1, "email", "sam@northstar.io");
    alias(3, "email", "s.quinn@northstar.io");
    person(4, "Sam Carter", { org: "Gamma" }); // same first + last name as 1

    const clusters = duplicateClusters(db);
    const byKey = new Map(clusters.map((c) => [c.key, c]));
    expect(byKey.has("1-3-4")).toBe(true); // 1↔3 domain, 1↔4 last name → one cluster
    const c = byKey.get("1-3-4")!;
    expect(c.confidence).toBe("medium"); // names are not all identical
    expect(c.reasons).toEqual(
      expect.arrayContaining(["shared email domain (northstar.io)", "same last name"])
    );
    expect(clusters.every((cl) => !cl.members.some((m) => m.id === 2))).toBe(true);
  });

  it("does NOT cluster on first name alone (generic domains corroborate nothing)", () => {
    person(1, "John Smith", { org: "Acme", role: "CTO", location: "NYC" });
    person(2, "John Doe", { org: "Globex", role: "Designer", location: "LA" });
    alias(1, "email", "john@gmail.com");
    alias(2, "email", "john.doe@gmail.com");
    expect(duplicateClusters(db)).toEqual([]);
  });

  it("orders high-confidence clusters first and honours 'not duplicates'", () => {
    person(1, "Sam Carter", { org: "Northstar" });
    person(2, "Sam Q Carter", { org: "Northstar" }); // medium (names differ)
    person(3, "Cory Levy", { org: "ZFellows" });
    person(4, "Cory Levy", { org: "ZFellows" }); // high

    expect(duplicateClusters(db).map((c) => c.confidence)).toEqual(["high", "medium"]);

    dismissDuplicates(db, "3-4");
    const after = duplicateClusters(db);
    expect(after.map((c) => c.key)).toEqual(["1-2"]);
  });

  it("mergeCluster collapses the cluster and clears the survivor's unverified tag", () => {
    person(1, "Cory Levy", { org: "ZFellows" });
    person(2, "Cory Levy", { org: "ZFellows", tier: 3 });
    unverified(2);
    alias(2, "email", "cory@zfellows.com");

    const kept = mergeCluster(db, [1, 2]);
    expect(kept).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM person").get()).toEqual({ c: 1 });
    expect(hasTag(kept!)).toBe(false);
    expect(duplicateClusters(db)).toEqual([]);
    expect(mergeCluster(db, [kept!])).toBeNull(); // needs 2+
  });
});

// ── #7 ambiguous identity ────────────────────────────────────────────────────

describe("ambiguous queue", () => {
  const seedCandidates = () => {
    person(1, "John Smith", { org: "Acme" });
    person(2, "John Smith", { org: "Globex" });
  };

  it("records, collapses repeats, lists resolved candidates, and attaches on resolve", () => {
    seedCandidates();
    const first = recordAmbiguous(db, {
      handleKind: "email",
      handleValue: "j.smith@shared.com",
      name: "John Smith",
      candidateIds: [1, 2],
      sampleText: "  Hey — following up on   the deck ",
    });
    expect(first).toEqual({ key: ambiguousKey("email", "j.smith@shared.com"), hits: 1 });

    // same handle again (40 texts → ONE decision): candidate union, hit counter, first sample
    const again = recordAmbiguous(db, {
      handleKind: "email",
      handleValue: "j.smith@shared.com",
      candidateIds: [2],
      sampleText: "a later message",
    });
    expect(again!.hits).toBe(2);

    const items = pendingAmbiguous(db);
    expect(items).toHaveLength(1);
    expect(items[0].handleValue).toBe("j.smith@shared.com");
    expect(items[0].sampleText).toBe("Hey — following up on the deck");
    expect(items[0].hits).toBe(2);
    expect(items[0].candidates.map((c) => c.display_name)).toEqual(["John Smith", "John Smith"]);
    expect(items[0].candidates.map((c) => c.org)).toEqual(["Acme", "Globex"]);

    const res = resolveAmbiguous(db, items[0].key, 2);
    expect(res).toEqual({ resolved: true, attached: true });
    expect(
      db.prepare("SELECT person_id, kind FROM alias WHERE value = 'j.smith@shared.com'").get()
    ).toEqual({ person_id: 2, kind: "email" });
    expect(pendingAmbiguous(db)).toEqual([]);
    expect(getSetting(db, items[0].key)).toBeNull();
  });

  it("dismiss clears the entry without touching aliases", () => {
    seedCandidates();
    const rec = recordAmbiguous(db, {
      handleKind: "imessage_handle",
      handleValue: "+14155550123",
      candidateIds: [1, 2],
      sampleText: "who dis",
    })!;
    expect(pendingAmbiguous(db)).toHaveLength(1);
    expect(dismissAmbiguous(db, rec.key)).toBe(true);
    expect(pendingAmbiguous(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM alias").get()).toEqual({ c: 0 });
    expect(dismissAmbiguous(db, rec.key)).toBe(false);
    expect(() => dismissAmbiguous(db, "digest_enabled")).toThrow(/ambiguous/);
  });

  it("ignores unactionable records and drops entries whose candidates vanished", () => {
    seedCandidates();
    expect(recordAmbiguous(db, { handleKind: "email", handleValue: "", candidateIds: [1, 2] })).toBeNull();
    expect(recordAmbiguous(db, { handleKind: "email", handleValue: "a@b.com", candidateIds: [1] })).toBeNull();

    const rec = recordAmbiguous(db, {
      handleKind: "email",
      handleValue: "j@shared.com",
      candidateIds: [1, 2],
    })!;
    db.prepare("DELETE FROM person WHERE id = 2").run(); // merged away since
    expect(pendingAmbiguous(db)).toEqual([]);
    expect(getSetting(db, rec.key)).not.toBeNull(); // listing is a read, not a cleanup
    expect(() => resolveAmbiguous(db, rec.key, 99)).toThrow(/not found/);
  });
});

// ── the combined payload ─────────────────────────────────────────────────────

describe("reviewQueue", () => {
  it("bundles the three queues with counts", () => {
    person(1, "Cory Levy", { org: "ZFellows" });
    person(2, "Cory Levy", { org: "ZFellows", tier: 3 });
    unverified(2);
    recordAmbiguous(db, { handleKind: "email", handleValue: "c@shared.com", candidateIds: [1, 2] });

    const q = reviewQueue(db);
    expect(q.counts).toEqual({ contacts: 1, duplicates: 1, ambiguous: 1, notes: 0, total: 3 });
    expect(q.contacts[0].id).toBe(2);
    expect(q.duplicates[0].key).toBe("1-2");
    expect(q.ambiguous[0].candidates).toHaveLength(2);
  });

  it("carries pending note chunks in payload and counts", () => {
    queueNoteChunk(db, { name: "Jay Shah", facts: ["owes me $20"] }, []);
    const q = reviewQueue(db);
    expect(q.notes).toHaveLength(1);
    expect(q.notes[0].chunk.name).toBe("Jay Shah");
    expect(q.counts.notes).toBe(1);
    expect(q.counts.total).toBe(1);
  });
});
