# ADR 0008 — Ticket storage and proof transport

Status: accepted
Date: 2026-10-16

## Issue

Spec §22.4 and §58.12 freeze ticket schemas and proof canonicalization
but leave storage and transport encoding to engineering.

## Decision

- Tickets live in SQLite (`tickets` table keyed by `ticket_sha256` with
  expiry and scope set), consumed in the same transaction as upgrade
  success; losers of a concurrent redeem get `CONFLICT`.
- `proof_jti` rows expire at `iat + 60s` with a pruning job; insert and
  verification share one transaction.
- Transport headers are frozen: `Authorization: Bearer`,
  `X-PRISM-POP`, `X-PRISM-POP-DOC`, `X-PRISM-SNAPSHOT`.
- WS redemption travels as
  `Sec-WebSocket-Protocol: prism.v1, <ticket>.<sig>` (4KB cap).

## Consequences

- Restart preserves replay protection; revocation closes sockets within
  one heartbeat.
