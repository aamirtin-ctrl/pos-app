// Profile embeddings for vector retrieval (ranking.ts). Gemini gemini-embedding-001 at 768
// dims into the sqlite-vec vec_profile virtual table. Best-effort: skips entirely without a
// GEMINI_API_KEY or when sqlite-vec failed to load — ranking then degrades to prefilter.

import { GoogleGenAI } from "@google/genai";
import type { Db } from "../db/db.ts";
import { hasVec } from "../db/db.ts";
import { recordCall } from "./meter.ts";
import type { SecretStore } from "../secrets.ts";

const MODEL = "gemini-embedding-001";
const DIMS = 768;

async function embedText(ai: GoogleGenAI, text: string): Promise<number[] | null> {
  const res = await ai.models.embedContent({
    model: MODEL,
    contents: text,
    config: { outputDimensionality: DIMS },
  });
  const values = res.embeddings?.[0]?.values;
  return values && values.length === DIMS ? values : null;
}

/** Query-side embedder for ranking.rank's `embedQuery` option. Null when unkeyed/unavailable. */
export function makeQueryEmbedder(
  db: Db,
  secrets: SecretStore
): ((text: string) => Promise<number[] | null>) | null {
  const key = secrets.get("GEMINI_API_KEY");
  if (!key || !hasVec()) return null;
  const ai = new GoogleGenAI({ apiKey: key });
  return async (text: string) => {
    try {
      const vec = await embedText(ai, text);
      if (vec) recordCall(db, "embeddings", MODEL, Math.ceil(text.length / 4), 0);
      return vec;
    } catch (e) {
      console.warn(`query embed failed: ${(e as Error).message}`);
      return null;
    }
  };
}

/**
 * Embed `${bio}\n${relationship_summary}` for every person whose profile changed since the
 * last embedding (or was never embedded). Upserts vec_profile (person_id rowid) and
 * profile_embedding_meta, meters cost. Returns {embedded: 0} when unkeyed or vec is absent.
 */
export async function embedProfiles(db: Db, secrets: SecretStore): Promise<{ embedded: number }> {
  const key = secrets.get("GEMINI_API_KEY");
  if (!key || !hasVec()) return { embedded: 0 };

  const stale = db
    .prepare(
      `SELECT p.id, p.bio, p.relationship_summary
       FROM person p
       LEFT JOIN profile_embedding_meta m ON m.person_id = p.id
       WHERE (p.bio IS NOT NULL OR p.relationship_summary IS NOT NULL)
         AND (m.person_id IS NULL OR p.updated_at > m.embedded_at)`
    )
    .all() as { id: number; bio: string | null; relationship_summary: string | null }[];
  if (stale.length === 0) return { embedded: 0 };

  const ai = new GoogleGenAI({ apiKey: key });
  const delVec = db.prepare("DELETE FROM vec_profile WHERE person_id = ?");
  const insVec = db.prepare("INSERT INTO vec_profile (person_id, embedding) VALUES (?, ?)");
  const upMeta = db.prepare(
    `INSERT INTO profile_embedding_meta (person_id, embedded_at) VALUES (?, datetime('now'))
     ON CONFLICT(person_id) DO UPDATE SET embedded_at = excluded.embedded_at`
  );

  let embedded = 0;
  for (const p of stale) {
    const text = `${p.bio ?? ""}\n${p.relationship_summary ?? ""}`.trim();
    if (!text) continue;
    try {
      const vec = await embedText(ai, text);
      if (!vec) continue;
      delVec.run(p.id);
      insVec.run(p.id, JSON.stringify(vec));
      upMeta.run(p.id);
      recordCall(db, "embeddings", MODEL, Math.ceil(text.length / 4), 0);
      embedded++;
    } catch (e) {
      console.warn(`embed person ${p.id} failed: ${(e as Error).message}`);
    }
  }
  return { embedded };
}
