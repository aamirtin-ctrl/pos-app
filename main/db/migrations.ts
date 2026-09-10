// Forward-only, versioned migrations. NEVER edit a shipped migration — append a new one.
// SQL is embedded (not .sql files) so esbuild bundling needs no asset copying.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "spine",
    sql: `
-- ─── People ────────────────────────────────────────────────
CREATE TABLE person (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  given_name TEXT,
  family_name TEXT,
  org TEXT,
  role TEXT,
  location TEXT,
  bio TEXT,                    -- LLM-synthesized, background facts
  relationship_summary TEXT,   -- LLM-synthesized, your history with them
  tier INTEGER NOT NULL DEFAULT 2,  -- 0=inner, 1=active, 2=network, 3=archive
  last_contact_at TEXT,
  next_touch_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  profile_synthesized_at TEXT
);

CREATE TABLE alias (             -- identity resolution
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- email | phone | imessage_handle | linkedin | slack_id (open enum)
  value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  UNIQUE(kind, value)
);
CREATE INDEX idx_alias_person ON alias(person_id);

-- ─── Interactions ─────────────────────────────────────────
-- Channel-agnostic. Messaging integrations write here later.
CREATE TABLE interaction (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,         -- gmail | imessage | slack | manual | meeting | linkedin | outlook | mailfile
  direction TEXT,                -- inbound | outbound | mutual
  occurred_at TEXT,
  subject TEXT,
  body_raw TEXT,
  body_summary TEXT,
  external_id TEXT,
  thread_external_id TEXT,
  extracted_at TEXT,
  UNIQUE(channel, external_id)
);
CREATE INDEX idx_interaction_person ON interaction(person_id, occurred_at DESC);

-- ─── Commitments ──────────────────────────────────────────
-- The join between conversation and calendar. Both surfaces write here.
CREATE TABLE commitment (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,  -- nullable: self-commitments allowed
  direction TEXT NOT NULL DEFAULT 'i_owe_them',  -- i_owe_them | they_owe_me
  description TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | scheduled | done | dropped
  source_interaction_id INTEGER REFERENCES interaction(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 1.0,          -- LLM extraction confidence 0-1
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,  -- low-confidence needs confirmation
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_commitment_status ON commitment(status);

-- ─── Tasks and blocks ─────────────────────────────────────
CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  block_type TEXT NOT NULL,      -- §5.1 taxonomy
  cognitive_load INTEGER,        -- 1..5
  estimated_minutes INTEGER,     -- post-buffer, what the planner uses
  raw_estimate_minutes INTEGER,  -- pre-buffer
  is_mit INTEGER NOT NULL DEFAULT 0,
  hard_deadline_at TEXT,
  project TEXT,
  commitment_id INTEGER REFERENCES commitment(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'inbox',  -- inbox | planned | in_progress | done | deferred
  splittable INTEGER NOT NULL DEFAULT 0,
  estimate_source TEXT,          -- stated | inferred
  plan_date TEXT,                -- the day this task was braindumped for
  gtasks_id TEXT,                -- Google Tasks id once pushed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE plan (              -- one row per generated day plan
  id INTEGER PRIMARY KEY,
  plan_date TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  engine_version TEXT NOT NULL,
  doctrine_snapshot TEXT NOT NULL,  -- JSON
  narration TEXT,
  unplaced_tasks TEXT,              -- JSON array with reasons
  accepted_at TEXT,
  pushed_at TEXT
);

CREATE TABLE block (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,  -- nullable (breaks, meals, gym)
  block_type TEXT NOT NULL,
  title TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  gcal_event_id TEXT,            -- set on push
  is_anchor INTEGER NOT NULL DEFAULT 0,  -- user/external fixed, planner cannot move
  is_locked INTEGER NOT NULL DEFAULT 0,  -- user pinned this placement
  plan_id INTEGER REFERENCES plan(id) ON DELETE CASCADE,
  capacity_score_at_placement REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_block_span ON block(starts_at, ends_at);

-- ─── Learning loop ────────────────────────────────────────
CREATE TABLE block_outcome (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  completed INTEGER,
  actual_start_at TEXT,
  actual_end_at TEXT,
  perceived_focus INTEGER,       -- 1-5, optional
  note TEXT
);

-- ─── Ops ──────────────────────────────────────────────────
CREATE TABLE llm_call (
  id INTEGER PRIMARY KEY,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_llm_call_month ON llm_call(called_at);

CREATE TABLE sync_run (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  records_ingested INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE sync_state (
  source TEXT PRIMARY KEY,
  last_sync_at TEXT,
  cursor TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "sidecars",
    sql: `
