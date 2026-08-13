// Review queue — the pos port of PersonalCRM2 lib/review.ts (GAP_REPORT #7, #8, #9).
// One place for the "unclear data" a human should resolve after a sync:
//
//   #8 New-contact triage   — people carrying the 'unverified' tag (connectors add it to
//                             auto-created unknown senders). Bulk keep / group / discard.
//   #9 Duplicate clustering — live people who look like the same human, with the fields
//                             that differ so the UI can say WHY, feeding the existing merge.
//   #7 Ambiguous identity   — handles that resolveHandle() reported as `ambiguous`
//                             (>1 candidate person). Connectors currently drop these
//                             silently; recordAmbiguous() is the hook that queues them.
//
// Storage note: the ambiguous queue lives in the existing `setting` table under
// `ambiguous:<kind>:<value>` keys holding JSON, NOT a new table. Migrations are
// append-only and shipped, and this data is small, transient (it is deleted the moment
// the user decides) and never joined against. The duplicate-cluster "not duplicates"
// dismissals use the same trick under `review:dupe:<ids>`.
//
// Nothing here imports crm/people.ts for writes except mergeCluster (read-only reuse of
// mergePeople); discardContacts writes its own DELETE so the triage path owns its
// semantics (hard delete: aliases/interactions/drafts cascade, commitments keep their
// rows with person_id nulled).

import type { Db } from "../db/db.ts";
import { getSetting, setSetting } from "../db/db.ts";
import { assignToGroup } from "./groups.ts";
import { mergePeople } from "./people.ts";
import { emailDomain, isGenericEmailDomain, normalizeName } from "./normalize.ts";
import { pendingNoteChunks, type NoteChunkItem } from "./notesglean.ts";
import { bulkAddressReason, isBulkDisplayName } from "../connectors/common.ts";

/** The tag connectors put on auto-created contacts (main/connectors/{imessage,gmail}.ts). */
export const UNVERIFIED_TAG = "unverified";

const AMBIGUOUS_PREFIX = "ambiguous:";
const DUPE_DISMISS_PREFIX = "review:dupe:";
/** Tier a kept contact is promoted to (connectors create them at 3 = archive). */
const KEPT_TIER = 2;

// ───────────────────────────── #8 new-contact triage ─────────────────────────────

export interface PendingContact {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  tier: number;
  created_at: string;
  /** Every alias handle we know, so the row can show "who is this, really". */
  handles: { kind: string; value: string }[];
  /** How much history is attached — 0 means nothing would be lost by discarding. */
  interactions: number;
  /** Newest message text (summary → subject → raw), trimmed for a one-line preview. */
  last_snippet: string | null;
  last_channel: string | null;
  last_at: string | null;
  groups: string[];
}

const SNIPPET_MAX = 140;

