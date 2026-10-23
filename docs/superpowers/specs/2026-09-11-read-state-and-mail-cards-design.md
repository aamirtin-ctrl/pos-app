# Messaging: real read state + mail-shaped mail — Design

Date: 2026-09-11. Status: approved by owner (chat), built autonomously per owner instruction.
Owner follow-up: he asked to be reminded to **audit the mail-text feature afterwards**.

## Purpose

Two owner complaints about the Messaging surface:

1. "It just shows the unread dot all the time." The dot was never an unread marker — it is
   `unanswered` (no outbound after the latest inbound, or a suggested draft exists), so every
   conversation where the other person spoke last carries it forever. Nothing in the
   database tracks read state at all.
2. "Inboxed mail items look really weird." Every channel renders through one chat-bubble
   renderer: a 78%-width bubble, the subject as a tiny label, and a 200-character snippet
   as the body — because the connectors store only that snippet (the original privacy
   contract: never the full body).

## Decisions (owner-approved)

- **Read state is mirrored from the sources**: chat.db `is_read`/`date_read` for iMessage,
  the IMAP `\Seen` flag for mail. Opening a conversation in POS marks it read locally.
- **Write-back to mail**: opening a mail conversation in POS also sets `\Seen` on the
  server over IMAP. Messages.app has no external mark-read, so iMessage stays local.
- **Full mail text is stored** (reversing the snippet-only privacy contract, owner decision
  2026-09-11). Mail cards show the subject bolded at the top, then the body, with a small
  toggle at the bottom of the text that reveals the previous emails on the chain (quoted
  history).
- **The dot means unread only.** "Needs a reply" keeps driving the sort order but gets no
  marker.

## Data

### Migration 22 — `read_at` on interaction

```sql
ALTER TABLE interaction ADD COLUMN read_at TEXT;
```

`NULL` = unread. Backfill in the same migration:

- every row that is not `direction = 'inbound'` → `read_at = COALESCE(occurred_at, now)`;
- every inbound row older than 30 days → `read_at = occurred_at`;
- every inbound row from a channel with no read source (anything other than
  `gmail | outlook | icloud | imessage`) → `read_at = COALESCE(occurred_at, now)`.

Inbound mail/iMessage from the last 30 days stays `NULL` until the first sync (which runs
at app launch) mirrors the true state from the source.

### Ingest

`insertInteraction` gains optional `readAt` and `bodyRaw`. Callers are explicit:

- **imessage** (`syncImessage`, `backfillMissingSenders`): `CHAT_MESSAGE_SQL` also selects
  `m.is_read`, `m.date_read`. Inbound: `readAt = is_read ? appleDate(date_read || date) :
  null`. Outbound: `readAt = occurredAt`.
- **mail** (`syncMailAccount`): the existing fetch adds `flags: true`. Inbound:
  `readAt = flags has \Seen ? now : null`. Outbound: `readAt = occurredAt`.
  `bodyRaw = parsed.text || stripped html`, capped at `MAIL_BODY_MAX = 64_000` chars.
- **linkedin-email**, **mailfile**, **sendEmail**, **sendIMessage(ToChat)**: `readAt =
  occurredAt` (no source to mirror; historical import; own outbound).

### Mirror pass (every 15-minute tick, unread → read only)

Nothing ever flips a row back to unread — un-reading in Gmail is rare and not worth
two-way sync.

- **iMessage** (`mirrorImessageReadState`, run inside `syncImessage` after ingest, same
  chat.db session): `SELECT guid, ROWID, date_read FROM message WHERE is_from_me = 0 AND
  is_read = 1 AND date_read > ?`, cursor `imessage_read` in `sync_state` (Apple-epoch ns;
  first run = 30 days ago). For each hit: `UPDATE interaction SET read_at = ? WHERE
  channel = 'imessage' AND external_id IN (guid, 'imessage:<rowid>') AND read_at IS NULL`.
  Fallback for a message read on another device that arrives with `is_read = 1` but
  `date_read = 0` (never crosses the cursor): while POS still holds unread iMessage rows in
  the 30-day window, a second query `is_from_me = 0 AND is_read = 1 AND date_read = 0 AND
  date > <30 days>` stamps those `read_at = now`. Free in the steady state.
- **Mail** (`mirrorMailReadState`, run inside `syncMailAccount` after ingest, same
  connection, INBOX only — and it runs even when the ingest found no new mail): bounded by
  what POS needs, never by mailbox size. Candidates = inbound email rows in the last 30
  days that are unread OR lack `body_raw`, newest first, at most `MIRROR_CANDIDATE_CAP =
  200` per tick. Each candidate is looked up with `search({ header: { "message-id": id } },
  { uid: true })` (a row the other account owns is simply not found); then ONE
  `fetch(uids, { uid, flags })` for the ones found:
  - `\Seen` present and POS unread → `read_at = now`.
  - `body_raw IS NULL` → fetch `source` for at most `BODY_FILL_BATCH = 150` of them per
    tick and store `bodyRaw` (same text/HTML rule as ingest). Existing rows fill in over
    the first few syncs.

  An earlier draft swept the whole 30-day INBOX with an envelope fetch; on the owner's
  Gmail account that dropped the connection mid-pass, hence the per-Message-ID design.
  The pass takes a minimal client interface (`search`, `fetch`, `messageFlagsAdd`) so
  tests inject a fake.