-- Owner decision 2026-08-03: groups, tags, and reconnect-dismissals survive the retrofit,
-- normalized (no more comma-strings on the person row).
CREATE TABLE grp (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hidden INTEGER NOT NULL DEFAULT 0,
  hide_contacts INTEGER NOT NULL DEFAULT 0,
  suppress_follow_ups INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE person_group (
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES grp(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, group_id)
);
CREATE TABLE person_tag (
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);
CREATE TABLE dismissal (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- stale | followup | linkedin | datagap
  snooze_until TEXT,             -- NULL = dismissed indefinitely
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dismissal ON dismissal(person_id, kind);
CREATE TABLE enrichment_attempt (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  source TEXT NOT NULL,          -- web | scrapingdog | bio-mining
  status TEXT NOT NULL,          -- success | fail
  detail TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrich_attempt ON enrichment_attempt(person_id, source);
-- Embedding bookkeeping. The vec_profile virtual table itself is created at runtime
-- (db.ts) because sqlite-vec must be loaded on the connection first.
CREATE TABLE profile_embedding_meta (
  person_id INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  embedded_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "drafts",
    sql: `
-- Auto-drafted replies. One suggested draft per inbound interaction; the user
-- copies/edits and sends from the native app (no auto-send, ever).
CREATE TABLE draft (
  id INTEGER PRIMARY KEY,
  interaction_id INTEGER NOT NULL UNIQUE REFERENCES interaction(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested',  -- suggested | dismissed | sent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_draft_status ON draft(status);
`,
  },
  {
    version: 4,
    name: "msgplans",
    sql: `
-- Plans from messages (main/msgplans.ts): ONE tracked event per conversation, mirroring
-- the Python watcher's state.json {event, last_decided_rowid} per conversation.
-- The message-scan cursor lives in the existing sync_state under source 'msgplans'.
CREATE TABLE msg_plan (
  id INTEGER PRIMARY KEY,
  conversation_key TEXT NOT NULL UNIQUE,   -- chat guid, else the handle
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  title TEXT,
  starts_at TEXT,
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  gcal_event_id TEXT,                      -- the single event on "POS — From Messages"
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | cancelled | idle (decided, no event)
  last_decided_rowid INTEGER,              -- never re-decide the same thread
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_plan_status ON msg_plan(status);
`,
  },
  {
    version: 5,
    name: "worklog",
    sql: `
-- Worklog memory (main/worklog.ts): durable "what I actually did" entries. 'auto' rows
-- come from the weekly distillation of completed tasks / accepted plans; 'manual' rows
-- from the sparkle box ("log: …"). Feeds catch-up updates and the assistant's context.
CREATE TABLE worklog (
  id INTEGER PRIMARY KEY,
  happened_at TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_worklog_happened ON worklog(happened_at);
`,
  },
  {
    version: 6,
    name: "dedupe",
    sql: `
-- Owner report 2026-08-05 (duplicate commitments). Two independent defenses:
--   1. extraction_log — a content hash of every interaction ever decided, so identical
--      text (the iMessage self-thread echo, the same task arriving by mail AND iMessage)
--      is never sent to the LLM or extracted twice. Cheap, deterministic, first line.
--   2. commitment.dedupe_key — a normalized slug of the AI title + person + due day,
--      unique where set, so the SAME commitment stated in two DIFFERENT messages
--      collapses into ONE row (INSERT … ON CONFLICT DO UPDATE keeps the better one).
-- kind/start_time carry the second extraction query's TASK-vs-CALENDAR-EVENT verdict.
ALTER TABLE commitment ADD COLUMN dedupe_key TEXT;
ALTER TABLE commitment ADD COLUMN kind TEXT DEFAULT 'task';   -- task | event
ALTER TABLE commitment ADD COLUMN start_time TEXT;            -- HH:MM, only when kind='event'
CREATE UNIQUE INDEX idx_commitment_dedupe ON commitment(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE extraction_log (
  id INTEGER PRIMARY KEY,
  interaction_id INTEGER,
  content_hash TEXT UNIQUE,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  verdict TEXT                                                -- commitment | rejected | capture
);
CREATE INDEX idx_extraction_log_interaction ON extraction_log(interaction_id);
`,
  },
  {
    version: 7,
    name: "user_fact",
    sql: `
-- Personal context ("about you") — owner report 2026-08-05: clicking "Add task" on a
-- commitment about a "meetup at the start of school" prefilled TODAY, because nothing in
-- the app knew he attends Stanford and that the fall term starts ~Sept 22. These rows are
-- the app's memory of the USER themselves (main/context.ts). They render into a compact
-- ABOUT THE USER block at the top of the extraction prompts and the assistant's context,
-- and 'date_anchor' rows let resolveNamedDate() turn "start of school" into a real date.
--   kind = 'fact'       — a durable statement ("Stanford University", "Dallas, TX")
--        | 'date_anchor' — a named point in time (school-start); its date lives in starts_at
--        | 'recurring'   — something that repeats (a weekly class, an annual trip)
-- source = 'seed' (editable defaults) | 'manual' (Settings) | 'assistant' ("remember: …").
CREATE TABLE user_fact (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  starts_at TEXT,
  ends_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_fact_kind ON user_fact(kind);
`,
  },
  {
    version: 8,
    name: "flexibility",
    sql: `
-- Three-tier event flexibility (owner ask 2026-08-05): "sometimes I add Google Calendar
-- events after the fact — typically that means it's something I have to go to, and my
-- calendar should adjust around it. The app should know which events can be moved, which
-- shouldn't be, and which it should try not to."
--
-- Until now the model was binary: is_anchor=1 (immovable) vs planner-placed (free). There
-- was no "prefer not to move". This column is that third state.
--
--   'fixed'     — external obligation; occupies its minutes, never moved (what an anchor
--                 has always been). Inferred from attendees / accepted invitation /
--                 obligation words in the title (main/gcal/sync.ts inferFlexibility).
--   'preferred' — the owner's own solo event; real, but displaceable under pressure.
--   'flexible'  — POS-generated; the planner owns the placement outright.
--
-- DEFAULT 'flexible' because every block this migration back-fills was written by the
-- planner. Anchors are re-stamped 'fixed' on the next plan generation, and the ENGINE
-- default (grid.ts DEFAULT_FLEXIBILITY) is 'fixed', so an anchor that never declares a
-- tier still behaves exactly as it did before.
ALTER TABLE block ADD COLUMN flexibility TEXT NOT NULL DEFAULT 'flexible';

-- Data back-fill only (no further schema change): rows that were ALREADY immovable under
-- the binary model are 'fixed' by definition — an external anchor, or a placement the owner
-- pinned himself. Without this the default above would quietly demote them.
UPDATE block SET flexibility = 'fixed' WHERE is_anchor = 1 OR is_locked = 1;
`,
  },
  {
    version: 9,
    name: "task_window",
    sql: `
-- Deadline WINDOWS (owner report 2026-08-06). Yesterday he captured "maybe about two hours
-- in total to go through my Stanford academic advising stuff — I could do this the rest of
-- the week, it doesn't have to be today." Today he captured "two hours for a Stanford math
-- test today." The advising task had been pinned to a single day, so today it competed with
-- the test instead of being deferred. His expectation, in his words: the app should have
-- remembered the work was due anytime this week and moved it.
--
-- A task could only ever say "this day" (plan_date) or "by this instant" (hard_deadline_at).
-- There was no way to say "N minutes of work, ANYWHERE in this window", so every flexible
-- phrase the extractor heard ("this week", "by Friday", "no rush") was discarded.
--
--   window_start — first day the work may be scheduled. Defaults to the creation/plan date.
--   window_end   — LAST day the work may be scheduled, inclusive.
--
-- Semantics, and the whole point of the column: with a window_end set, plan_date stops being
-- a commitment and becomes the CURRENTLY CHOSEN day. The solver may hand the task back as
-- 'deferred_within_window' and the planner then advances plan_date to the next day inside the
-- window — never past window_end. On window_end itself there is nowhere left to go, so a
-- failure there is a real failure ('no_eligible_slot'), not a deferral.
--
-- INVARIANT the engine relies on: window_end is written ONLY for work the user said was
-- flexible across a range. A specific day ("today", "tomorrow", "Thursday") leaves window_end
-- NULL and is expressed by plan_date alone — so "window_end is set" and "this may move" are
-- the same statement, and no task without a window behaves any differently than before.
ALTER TABLE task ADD COLUMN window_start TEXT;
ALTER TABLE task ADD COLUMN window_end TEXT;
CREATE INDEX idx_task_window ON task(window_end) WHERE window_end IS NOT NULL;
`,
  },
  {
    version: 10,
    name: "gcal_tombstone",
    sql: `
-- Withdrawing events the plan no longer contains (owner directive 2026-08-06: "it should
-- automatically populate to my Google Calendar, it shouldn't require me to press a button").
--
-- Pushing used to be a deliberate act, so a superseded plan simply never reached Google and
-- nothing was left behind. Now every plan pushes, and re-planning a day DELETES the old
-- blocks — by cascade, so no TypeScript ever sees it happen. Their Google events would
-- survive as orphans with nothing left to match them back to, and the owner's calendar would
-- silently accumulate the ghosts of every abandoned schedule.
--
-- The DELETE itself is therefore what records the debt. A trigger fires on any block removal
-- (cascades included, which is the case that matters) and the next push withdraws the event.
-- Deleting a row from this table means "Google no longer has it" — that is why an event
-- already gone from Google, a 404, counts as success in drainTombstones.
--
-- INSERT OR IGNORE + the unique index make the trigger idempotent: an event id can be owed a
-- deletion once, no matter how many blocks carried it over their lifetimes.
CREATE TABLE gcal_tombstone (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  -- Which calendar to delete from, captured at tombstone time. The POS calendar id is
  -- stable, but reading it now means a later re-created calendar can never make us issue a
  -- delete against the wrong one.
  calendar_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_gcal_tombstone_event ON gcal_tombstone(event_id);

CREATE TRIGGER block_gcal_tombstone AFTER DELETE ON block
WHEN OLD.gcal_event_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO gcal_tombstone (event_id, calendar_id)
  VALUES (OLD.gcal_event_id, (SELECT value FROM setting WHERE key = 'pos_calendar_id'));
END;
`,
  },
  {
    version: 11,
    name: "task_updated_at",
    sql: `
-- Who wins when a task changed on BOTH sides (owner-visible bug, 2026-08-06).
--
-- reconcileGoogleTasks pulls phone-side edits, and its title rule was unconditional: if
-- Google's title differs from ours, Google's replaces ours. It also runs BEFORE the push on
-- every tick. Together that makes a local rename impossible to keep — it is reverted from
-- Google on the next tick, before it has ever been pushed there.
--
-- Found while merging his two duplicate Stanford tasks: the rename to "Go through my Stanford
-- academic advising stuff" was silently restored to the raw transcript fragment Google still
-- held. Two-way sync is right; "the remote always wins" is not, because it makes one side
-- read-only without saying so.
--
-- So both sides need a clock. Google Tasks already returns an "updated" stamp on every task;
-- this is the local half. The trigger stamps any UPDATE, so nothing has to remember to, and with
-- SQLite's default recursive_triggers=OFF the trigger's own write does not re-fire it.
--
-- NULL means "never edited locally since this column existed", which correctly lets Google
-- win for every task that predates the migration.
ALTER TABLE task ADD COLUMN updated_at TEXT;

CREATE TRIGGER task_touch_updated_at AFTER UPDATE ON task
BEGIN
  UPDATE task SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
`,
  },
  {
    version: 12,
    name: "capture_inbox",
    sql: `
-- Nothing he says is allowed to evaporate (owner ask 2026-08-06: "the system should be able to
-- take info from my emails to myself, sparkle button, and personal texts and all that should
-- run through a tasks/calendar event/personal info gleaning pipeline").
--
-- The pipeline already existed at all three entry points. What it did not have was DURABILITY.
-- Every one of them classified with the model and acted on the answer in a single pass, so a
-- provider that was down meant the input was read, misrouted or ignored, and then gone — there
-- was no record that he had ever said it.
--
-- That is not hypothetical: his Gemini quota ran out at 18:18 today, and the things he typed
-- into the sparkle box afterwards produced no task, no event, no note, and no error he could
-- see. The only evidence they ever happened is that he remembered.
--
-- So the raw text is written HERE first, before anything is interpreted, and the interpretation
-- becomes a separate step that may fail and be retried. A NULL processed_at IS the queue;
-- attempts stops a permanently unparseable line from being retried forever; result is what the
-- pipeline decided, kept for audit so a wrong routing can be found and explained.
CREATE TABLE capture_inbox (
  id INTEGER PRIMARY KEY,
  -- Where he said it: 'sparkle' | 'self_email' | 'imessage' | 'alexa'.
  source TEXT NOT NULL,
  -- Exactly what he said. Never rewritten — this is the record of the input itself.
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- What the pipeline made of it once it succeeded (JSON: intent + what was created).
  result TEXT,
  -- Why the last attempt failed, when it did.
  error TEXT
);
CREATE INDEX idx_capture_pending ON capture_inbox(processed_at, id) WHERE processed_at IS NULL;
`,
  },
  {
    version: 13,
    name: "task_day_part",
    sql: `
-- Owner report 2026-08-06: "the one that I said for tonight is in the afternoon and not in the
-- night. And the one that I said for tomorrow is today."
--
-- He said "tonight" and "tomorrow" — the two least ambiguous scheduling words there are — and
-- both were understood and then discarded:
--
--   TOMORROW was parsed correctly (parseWindow returns that date with flexible=false) and then
--   thrown away, because braindump only persisted a date when the range was FLEXIBLE. plan_date
--   was hardcoded to the day of capture, so work for tomorrow landed on today. No model needed
--   to get this right; the answer was already computed and then dropped on the floor.
--
--   TONIGHT had nowhere to be stored at all. A parsed task could express a duration and a date
--   but never a time of day, so the energy curve placed it wherever scored best — 14:00. That
--   is the correct behaviour when nothing was stated and the wrong one when something was.
--
-- day_part is that missing dimension: 'morning' | 'afternoon' | 'evening', NULL when he named
-- none, which is the overwhelming majority and behaves exactly as before.
ALTER TABLE task ADD COLUMN day_part TEXT;
`,
  },
  {
    version: 14,
    name: "protect_done_events",
    sql: `
-- Owner report 2026-08-06: "some bug happened where it removed my Stanford math test calendar
-- event, even though that time had already passed and I had done that task. It shouldn't be
-- editing old stuff."
--
-- What actually happened: earlier today I ran raw \`sqlite3 ... DELETE FROM plan\` commands by
-- hand to clean up duplicate blocks. The sqlite3 CLI does not enable PRAGMA foreign_keys, so
-- those deletes did NOT cascade to the blocks they owned — they were orphaned, invisible to
-- every app query (all of them INNER JOIN block through plan), including the math test's own
-- completed block. The orphan-event reconciler I built two features ago (reconcileDayEvents,
-- to stop stale Google events from accumulating) then correctly did its job: it saw a Google
-- Calendar event that nothing in the database claimed anymore, and deleted it. The event was
-- his record of a real, completed test.
--
-- The fix is not "don't clean up orphans" — that mechanism is why his calendar was not
-- drowning in duplicates. It is that DONE work must be a protected class the cleanup can never
-- reach, independent of whatever plan/block rows happen to still exist. gcal_event_id is a
-- durable snapshot, copied here the moment a task is marked done (tasks.setStatus,
-- pullFromGoogle) and read by reconcileDayEvents/drainTombstones as permanently claimed.
--
-- Backfilled immediately for every task already done, via a plain SELECT with no plan join —
-- exactly the query the orphan-cleanup lacked, which is what recovers the math test's id from
-- its orphaned block without needing to touch or repair that block at all.
ALTER TABLE task ADD COLUMN gcal_event_id TEXT;
UPDATE task SET gcal_event_id = (
  SELECT b.gcal_event_id FROM block b
   WHERE b.task_id = task.id AND b.gcal_event_id IS NOT NULL
   ORDER BY b.id DESC LIMIT 1
) WHERE status = 'done' AND gcal_event_id IS NULL;
`,
  },
  {
    version: 15,
    name: "recurring_tasks",
    sql: `
-- Owner report 2026-08-06: "I texted myself I need time to workout and gym everyday. The app
-- populated time to film today but not to gym, and it didn't add time for this on any of the
-- other days. It should have realized this is a preference and to add it in to my calendars."
--
-- "Everyday" names a STANDING commitment, not a one-off task, and nothing in the schema could
-- express that — a task has exactly one plan_date. So it was captured as a single instance on
-- the day he happened to text it and then, correctly by the rules that exist, never appeared
-- again.
--
--   recurrence      — 'daily' on a TEMPLATE row (what he actually asked for: "this happens
--                      every day"). NULL for an ordinary one-off task, which is every existing
--                      row and everything captured from here on unless "everyday"/"every day"/
--                      "daily" is heard in the text.
--   recurrence_parent_id — set on an INSTANCE materialized FROM a template for one specific
--                      day. The template's own row IS its first day's instance (parent NULL),
--                      so day one needs no special case.
--
-- Materialization (main/crm/recurring.ts) runs before a day is planned: any template with no
-- instance yet for that date gets one, cloned with that day's own estimate/window/day-part, so
-- a recurring task is a REGULAR task from the solver's point of view — no separate code path,
-- no different rules about deep-work caps or gym's sleep floor.
ALTER TABLE task ADD COLUMN recurrence TEXT;
ALTER TABLE task ADD COLUMN recurrence_parent_id INTEGER REFERENCES task(id) ON DELETE SET NULL;
CREATE INDEX idx_task_recurrence_parent ON task(recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL;
`,
  },
  {
    version: 16,
    name: "stated_estimates_unbuffered",
    sql: `
-- Owner report 2026-08-07: "it put gym at 1 hr 45 mins" — he said 1.25 hrs. The
-- planning-fallacy multiplier (gym ×1.4) was applied to a duration he STATED, turning his
-- own number into the app's number. bufferedMinutes now skips the multiplier for
-- estimate_source='stated'; this recomputes the rows already sitting in the schedule so the
-- fix reaches today, not just the next braindump. Integer arithmetic: round raw up to the
-- 15-minute grid, nothing more.
UPDATE task
   SET estimated_minutes = ((raw_estimate_minutes + 14) / 15) * 15
 WHERE estimate_source = 'stated'
   AND raw_estimate_minutes IS NOT NULL
   AND status IN ('inbox','planned','in_progress');
`,
  },
  {
    version: 17,
    name: "gtasks_list",
    sql: `
-- Owner report 2026-08-07: "in my google tasks i added from much earlier i need to do my
-- physics diagnostic today. yet its not scheduling for that." The reconcile only ever read
-- POS's own tasklist, so a task typed into the normal Google Tasks app (the default
-- "My Tasks" list) was invisible here.
--
-- The pull now reads '@default' too. A task imported from there must remember which list it
-- lives in, because every write back (title/due updates, completion) goes to a specific
-- tasklist — patching a default-list task against the POS list is a 404.
-- NULL = the POS list (every pre-existing linked task), so old rows keep old behavior.
ALTER TABLE task ADD COLUMN gtasks_list TEXT;
`,
  },
  {
    version: 18,
    name: "stated_estimates_unbuffered_templates",
    sql: `
-- Migration 16 recomputed stated estimates but scoped itself to status IN
-- ('inbox','planned','in_progress'). Recurring TEMPLATES are frequently outside that set —
-- his gym template had been completed — so the one row every future day is copied from kept
-- its pre-fix value: raw 75, estimated 105.
--
-- The consequence was visible the same evening. Aug 7 and Aug 8 had been repaired by 16, then
-- Aug 9 and Aug 10 materialized from the untouched template and came back at 105 — his
-- 1.25-hour gym scheduled as 1h45m again, the exact complaint that started the day.
--
-- This finishes the job at every status, and crm/recurring.ts now DERIVES each instance's
-- estimate from raw minutes so a stale cached value on a template can never propagate again.
-- 'done' rows are included deliberately: a template is not history, it is the source every
-- future instance is copied from.
UPDATE task
   SET estimated_minutes = ((raw_estimate_minutes + 14) / 15) * 15
 WHERE estimate_source = 'stated'
   AND raw_estimate_minutes IS NOT NULL
   AND estimated_minutes <> ((raw_estimate_minutes + 14) / 15) * 15
   AND (recurrence = 'daily' OR recurrence_parent_id IS NOT NULL);
`,
  },
  {
    version: 19,
    name: "reminder_id_on_task",
    sql: `
-- Owner directive 2026-08-10: iOS already detects a plan in Messages and offers a one-tap
-- reminder, and unlike POS's own extraction HE chose it. Reminders.app therefore becomes an
-- input; message text stops being mined for tasks (it keeps feeding the CRM half).
--
-- Identity is a COLUMN, not a notes marker, and the reason is the bug this same session
-- fixed: the tentative Google push omitted its pos:task marker, the pull side could not
-- recognize POS's own row, and one commitment became 31 Google rows and 220 local
-- duplicates. Import idempotency must not depend on free text a user can edit or a sync can
-- strip. A UNIQUE index makes a second import of the same reminder impossible at the
-- storage layer rather than by convention.
-- Deliberately NOT a partial index. "... WHERE reminder_id IS NOT NULL" reads tidier, but
-- SQLite then refuses "ON CONFLICT(reminder_id) DO NOTHING" — the conflict target has to
-- restate the predicate — and importReminders would have thrown on its first duplicate,
-- which is precisely the case the index exists to survive. A plain UNIQUE index is correct
-- here anyway: SQLite treats NULLs as distinct, so every task that has no reminder (the
-- overwhelming majority) is unaffected.
ALTER TABLE task ADD COLUMN reminder_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reminder_id ON task(reminder_id);
`,
  },
  {
    version: 20,
    name: "extraction_recency_index",
    sql: `
-- Commitment extraction now bounds itself to the last two days (EXTRACT_LOOKBACK). Its
-- selection filters and orders on occurred_at, and there was no index on that column: the
-- owner's interaction table holds 23,457 unextracted rows going back to 2023-07-05, so
-- every worker tick would scan all of them to find the handful that are recent.
--
-- Why the bound exists at all, recorded here because the evidence is worth keeping: the old
-- query ordered by row id — insertion order — with no age limit, so an imported message
-- history presented itself as "newest". Measured in his database, commitments were being
-- created 23, 36, 63, even 83 days after the message was sent. "Do Kumail and Hasan's
-- tasks" was extracted 2026-08-10 from a message sent 2026-05-20.
CREATE INDEX IF NOT EXISTS idx_interaction_extract_scan ON interaction(extracted_at, occurred_at);
`,
  },
];
