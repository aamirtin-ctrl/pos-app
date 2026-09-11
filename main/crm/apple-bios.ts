// Mirror POS person bios into Apple Contacts (owner asks 2026-08-20 and 2026-09-11).
//
// 2026-08-20: bios "should also be reflected in my apple contacts"; people the Mac doesn't
// know get cards CREATED (name + handles + bio) — which also teaches iMessage their names.
// 2026-09-11: inferred-name people MAY get cards too, but the note's last line must read
// "Inferred by POS" so the card can never pass for user-made; a USER EDIT of that card
// (any change — name, number, note) is the verification signal; and a card the user
// DELETES deletes the corresponding POS person.
//
// The edit/delete signals need an exact link, not a guess, so every card POS creates or
// matches is recorded on the person (apple_card_id) together with the time POS last wrote
// it (apple_card_written_at). A card whose modificationDate is later than that write —
// with slack for save latency — was touched by the user. POS refreshes the stamp on every
// write of its own, so its own updates never read as user edits.
//
// Matching: phone (last 10) → email → unique normalized name. Bios live inside a managed
// ―― POS ―― block so owner-typed note text survives; re-runs replace only the block.
// Bare-number "names" are never created, and a name matching MULTIPLE cards is left alone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { Db } from "../db/db.ts";

const run = promisify(execFile);

export const BLOCK_START = "―― POS ――";
export const BLOCK_END = "―― /POS ――";
/** Last line of the managed block on any card whose name is still an LLM guess. */
export const INFERRED_MARKER = "Inferred by POS";

/** modificationDate later than this many ms past POS's own write = the user edited. */
const EDIT_SLACK_MS = 120_000;

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

