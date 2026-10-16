-- PRISM Node migration 001 — Stage 1 foundation tables.
--
-- Conventions (§58.1): every durable entity uses an opaque TEXT PRIMARY KEY
-- (never a filesystem path or row order). Hashes are hex TEXT, expiries are
-- INTEGER unix seconds, scope sets are canonical JSON TEXT arrays.
--
-- Applied idempotently by src/storage/runMigrations inside one
-- BEGIN IMMEDIATE transaction and recorded in _migrations.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  identity_pubkey TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Long-lived owner bootstrap key (§6.3, §22.1): keyed verifier only.
CREATE TABLE IF NOT EXISTS owner_keys (
  key_id TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Paired devices (§22.10): ECDSA P-256 device keys + scope set.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  pubkey TEXT NOT NULL,
  client_class TEXT NOT NULL DEFAULT 'public_static',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- Short-lived device-bound sessions (§22.2): 15m TTL, 24h max.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- WebSocket tickets (§22.4, ADR 0008): looked up by ticket_sha256,
-- consumed in the same transaction as upgrade success; 60s expiry.
CREATE TABLE IF NOT EXISTS tickets (
  ticket_sha256 TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets(session_id);
CREATE INDEX IF NOT EXISTS idx_tickets_expiry ON tickets(expires_at);

-- Proof replay protection (§58.12, ADR 0008): jti expires at iat + 60s.
CREATE TABLE IF NOT EXISTS proof_jti (
  jti TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  iat INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proof_jti_expiry ON proof_jti(expires_at);

-- Node Manager challenges (§6.1): 60s single-use action-bound nonces.
CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  os_principal TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON challenges(expires_at);

-- Pinned Node Manager helper keys (§6.1): writable only inside a
-- helper-signed rotation transaction, never by direct control-plane write.
CREATE TABLE IF NOT EXISTS helper_keys (
  key_id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  pubkey_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

-- Node-level durable security/audit history (§35.2): hash-chained,
-- survives Agent deletion for its retention period.
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  prev_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_node_time ON audit(node_id, created_at);
