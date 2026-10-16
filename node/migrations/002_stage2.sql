-- PRISM Node migration 002 — Stage 2 durable-work tables.
--
-- Conventions (§58.1, matching 001_init.sql): every durable entity uses an
-- opaque TEXT PRIMARY KEY (never a filesystem path or row order); hashes are
-- hex TEXT; expiries are INTEGER unix seconds; scope sets and other
-- structured fields are canonical JSON TEXT.
--
-- Covers the Stage 2 aggregates: agents, tasks, runs, steps, step_attempts
-- (+ durable worker leases and the §27.2 fencing epoch), the §23.0 event log
-- (events + transactional outbox + resync snapshots), the Stage 2 model
-- catalog (shared Node-level weights, §31.3), and single-use pairing tokens.
--
-- Applied idempotently (every statement is IF NOT EXISTS).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Agents (§10): persistent entities with stable identity. Main Agent plus
-- future specialists; specialists are created only via the Main Agent (§25.4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'READY',
  config_json TEXT NOT NULL DEFAULT '{}',
  model_ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- ---------------------------------------------------------------------------
-- Tasks (§26): the durable unit of requested work. A Task outlives any one
-- Run attempt; terminal Tasks never resume (§27.5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  owner_id TEXT NOT NULL DEFAULT '',
  parent_task_id TEXT REFERENCES tasks(task_id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  recovery_policy TEXT NOT NULL DEFAULT 'auto_reconcile',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

-- ---------------------------------------------------------------------------
-- Runs (§26.1): one execution attempt of a Task. Restarting from a
-- checkpoint always creates a new attempt (attempt_no + 1); terminal Runs
-- never resume (§27.5). model_selection_json records the final resolved
-- model/provider per §30.1 routing precedence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  attempt_no INTEGER NOT NULL DEFAULT 1,
  restart_of_run_id TEXT,
  from_checkpoint_id TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  model_ref TEXT NOT NULL DEFAULT '',
  model_selection_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_ref TEXT,
  resource_json TEXT NOT NULL DEFAULT '{}',
  event_cursor INTEGER NOT NULL DEFAULT 0,
  recovery_state TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- ---------------------------------------------------------------------------
-- Steps + step attempts (§27.2): every executable step has a durable journal
-- record with stable StepId, unique StepAttemptId, request hash, idempotency
-- key, approval ref, worker lease, fencing token, and reconciliation status.
-- The partial unique index prevents two ACTIVE attempts owning one step.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  request_hash TEXT,
  idempotency_key TEXT,
  approval_ref TEXT,
  worker_lease TEXT,
  fencing_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  result_receipt TEXT,
  reconciliation TEXT NOT NULL DEFAULT 'none',
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);

CREATE TABLE IF NOT EXISTS step_attempts (
  step_attempt_id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT,
  approval_ref TEXT,
  worker_lease TEXT NOT NULL DEFAULT '',
  fencing_token TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_receipt TEXT,
  reconciliation TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS idx_step_attempts_step ON step_attempts(step_id);
CREATE INDEX IF NOT EXISTS idx_step_attempts_run ON step_attempts(run_id);
-- §27.2: at most one unfinished attempt may own a step.
CREATE UNIQUE INDEX IF NOT EXISTS uq_step_attempts_active_step
  ON step_attempts(step_id) WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- Fencing epoch (§27.2): fencing_epoch(epoch INTEGER PRIMARY KEY
-- AUTOINCREMENT, bumped_at). Bumped once in a single BEGIN IMMEDIATE
-- transaction at boot before any admission; never restored from backup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fencing_epoch (
  epoch INTEGER PRIMARY KEY AUTOINCREMENT,
  bumped_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Leases: bounded execution leases granted to workers. Every tool-broker
-- dispatch and result commit presents the lease's fencing token; only the
-- current token may commit (§27.2–§27.3). token_sha256 is the lookup for the
-- run-scoped capability token (hex SHA-256 of the secret, never the secret).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_attempt_id TEXT,
  holder TEXT NOT NULL DEFAULT '',
  fencing_token TEXT NOT NULL DEFAULT '',
  token_sha256 TEXT NOT NULL DEFAULT '',
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leases_run ON leases(run_id);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_leases_token ON leases(token_sha256);

-- ---------------------------------------------------------------------------
-- Event log (§23.0, §58.3): durable, ordered, Node-local monotonic sequence.
-- sequence is assigned inside the committing transaction and published only
-- after commit (transactional outbox). Payloads are held by reference
-- (payload_ref); security_audit rows are redacted at delivery (§23.0).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  node_id TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  step_id TEXT,
  step_attempt_id TEXT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  payload_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  security_class TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_sequence ON events(sequence);
CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events(agent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

-- Transactional outbox: one row per not-yet-published event, inserted in the
-- same transaction as the event row and deleted after publish-after-commit.
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  envelope_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON outbox(published_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_sequence ON outbox(sequence);

-- ---------------------------------------------------------------------------
-- Resync snapshots (§23.0, §58.3): snapshots{id,H,filter_hash,expires_at,
-- payload_ref}. Materialized in the same transaction that reads the event
-- head H; payload reads paginate from the stored row, never live tables.
-- Active tokens capped at 32 per Node / 4 per session (LRU); expiry is never
-- extended (§53 invariants 49, §53.1 invariant 23).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  h INTEGER NOT NULL,
  filter_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  payload_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_node ON snapshots(node_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON snapshots(expires_at);

-- ---------------------------------------------------------------------------
-- Model catalog, Stage 2 (§31): catalog entry vs installed weights vs loaded
-- session are distinct states; weights are shared at Node level (§31.3,
-- invariant 10). model_id is the Agent-facing reference (e.g. qwen3-30b),
-- never an Ollama-specific implementation name (§31). Stage 2 admits only
-- the Ollama local-runtime family; BYOK families arrive in Stage 6.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS models (
  model_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT 'ollama',
  runtime TEXT NOT NULL DEFAULT 'ollama',
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  weights_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  installed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);

-- ---------------------------------------------------------------------------
-- Pairing tokens (§22.2, §22.10): single-use, short-lived bootstrap tokens
-- (QR / manual). Only token_sha256 is stored for lookup; the secret itself
-- is shown once. Consumed in the same transaction as pairing success.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pairing_tokens_sha
  ON pairing_tokens(token_sha256);
CREATE INDEX IF NOT EXISTS idx_pairing_tokens_expiry
  ON pairing_tokens(expires_at);
