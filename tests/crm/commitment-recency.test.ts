// Why undated commitments nag forever, and the two things that fix it.
//
// Owner report 2026-08-06: "I was looking through the commitments on the relationships page,
// and it was suggesting commitments that are from messages that are weeks old… obviously it's
// better to have a false positive than stuff I'm not sure about, but it's kind of annoying."
//
// His actual table explained it better than the complaint did: EVERY open commitment had
// due_at NULL, and nine of the fourteen were inherited from the PersonalCRM2 migration with no
// source message in POS at all. An undated commitment has no day to be scheduled on, so it can
// never be done, never age out, and can do nothing except appear again tomorrow. The annoyance
// is a missing DATE, not a missing filter.
//
// So: read the date out of the text where the text states one (several of his did — "Reconnect
// in September", "Meet up at start of school"), and set the rest aside without deleting them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import {
  listCommitments,
  rehydrateCommitmentDates,
  messageInstant,
  COMMITMENT_STALE_DAYS,
} from "../../main/crm/commitments.ts";
import { setFact } from "../../main/context.ts";

const NOW = new Date("2026-08-06T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-commit-age-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name = "Someone"): number {
  return Number(db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 1)").run(name).lastInsertRowid);
}

/** A commitment with an optional source message `sourceDaysAgo` days old. */
function addCommitment(
  description: string,
  opts: { dueAt?: string | null; sourceDaysAgo?: number | null; createdDaysAgo?: number } = {}
): number {
  let sourceId: number | null = null;
  if (opts.sourceDaysAgo != null) {
    sourceId = Number(
      db
        .prepare(
          `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary)
           VALUES (?, 'imessage', 'inbound', ?, 'msg')`
        )
        .run(addPerson(), daysAgo(opts.sourceDaysAgo)).lastInsertRowid
    );
  }
  return Number(
    db
      .prepare(
        `INSERT INTO commitment (person_id, direction, description, due_at, status,
                                 source_interaction_id, confidence, confirmed_by_user, created_at)
         VALUES (NULL, 'i_owe_them', ?, ?, 'open', ?, 1.0, 1, ?)`
      )
      .run(description, opts.dueAt ?? null, sourceId, daysAgo(opts.createdDaysAgo ?? 0)).lastInsertRowid
  );
}

const byId = (id: number) => listCommitments(db, "open", NOW).find((c) => c.id === id)!;

describe("freshness", () => {
  it("a dated commitment is never stale, however old the message behind it", () => {
    const id = addCommitment("Send the deck", { dueAt: "2026-12-01", sourceDaysAgo: 200 });
    expect(byId(id).stale).toBe(false);
  });

  it("an undated commitment from a recent message is live", () => {
    const id = addCommitment("Look for tickets for odyssey", { sourceDaysAgo: 4 });
    const row = byId(id);
    expect(row.stale).toBe(false);
    expect(row.inherited).toBe(false);
    expect(row.evidence_at?.slice(0, 10)).toBe(daysAgo(4).slice(0, 10));
  });

  it("an undated commitment goes stale once nothing has evidenced it for a month", () => {
    const fresh = addCommitment("Recent thing", { sourceDaysAgo: COMMITMENT_STALE_DAYS - 5 });
    const old = addCommitment("Old thing", { sourceDaysAgo: COMMITMENT_STALE_DAYS + 5 });
    expect(byId(fresh).stale).toBe(false);
    expect(byId(old).stale).toBe(true);
  });

  it("an inherited commitment is stale on sight — nothing in POS ever evidenced it", () => {
    // The migration did not preserve original dates, so created_at is the migration timestamp
    // and says nothing about age. Treating it as evidence would call all nine of his "new".
    const id = addCommitment("Ask for a16z scout program referral", { sourceDaysAgo: null, createdDaysAgo: 0 });
    const row = byId(id);
    expect(row.inherited).toBe(true);
    expect(row.stale).toBe(true);
  });

  it("nothing is deleted — stale rows are still open and still returned", () => {
    addCommitment("Inherited", { sourceDaysAgo: null });
    addCommitment("Live", { sourceDaysAgo: 2 });
    const all = listCommitments(db, "open", NOW);
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.status === "open")).toBe(true);
    expect(all.filter((c) => c.stale)).toHaveLength(1);
  });
});

// interaction.occurred_at carries two shapes depending on who wrote the row, and the first
// version of the anchor handled only one — appending "Z" to an already-zoned ISO string
// produced "…617ZZ", an invalid Date that fell back to "now". That is the exact failure the
// anchor exists to prevent, and it survived until a dry run over his live data caught a
// commitment from the 5th being dated the 7th.
describe("messageInstant", () => {
  it("reads SQLite's own datetime() output as UTC", () => {
    expect(messageInstant("2026-08-05 07:33:09")?.toISOString()).toBe("2026-08-05T07:33:09.000Z");
  });

  it("reads full ISO from the connectors without mangling it", () => {
    expect(messageInstant("2026-08-05T02:05:58.617Z")?.toISOString()).toBe("2026-08-05T02:05:58.617Z");
  });

  it("handles an explicit offset", () => {
    expect(messageInstant("2026-08-05T02:05:58+02:00")?.toISOString()).toBe("2026-08-05T00:05:58.000Z");
  });

  it("is null rather than silently wrong", () => {
    expect(messageInstant(null)).toBeNull();
    expect(messageInstant("")).toBeNull();
    expect(messageInstant("not a date")).toBeNull();
  });
});

