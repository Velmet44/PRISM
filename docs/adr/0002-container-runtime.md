# ADR 0002 — Private container runtime default

Status: accepted
Date: 2026-10-16

## Issue

Spec §36.4 requires a PRISM-managed private rootless runtime under the
`prism-sup` user and forbids touching the host engine.

## Decision

Default to rootless Podman; accept rootless Docker only where Podman is
unavailable, pinned per release in the support manifest. Selection is
validated by preflight: systemd delegation, userns/subuid ranges,
`openat2`, and the cross-agent `link()` hardlink-isolation probe (§16.1).

## Consequences

- Installer owns runtime storage and the `0600` socket; the supervisor is
  the only socket client.
- Sandbox profiles land in Stage 5; this ADR only freezes selection rules.