function snippet(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

function uniqueIds(ids: number[] | null | undefined): number[] {
  return [...new Set(ids ?? [])].filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * Everyone awaiting triage: the people carrying the `unverified` tag, newest first,
 * with their handles, interaction count and last message snippet.
 */
export function pendingContacts(db: Db): PendingContact[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.org, p.role, p.tier, p.created_at
         FROM person p
         JOIN person_tag t ON t.person_id = p.id AND t.tag = ?
        ORDER BY p.created_at DESC, p.id DESC`
    )
    .all(UNVERIFIED_TAG) as Omit<
    PendingContact,
    "handles" | "interactions" | "last_snippet" | "last_channel" | "last_at" | "groups"
  >[];
  if (rows.length === 0) return [];

  const handles = db.prepare("SELECT kind, value FROM alias WHERE person_id = ? ORDER BY kind, value");
  const count = db.prepare("SELECT COUNT(*) AS n FROM interaction WHERE person_id = ?");
  const last = db.prepare(
    `SELECT channel, occurred_at, subject, body_summary, body_raw
       FROM interaction WHERE person_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`
  );
  const groups = db.prepare(
    `SELECT g.name FROM person_group pg JOIN grp g ON g.id = pg.group_id
      WHERE pg.person_id = ? ORDER BY g.name`
  );

  return rows.map((p) => {
    const l = last.get(p.id) as
      | { channel: string; occurred_at: string | null; subject: string | null; body_summary: string | null; body_raw: string | null }
      | undefined;
    return {
      ...p,
      handles: handles.all(p.id) as { kind: string; value: string }[],
      interactions: (count.get(p.id) as { n: number }).n,
      last_snippet: l ? snippet(l.body_summary ?? l.subject ?? l.body_raw) : null,
      last_channel: l?.channel ?? null,
      last_at: l?.occurred_at ?? null,
      groups: (groups.all(p.id) as { name: string }[]).map((g) => g.name),
    };
  });
}

/**
 * Keep: this is a real person. Drops the `unverified` tag and promotes archive-tier
 * auto-creations to the normal network tier. Returns how many people changed.
 */
export function keepContacts(db: Db, ids: number[]): number {
  const list = uniqueIds(ids);
  if (list.length === 0) return 0;
  const untag = db.prepare("DELETE FROM person_tag WHERE person_id = ? AND tag = ?");
  const promote = db.prepare(
    `UPDATE person SET tier = ?, updated_at = datetime('now') WHERE id = ? AND tier > ?`
  );
  const run = db.transaction(() => {
    let n = 0;
    for (const id of list) {
      const removed = untag.run(id, UNVERIFIED_TAG).changes;
      const bumped = promote.run(KEPT_TIER, id, KEPT_TIER).changes;
      if (removed || bumped) n++;
    }
    return n;
  });
  return run();
}

/**
 * Discard: not a person worth keeping. Hard delete, written here rather than borrowed
 * from crm/people.ts so the triage path owns its own semantics. Aliases, interactions
 * and drafts cascade; commitments/msg_plans keep their rows with person_id nulled.
 */
export function discardContacts(db: Db, ids: number[]): number {
  const list = uniqueIds(ids);
  if (list.length === 0) return 0;
  const del = db.prepare("DELETE FROM person WHERE id = ?");
  const run = db.transaction(() => {
    let n = 0;
    for (const id of list) n += del.run(id).changes;
    return n;
  });
  return run();
}

/**
 * Add to a group and keep (matching the old app: filing a contact IS confirming it).
 * The group is created when new — see crm/groups.ts assignToGroup.
 */
export function groupContacts(db: Db, ids: number[], groupName: string): { added: number; kept: number } {
  const list = uniqueIds(ids);
  if (list.length === 0) return { added: 0, kept: 0 };
  const name = (groupName ?? "").trim();
  if (!name) throw new Error("group name is empty");
  const added = assignToGroup(db, list, name);
  return { added, kept: keepContacts(db, list) };
}

// ─────────────────── bulk-mail cleanup (what leaked before the gate) ───────────────────
// The mail connector only gained a header-based bulk gate on 2026-08-05. Everything the
// old local-part denylist let through is already sitting in the DB as `unverified`
// contacts with inbound-only email history: Half Baked, X, the NYT, Instagram, Alexa.
//
// This is a DELETE, so the qualifying test is deliberately narrow — three conditions,
// ALL required:
//   1. carries the `unverified` tag (never touches a contact a human confirmed);
//   2. has at least one interaction and EVERY interaction is an inbound mail-channel row
//      (one reply, one iMessage, one meeting → a real relationship, left alone);
//   3. looks bulk: every email alias matches bulkAddressReason, OR the display name is a
//      robot name, OR every stored subject is unmistakably newsletter/notification copy.
//
// DELETION POLICY (owner spec 2026-08-06): a person who has EVER exchanged an iMessage is
// never removed by anything automatic — only by the user clicking ✕ in Messaging (which
// calls crm/people.ts deletePerson) or by an explicit Discard in the review queue. That is
// enforced below as its own named condition (2a), not as a side effect of 2b, so it can't
// be weakened by accident when the channel list changes.

/**
 * Channels that count as email for condition 2b. Anything else — iMessage above all, but
 * also linkedin, slack, calendar — means a real conversation and disqualifies the person.
 */
const MAIL_CHANNELS = new Set(["gmail", "outlook", "email", "mail", "mailfile", "linkedin-email"]);

/**
 * Condition 2a, stated explicitly: any interaction on a non-mail channel makes this person
 * untouchable. `interaction.channel` for texts is always 'imessage' (see
 * main/connectors/imessage.ts and messaging.ts sendIMessage), so one text — in either
 * direction, however old — is enough to protect a contact forever.
 */
function hasNonMailInteraction(rows: { channel: string }[]): boolean {
  return rows.some((r) => !MAIL_CHANNELS.has(r.channel));
}

/**
 * Subject copy no human writes to one person. Only consulted when the address and name
 * were inconclusive, and only when EVERY stored subject matches.
 */
const BULK_SUBJECT =
  /(unsubscribe|newsletter|\bdigest\b|your (daily|weekly|monthly)\b|this week in\b|\d+% off|limited time|shop now|new arrivals|sale ends|order (confirmation|update|#)|your order|your receipt|invoice #|verify your (email|account)|confirm your (email|subscription|account)|reset your password|password reset|security alert|new sign-?in|we've updated our|terms of service|privacy policy|webinar|black friday|cyber monday|recommended for you|trending (now|today)|new (post|episode|video) from|liked your|started following|weekly recap|latest issue)/i;

export interface BulkPurgeCandidate {
  id: number;
  display_name: string;
  /** Which rule condemned them — surfaced so a surprising purge count is explainable. */
  reason: string;
  interactions: number;
}

/** The people purgeBulkContacts would delete, with the reason — the dry-run view. */
export function bulkContactCandidates(db: Db): BulkPurgeCandidate[] {
  const people = db
    .prepare(
      `SELECT p.id, p.display_name
         FROM person p
         JOIN person_tag t ON t.person_id = p.id AND t.tag = ?
        ORDER BY p.id`
    )
    .all(UNVERIFIED_TAG) as { id: number; display_name: string }[];
  if (people.length === 0) return [];

  const aliasesOf = db.prepare("SELECT kind, value FROM alias WHERE person_id = ?");
  const rowsOf = db.prepare(
    "SELECT channel, direction, subject, body_summary FROM interaction WHERE person_id = ?"
  );

  const out: BulkPurgeCandidate[] = [];
  for (const p of people) {
    const rows = rowsOf.all(p.id) as {
      channel: string;
      direction: string | null;
      subject: string | null;
      body_summary: string | null;
    }[];
    // Condition 2 — inbound email and nothing else. No history at all is NOT enough
    // evidence to delete somebody, so an empty list disqualifies too.
    if (rows.length === 0) continue;
    // 2a. Anyone he has ever texted with is off-limits, unconditionally.
    if (hasNonMailInteraction(rows)) continue;
    // 2b. Inbound only — a single reply of his own makes it a relationship.
    if (rows.some((r) => r.direction !== "inbound")) continue;

    // Condition 3 — address, then name, then subjects.
    const aliases = aliasesOf.all(p.id) as { kind: string; value: string }[];
    const emails = aliases.filter((a) => a.kind === "email").map((a) => a.value);
    const addressReasons = emails.map((e) => bulkAddressReason(e));
    let reason: string | null = null;
    if (emails.length > 0 && addressReasons.every((r) => r !== null)) {
      reason = addressReasons[0];
    } else if (isBulkDisplayName(p.display_name) || bulkAddressReason(p.display_name.trim())) {
      reason = `bulk-display-name:${p.display_name.trim()}`;
    } else {
      const subjects = rows.map((r) => (r.subject ?? "").trim()).filter(Boolean);
      if (subjects.length === rows.length && subjects.every((s) => BULK_SUBJECT.test(s))) {
        reason = "bulk-subjects";
      }
    }
    if (!reason) continue;
    out.push({ id: p.id, display_name: p.display_name, reason, interactions: rows.length });
  }
  return out;
}

/**
 * Delete the leaked newsletter contacts and their interactions (alias/interaction rows
 * cascade off person — see migration 1). Returns how many people were removed.
 */
export function purgeBulkContacts(db: Db): number {
  const candidates = bulkContactCandidates(db);
  if (candidates.length === 0) return 0;
  const del = db.prepare("DELETE FROM person WHERE id = ?");
  const run = db.transaction(() => {
    let n = 0;
    for (const c of candidates) n += del.run(c.id).changes;
    return n;
  });
  return run();
}

/** Setting key that makes the cleanup a one-shot — see purgeBulkContactsOnce. */
export const BULK_CLEANUP_SETTING = "cleanup_bulk_v1";

/**
 * One-shot wrapper for startup wiring (main/index.ts or main/workers.ts — NOT edited
 * here). Call it once after migrations run; the `cleanup_bulk_v1` setting makes every
 * later call a no-op, so re-running it on each boot is safe:
 *
 *     import { purgeBulkContactsOnce } from "./crm/review.ts";
 *     const { ran, purged } = purgeBulkContactsOnce(db);
 *     if (ran) console.log(`[cleanup] purged ${purged} bulk contacts`);
 */
export function purgeBulkContactsOnce(db: Db): { ran: boolean; purged: number } {
  if (getSetting(db, BULK_CLEANUP_SETTING)) return { ran: false, purged: 0 };
  const purged = purgeBulkContacts(db);
  setSetting(db, BULK_CLEANUP_SETTING, JSON.stringify({ at: new Date().toISOString(), purged }));
  return { ran: true, purged };
}

// ───────────────────────────── #9 duplicate clustering ─────────────────────────────

export interface DuplicateMember {
  id: number;
  display_name: string;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
  handles: string[];
  interactions: number;
  unverified: boolean;
}

export interface DuplicateCluster {
  /** Stable key over the member ids — also the "not duplicates" dismissal key. */
  key: string;
  /** high = every member's full name is identical; medium = first name + a corroborator. */
  confidence: "high" | "medium";
  /** Why these were bucketed together, e.g. ["same org (ZFellows)", "same last name"]. */
  reasons: string[];
  members: DuplicateMember[];
  /** Fields where the members disagree — what the UI shows to justify the suspicion. */
  differing: { field: string; values: (string | null)[] }[];
}

interface ClusterPerson {
  id: number;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  org: string | null;
  role: string | null;
  location: string | null;
  tier: number;
  last_contact_at: string | null;
}

function firstNameKey(p: ClusterPerson): string {
  const given = (p.given_name ?? "").trim();
  const source = given || p.display_name;
  return normalizeName(source).split(" ")[0] ?? "";
}

function lastNameKey(p: ClusterPerson): string {
  const family = (p.family_name ?? "").trim();
  if (family) return normalizeName(family);
  const parts = normalizeName(p.display_name).split(" ").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

const orgKey = (p: ClusterPerson) => (p.org ?? "").trim().toLowerCase();

/** Cluster key: the member ids, sorted, joined — stable across reloads and reorderings. */
export function clusterKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join("-");
}

const DIFF_FIELDS: { field: string; of: (m: DuplicateMember) => string | null }[] = [
  { field: "name", of: (m) => m.display_name },
  { field: "org", of: (m) => m.org },
  { field: "role", of: (m) => m.role },
  { field: "location", of: (m) => m.location },
  { field: "handles", of: (m) => (m.handles.length ? m.handles.join(", ") : null) },
  { field: "last contact", of: (m) => (m.last_contact_at ? m.last_contact_at.slice(0, 10) : null) },
];

/**
 * Possible duplicates: live people sharing a normalized FIRST name AND at least one
 * corroborator — same org, a shared (non-generic) email domain, or the same last name.
 * First name alone is never enough, mirroring identity.ts's "a wrong link is worse than
 * no link". Clusters of 2+ only; exact full-name matches rank as high confidence and
 * come first. Clusters the user dismissed as "not duplicates" are filtered out.
 */
export function duplicateClusters(db: Db): DuplicateCluster[] {
  const people = db
    .prepare(
      `SELECT id, display_name, given_name, family_name, org, role, location, tier, last_contact_at
         FROM person ORDER BY id`
    )
    .all() as ClusterPerson[];
  if (people.length < 2) return [];

  // Non-generic email domains per person (gmail.com & friends corroborate nothing).
  const domains = new Map<number, Set<string>>();
  const allHandles = new Map<number, string[]>();
  for (const a of db.prepare("SELECT person_id, kind, value FROM alias ORDER BY kind, value").all() as {
    person_id: number;
    kind: string;
    value: string;
  }[]) {
    const list = allHandles.get(a.person_id) ?? [];
    list.push(a.value);
    allHandles.set(a.person_id, list);
    if (a.kind !== "email") continue;
    const d = emailDomain(a.value);
    if (!d || isGenericEmailDomain(d)) continue;
    const set = domains.get(a.person_id) ?? new Set<string>();
    set.add(d);
    domains.set(a.person_id, set);
  }

  const buckets = new Map<string, ClusterPerson[]>();
  for (const p of people) {
    const key = firstNameKey(p);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(p);
    buckets.set(key, list);
  }

  const interactionCounts = new Map<number, number>(
    (
      db.prepare("SELECT person_id, COUNT(*) AS n FROM interaction GROUP BY person_id").all() as {
        person_id: number;
        n: number;
      }[]
    ).map((r) => [r.person_id, r.n])
  );
  const unverifiedIds = new Set(
    (db.prepare("SELECT person_id FROM person_tag WHERE tag = ?").all(UNVERIFIED_TAG) as {
      person_id: number;
    }[]).map((r) => r.person_id)
  );

  const out: DuplicateCluster[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue;

    // Union-find over the bucket: only linked pairs (first name + a corroborator) merge.
    const parent = new Map<number, number>(group.map((p) => [p.id, p.id]));
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const next = parent.get(x)!;
        parent.set(x, r);
        x = next;
      }
      return r;
    };
    const reasonsByRoot = new Map<number, Set<string>>();
    const noteReason = (root: number, reason: string) => {
      const set = reasonsByRoot.get(root) ?? new Set<string>();
      set.add(reason);
      reasonsByRoot.set(root, set);
    };
    const pending: { a: number; b: number; reasons: string[] }[] = [];

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const why: string[] = [];
        if (orgKey(a) && orgKey(a) === orgKey(b)) why.push(`same org (${a.org!.trim()})`);
        const shared = [...(domains.get(a.id) ?? [])].filter((d) => domains.get(b.id)?.has(d));
        if (shared.length) why.push(`shared email domain (${shared.join(", ")})`);
        if (lastNameKey(a) && lastNameKey(a) === lastNameKey(b)) why.push("same last name");
        if (why.length === 0) continue;
        const ra = find(a.id);
        const rb = find(b.id);
        if (ra !== rb) parent.set(rb, ra);
        pending.push({ a: a.id, b: b.id, reasons: why });
      }
    }
    // Reasons are attributed after every union so they land on the final root.
    for (const link of pending) for (const r of link.reasons) noteReason(find(link.a), r);

    const clusters = new Map<number, ClusterPerson[]>();
    for (const p of group) {
      const root = find(p.id);
      const list = clusters.get(root) ?? [];
      list.push(p);
      clusters.set(root, list);
    }

    for (const [root, membersRaw] of clusters) {
      if (membersRaw.length < 2) continue;
      const members: DuplicateMember[] = membersRaw.map((p) => ({
        id: p.id,
        display_name: p.display_name,
        org: p.org,
        role: p.role,
        location: p.location,
        tier: p.tier,
        last_contact_at: p.last_contact_at,
        handles: allHandles.get(p.id) ?? [],
        interactions: interactionCounts.get(p.id) ?? 0,
        unverified: unverifiedIds.has(p.id),
      }));
      const names = new Set(membersRaw.map((p) => normalizeName(p.display_name)));
      const differing = DIFF_FIELDS.map(({ field, of }) => ({
        field,
        values: members.map(of),
      })).filter((d) => new Set(d.values.map((v) => v ?? "")).size > 1);
      out.push({
        key: clusterKey(members.map((m) => m.id)),
        confidence: names.size === 1 ? "high" : "medium",
        reasons: [...(reasonsByRoot.get(root) ?? [])],
        members,
        differing,
      });
    }
  }

  const dismissed = new Set(
    (db.prepare("SELECT key FROM setting WHERE key LIKE ?").all(`${DUPE_DISMISS_PREFIX}%`) as {
      key: string;
    }[]).map((r) => r.key.slice(DUPE_DISMISS_PREFIX.length))
  );

  return out
    .filter((c) => !dismissed.has(c.key))
    .sort(
      (a, b) =>
        (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
        b.members.length - a.members.length ||
        a.members[0].display_name.localeCompare(b.members[0].display_name)
    );
}

/** "Not duplicates" — remember the verdict so the cluster stops coming back. */
export function dismissDuplicates(db: Db, key: string): boolean {
  const k = (key ?? "").trim();
  if (!k) return false;
  setSetting(db, `${DUPE_DISMISS_PREFIX}${k}`, new Date().toISOString());
  return true;
}

/**
 * Merge a suspected-duplicate cluster into one person (crm/people.ts mergePeople picks
 * the richest survivor and backfills), then clear the survivor's `unverified` tag —
 * a merge is a decision, so the result never re-enters triage.
 */
export function mergeCluster(db: Db, ids: number[]): number | null {
  const list = uniqueIds(ids);
  if (list.length < 2) return null;
  const kept = mergePeople(db, list);
  if (kept != null) keepContacts(db, [kept]);
  return kept;
}

// ───────────────────────────── #7 ambiguous identity ─────────────────────────────

export interface AmbiguousInput {
  /** alias kind the handle would be written as: email | phone | imessage_handle | linkedin … */
  handleKind: string;
  /** NORMALIZED handle value (the caller normalizes; this is what the alias row will hold). */
  handleValue: string;
  /** Display name the source used, when it had one. */
  name?: string | null;
  /** The person ids resolveHandle() could not choose between. */
  candidateIds: number[];
  /** A line of the message, so the user can recognize the conversation. */
  sampleText?: string | null;
}

interface AmbiguousStored {
  handleKind: string;
  handleValue: string;
  name: string | null;
  candidateIds: number[];
  sampleText: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many rows hit this same handle — one decision covers all of them. */
  hits: number;
}

export interface AmbiguousItem extends Omit<AmbiguousStored, "candidateIds"> {
  key: string;
  candidates: { id: number; display_name: string; org: string | null; role: string | null }[];
}

/** The setting key for one ambiguous handle. Same handle → same key → one decision. */
export function ambiguousKey(handleKind: string, handleValue: string): string {
  return `${AMBIGUOUS_PREFIX}${handleKind.trim().toLowerCase()}:${handleValue.trim().toLowerCase()}`;
}

/**
 * CONNECTOR HOOK (currently unwired — see the report / GAP_REPORT #7).
 *
 * Every connector (connectors/{imessage,gmail,linkedin,linkedin-email,mailfile}.ts)
 * calls resolveHandle() and, when the outcome is `{ status: "ambiguous", candidateIds }`,
 * silently skips the row. Call this instead at that exact branch:
 *
 *     const r = resolveHandle(db, handle);
 *     if (r.status === "ambiguous") {
 *       recordAmbiguous(db, {
 *         handleKind: "email",              // the alias kind this handle would become
 *         handleValue: normalizeEmail(from)!.norm,
 *         name: fromName,
 *         candidateIds: r.candidateIds ?? [],
 *         sampleText: subject ?? body,
 *       });
 *       continue;                            // still skip the row — the user decides later
 *     }
 *
 * Repeat calls for the same handle collapse onto one queue entry (candidate union,
 * hit counter, first sample text kept) so 40 texts from one unknown number are ONE
 * decision. Writing is cheap and idempotent; nothing here mutates person/alias.
 */
export function recordAmbiguous(db: Db, input: AmbiguousInput): { key: string; hits: number } | null {
  const kind = (input.handleKind ?? "").trim();
  const value = (input.handleValue ?? "").trim();
  const candidates = uniqueIds(input.candidateIds);
  if (!kind || !value || candidates.length === 0) return null;

  const key = ambiguousKey(kind, value);
  const now = new Date().toISOString();
  const prev = readAmbiguous(db, key);
  const candidateIds = [...new Set([...(prev?.candidateIds ?? []), ...candidates])];
  // A queue entry the user cannot act on is noise — a decision needs 2+ candidates.
  // (Counted across repeats: a later row may only carry one of the two.)
  if (candidateIds.length < 2) return null;

  const merged: AmbiguousStored = {
    handleKind: kind,
    handleValue: value,
    name: input.name?.trim() || prev?.name || null,
    candidateIds,
    sampleText: prev?.sampleText ?? snippet(input.sampleText),
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastSeenAt: now,
    hits: (prev?.hits ?? 0) + 1,
  };
  setSetting(db, key, JSON.stringify(merged));
  return { key, hits: merged.hits };
}

function readAmbiguous(db: Db, key: string): AmbiguousStored | null {
  const raw = getSetting(db, key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AmbiguousStored>;
    if (!v || typeof v.handleValue !== "string") return null;
    return {
      handleKind: v.handleKind ?? "",
      handleValue: v.handleValue,
      name: v.name ?? null,
      candidateIds: uniqueIds(v.candidateIds as number[] | undefined),
      sampleText: v.sampleText ?? null,
      firstSeenAt: v.firstSeenAt ?? "",
      lastSeenAt: v.lastSeenAt ?? v.firstSeenAt ?? "",
      hits: v.hits ?? 1,
    };
  } catch {
    return null; // corrupt JSON: treat as absent rather than blowing up the queue
  }
}

/**
 * The queue, newest first, with candidate ids resolved to live people. Entries whose
 * candidates no longer exist (merged/deleted since) drop out — with fewer than two
 * real candidates there is nothing to choose between.
 */
export function pendingAmbiguous(db: Db): AmbiguousItem[] {
  const rows = db.prepare("SELECT key, value FROM setting WHERE key LIKE ? ORDER BY key").all(
    `${AMBIGUOUS_PREFIX}%`
  ) as { key: string; value: string }[];
  if (rows.length === 0) return [];

  const person = db.prepare("SELECT id, display_name, org, role FROM person WHERE id = ?");
  const out: AmbiguousItem[] = [];
  for (const r of rows) {
    const stored = readAmbiguous(db, r.key);
    if (!stored) continue;
    const candidates = stored.candidateIds
      .map((id) => person.get(id) as AmbiguousItem["candidates"][number] | undefined)
      .filter((p): p is AmbiguousItem["candidates"][number] => !!p);
    if (candidates.length < 2) continue;
    const { candidateIds: _drop, ...rest } = stored;
    out.push({ key: r.key, ...rest, candidates });
  }
  return out.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}

/**
 * "It's this one": attach the handle to the chosen person as an alias and clear the
 * entry. INSERT OR IGNORE respects alias's UNIQUE(kind, value) — if the handle was
 * claimed in the meantime the decision still closes rather than throwing.
 */
export function resolveAmbiguous(
  db: Db,
  key: string,
  personId: number
): { resolved: boolean; attached: boolean } {
  if (!key.startsWith(AMBIGUOUS_PREFIX)) throw new Error("not an ambiguous queue key");
  const stored = readAmbiguous(db, key);
  if (!stored) return { resolved: false, attached: false };
  const exists = db.prepare("SELECT 1 FROM person WHERE id = ?").get(personId);
  if (!exists) throw new Error(`person ${personId} not found`);

  const run = db.transaction(() => {
    const res = db
      .prepare(
        "INSERT OR IGNORE INTO alias (person_id, kind, value, confidence, source) VALUES (?, ?, ?, 1.0, 'review')"
      )
      .run(personId, stored.handleKind, stored.handleValue);
    db.prepare("DELETE FROM setting WHERE key = ?").run(key);
    return res.changes > 0;
  });
  return { resolved: true, attached: run() };
}

/** "None of these" — forget the entry without touching anybody's aliases. */
export function dismissAmbiguous(db: Db, key: string): boolean {
  if (!key.startsWith(AMBIGUOUS_PREFIX)) throw new Error("not an ambiguous queue key");
  return db.prepare("DELETE FROM setting WHERE key = ?").run(key).changes > 0;
}

// ───────────────────────────── the queue as one payload ─────────────────────────────

export interface ReviewQueue {
  contacts: PendingContact[];
  duplicates: DuplicateCluster[];
  ambiguous: AmbiguousItem[];
  /** Note chunks the Apple Notes gleaner could not attribute (crm/notesglean.ts). */
  notes: NoteChunkItem[];
  counts: { contacts: number; duplicates: number; ambiguous: number; notes: number; total: number };
}

/** Everything the Review modal (and its count badge) needs, in one IPC round-trip. */
export function reviewQueue(db: Db): ReviewQueue {
  const contacts = pendingContacts(db);
  const duplicates = duplicateClusters(db);
  const ambiguous = pendingAmbiguous(db);
  const notes = pendingNoteChunks(db);
  return {
    contacts,
    duplicates,
    ambiguous,
    notes,
    counts: {
      contacts: contacts.length,
      duplicates: duplicates.length,
      ambiguous: ambiguous.length,
      notes: notes.length,
      total: contacts.length + duplicates.length + ambiguous.length + notes.length,
    },
  };
}