describe("rehydrateCommitmentDates", () => {
  it("dates a commitment whose own text names a month", () => {
    const id = addCommitment("Meetup for coffee in September", { sourceDaysAgo: null });
    expect(rehydrateCommitmentDates(db, NOW)).toBe(1);
    const row = byId(id);
    expect(row.due_at?.slice(0, 7)).toBe("2026-09");
    expect(row.stale).toBe(false); // it has a day now, so it stops nagging until then
  });

  it("resolves the personal anchors parseWhen cannot know about", () => {
    setFact(db, { key: "school_term_start", value: "2026-09-22", kind: "date_anchor", startsAt: "2026-09-22" });
    const id = addCommitment("Meet up at start of school", { sourceDaysAgo: null });
    expect(rehydrateCommitmentDates(db, NOW)).toBe(1);
    expect(byId(id).due_at?.slice(0, 10)).toBe("2026-09-22");
  });

  it("leaves text that names no time alone rather than inventing a date", () => {
    const id = addCommitment("Ask for a16z scout program referral", { sourceDaysAgo: null });
    expect(rehydrateCommitmentDates(db, NOW)).toBe(0);
    expect(byId(id).due_at).toBeNull();
    expect(byId(id).stale).toBe(true); // still set aside, still not deleted
  });

  it("never overwrites a date that is already there", () => {
    const id = addCommitment("Coffee in September", { dueAt: "2026-08-20", sourceDaysAgo: 1 });
    rehydrateCommitmentDates(db, NOW);
    expect(byId(id).due_at).toBe("2026-08-20");
  });

  it("refuses a date that has already passed — that would be instantly overdue, not answered", () => {
    const id = addCommitment("Meet up in March", { sourceDaysAgo: null });
    rehydrateCommitmentDates(db, NOW);
    const due = byId(id).due_at;
    // Either it resolved forward (next March) or not at all; never behind today.
    if (due) expect(due.slice(0, 10) >= "2026-08-06").toBe(true);
  });

  // Caught by a dry run over his live data before this shipped: "Contact will talk to him
  // during their call tomorrow", from a message sent 2026-08-05, was being dated 2026-08-07.
  // Anchoring on today walks a deadline forward one day for every day it stays open.
  it("reads relative language against the message, not against today", () => {
    const id = addCommitment("Call them tomorrow", { sourceDaysAgo: 4 }); // sent 2026-08-02
    rehydrateCommitmentDates(db, NOW);
    // "Tomorrow" meant 2026-08-03 — already past, so it gets no date rather than a fresh one.
    expect(byId(id).due_at).toBeNull();
  });

  it("still resolves forward-looking language from an old message correctly", () => {
    const id = addCommitment("Lunch in December", { sourceDaysAgo: 40 });
    rehydrateCommitmentDates(db, NOW);
    expect(byId(id).due_at?.slice(0, 7)).toBe("2026-12");
  });

  // The live-data failure, reproduced exactly: an ISO-with-Z source timestamp.
  it("anchors correctly when the source timestamp is full ISO, not SQLite datetime()", () => {
    const src = Number(
      db
        .prepare(
          `INSERT INTO interaction (person_id, channel, direction, occurred_at, body_summary)
           VALUES (?, 'imessage', 'inbound', '2026-08-05T02:05:58.617Z', 'msg')`
        )
        .run(addPerson()).lastInsertRowid
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO commitment (person_id, direction, description, due_at, status,
                                   source_interaction_id, confidence, confirmed_by_user)
           VALUES (NULL, 'i_owe_them', 'Talk to them during their call tomorrow', NULL, 'open', ?, 1.0, 1)`
        )
        .run(src).lastInsertRowid
    );
    rehydrateCommitmentDates(db, NOW); // NOW = 2026-08-06
    // "Tomorrow" from a message sent on the 5th is the 6th — today — never the 7th.
    const due = byId(id).due_at;
    expect(due === null || due.slice(0, 10) === "2026-08-06").toBe(true);
    expect(due?.slice(0, 10)).not.toBe("2026-08-07");
  });

  it("is idempotent — a second pass changes nothing", () => {
    addCommitment("Reconnect in September", { sourceDaysAgo: null });
    addCommitment("Meet later this summer", { sourceDaysAgo: null });
    const first = rehydrateCommitmentDates(db, NOW);
    expect(first).toBeGreaterThan(0);
    expect(rehydrateCommitmentDates(db, NOW)).toBe(0);
  });

  it("touches only open commitments", () => {
    const id = addCommitment("Coffee in September", { sourceDaysAgo: null });
    db.prepare("UPDATE commitment SET status = 'dropped' WHERE id = ?").run(id);
    expect(rehydrateCommitmentDates(db, NOW)).toBe(0);
  });
});
