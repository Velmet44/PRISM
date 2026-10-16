/**
 * PRISM Node storage — Stage 1.
 *
 * SQLite via `node:sqlite` (no native addons) with Kysely used for
 * *types only* (ADR 0004). Runtime access goes through `DatabaseSync`;
 * `Kysely<DatabaseSchema>` is exported as a type so later stages can adopt
 * the typed query layer without changing the schema contract.
 *
 * Invariants:
 * - WAL mode (`PRAGMA journal_mode=WAL`) where supported (§41).
 * - All multi-row invariants run inside explicit transactions;
 *   fencing bumps and ticket consumption use `BEGIN IMMEDIATE` (ADR 0004).
 * - Backups use the SQLite online backup API; live WAL files are never
 *   file-copied as a database backup (§40.3).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import type { Kysely } from "kysely";

// ---------------------------------------------------------------------------
// Row types (Stage 1 tables). IDs are opaque TEXT PRIMARY KEYs (§58.1);
// hashes are hex TEXT; expiries are INTEGER unix seconds; scope sets and
// other structured fields are canonical JSON TEXT.
// ---------------------------------------------------------------------------

export interface NodesRow {
  /** NodeId (§58.1). */
  node_id: string;
  /** Raw Ed25519 base64/hex public key material (public metadata only). */
  identity_pubkey: string;
  /** hex(SHA256(raw pubkey)) fingerprint (§22.9). */
  fingerprint: string;
  created_at: number;
  updated_at: number;
}

export interface OwnerKeysRow {
  /** Non-secret key identifier from `prism_ok_<key-id>_…` (§22.1). */
  key_id: string;
  /** Keyed verifier HMAC-SHA-256 under the Node-local pepper (§6.3). Never a secret. */
  verifier: string;
  created_at: number;
  revoked_at: number | null;
}

export interface DevicesRow {
  device_id: string;
  name: string;
  /** Device ECDSA P-256 public key (§22.2). */
  pubkey: string;
  /** `bundled` | `public_static` | Node-assigned class (§22.6). */
  client_class: string;
  /** JSON array of scope strings (§58.12 vocabulary). */
  scopes_json: string;
  status: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface SessionsRow {
  session_id: string;
  device_id: string;
  node_id: string;
  /** JSON array of scope strings. */
  scopes_json: string;
  issued_at: number;
  /** 15-minute TTL sessions, 24-hour max (§53.1 invariant 42). */
  expires_at: number;
  revoked_at: number | null;
}

export interface TicketsRow {
  /** hex(SHA256(ticket_secret)) — lookup key, never the secret (§22.4). */
  ticket_sha256: string;
  ticket_id: string;
  session_id: string;
  device_id: string;
  node_id: string;
  nonce: string;
  /** JSON array drawn from streams:/control: vocab (§22.4). */
  scopes_json: string;
  issued_at: number;
  /** Tickets/nonces expire in 60 seconds (§22.4). */
  expires_at: number;
  consumed_at: number | null;
}

export interface ProofJtiRow {
  /** 128-bit hex proof nonce; replay protection (ADR 0008). */
  jti: string;
  node_id: string;
  session_id: string;
  device_id: string;
  iat: number;
  /** Rows expire at `iat + 60s` with a pruning job (ADR 0008). */
  expires_at: number;
}

export interface ChallengesRow {
  challenge_id: string;
  /** 128-bit hex nonce (§6.1). */
  nonce: string;
  /** Exact action hash, or `ROTATE_HELPER` for rotation (§6.1). */
  action_hash: string;
  issued_at: number;
  /** `issued_at + 60s`; single-use (§6.1). */
  expires_at: number;
  consumed_at: number | null;
  os_principal: string | null;
}

export interface HelperKeysRow {
  key_id: string;
  /** Pinned per-install ECDSA P-256 helper public key (§6.1). */
  pubkey: string;
  /** Hash of the pinned key, mirrored in the database (§6.1). */
  pubkey_hash: string;
  created_at: number;
  revoked_at: number | null;
  active: number;
}

export interface AuditRow {
  id: string;
  node_id: string;
  event_type: string;
  actor: string;
  /** Canonical JSON payload (no secret material). */
  payload_json: string;
  /** Hash-chain link (§35.2 / §53.1 invariant 24). */
  hash: string;
  prev_hash: string | null;
  created_at: number;
}

/** Kysely schema for the Stage 1 tables (types only at runtime). */
export interface DatabaseSchema {
  nodes: NodesRow;
  owner_keys: OwnerKeysRow;
  devices: DevicesRow;
  sessions: SessionsRow;
  tickets: TicketsRow;
  proof_jti: ProofJtiRow;
  challenges: ChallengesRow;
  helper_keys: HelperKeysRow;
  audit: AuditRow;
}

/** Typed query-layer handle for later stages. Type-only: no runtime import. */
export type PrismKyselyDb = Kysely<DatabaseSchema>;

/** Stage 1 table names. */
export const STAGE1_TABLES = [
  "nodes",
  "owner_keys",
  "devices",
  "sessions",
  "tickets",
  "proof_jti",
  "challenges",
  "helper_keys",
  "audit",
] as const;

export type Stage1Table = (typeof STAGE1_TABLES)[number];

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

export interface OpenDatabaseOptions {
  /** Run `migrations/001_init.sql` when true (default). */
  migrate?: boolean;
  /** Directory containing `001_init.sql`. Auto-detected when omitted. */
  migrationsDir?: string;
  /** SQLite busy timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface PrismDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  close(): void;
}

function candidateMigrationsDirs(explicit?: string): string[] {
  if (explicit !== undefined && explicit !== "") {
    return [explicit];
  }
  const here = new URL(".", import.meta.url);
  return [
    new URL("../../migrations/", here).pathname,
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "node/migrations"),
  ];
}

function findMigrationFile(explicitDir?: string): string | null {
  for (const dir of candidateMigrationsDirs(explicitDir)) {
    const file = path.join(dir, "001_init.sql");
    try {
      if (fs.statSync(file).isFile()) {
        return file;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Pragmas applied to every opened database (§41: WAL where supported). */
export function applyPragmas(db: DatabaseSync, timeoutMs = 5000): void {
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(timeoutMs)};`);
  } catch {
    // busy_timeout is advisory; ignore when unsupported (e.g. :memory:).
  }
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL may be unsupported on :memory: or exotic filesystems; fall back silently.
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // keep default journal mode
  }
}

/**
 * Apply `migrations/001_init.sql` inside a single transaction and record
 * it in `_migrations`. Re-running is a no-op (idempotent).
 */
export function runMigrations(db: DatabaseSync, migrationsDir?: string): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`,
  );
  const applied = new Set<string>(
    db
      .prepare("SELECT version FROM _migrations;")
      .all()
      .map((row) => (row as { version: string }).version),
  );
  if (applied.has("001")) {
    return [];
  }
  const file = findMigrationFile(migrationsDir);
  if (file === null) {
    throw new Error(
      "storage: cannot locate migrations/001_init.sql (pass migrationsDir explicitly)",
    );
  }
  const sql = fs.readFileSync(file, "utf8");
  const nowSec = Math.floor(Date.now() / 1000);
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO _migrations(version, applied_at) VALUES ('001', ?);").run(nowSec);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // already rolled back by SQLite
    }
    throw err;
  }
  return ["001"];
}

