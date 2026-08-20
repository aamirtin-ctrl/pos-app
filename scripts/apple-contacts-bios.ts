// Mirror POS person bios into Apple Contacts notes (owner ask 2026-08-20: "the bios made by
// POS should also be reflected in my apple contacts").
//
// Matching: phone (last 10 digits) → email → exact normalized name. The bio is written inside
// a managed block, so anything the owner typed in a contact's note himself is preserved —
// re-runs replace only the block. Contacts the Mac doesn't know stay untouched (nothing is
// created here; creating Apple contacts is a separate decision).
//
//   npm run contacts:bios            dry run — show who would get what
//   npm run contacts:bios -- apply   write the notes
//
// First run prompts for Contacts automation permission — click OK.
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { openDb } from "../main/db/db.ts";

const APPLY = process.argv.includes("apply");
const BLOCK_START = "―― POS ――";
const BLOCK_END = "―― /POS ――";

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

function jxa(script: string, arg?: string): string {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", script, ...(arg ? [arg] : [])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const DUMP = `
(() => {
  const app = Application("Contacts");
  const P = app.people;
  const out = { ids: P.id(), names: P.name(), notes: P.note(),
                phones: P.phones.value(), emails: P.emails.value() };
  return JSON.stringify(out);
})()`;

const APPLY_SCRIPT = `
function run(argv) {
  const updates = JSON.parse($.NSString.stringWithContentsOfFileEncodingError($(argv[0]), $.NSUTF8StringEncoding, null).js);
  const app = Application("Contacts");
  let done = 0;
  for (const u of updates) {
    const hits = app.people.whose({ id: u.id })();
    if (hits.length !== 1) continue;
    hits[0].note = u.note;
    done++;
  }
  app.save();
  return String(done);
}`;

const db = openDb(join(os.homedir(), "Library/Application Support/POS/pos.db"));
const people = db
  .prepare("SELECT id, display_name, bio FROM person WHERE bio IS NOT NULL AND bio != ''")
  .all() as { id: number; display_name: string; bio: string }[];
const aliases = db.prepare("SELECT person_id, kind, value FROM alias").all() as {
  person_id: number; kind: string; value: string;
}[];
const aliasByPerson = new Map<number, { phones: string[]; emails: string[] }>();
for (const a of aliases) {
  const e = aliasByPerson.get(a.person_id) ?? { phones: [], emails: [] };
  if (a.kind === "phone" || a.kind === "imessage_handle") {
    if (/\d/.test(a.value)) e.phones.push(norm10(a.value));
    else e.emails.push(a.value.toLowerCase()); // an email iMessage handle
  }
  if (a.kind === "email") e.emails.push(a.value.toLowerCase());
  aliasByPerson.set(a.person_id, e);
}

console.log(`POS people with bios: ${people.length}. Reading Apple Contacts…`);
const dump = JSON.parse(jxa(DUMP)) as {
  ids: string[]; names: string[]; notes: (string | null)[];
  phones: string[][]; emails: string[][];
};
console.log(`Apple contacts: ${dump.ids.length}`);

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
let matched = 0;
const unmatched: string[] = [];
for (const p of people) {
  const al = aliasByPerson.get(p.id) ?? { phones: [], emails: [] };
  let idx: number | undefined;
  for (const ph of al.phones) if ((idx = byPhone.get(ph)) !== undefined) break;
  if (idx === undefined) for (const em of al.emails) if ((idx = byEmail.get(em)) !== undefined) break;
  if (idx === undefined) {
    const hits = byName.get(normName(p.display_name)) ?? [];
    if (hits.length === 1) idx = hits[0]; // ambiguous names never match
  }
  if (idx === undefined) {
    unmatched.push(p.display_name);
    continue;
  }
  matched++;
  const next = spliceBlock(dump.notes[idx], p.bio);
  if ((dump.notes[idx] ?? "").trim() === next.trim()) continue; // already current
  updates.push({ id: dump.ids[idx], note: next });
  if (!APPLY) console.log(`  would update: ${p.display_name} → ${dump.names[idx]}`);
}

console.log(`matched=${matched} to-update=${updates.length} unmatched=${unmatched.length}`);
if (unmatched.length) console.log(`not in Apple Contacts: ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? "…" : ""}`);

if (APPLY && updates.length) {
  const f = join(os.tmpdir(), `pos-contact-notes-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify(updates));
  const done = jxa(APPLY_SCRIPT, f).trim();
  rmSync(f, { force: true });
  console.log(`Apple Contacts notes written: ${done}`);
} else if (!APPLY) {
  console.log("(dry run — pass 'apply' to write)");
}
