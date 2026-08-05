# Feature-parity gap audit — PersonalCRM2 → pos

Old app: `PersonalCRM2` (Next.js + Postgres, per `HANDOFF.md`). New app: `pos` (Electron + SQLite).
Status: **PRESENT** (works, where) / **PARTIAL** (exists but missing pieces) / **MISSING** (no equivalent).
Effort = S (<½ day), M (1–2 days), L (3+ days).

| # | Feature (old) | Status | Detail | Effort |
|---|---|---|---|---|
| 1 | Contact merge UX (shift-select → Merge bar) | PARTIAL | UI present: checkbox multi-select → floating "Merge N" bar (`renderer/src/relationships/Contacts.tsx`), backend `mergePeople` (`main/crm/people.ts`). But semantics are weaker than `lib/merge.ts`: survivor = **lowest id** (old: richest record), no field backfill (org/role/email gaps not filled from the losers), no notes concat / tag union kept only via sidecar moves, losers **hard-deleted** (old: soft-delete). | S–M |
| 2 | Group creation from UI | PARTIAL | No explicit "create group" control. `groups.create` IPC exists but nothing calls it; groups come into existence only implicitly via ContactDetail's "add to group…" input (`groups.assign` upserts). No sidebar list w/ counts, no drag-drop assign. | S |
| 3 | Group assign / remove per contact | PRESENT | ContactDetail chips: add via input, remove via ×; `groups.assign` / `groups.remove` in `main/ipc.ts`. Bulk assign (multi-select → group) is missing. | — |
| 4 | Group hide | PARTIAL | `groups.hide` IPC sets `grp.hidden`, but **no UI calls it**; hidden groups are only excluded from filter chips (`Contacts.tsx`). | S |
| 5 | Hide-with-contacts (archive members) | MISSING | `grp.hide_contacts` column exists (migrated by `scripts/migrate-from-postgres.ts`) but is **never enforced** — no `hiddenAt` equivalent, members of hidden-with-contacts groups still appear in every list/query (old: `reconcileHiddenContacts` + `hiddenAt: null` filter everywhere). | M |
| 6 | Suppress-followups toggle per group | PARTIAL | Enforced: `reconnectDue` excludes members of `suppress_follow_ups=1` groups (`main/crm/reconnect.ts`). But the flag is **write-only via migration** — no UI, IPC, or assistant path to set/unset it. | S |
| 7 | ReviewModal: ambiguous-identity resolution | MISSING | `resolveHandle` returns `ambiguous` + candidateIds (`main/crm/identity.ts`), but every connector (imessage/linkedin/gmail/linkedin-email/mailfile) just **skips** ambiguous rows — nothing is queued, no picker UI. Old: staging rows + candidate buttons, resolution applied to all rows with the same counterpart. | M–L |
| 8 | ReviewModal: new-contact triage (bulk keep/group/discard) | PARTIAL | Replacement is the `unverified` tag: unknown senders become tier-3 contacts, "Unverified" chip filter + per-row hover ✕ delete (`Contacts.tsx`). No auto-opening review queue, no bulk keep/group/discard/merge, no interaction counts, no ⌘/shift multi-select actions beyond merge. | M |
| 9 | ReviewModal: duplicate clustering (same first name flagged) | MISSING | No "possible duplicate" detection or clustering anywhere in pos. | S–M |
| 10 | QuickNote popup ("met today" bump + note→follow-up detection) | PARTIAL | Assistant "note about Sarah: …" appends to bio (`main/assistant.ts` add_note) — but `last_contact_at` only `COALESCE`s (set when never-contacted, **no bump** to today), no "I just met them" checkbox, no follow-up detection on the note, no dedicated popup w/ contact combobox. | M |
| 11 | About-save extraction (note save → detected follow-up + "set last contact today?" toast) | MISSING | `people.patch` writes bio verbatim (`main/crm/people.ts`); no `detectFollowUp` on save, no role/tags/last-discussed extraction, no toast. The detection code already exists in pos (`crm/followups.ts detectMessageFollowUp`) — it's just not wired to note saves. | S–M |
| 12 | Message→follow-up detection (sessions, ±2 window, parseWhen, confirm/decline) | PRESENT | Faithful port in `main/crm/followups.ts` + `crm/when.ts`, upgraded into the commitments pipeline (`crm/commitments.ts`: LLM extraction + deterministic fallback + sanity gate + same-day expiry). Runs post-sync in `workers.ts`. | — |
| 13 | Gemini profile synthesis (`npm run enrich`: notes/tags/follow_up/last_discussed/personal_detail) | MISSING | No equivalent of `lib/enrich.ts synthesizeContact`. Nothing writes tags/bio from interaction batches. (Worklog distillation exists but is about the *user*, not contacts.) | M |
| 14 | Bio-mining (budget-aware conversation → About bullets, ledger, 14-day cadence) | MISSING | No port of `lib/bio-mining.ts`. The `enrichment_attempt` table exists in `main/db/migrations.ts` but **zero code uses it**. | M |
| 15 | PDL / Firecrawl / ScrapingDog web enrichment (+ credit-safety ledger) | MISSING | No enrichment clients, no waterfall, no `verified` flag surface. Ledger table pre-created (see #14) — schema-ready, code absent. | L |
| 16 | Freshness dots | PRESENT | Opacity-decay dot per row (`Contacts.tsx freshnessOpacity`, matches old opacity-not-hue language), `freshness_days` computed in `crm/people.ts`, "Last contact Nd ago" on detail. Minor gap: no fresh/warm/stale/cold **filter chips**. | — |
| 17 | Reach-out links (mailto / tel / LinkedIn profile / LinkedIn people-search fallback) | MISSING | ContactDetail lists aliases as plain text — no action buttons, no LinkedIn search deep-link. Partly superseded: the unified inbox actually *sends* email/iMessage and `app.openLinkedIn` opens real LinkedIn messaging, but the one-click per-contact reach-out surface is gone. | S |
| 18 | Profile badge ("You" avatar card: photo, name, email, stats) | MISSING | No profile/avatar anywhere in the renderer. | S |
| 19 | NL rules engine (chat: "family group shouldn't show follow-ups" / delete group) | MISSING | `assistant.ts` intents are plan/event/find/note/log/search/question only — no rule parsing, no suppress/unsuppress/delete-group actions. Backend flag exists (#6), so this is mostly an assistant intent + one UPDATE. | S–M |
| 20 | CSV export (16-column round-trip, `scripts/export-csv.ts`) | MISSING | No CSV export path in pos (grep: csv only in linkedin import/digest/capture). | S |
| 21 | LinkedIn CSV import UI | PRESENT | Settings → LinkedIn card → `sync.pickAndRun("linkedin")` native folder picker → `connectors/linkedin.ts` (Connections.csv + messages.csv, org/role backfill, never auto-pick ambiguous). Plus linkedin-email connector. | — |
| 22 | Reconnect dismiss / snooze | PARTIAL | `dismissal` table honored by `reconnectDue` (migrated rows work), but **no IPC/UI to dismiss or snooze** a reconnect row from the app. | S |
| 23 | Home query box ("who should I talk to") + ranked results | PRESENT | `crm/ranking.ts` (port + vector retrieval upgrade), Home.tsx query hero, assistant find_people. | — |
| 24 | Stale + follow-ups dashboard | PRESENT | Reconnect panel (tier cadence, group chips) + Commitments panel (confirm/drop/edit/toTask/toEvent, needs-review section, approve-all, swipe-delete) — richer than the old Home. | — |
| 25 | Integrations panel (self-serve connect + sync, no terminal) | PRESENT | Settings cards: mail accounts (IMAP + Google OAuth), iMessage, LinkedIn folder, mailfile, msgplans, Notion, gcal, ICS; sync status rows; 15-min cron in `workers.ts`. | — |
| 26 | Calendar watcher: create/update/cancel per conversation | PRESENT | `main/msgplans.ts` — faithful port of brain/prefilter/watcher/store; cancel always honored; update reuses the tracked event. Backend is Google Calendar ("POS — From Messages") instead of Calendar.app. | — |
| 27 | Calendar watcher: confidence gate | PRESENT | `CONFIDENCE_THRESHOLD = 0.6`, enforced in the decision gate (`msgplans.ts` ~line 445). | — |
| 28 | Calendar watcher: 6h stale rule | PRESENT | `STALE_HOURS = 6`; new events with start >6h past are skipped, updates to tracked events still allowed. | — |
| 29 | Calendar watcher: one event per thread | PRESENT | `msg_plan` table, `UNIQUE(conversation_key)`, per-conversation `last_decided_rowid` cursor. | — |
| 30 | Calendar watcher: back-and-forth refinement | PRESENT | Same ported SYSTEM prompt (refine time / flip tentative→confirmed / cancel) + precomputed date-reference table. Adaptations: automated-thread gate, identity-resolved names, duration guard. **Cadence gap:** 15-min cron vs the old 5-second always-on daemon — plans land up to 15 min later and only while the app runs. | S (cadence) |

## Recommended build order

**Wave 1 — close the daily-driver gaps (all S/S–M, ~1 week):**
1. About/note-save follow-up detection + "met today" bump (#10, #11) — wire existing `detectMessageFollowUp` into `people.patch` and the assistant note path; add a metToday flag.
2. Reach-out links on ContactDetail (#17) — mailto/tel/LinkedIn buttons from aliases + people-search fallback.
3. Assistant rules engine (#19) + suppress-followups toggle surface (#6) — one new intent writing `grp.suppress_follow_ups`; also expose delete-group.
4. Group UX: explicit create + hide menu + bulk assign from the merge bar (#2, #4); reconnect dismiss/snooze IPC + ✕ on Reconnect rows (#22).
5. CSV export (#20) — port `csv-schema.ts` mapping to a save-dialog IPC.
6. Merge semantics parity (#1) — richest-record survivor + field backfill inside `mergePeople`.

**Wave 2 — review + enrichment (M/L, the big rocks):**
1. Review queue (#7, #8, #9) — persist ambiguous resolutions (staging-style table or alias-candidate rows), a Review modal with candidate picker, bulk keep/group/discard over `unverified` contacts, same-first-name duplicate clustering feeding the existing merge.
2. Hide-with-contacts enforcement (#5) — a `hidden_at`-style filter applied in `listPeople`/`reconnectDue`/inbox, reconciled on group changes.
3. Profile synthesis + bio-mining (#13, #14) — port `enrich.ts`/`bio-mining.ts` onto the LLM client + the already-present `enrichment_attempt` ledger; run post-sync in `workers.ts`.
4. Web enrichment waterfall (#15) — PDL → Firecrawl (→ ScrapingDog opt-in), ledger-guarded, `verified` surfaced on ContactDetail.
5. Msgplans cadence (#30) — optional tighter poll (e.g. 1-min chat.db cursor check between crons) if the 15-min lag bites.
6. Profile badge (#18) — small, cosmetic, last.