/** The block body: the bio, and — for a still-inferred person — the marker as last line. */
export function composeCardBio(bio: string | null, inferred: boolean): string {
  const b = (bio ?? "").trim();
  if (!inferred) return b;
  return b ? `${b}\n\n${INFERRED_MARKER}` : INFERRED_MARKER;
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

/**
 * Did the user touch this card since POS last wrote it? Conservative: with no recorded
 * write time there is nothing to compare against, so the answer is no.
 */
export function wasUserEdited(modifiedISO: string | null, writtenISO: string | null): boolean {
  if (!modifiedISO || !writtenISO) return false;
  const m = Date.parse(modifiedISO);
  const w = Date.parse(writtenISO);
  if (Number.isNaN(m) || Number.isNaN(w)) return false;
  return m > w + EDIT_SLACK_MS;
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
                phones: P.phones.value(), emails: P.emails.value(),
                modified: P.modificationDate() };
  return JSON.stringify(out);
})()`;

// One pass applies both kinds of change. Updates go by id; creates build a full card and
// report the new card's id back, paired with the POS person id that asked for it.
const APPLY_SCRIPT = `
function run(argv) {
  const payload = JSON.parse($.NSString.stringWithContentsOfFileEncodingError($(argv[0]), $.NSUTF8StringEncoding, null).js);
  const app = Application("Contacts");
  let updated = 0;
  for (const u of payload.updates) {
    const hits = app.people.whose({ id: u.id })();
    if (hits.length !== 1) continue;
    hits[0].note = u.note;
    updated++;
  }
  const made = [];
  for (const c of payload.creates) {
    const p = app.Person({ firstName: c.first, lastName: c.last, note: c.note });
    app.people.push(p);
    for (const ph of c.phones) p.phones.push(app.Phone({ label: "mobile", value: ph }));
    for (const em of c.emails) p.emails.push(app.Email({ label: "home", value: em }));
    made.push({ personId: c.personId, obj: p });
  }
  app.save();
  const created = made.map((m) => ({ personId: m.personId, cardId: m.obj.id() }));
  return JSON.stringify({ updated, created });
}`;

export interface AppleBioSyncResult {
  matched: number;
  updated: number;
  created: number;
  ambiguous: string[];
  skippedUncreatable: number;
  /** POS people deleted because the user deleted their Apple card. */
  deletedMirrored: number;
  /** Inferred people verified because the user edited their POS-made card. */
  verifiedByEdit: number;
}

/**
 * The whole mirror: read POS people, read Apple Contacts in bulk, mirror card deletions
 * and user-edit verifications back, update matched cards' managed blocks, create the rest.
 * `apply: false` reports without writing anywhere (Contacts OR the POS db).
 */
export async function syncAppleContactBios(
  db: Db,
  opts: { apply: boolean; create?: boolean }
): Promise<AppleBioSyncResult> {
  const create = opts.create ?? true;
  const out: AppleBioSyncResult = {
    matched: 0, updated: 0, created: 0, ambiguous: [], skippedUncreatable: 0,
    deletedMirrored: 0, verifiedByEdit: 0,
  };

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
    phones: string[][]; emails: string[][]; modified: (string | null)[];
  };

  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();
  const byName = new Map<string, number[]>();
  const byCardId = new Map<string, number>();
  for (let i = 0; i < dump.ids.length; i++) {
    byCardId.set(dump.ids[i], i);
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

  const aliasIdx = (personId: number): number | undefined => {
    const al = aliasByPerson.get(personId) ?? { phones: [], emails: [] };
    for (const ph of al.phones) {
      const i = byPhone.get(norm10(ph));
      if (i !== undefined) return i;
    }
    for (const em of al.emails) {
      const i = byEmail.get(em);
      if (i !== undefined) return i;
    }
    return undefined;
  };

  // ── card-link maintenance: deletions mirror back, user edits verify ────────
  // Guard: an EMPTY dump means Contacts couldn't be read, not that the user deleted
  // every card — a failed read must never cascade into deleting POS people.
  if (dump.ids.length > 0) {
    const linked = db
      .prepare(
        `SELECT id, display_name, name_inferred_at, apple_card_id, apple_card_written_at
         FROM person WHERE apple_card_id IS NOT NULL`
      )
      .all() as {
      id: number; display_name: string; name_inferred_at: string | null;
      apple_card_id: string; apple_card_written_at: string | null;
    }[];
    for (const p of linked) {
      const idx = byCardId.get(p.apple_card_id);
      if (idx === undefined) {
        // Card gone. If some OTHER card still carries their handle, Contacts merely
        // re-identified it (iCloud merge) — relink below. Otherwise the user deleted
        // the contact, and the POS person goes with it (owner ask 2026-09-11).
        if (aliasIdx(p.id) !== undefined) {
          if (opts.apply) {
            db.prepare(
              "UPDATE person SET apple_card_id = NULL, apple_card_written_at = NULL WHERE id = ?"
            ).run(p.id);
          }
          continue;
        }
        if (opts.apply) db.prepare("DELETE FROM person WHERE id = ?").run(p.id);
        out.deletedMirrored++;
        continue;
      }
      // Card present. A user edit on a still-inferred person's card is verification:
      // adopt the card's (possibly corrected) name, drop the guess state.
      if (p.name_inferred_at && wasUserEdited(dump.modified[idx], p.apple_card_written_at)) {
        const cardName = (dump.names[idx] ?? "").trim();
        if (opts.apply) {
          db.prepare(
            `UPDATE person SET display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
               name_inferred_at = NULL, updated_at = datetime('now') WHERE id = ?`
          ).run(cardName, cardName, p.id);
          db.prepare("DELETE FROM person_tag WHERE person_id = ? AND tag = 'unverified'").run(p.id);
        }
        out.verifiedByEdit++;
      }
    }
  }

  // ── bios pass: people with a bio, plus inferred people (their card carries the marker
  //    even before any bio is mined, so iMessage learns the name and the flag is visible).
  const people = db
    .prepare(
      `SELECT id, display_name, bio, name_inferred_at, apple_card_id FROM person
       WHERE (bio IS NOT NULL AND bio != '') OR name_inferred_at IS NOT NULL`
    )
    .all() as {
    id: number; display_name: string; bio: string | null;
    name_inferred_at: string | null; apple_card_id: string | null;
  }[];

  const updates: { id: string; personId: number; note: string }[] = [];
  const creates: { personId: number; first: string; last: string; note: string; phones: string[]; emails: string[] }[] = [];

  for (const p of people) {
    const al = aliasByPerson.get(p.id) ?? { phones: [], emails: [] };
    let idx = p.apple_card_id !== null ? byCardId.get(p.apple_card_id) : undefined;
    if (idx === undefined) idx = aliasIdx(p.id);
    const nameHits = byName.get(normName(p.display_name)) ?? [];
    if (idx === undefined && nameHits.length === 1) idx = nameHits[0];

    const body = composeCardBio(p.bio, p.name_inferred_at !== null);
    if (idx !== undefined) {
      out.matched++;
      if (opts.apply && p.apple_card_id !== dump.ids[idx]) {
        db.prepare("UPDATE person SET apple_card_id = ? WHERE id = ?").run(dump.ids[idx], p.id);
      }
      if (!body) continue; // nothing to write into the block
      const next = spliceBlock(dump.notes[idx], body);
      if ((dump.notes[idx] ?? "").trim() !== next.trim()) {
        updates.push({ id: dump.ids[idx], personId: p.id, note: next });
      }
      continue;
    }
    if (nameHits.length > 1) {
      out.ambiguous.push(p.display_name); // several cards share the name — a human call
      continue;
    }
    if (!create) continue;
    if (!isCreatableName(p.display_name)) {
      out.skippedUncreatable++;
      continue;
    }
    const { first, last } = splitName(p.display_name);
    creates.push({ personId: p.id, first, last, note: spliceBlock(null, body), phones: al.phones, emails: al.emails });
  }

  if (opts.apply && (updates.length || creates.length)) {
    const f = join(os.tmpdir(), `pos-apple-bios-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ updates, creates }));
    try {
      const res = JSON.parse((await jxa(APPLY_SCRIPT, f)).trim()) as {
        updated: number; created: { personId: number; cardId: string }[];
      };
      out.updated = res.updated;
      out.created = res.created.length;
      const stamp = db.prepare(
        "UPDATE person SET apple_card_id = ?, apple_card_written_at = datetime('now') WHERE id = ?"
      );
      for (const u of updates) stamp.run(u.id, u.personId);
      for (const c of res.created) stamp.run(c.cardId, c.personId);
    } finally {
      rmSync(f, { force: true });
    }
  } else {
    out.updated = updates.length;
    out.created = creates.length;
  }
  return out;
}
