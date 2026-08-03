// Identity resolution (ported from PersonalCRM2 lib/identity.ts — Doc 1 §6). Maps a raw
// handle bundle to exactly ONE person, or flags it unmatched/ambiguous for the user. A wrong
// link is worse than no link (it corrupts a real person's history), so: identifier matches
// are exact; name matches require a corroborator; multiple candidates are NEVER auto-picked.
//
// Adaptation vs source: PersonalCRM2 resolved Prisma staging rows; here we resolve a plain
// handle object against the `alias` table (UNIQUE(kind, value)) with prepared statements.

import type { Db } from "../db/db.ts";
import {
  normalizeEmail,
  normalizePhone,
  normalizeLinkedin,
  normalizeName,
  emailDomain,
  isGenericEmailDomain,
} from "./normalize.ts";

export type MatchStatus = "matched" | "ambiguous" | "unmatched";

export interface HandleInput {
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  name?: string | null;
  /** Org/company hint from the source (e.g. email signature, LinkedIn) — the Layer-2 corroborator. */
  org?: string | null;
}

export interface ResolveOutcome {
  status: MatchStatus;
  personId?: number;
  candidateIds?: number[]; // populated when ambiguous
  matchedBy?: "email" | "phone" | "linkedin" | "name+corroborator";
}

/** Look up a person by an exact normalized identifier (UNIQUE(kind, value) → 0 or 1 hit). */
function byIdentifier(db: Db, kinds: string[], valueNorm: string): number | null {
  const row = db
    .prepare(
      `SELECT person_id FROM alias WHERE value = ? AND kind IN (${kinds.map(() => "?").join(",")}) LIMIT 1`
    )
    .get(valueNorm, ...kinds) as { person_id: number } | undefined;
  return row?.person_id ?? null;
}

/**
 * Resolve one handle bundle through the cascade. Pure read — does not write.
 * Cascade: exact email → exact phone → exact linkedin → name + corroborator.
 * Name alone NEVER matches; >1 candidate → ambiguous.
 */
export function resolveHandle(db: Db, input: HandleInput): ResolveOutcome {
  // 1–3: exact normalized identifier matches (strongest, unambiguous by UNIQUE).
  const email = normalizeEmail(input.email);
  if (email) {
    const id = byIdentifier(db, ["email"], email.norm);
    if (id) return { status: "matched", personId: id, matchedBy: "email" };
  }
  const phone = normalizePhone(input.phone);
  if (phone) {
    // iMessage handles are phone numbers in E.164 — same identifier space.
    const id = byIdentifier(db, ["phone", "imessage_handle"], phone.norm);
    if (id) return { status: "matched", personId: id, matchedBy: "phone" };
  }
  const linkedin = normalizeLinkedin(input.linkedin);
  if (linkedin) {
    const id = byIdentifier(db, ["linkedin"], linkedin.norm);
    if (id) return { status: "matched", personId: id, matchedBy: "linkedin" };
  }

  // 4: name + corroborator. Name alone is NEVER sufficient.
  if (input.name) {
    const nameKey = normalizeName(input.name);
    if (nameKey) {
      // Domain only corroborates when it's a real org domain — a shared consumer
      // provider (gmail.com, etc.) does NOT distinguish two same-named people.
      const rawDomain = email ? emailDomain(email.raw) : null;
      const domain = rawDomain && !isGenericEmailDomain(rawDomain) ? rawDomain : null;
      const inputOrg = input.org?.trim().toLowerCase() || null;

      // Candidate persons sharing the normalized name (small personal-CRM scale: filter in JS
      // so name normalization stays byte-identical with the source).
      const sameName = (
        db.prepare("SELECT id, display_name, org FROM person").all() as {
          id: number;
          display_name: string;
          org: string | null;
        }[]
      ).filter((p) => normalizeName(p.display_name) === nameKey);

      if (sameName.length > 0) {
        const emailAliases = db.prepare(
          "SELECT value FROM alias WHERE person_id = ? AND kind = 'email'"
        );
        const corroborated = sameName.filter((p) => {
          const orgMatch = inputOrg && p.org ? p.org.trim().toLowerCase() === inputOrg : false;
          const domainMatch =
            domain !== null &&
            (emailAliases.all(p.id) as { value: string }[]).some(
              (a) => emailDomain(a.value) === domain
            );
          return orgMatch || domainMatch;
        });

        if (corroborated.length === 1) {
          return { status: "matched", personId: corroborated[0].id, matchedBy: "name+corroborator" };
        }
        if (corroborated.length > 1) {
          // Multiple corroborated candidates → ambiguous, let the user pick.
          return { status: "ambiguous", candidateIds: corroborated.map((p) => p.id) };
        }
        // Name matched but no corroborator. If several share the name, surface them
        // as ambiguous candidates; a lone uncorroborated name stays unmatched.
        if (sameName.length > 1) {
          return { status: "ambiguous", candidateIds: sameName.map((p) => p.id) };
        }
      }
    }
  }

  // 5: no confident match.
  return { status: "unmatched" };
}