### Mark read from POS

New IPC `inbox.markRead({ threadKey })` (`markConversationRead` in messaging.ts):

- `person:<id>` → inbound rows for that person with `thread_external_id IS NULL OR channel
  IN (email channels)` (the same scope as the 1:1 thread query);
  `chat:<guid>` → inbound rows with that `thread_external_id`.
- `UPDATE … SET read_at = now WHERE … AND read_at IS NULL`; returns `{ marked, mailIds }`
  where `mailIds` are the normalized Message-IDs of affected email rows.
- If `mailIds` is non-empty, the IPC handler fires `markSeenOnServer(secrets, mailIds)`
  and does NOT await it: for each configured mail account (only known SMTP providers +
  custom IMAP alike — it is just IMAP), connect, lock INBOX, `search({ header:
  { "message-id": id } }, { uid: true })` per id, `messageFlagsAdd(uids, ["\\Seen"],
  { uid: true })`. One connection per call. Failures log (`console.warn`) and never surface.

## Read side (`listInbox`)

- `InboxItem.unread: 0 | 1` — 1 when any inbound row in the conversation's scan bucket has
  `read_at IS NULL`. Because the scan already covers at least 30 days / 400 rows, this is
  the same window the mirror keeps accurate.
- `ThreadMessage` gains `read_at: string | null` and `body: string | null` (`body_raw`).

## Renderer (`renderer/src/inbox/Stub.tsx`)

- **List row**: dot (existing `--petal`) + `font-semibold` name only when `unread`. The
  needs-reply dot is removed. Sort unchanged (unanswered first, then newest).
- **Selection**: explicit click / Enter on a row with `unread` calls
  `window.pos.inbox.markRead({ threadKey })` and optimistically sets `read_at` on that
  conversation's items in local state (no refetch flicker). The auto-selected first
  conversation on load is NOT marked read until clicked.
- **Freshness**: read state changes behind the app's back (a text read on the phone, the
  15-minute mirror), so the list refetches when the window regains focus / visibility and
  every 60 s. Selection and compose live in their own state and are untouched.
- **Thread view**: rows whose channel is in `EMAIL_CHANNELS` render as a full-width mail
  card; everything else keeps today's bubble.
  Mail card: subject in bold (falls back to "(no subject)"), a muted meta line (`sender_name`
  or "You" · date), the body with `white-space: pre-wrap`, and — when the body has a quoted
  tail — a text button at the bottom: "Show previous emails" / "Hide previous emails" that
  toggles the quoted block (muted colour). Rows with no stored body show the snippet.
- **Quoted-text splitter** (`renderer/src/inbox/quoted.ts`, pure, unit-tested): the visible
  part ends at the first of — a line matching `/^On .{0,300}wrote:\s*$/` (allowing the
  wrapped two-line form), `-----Original Message-----` / `---------- Forwarded message
  ---------`, a `From: …` line followed within 3 lines by `Sent:|Date:|To:|Subject:`, or
  the first run of ≥ 2 consecutive `>`-prefixed lines. Everything from that point is the
  quoted tail. Trailing whitespace trimmed; empty tail → no toggle.

## Out of scope

- Unread counts anywhere outside Messaging (sidebar badges).
- Two-way mirror (read → unread).
- Read state for LinkedIn, Slack, notes, manual rows (always read at ingest).
- HTML rendering of mail; bodies are plain text.

## Testing

- `tests/messaging.test.ts`: `listInbox` exposes `unread` and thread `read_at`/`body`;
  `markConversationRead` scopes by person (excluding group rows, including mail rows with a
  thread id) and by chat guid, returns mail Message-IDs only for email channels, and is
  idempotent.
- `tests/db.test.ts` (or new `read-state-migration.test.ts`): backfill rules above.
- `tests/connectors/imessage-read.test.ts`: synthetic chat.db → `mirrorImessageReadState`
  marks the right rows, advances the cursor, never un-reads.
- `tests/connectors/mail-read.test.ts`: fake IMAP client → mirror marks seen rows, fills
  `body_raw` in a bounded batch, and `markSeenOnServer` searches by Message-ID and adds
  `\Seen`.
- `tests/quoted.test.ts`: splitter cases (Gmail "On … wrote:", Outlook "From:/Sent:",
  forwarded, `>` runs, no quote).
