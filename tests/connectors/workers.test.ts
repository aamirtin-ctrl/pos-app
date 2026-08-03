// Workers orchestration: sync_run bookkeeping, error capture (never propagates),
// post-ingest hook (last-contact advance + reconnect refresh), syncStatus.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { SecretStore } from "../../main/secrets.ts";
import { runSync, syncStatus, advanceLastContact } from "../../main/workers.ts";

let dir: string;
let db: Db;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-workers-"));
  db = openDb(path.join(dir, "pos.db"));
  secrets = new SecretStore(path.join(dir, "secrets"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runSync", () => {
  it("a throwing connector is recorded in sync_run.error and does NOT propagate", async () => {
    const r = await runSync(db, secrets, null, "gmail", undefined, {
      gmail: async () => {
        throw new Error("boom");
      },
    });
    expect(r.error).toBe("boom");
    expect(r.ingested).toBe(0);

    const run = db
      .prepare("SELECT * FROM sync_run WHERE source = 'gmail' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(run.error).toBe("boom");
    expect(run.started_at).toBeTruthy();
    expect(run.finished_at).toBeTruthy();
    expect(run.records_ingested).toBe(0);
  });

  it("a successful run records counts and fires the post-ingest hook (llm null → no throw)", async () => {
    // Seed: person with an outbound interaction — the hook should advance last_contact_at
    // and compute next_touch_due_at from the tier cadence.
    db.prepare("INSERT INTO person (display_name, tier) VALUES ('Cory Levy', 1)").run();
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id)
       VALUES (1, 'gmail', 'outbound', '2026-08-01T12:00:00.000Z', 'x1')`
    ).run();

    const r = await runSync(db, secrets, null, "gmail", undefined, {
      gmail: async () => ({ source: "gmail", ingested: 1, skipped: 2, created: 0 }),
    });
    expect(r.error).toBeUndefined();

    const run = db
      .prepare("SELECT records_ingested, error FROM sync_run ORDER BY id DESC LIMIT 1")
      .get() as { records_ingested: number; error: string | null };
    expect(run.records_ingested).toBe(1);
    expect(run.error).toBeNull();

    const p = db
      .prepare("SELECT last_contact_at, next_touch_due_at FROM person WHERE id = 1")
      .get() as { last_contact_at: string | null; next_touch_due_at: string | null };
    expect(p.last_contact_at).toBe("2026-08-01T12:00:00.000Z");
    expect(p.next_touch_due_at).toBeTruthy(); // tier 1 → +30 days
  });

  it("linkedin/mailfile without a path report path-required instead of throwing", async () => {
    const r = await runSync(db, secrets, null, "linkedin");
    expect(r.error).toBe("path-required");
  });
});

describe("advanceLastContact", () => {
  it("is forward-only and ignores inbound interactions", () => {
    db.prepare(
      "INSERT INTO person (display_name, last_contact_at) VALUES ('A', '2026-09-01T00:00:00.000Z')"
    ).run();
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id)
       VALUES (1, 'gmail', 'outbound', '2026-08-01T00:00:00.000Z', 'old')`
    ).run();
    db.prepare(
      `INSERT INTO interaction (person_id, channel, direction, occurred_at, external_id)
       VALUES (1, 'gmail', 'inbound', '2026-10-01T00:00:00.000Z', 'in')`
    ).run();
    expect(advanceLastContact(db)).toBe(0); // outbound max is older; inbound never counts
    const p = db.prepare("SELECT last_contact_at FROM person WHERE id = 1").get() as {
      last_contact_at: string;
    };
    expect(p.last_contact_at).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("syncStatus", () => {
  it("reports last run + cursor per source", async () => {
    await runSync(db, secrets, null, "gmail", undefined, {
      gmail: async () => {
        throw new Error("boom");
      },
    });
    await runSync(db, secrets, null, "gmail", undefined, {
      gmail: async () => ({ source: "gmail", ingested: 3, skipped: 0, created: 0 }),
    });
    db.prepare("INSERT INTO sync_state (source, cursor) VALUES ('gmail', '2026-08-01T00:00:00.000Z')").run();

    const status = syncStatus(db);
    expect(status.map((s) => s.source)).toEqual(["gmail", "imessage", "linkedin", "mailfile"]);
    const gmail = status[0];
    expect(gmail.last_run?.records_ingested).toBe(3); // latest run wins
    expect(gmail.last_run?.error).toBeNull();
    expect(gmail.cursor).toBe("2026-08-01T00:00:00.000Z");
    expect(status[1].last_run).toBeNull(); // imessage never ran
  });
});
