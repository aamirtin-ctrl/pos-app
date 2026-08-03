// One-shot migration: legacy PersonalCRM2 Postgres → the pos SQLite spine.
// Usage: npm run migrate:from-postgres [-- --out <path>] [-- --force]
// Mapping rules follow PersonalCRM2/MIGRATION_MAP.md §A–D exactly.
// Everything writes in ONE better-sqlite3 transaction; any throw rolls back.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { openDb } from "../main/db/db.ts";
import {
  parseFollowUp,
  splitName,
  commaSplit,
  mapDirection,
  dateToMidnightIso,
  tsToIso,
  buildBio,
  threadFromRawMeta,
} from "./migrate-lib.ts";

const LEGACY_ENV = "/Users/aamirtinwala/Desktop/Desktop App/PersonalCRM2/.env";

// pg returns DATE columns as JS Dates at local midnight by default — keep the raw
// "YYYY-MM-DD" string instead so midnight-ISO conversion is timezone-proof.
pg.types.setTypeParser(1082, (v: string) => v);

interface TableStat {
  source: number;
  migrated: number;
  skipped: number;
  reasons: Map<string, number>;
}

function stat(): TableStat {
  return { source: 0, migrated: 0, skipped: 0, reasons: new Map() };
}
function skip(s: TableStat, reason: string, n = 1): void {
  s.skipped += n;
  s.reasons.set(reason, (s.reasons.get(reason) ?? 0) + n);
}

function readDsn(): string {
  const env = fs.readFileSync(LEGACY_ENV, "utf8");
  const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error(`DATABASE_URL not found in ${LEGACY_ENV}`);
  return m[1].replace(/\?schema=public$/, "");
}

function parseArgs(argv: string[]): { out: string; force: boolean } {
  let out = path.join(os.homedir(), "Library", "Application Support", "pos", "pos.db");
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out requires a path");
      out = v;
    } else if (argv[i] === "--force") {
      force = true;
    }
  }
  return { out, force };
}

