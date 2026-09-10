// Person merge (owner ask 2026-08-20): the same human can exist twice — a NAMED person from a
// note/import and a bare-number person auto-created from their texts (Luke Nettune vs
// +12149120031). Nothing can auto-join them without a shared key, so this is the explicit join:
// every row that referenced the duplicate is repointed at the survivor, the profile fields are
// combined (survivor's word wins; blanks fill from the duplicate; bio bullets union), and the
// duplicate row is deleted.

import type { Db } from "../db/db.ts";
import { splitBio, composeBio } from "./enrich.ts";

/** Every table with a person_id column (mirrors migrations.ts's REFERENCES person list). */
const PERSON_REF_TABLES = [
  "alias",
  "commitment",
  "dismissal",
  "draft",
  "enrichment_attempt",
  "interaction",
  "msg_plan",
  "person_group",
  "person_tag",
] as const;

export interface MergeResult {
  survivor: number;
  merged: number;
  moved: Record<string, number>;
}

/**
 * Merge `loserId` into `survivorId`. Survivor keeps its name/tier; org/role/bio-head fill from
 * the loser only when the survivor's are blank; bio bullets are unioned (dedup, order kept).
 * profile_embedding_meta (PRIMARY KEY person_id) for the loser is dropped: the
 * merged profile text changed, so its embedding is stale by definition and re-derives.
 */
export function mergePersons(db: Db, survivorId: number, loserId: number): MergeResult {
  if (survivorId === loserId) throw new Error("cannot merge a person into themselves");
  const survivor = db.prepare("SELECT * FROM person WHERE id = ?").get(survivorId) as Record<string, unknown> | undefined;
  const loser = db.prepare("SELECT * FROM person WHERE id = ?").get(loserId) as Record<string, unknown> | undefined;
  if (!survivor || !loser) throw new Error("both people must exist");

  const moved: Record<string, number> = {};
  const tx = db.transaction(() => {
    // Aliases move with the rest: UNIQUE(kind,value) is GLOBAL, so a value can only ever
    // belong to one person — the loser's aliases can never collide with the survivor's.
    for (const table of PERSON_REF_TABLES) {
      const r = db.prepare(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`).run(survivorId, loserId);
      if (r.changes > 0) moved[table] = r.changes;
    }
    db.prepare("DELETE FROM profile_embedding_meta WHERE person_id = ?").run(loserId);

    // Profile fields: survivor's word wins; blanks fill from the loser; bullets union.
    const sBio = splitBio((survivor.bio as string | null) ?? null);
    const lBio = splitBio((loser.bio as string | null) ?? null);
    const bullets = [...sBio.bullets];
    for (const b of lBio.bullets) if (!bullets.some((x) => x.toLowerCase() === b.toLowerCase())) bullets.push(b);
    const head = sBio.head || lBio.head;
    db.prepare(
      `UPDATE person SET
         bio = ?,
         org = coalesce(nullif(org, ''), ?),
         role = coalesce(nullif(role, ''), ?),
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(composeBio(head, bullets), loser.org ?? null, loser.role ?? null, survivorId);

    db.prepare("DELETE FROM person WHERE id = ?").run(loserId);
  });
  tx();

  return { survivor: survivorId, merged: loserId, moved };
}
