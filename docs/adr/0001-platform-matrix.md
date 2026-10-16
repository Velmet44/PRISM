# ADR 0001 — Supported platform matrix

Status: accepted
Date: 2026-10-16

## Issue

Spec §8 requires a machine-readable support manifest with passing test
evidence for every listed combination. The first matrix must prove both
Linux native and Windows paths without exploding CI cost.

## Decision

Stage 0 certifies three combinations, modeled in
`packages/schemas/examples/support-manifest.example.json`:

- Ubuntu 24.04 x86_64 and aarch64, kernel 6.8, systemd 255.
- Debian 12 x86_64, kernel 6.1, systemd 252.
- WSL2 Ubuntu 24.04 x86_64 via the Windows secure-desktop helper.

Unlisted combinations are unsupported and fail preflight with
`UNSUPPORTED` plus `missing_requirement` remediation.

## Consequences

- CI runs Ubuntu 24.04, a Debian 12 container, and Windows.
- WSL2 systemd behavior is validated on release branches; CI proves the
  shared TypeScript contracts on Windows.