/**
 * Open (creating parent dirs) a PRISM SQLite database with WAL and
 * Stage 1 migrations applied.
 */
export function openDatabase(dbPath: string, opts?: OpenDatabaseOptions): PrismDatabase {
  const absolute = path.resolve(dbPath);
  if (absolute !== ":memory:") {
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(absolute === ":memory:" ? ":memory:" : absolute);
  applyPragmas(db, opts?.timeoutMs ?? 5000);
  if (opts?.migrate !== false && absolute !== ":memory:") {
    runMigrations(db, opts?.migrationsDir);
  } else if (opts?.migrate !== false) {
    // :memory: databases still get the schema; locate the SQL the same way.
    runMigrations(db, opts?.migrationsDir);
  }
  return {
    db,
    path: absolute,
    close(): void {
      db.close();
    },
  };
}

/**
 * Run `fn` inside an explicit transaction. `immediate=true` (default)
 * uses `BEGIN IMMEDIATE` so fencing bumps and ticket consumption
 * serialize writers (ADR 0004). Throws when already in a transaction —
 * callers needing nesting should use SAVEPOINTs explicitly.
 */
export function withTransaction<T>(
  db: DatabaseSync,
  fn: (db: DatabaseSync) => T,
  immediate = true,
): T {
  if (db.isTransaction) {
    throw new Error("storage: withTransaction does not support nested transactions");
  }
  db.exec(immediate ? "BEGIN IMMEDIATE;" : "BEGIN;");
  try {
    const result = fn(db);
    if (result instanceof Promise) {
      throw new Error("storage: withTransaction callback must be synchronous");
    }
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore secondary rollback failures
    }
    throw err;
  }
}

/**
 * Transactionally consistent database snapshot via the SQLite online
 * backup API (§40.3). NEVER file-copies the live database or WAL files.
 *
 * The destination is overwritten when it exists. The source database must
 * be open; an internal handle is opened when a path is given.
 */
export async function backupDatabase(
  source: DatabaseSync | string,
  destPath: string,
): Promise<{ destPath: string; pages: number }> {
  const absolute = path.resolve(destPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  if (typeof source !== "string") {
    const pages = await sqliteBackup(source, absolute);
    return { destPath: absolute, pages };
  }
  const src = new DatabaseSync(path.resolve(source));
  try {
    const pages = await sqliteBackup(src, absolute);
    return { destPath: absolute, pages };
  } finally {
    src.close();
  }
}

/** Delete expired `proof_jti` rows (ADR 0008 pruning job hook). */
export function pruneExpiredJti(db: DatabaseSync, nowSec?: number): number {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const result = db.prepare("DELETE FROM proof_jti WHERE expires_at <= ?;").run(now);
  return Number(result.changes ?? 0);
}
