// Mirror POS person bios into Apple Contacts (owner asks 2026-08-20: bios "should also be
// reflected in my apple contacts", and people the Mac doesn't know should be CREATED there).
//
// Matching: phone (last 10 digits) → email → unique normalized name. Bios are written inside a
// managed ―― POS ―― block so owner-typed note text survives; re-runs replace only the block.
// Unmatched people with a real name are created (name + phones/emails + bio) — which also
// teaches every iMessage surface their name. Bare-number "names" are never created, and a name
// that matches MULTIPLE Apple cards is left alone rather than guessed at.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { Db } from "../db/db.ts";

const run = promisify(execFile);

export const BLOCK_START = "―― POS ――";
export const BLOCK_END = "―― /POS ――";

const norm10 = (p: string) => p.replace(/\D/g, "").slice(-10);
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Splice the managed block into an existing note, replacing a previous block if present. */
export function spliceBlock(existing: string | null, bio: string): string {
  const block = `${BLOCK_START}\n${bio.trim()}\n${BLOCK_END}`;
  const cur = (existing ?? "").trim();
  if (!cur) return block;
  const re = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);
  if (re.test(cur)) return cur.replace(re, block);
  return `${cur}\n\n${block}`;
}

/** "Abdeali Diwan" → { first: "Abdeali", last: "Diwan" }; single word → first only. */
export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/** A display name worth creating an Apple contact for — not a bare number/handle. */
export function isCreatableName(name: string): boolean {
  const n = name.trim();
  if (!n || /^\+?\d[\d\s()-]*$/.test(n)) return false; // bare phone number
  if (n.includes("@")) return false; // bare email handle
  return /[a-z]/i.test(n);
}

async function jxa(script: string, arg?: string): Promise<string> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script, ...(arg ? [arg] : [])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const DUMP = `
(() => {
  const app = Application("Contacts");
  const P = app.people;
  const out = { ids: P.id(), names: P.name(), notes: P.note(),
                phones: P.phones.value(), emails: P.emails.value() };
  return JSON.stringify(out);
})()`;

// One pass applies both kinds of change. Updates go by id; creates build a full card.
const APPLY_SCRIPT = `
function run(argv) {
  const payload = JSON.parse($.NSString.stringWithContentsOfFileEncodingError($(argv[0]), $.NSUTF8StringEncoding, null).js);
  const app = Application("Contacts");
  let updated = 0, created = 0;
  for (const u of payload.updates) {
    const hits = app.people.whose({ id: u.id })();
    if (hits.length !== 1) continue;
    hits[0].note = u.note;
    updated++;
  }
  for (const c of payload.creates) {
    const p = app.Person({ firstName: c.first, lastName: c.last, note: c.note });
    app.people.push(p);
    for (const ph of c.phones) p.phones.push(app.Phone({ label: "mobile", value: ph }));
    for (const em of c.emails) p.emails.push(app.Email({ label: "home", value: em }));
    created++;
  }
  app.save();
  return JSON.stringify({ updated, created });
}`;

export interface AppleBioSyncResult {
  matched: number;
  updated: number;
  created: number;
  ambiguous: string[];
  skippedUncreatable: number;
}

/**
 * The whole mirror: read POS bios + aliases, read Apple Contacts in bulk, update matches'
 * managed blocks, create the rest. `apply: false` reports without writing.
 */
export async function syncAppleContactBios(
  db: Db,
  opts: { apply: boolean; create?: boolean }
): Promise<AppleBioSyncResult> {
  const create = opts.create ?? true;
  const people = db
    .prepare(
      "SELECT id, display_name, bio, name_inferred_at FROM person WHERE bio IS NOT NULL AND bio != ''"
    )
    .all() as { id: number; display_name: string; bio: string; name_inferred_at: string | null }[];
  const aliases = db.prepare("SELECT person_id, kind, value FROM alias").all() as {
    person_id: number; kind: string; value: string;
  }[];
  const aliasByPerson = new Map<number, { phones: string[]; emails: string[] }>();
  for (const a of aliases) {
    const e = aliasByPerson.get(a.person_id) ?? { phones: [], emails: [] };
    if (a.kind === "phone" || a.kind === "imessage_handle") {
      if (/\d/.test(a.value)) e.phones.push(a.value);
      else e.emails.push(a.value.toLowerCase());
    }
    if (a.kind === "email") e.emails.push(a.value.toLowerCase());
    aliasByPerson.set(a.person_id, e);
  }

  const dump = JSON.parse(await jxa(DUMP)) as {
    ids: string[]; names: string[]; notes: (string | null)[];
    phones: string[][]; emails: string[][];
  };

  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();
  const byName = new Map<string, number[]>();
  for (let i = 0; i < dump.ids.length; i++) {
    for (const p of dump.phones[i] ?? []) {
      const k = norm10(p);
      if (k.length === 10 && !byPhone.has(k)) byPhone.set(k, i);
    }
    for (const e of dump.emails[i] ?? []) {
      const k = e.toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, i);
    }
    const nk = normName(dump.names[i] ?? "");
    if (nk) byName.set(nk, [...(byName.get(nk) ?? []), i]);
  }

  const updates: { id: string; note: string }[] = [];
  const creates: { first: string; last: string; note: string; phones: string[]; emails: string[] }[] = [];
  const out: AppleBioSyncResult = { matched: 0, updated: 0, created: 0, ambiguous: [], skippedUncreatable: 0 };

  for (const p of people) {
    const al = aliasByPerson.get(p.id) ?? { phones: [], emails: [] };
    let idx: number | undefined;
    for (const ph of al.phones) if ((idx = byPhone.get(norm10(ph))) !== undefined) break;
    if (idx === undefined) for (const em of al.emails) if ((idx = byEmail.get(em)) !== undefined) break;
    const nameHits = byName.get(normName(p.display_name)) ?? [];
    if (idx === undefined && nameHits.length === 1) idx = nameHits[0];

    if (idx !== undefined) {
      out.matched++;
      const next = spliceBlock(dump.notes[idx], p.bio);
      if ((dump.notes[idx] ?? "").trim() !== next.trim()) updates.push({ id: dump.ids[idx], note: next });
      continue;
    }
    if (nameHits.length > 1) {
      out.ambiguous.push(p.display_name); // several cards share the name — a human call
      continue;
    }
    if (!create) continue;
    // An LLM-inferred name is a guess — creating an iCloud card from it would let the
    // guess "verify" itself on the next sync. Only saved/typed names may mint cards.
    if (p.name_inferred_at || !isCreatableName(p.display_name)) {
      out.skippedUncreatable++;
      continue;
    }
    const { first, last } = splitName(p.display_name);
    creates.push({ first, last, note: spliceBlock(null, p.bio), phones: al.phones, emails: al.emails });
  }

  if (opts.apply && (updates.length || creates.length)) {
    const f = join(os.tmpdir(), `pos-apple-bios-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ updates, creates }));
    try {
      const res = JSON.parse((await jxa(APPLY_SCRIPT, f)).trim()) as { updated: number; created: number };
      out.updated = res.updated;
      out.created = res.created;
    } finally {
      rmSync(f, { force: true });
    }
  } else {
    out.updated = updates.length;
    out.created = creates.length;
  }
  return out;
}
