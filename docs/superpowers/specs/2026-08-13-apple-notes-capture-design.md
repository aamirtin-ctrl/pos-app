# Apple Notes → POS People Capture — Design

Date: 2026-08-13. Status: approved by owner (chat), built autonomously per owner instruction.

## Purpose

The owner keeps one designated Apple Note as a drop-box for unstructured info about people
he has met ("Abdeali Diwan" as a line, loose facts under it — any format, any number of
people per dump, every field optional). POS ingests it on the normal sync cadence,
attributes each chunk to the right person (including people who only exist in POS because
of the iMessage connector), files the **facts** onto the person, and asks in the app when
attribution is unsure. The note works as an **inbox**: processed text is wiped; the durable
record lives in POS.

## Decisions (owner-approved)

- Source: **Apple Notes**, one designated note, title configurable in Settings
  (setting `applenotes_capture_note`, default `POS Inbox`).
- Model: **inbox — POS clears it**; processed text is **wiped**, not marked.
- Approach: **native connector** via the existing `runOsascript` bridge (applecal.ts),
  same shape as connectors/reminders.ts.
- Identity: exact identifier matches attach directly; **unique normalized-name match
  auto-attaches** (a deliberate, tagged, undoable relaxation of the name-never-matches
  doctrine — justified because the note is user-authored, not inbound traffic);
  everything else (zero-or-many candidates, partials) goes to the review queue.
- New people: created **directly as tier-2 contacts, no `unverified` triage** — writing
  someone down is itself the owner's verification.
- Chunks: every field optional except a person label of some kind; **facts[] are the
  payload that matters most**.

## Flow

1. **Capture** (`main/connectors/applenotes.ts`): each connector tick, read the designated
   note's plain-text body + modification date via osascript.
   - Skip if modified within the last 5 minutes (never swallow a half-typed entry).
   - Skip if body is effectively empty.
   - Content-hash the normalized body against `extraction_log`
     (crm/commitments.contentHash) — a failed wipe must not double-process.
   - Record raw text into `capture_inbox` (new `CaptureSource` `"apple_notes"`) FIRST,
     then wipe the note body via osascript. Durability before interpretation, exactly
     per capture-inbox doctrine.
2. **Interpretation** (`main/crm/notesglean.ts`), run from the existing capture drain:
   rows with source `"apple_notes"` route here instead of assistant.handleCommand.
   - **One LLM call per captured dump** (quota discipline: never per-chunk calls),
     strict-JSON-array output:
     `[{name?, org?, role?, phone?, email?, facts?: string[]}]` — model instructed to
     leave fields absent rather than infer, keep every substantive statement as a fact.
   - Per chunk: resolve →
     a. phone/email present → existing resolveHandle identifier cascade.
     b. else unique name match (normalizeName over live people + name aliases,
        exactly 1 hit) → attach, interaction tagged `name-matched`.
     c. else 0 candidates → create tier-2 person, facts as bio.
     d. else (≥2 candidates / resolveHandle ambiguous) → queue for review with the
        chunk JSON preserved.
     e. chunk with no name AND no identifier (facts only) → review, never a nameless
        person and never silently dropped.
   - Applying a chunk to a person: facts append to `person.bio` under the
     `— From notes —` marker (enrich.ts marker pattern; user-authored head never
     touched); phone/email/org/role fill empty fields and add aliases; an
     `interaction` row (channel `notes`) records the raw chunk so history shows it.
3. **Review** ("ask me in the app"): pending chunks stored under setting keys
   `notechunk:<id>` (same schema-free trick as `ambiguous:*`). ReviewModal gains a
   **Notes** section: original text + candidate people + "create new"; one tap resolves
   and applies the chunk. Chunks are never dropped silently.

## Error handling

- No automation permission / Notes not scriptable → typed connector error in the
  SyncReport, surfaced in Settings like other connectors; never throws the tick down.
- Designated note missing → sync error naming the title it looked for.
- LLM down → capture rows pend with existing retry/attempt caps; note already safely
  wiped because raw text is durable in `capture_inbox`.
- Unparseable dump after MAX_CAPTURE_ATTEMPTS → closed with error kept, findable.
- Wipe write-back fails → next tick re-reads same body, content hash skips re-capture.

## Testing

- Pure units (vitest, no osascript/LLM/db where possible): body normalization + hash
  skip logic, mod-date guard, glean JSON parsing/validation (all-fields-optional,
  junk-tolerant), unique-name matcher, chunk-apply (bio marker append, alias adds).
- Drain routing test: `"apple_notes"` rows hit notesglean, others still hit assistant.
- Connector test with mocked runOsascript (read, wipe, missing note).

## Out of scope (v1)

- Extracting follow-up tasks/commitments from note text (text still lands in bio).
- More than one designated note; reading historical notes; writing receipts to the note.
