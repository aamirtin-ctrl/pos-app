// Mailfile connector: resolve-then-insert against a real tmpdir DB, snippet cap,
// direction classification, unmatched skip, idempotent re-run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting, type Db } from "../../main/db/db.ts";
import { SecretStore } from "../../main/secrets.ts";
import { syncMailfile } from "../../main/connectors/mailfile.ts";

let dir: string;
let db: Db;
let secrets: SecretStore;

const LONG_BODY = "This is a long email body. ".repeat(20); // ~540 chars, well over 200

const MBOX = `From me@example.com Thu Jan 01 00:00:00 2026
From: Me <me@example.com>
To: Alice Example <alice@example.com>
Subject: Project kickoff
Date: Thu, 01 Jan 2026 10:00:00 +0000
Message-ID: <m1@example.com>

${LONG_BODY}

From bob@nowhere.com Thu Jan 02 00:00:00 2026
From: Bob Stranger <bob@nowhere.com>
To: Me <me@example.com>
Subject: Hello from a stranger
Date: Fri, 02 Jan 2026 10:00:00 +0000
Message-ID: <m2@nowhere.com>

Nice to meet you.
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-mailfile-"));
  db = openDb(path.join(dir, "pos.db"));
  secrets = new SecretStore(path.join(dir, "secrets"));
  setSetting(db, "mailfile_user_email", "me@example.com");
  // Seed the person + alias that message 1's counterpart resolves to.
  db.prepare("INSERT INTO person (display_name) VALUES ('Alice Example')").run();
  db.prepare(
    "INSERT INTO alias (person_id, kind, value) VALUES (1, 'email', 'alice@example.com')"
  ).run();
  fs.writeFileSync(path.join(dir, "export.mbox"), MBOX);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("syncMailfile", () => {
  it("ingests the matched message only, with a ≤200-char snippet and correct direction", async () => {
    const r = await syncMailfile({ db, secrets }, path.join(dir, "export.mbox"));
    expect(r.error).toBeUndefined();
    expect(r.ingested).toBe(1); // alice matched
    expect(r.skipped).toBe(1); // bob unmatched → skipped (no staging, no person creation)
    expect(r.created).toBe(0);
    expect(r.resolvedPct).toBe(50);

    const rows = db
      .prepare("SELECT * FROM interaction WHERE channel = 'mailfile'")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(1);
    expect(rows[0].direction).toBe("outbound"); // FROM me@example.com
    expect(rows[0].subject).toBe("Project kickoff");
    expect(rows[0].external_id).toBe("<m1@example.com>");
    const summary = rows[0].body_summary as string;
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).toContain("This is a long email body.");
    expect(summary).not.toContain(LONG_BODY.trim()); // never the full body
  });

  it("re-run is idempotent (still exactly 1 interaction, 0 newly ingested)", async () => {
    await syncMailfile({ db, secrets }, path.join(dir, "export.mbox"));
    const again = await syncMailfile({ db, secrets }, path.join(dir, "export.mbox"));
    expect(again.ingested).toBe(0);
    const n = db.prepare("SELECT COUNT(*) c FROM interaction").get() as { c: number };
    expect(n.c).toBe(1);
  });

  it("falls back to GMAIL_USER for self when the setting is missing", async () => {
    db.prepare("DELETE FROM setting WHERE key = 'mailfile_user_email'").run();
    secrets.set("GMAIL_USER", "me@example.com");
    const r = await syncMailfile({ db, secrets }, path.join(dir, "export.mbox"));
    expect(r.ingested).toBe(1);
    const row = db
      .prepare("SELECT direction FROM interaction WHERE channel = 'mailfile'")
      .get() as { direction: string };
    expect(row.direction).toBe("outbound");
  });

  it("missing path → error report, nothing thrown", async () => {
    const r = await syncMailfile({ db, secrets }, path.join(dir, "nope.mbox"));
    expect(r.error).toBe("not-found");
    expect(r.ingested).toBe(0);
  });
});
