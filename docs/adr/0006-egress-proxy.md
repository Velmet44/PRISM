# ADR 0006 — Egress proxy backend

Status: accepted
Date: 2026-10-16

## Issue

Spec §37.3 mandates an internal-only sandbox network, proxy-owned DNS,
validate-then-pin, per-hop redirect revalidation, UDP/ICMP drop, no TLS
interception, and run-bound `{run_id,epoch}` grants with 5-second fence
timeouts.

## Decision

Build the egress proxy as a dedicated local process owned by the
`prism-proxy` user (Rust implementation lands with the supervisor in
Stage 5). Network rules permit only the proxy address/port. Browser
requests are additionally intercepted at `browserContext` level before
encryption; the proxy itself stays host/port-only and never claims
path/body inspection.

## Consequences

- Package-install reaches allowlisted mirrors with pinned hashes only.
- `shell.network` and opaque tools stay denied from tainted contexts.
