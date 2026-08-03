// LinkedIn connector: connections create person + linkedin alias + 'mutual' interaction,
// messages attribute by profile-URL alias, "LinkedIn Member" skipped, re-run idempotent.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { SecretStore } from "../../main/secrets.ts";
import { syncLinkedin } from "../../main/connectors/linkedin.ts";

let dir: string;
let db: Db;
let secrets: SecretStore;

// Real exports prepend "Notes:" preamble lines before the header row.
const CONNECTIONS_CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Jane,Doe,https://www.linkedin.com/in/janedoe,,Acme Corp,CEO,18 Apr 2024
LinkedIn,Member,,,,,01 Jan 2024
`;

// Self-detection: in/me sends the most messages (2 of 3).
const MESSAGES_CSV = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT
conv1,,Me Person,https://www.linkedin.com/in/me,Jane Doe,https://www.linkedin.com/in/janedoe,2026-05-01 10:00:00 UTC,,Hey Jane — following up on the intro!
conv1,,Jane Doe,https://www.linkedin.com/in/janedoe,Me Person,https://www.linkedin.com/in/me,2026-05-01 11:00:00 UTC,,Great to hear from you.
conv1,,Me Person,https://www.linkedin.com/in/me,Jane Doe,https://www.linkedin.com/in/janedoe,2026-05-02 09:00:00 UTC,,Let's chat next week.
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-linkedin-"));
  db = openDb(path.join(dir, "pos.db"));
  secrets = new SecretStore(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "Connections.csv"), CONNECTIONS_CSV);
  fs.writeFileSync(path.join(dir, "messages.csv"), MESSAGES_CSV);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("syncLinkedin", () => {
  it("creates person + linkedin alias + connection & message interactions; skips LinkedIn Member", async () => {
    const r = await syncLinkedin({ db, secrets }, dir);
    expect(r.error).toBeUndefined();
    expect(r.created).toBe(1); // Jane only — "LinkedIn Member" skipped

    const people = db.prepare("SELECT * FROM person").all() as Array<Record<string, unknown>>;
    expect(people).toHaveLength(1);
    expect(people[0].display_name).toBe("Jane Doe");
    expect(people[0].org).toBe("Acme Corp");
    expect(people[0].role).toBe("CEO");

    const alias = db
      .prepare("SELECT * FROM alias WHERE kind = 'linkedin'")
      .get() as Record<string, unknown>;
    expect(alias.value).toBe("linkedin.com/in/janedoe"); // normalized profile URL
    expect(alias.person_id).toBe(people[0].id);

    const conn = db
      .prepare("SELECT * FROM interaction WHERE external_id = 'conn:linkedin.com/in/janedoe'")
      .get() as Record<string, unknown>;
    expect(conn.direction).toBe("mutual");
    expect(conn.channel).toBe("linkedin");
    expect(conn.occurred_at).toBe("2024-04-18T00:00:00.000Z");

    // 1 connection + 3 messages (2 outbound, 1 inbound), all attributed to Jane.
    const msgs = db
      .prepare(
        "SELECT direction FROM interaction WHERE channel = 'linkedin' AND external_id LIKE 'linkedin-msg:%' ORDER BY occurred_at"
      )
      .all() as Array<{ direction: string }>;
    expect(msgs.map((m) => m.direction)).toEqual(["outbound", "inbound", "outbound"]);
    expect(r.ingested).toBe(4);

    const total = db.prepare("SELECT COUNT(*) c FROM interaction").get() as { c: number };
    expect(total.c).toBe(4);
  });

  it("re-run is idempotent: no new people, no new interactions", async () => {
    await syncLinkedin({ db, secrets }, dir);
    const again = await syncLinkedin({ db, secrets }, dir);
    expect(again.created).toBe(0);
    expect(again.ingested).toBe(0);

    const people = db.prepare("SELECT COUNT(*) c FROM person").get() as { c: number };
    const interactions = db.prepare("SELECT COUNT(*) c FROM interaction").get() as { c: number };
    expect(people.c).toBe(1);
    expect(interactions.c).toBe(4);
  });

  it("missing export path → error report, nothing thrown", async () => {
    const r = await syncLinkedin({ db, secrets }, path.join(dir, "nope"));
    expect(r.error).toBe("not-found");
  });
});
