# ADR 0007 — Hardened extractor and WorkspaceFS

Status: accepted
Date: 2026-10-16

## Issue

Spec §16.1 treats workspaces as hostile: symlinks, hardlinks, special
files, racing renames, zip-slip, and decompression bombs.

## Decision

One hardened extractor for every archive entering PRISM (`.prism`,
restore, uploads): reject absolute paths, `..`, symlinks, hardlinks,
devices/FIFOs/sockets; cap size, ratio, entries, depth, and name length;
create descriptor-relative. WorkspaceFS resolves via `openat2`
beneath/no-symlink/no-magiclink, verifies `(st_dev,st_ino)` plus
ownership, scans `nlink`, and copies bytes only. Backends are allowlisted
per manifest with a cross-agent `link()` preflight probe.

## Consequences

- Rust implementation lands in Stage 5; contracts are frozen now.
- Internal hardlinks stay workspace-local and are never preserved.
