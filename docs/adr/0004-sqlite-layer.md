# ADR 0004 — SQLite access layer

Status: accepted
Date: 2026-10-16

## Issue

Stage 1 needs transactional invariants: event outbox with in-transaction
sequence assignment, `proof_jti` replay inserts, `fencing_epoch` bumps,
and materialized resync snapshots.

## Decision

Use `node:sqlite` with Kysely as the typed query layer. No native addon,
so Debian and Windows CI stay green. All multi-row invariants run inside
explicit transactions (`BEGIN IMMEDIATE` for fencing bumps and ticket
consumption).

## Consequences

- Driver lands in Stage 1; Stage 0 only freezes the schema contracts in
  `packages/schemas`.
- WAL mode where supported; live WAL files are never copied as backups.
