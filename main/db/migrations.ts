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
];