async function main(): Promise<void> {
  const { out, force } = parseArgs(process.argv.slice(2));
  const dsn = readDsn();

  // ── Pull everything from Postgres first (async), then write synchronously. ──
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  const q = async (sql: string) => (await client.query(sql)).rows;
  // Sequential on purpose — pg deprecates overlapping query() calls on one client.
  const contacts = await q("SELECT * FROM contacts ORDER BY id");
  const identifiers = await q("SELECT * FROM contact_identifiers ORDER BY id");
  const staging = await q("SELECT * FROM staging_interactions ORDER BY id");
  const groups = await q("SELECT * FROM groups ORDER BY id");
  const dismissals = await q("SELECT * FROM reconnect_dismissals ORDER BY id");
  const enrichments = await q("SELECT * FROM enrichment_attempts ORDER BY id");
  const syncStates = await q("SELECT * FROM sync_state ORDER BY source");
  await client.end();

  const db = openDb(out);
  const existing = (db.prepare("SELECT COUNT(*) c FROM person").get() as { c: number }).c;
  if (existing > 0 && !force) {
    console.error(
      `Target ${out} already has ${existing} person rows. Re-run with --force to wipe ` +
        `person/alias/interaction/commitment/grp/person_group/person_tag/dismissal/enrichment_attempt first.`
    );
    db.close();
    process.exit(1);
  }

  const stats: Record<string, TableStat> = {
    "contacts → person": stat(),
    "contact_identifiers → alias": stat(),
    "handle_* → alias (fold-in)": stat(),
    "staging_interactions → interaction": stat(),
    "follow_up → commitment": stat(),
    "groups → grp": stat(),
    "contacts.groups → person_group": stat(),
    "contacts.tags → person_tag": stat(),
    "reconnect_dismissals → dismissal": stat(),
    "enrichment_attempts → enrichment_attempt": stat(),
    "sync_state → sync_state": stat(),
  };

  const migrateAll = db.transaction(() => {
    if (existing > 0) {
      // FK cascades would handle children, but be explicit: wipe in dependency order.
      for (const t of [
        "person_tag",
        "person_group",
        "dismissal",
        "enrichment_attempt",
        "commitment",
        "interaction",
        "alias",
        "person",
        "grp",
      ]) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
    }

    // ── contacts → person (§A) ──
    const idMap = new Map<string, number>(); // legacy BigInt id (string) → new INTEGER id
    const insPerson = db.prepare(`
      INSERT INTO person (display_name, given_name, family_name, org, role, bio,
                          relationship_summary, tier, last_contact_at, created_at, updated_at)
      VALUES (@display_name, @given_name, @family_name, @org, @role, @bio,
              @relationship_summary, @tier, @last_contact_at, @created_at, @updated_at)
    `);
    const s = stats["contacts → person"];
    s.source = contacts.length;
    for (const c of contacts) {
      if (c.deleted_at != null) {
        skip(s, "deleted_at set (soft-deleted)");
        continue;
      }
      const { given, family } = splitName(c.name);
      const r = insPerson.run({
        display_name: c.name,
        given_name: given,
        family_name: family,
        org: c.company ?? null,
        role: c.role ?? null,
        bio: buildBio(c.notes ?? null, c.personal_detail ?? null),
        relationship_summary: c.relationship ?? null,
        tier: c.hidden_at != null ? 3 : 2,
        last_contact_at: dateToMidnightIso(c.last_contact_date),
        created_at: tsToIso(c.created_at),
        updated_at: tsToIso(c.updated_at),
      });
      idMap.set(String(c.id), Number(r.lastInsertRowid));
      s.migrated++;
    }

    // ── contact_identifiers → alias (§B) ──
    const insAlias = db.prepare(`
      INSERT OR IGNORE INTO alias (person_id, kind, value, is_primary, confidence, source)
      VALUES (?, ?, ?, 0, 1.0, 'migration')
    `);
    {
      const st = stats["contact_identifiers → alias"];
      st.source = identifiers.length;
      for (const ident of identifiers) {
        const pid = idMap.get(String(ident.contact_id));
        if (pid == null) {
          skip(st, "contact deleted / not migrated");
          continue;
        }
        const r = insAlias.run(pid, ident.kind, ident.value_norm);
        if (r.changes === 0) skip(st, "duplicate (kind,value)");
        else st.migrated++;
      }
    }

    // Fold contacts.handle_email/phone/linkedin into alias (INSERT OR IGNORE dedups).
    {
      const st = stats["handle_* → alias (fold-in)"];
      for (const c of contacts) {
        const pid = idMap.get(String(c.id));
        if (pid == null) continue;
        for (const [kind, value] of [
          ["email", c.handle_email],
          ["phone", c.handle_phone],
          ["linkedin", c.handle_linkedin],
        ] as const) {
          if (!value) continue;
          st.source++;
          const r = insAlias.run(pid, kind, value);
          if (r.changes === 0) skip(st, "already present via contact_identifiers");
          else st.migrated++;
        }
      }
    }

    // First alias per (person, kind) becomes primary.
    db.prepare(`
      UPDATE alias SET is_primary = 1
      WHERE id IN (SELECT MIN(id) FROM alias GROUP BY person_id, kind)
    `).run();

    // ── staging_interactions → interaction (§C) ──
    {
      const st = stats["staging_interactions → interaction"];
      st.source = staging.length;
      const insInteraction = db.prepare(`
        INSERT OR IGNORE INTO interaction
          (person_id, channel, direction, occurred_at, subject, body_raw, body_summary,
           external_id, thread_external_id)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `);
      for (const row of staging) {
        if (row.matched_contact_id == null || row.match_status !== "matched") {
          skip(st, `unmatched (match_status=${row.match_status})`);
          continue;
        }
        const pid = idMap.get(String(row.matched_contact_id));
        if (pid == null) {
          skip(st, "matched contact deleted / not migrated");
          continue;
        }
        const r = insInteraction.run(
          pid,
          row.source,
          mapDirection(row.direction),
          tsToIso(row.occurred_at),
          row.subject ?? null,
          row.snippet ?? null,
          row.external_id ?? null,
          threadFromRawMeta(row.raw_meta)
        );
        if (r.changes === 0) skip(st, "duplicate (channel,external_id)");
        else st.migrated++;
      }
    }

    // ── contacts.follow_up* → commitment (§D) ──
    {
      const st = stats["follow_up → commitment"];
      const insCommitment = db.prepare(`
        INSERT INTO commitment (person_id, direction, description, due_at, status,
                                confidence, confirmed_by_user, resolved_at)
        VALUES (?, 'i_owe_them', ?, ?, 'open', ?, ?, ?)
      `);
      for (const c of contacts) {
        if (c.follow_up == null || String(c.follow_up).trim() === "") continue;
        st.source++;
        const pid = idMap.get(String(c.id));
        if (pid == null) {
          skip(st, "contact deleted / not migrated");
          continue;
        }
        const { description, due_at } = parseFollowUp(c.follow_up);
        const confirmed = c.follow_up_source == null || c.follow_up_source !== "message" ? 1 : 0;
        insCommitment.run(
          pid,
          description,
          due_at,
          confirmed ? 1.0 : 0.6,
          confirmed,
          tsToIso(c.follow_up_resolved_at)
        );
        st.migrated++;
      }
    }

    // ── groups → grp + contacts.groups → person_group ──
    const grpIdByName = new Map<string, number>();
    const insGrp = db.prepare(`
      INSERT INTO grp (name, hidden, hide_contacts, suppress_follow_ups, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    {
      const st = stats["groups → grp"];
      st.source = groups.length;
      for (const g of groups) {
        const r = insGrp.run(
          g.name,
          g.hidden ? 1 : 0,
          g.hide_contacts ? 1 : 0,
          g.suppress_follow_ups ? 1 : 0,
          tsToIso(g.created_at)
        );
        grpIdByName.set(g.name, Number(r.lastInsertRowid));
        st.migrated++;
      }
    }
    {
      const st = stats["contacts.groups → person_group"];
      const insPG = db.prepare(
        "INSERT OR IGNORE INTO person_group (person_id, group_id) VALUES (?, ?)"
      );
      for (const c of contacts) {
        const pid = idMap.get(String(c.id));
        if (pid == null) continue;
        for (const name of commaSplit(c.groups)) {
          st.source++;
          let gid = grpIdByName.get(name);
          if (gid == null) {
            // Membership names a group that has no groups row — create it on the fly.
            const r = insGrp.run(name, 0, 0, 0, null);
            gid = Number(r.lastInsertRowid);
            grpIdByName.set(name, gid);
            const gs = stats["groups → grp"];
            gs.migrated++;
            gs.reasons.set(
              "created on the fly from contacts.groups",
              (gs.reasons.get("created on the fly from contacts.groups") ?? 0) + 1
            );
          }
          const r = insPG.run(pid, gid);
          if (r.changes === 0) skip(st, "duplicate membership");
          else st.migrated++;
        }
      }
    }

    // ── contacts.tags → person_tag ──
    {
      const st = stats["contacts.tags → person_tag"];
      const insTag = db.prepare("INSERT OR IGNORE INTO person_tag (person_id, tag) VALUES (?, ?)");
      for (const c of contacts) {
        const pid = idMap.get(String(c.id));
        if (pid == null) continue;
        for (const tag of commaSplit(c.tags, { lowercase: true })) {
          st.source++;
          const r = insTag.run(pid, tag);
          if (r.changes === 0) skip(st, "duplicate tag");
          else st.migrated++;
        }
      }
    }

    // ── reconnect_dismissals → dismissal ──
    {
      const st = stats["reconnect_dismissals → dismissal"];
      st.source = dismissals.length;
      const insDismissal = db.prepare(`
        INSERT INTO dismissal (person_id, kind, snooze_until, created_at) VALUES (?, ?, ?, ?)
      `);
      for (const d of dismissals) {
        const pid = idMap.get(String(d.contact_id));
        if (pid == null) {
          skip(st, "contact deleted / not migrated");
          continue;
        }
        insDismissal.run(pid, d.kind, dateToMidnightIso(d.snooze_until), tsToIso(d.created_at));
        st.migrated++;
      }
    }

    // ── enrichment_attempts → enrichment_attempt ──
    {
      const st = stats["enrichment_attempts → enrichment_attempt"];
      st.source = enrichments.length;
      const insEnrich = db.prepare(`
        INSERT INTO enrichment_attempt (person_id, source, status, detail, attempted_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const e of enrichments) {
        const pid = idMap.get(String(e.contact_id));
        if (pid == null) {
          skip(st, "contact deleted / not migrated");
          continue;
        }
        insEnrich.run(pid, e.source, e.status, e.detail ?? null, tsToIso(e.attempted_at));
        st.migrated++;
      }
    }

    // ── sync_state → sync_state (direct move) ──
    {
      const st = stats["sync_state → sync_state"];
      st.source = syncStates.length;
      const insSync = db.prepare(`
        INSERT INTO sync_state (source, last_sync_at, cursor, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at,
          cursor = excluded.cursor, updated_at = excluded.updated_at
      `);
      for (const ss of syncStates) {
        insSync.run(ss.source, tsToIso(ss.last_sync_at), ss.cursor ?? null, tsToIso(ss.updated_at));
        st.migrated++;
      }
    }
  });

  try {
    migrateAll();
  } catch (e) {
    db.close();
    console.error("Migration failed — transaction rolled back, target unchanged.");
    console.error(e);
    process.exit(1);
  }

  // ── Report ──
  console.log(`\nMigrated Postgres → ${out}\n`);
  const header = ["table", "source", "migrated", "skipped"];
  const rows = Object.entries(stats).map(([name, st]) => [
    name,
    String(st.source),
    String(st.migrated),
    String(st.skipped),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log("");
  for (const [name, st] of Object.entries(stats)) {
    for (const [reason, n] of st.reasons) console.log(`  ${name}: ${reason} × ${n}`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
