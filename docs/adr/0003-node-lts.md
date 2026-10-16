# ADR 0003 — Node.js LTS pin

Status: accepted
Date: 2026-10-16

## Issue

Spec §3.1 and §56 require a pinned Node.js LTS rather than whatever the
host provides.

## Decision

Pin Node.js 22 (`.nvmrc`, `engines >= 22`, CI `node-version: "22"`).
Refresh the pin per release via the support manifest.

## Consequences

- Local toolchains newer than 22 still work; CI is the gate.
- `node:sqlite` availability follows the 22 line (see ADR 0004).
