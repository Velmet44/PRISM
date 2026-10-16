# PRISM

PRISM is an open-source, self-hosted AI workspace/runtime platform for persistent autonomous agents.

V1 scope and architecture are defined in `docs/PRISM_V1_SPEC.md`. That spec is normative for behavior, boundaries, security invariants, and protocol contracts.

## Products

- **PRISM Web** (`web/`) — client application. Static-deployable TypeScript + React + Vite SPA. Not authoritative for state.
- **PRISM Node** (`node/`) — self-hosted authoritative backend/runtime. TypeScript + Node.js control plane, Rust supervisor, Ollama V1 local runtime adapter.

## Repository layout

```text
prism/
├── web/
├── node/
│   ├── src/
│   ├── workers/
│   ├── rust/
│   ├── migrations/
│   ├── installer/
│   └── tests/
├── packages/
│   ├── protocol/
│   ├── schemas/
│   ├── client/
│   └── shared/
├── models/
├── docs/
│   └── adr/
└── LICENSE
```

See `docs/PRISM_V1_SPEC.md` §3 for the full module layout.

## Status

Stage 1 done (bootable Node + Node Manager: config, storage/SQLite WAL,
identity, auth/devices, separated public/NM listeners, installer,
updates stubs). Stage 2 implemented (agent/task/run lifecycle with
fencing + idempotency, cognition loop with taint-preserving compaction,
events/outbox/replay, Ollama model manager, pairing + WS multiplex,
LAN-TLS/rate-limit, Web UI view-models) — build/typecheck/test green;
live E2E exit (restart mid-run and reconcile on Linux + WSL2) pending.

Implementation order follows spec §57: shared protocol/schemas, state machines, storage/event log, auth, policy, isolation, then agent runtime and surrounding systems.

## Development (Stage 0)

Supported dev platforms: Ubuntu 24.04, Debian 12, Windows 10/11
(plus WSL2 Ubuntu for the full Node runtime later). All scripts are plain
`pnpm`/`tsc`/`vitest`/`node` invocations with no shell scripts, so the
same commands work everywhere.

### Prereqs per OS

| Tool | Ubuntu / Debian | Windows |
|---|---|---|
| Node.js 22 | `fnm install 22` (or distro package) | `winget install fnm` then `fnm install 22` |
| pnpm 9.15.9 | `npm install --global pnpm@9.15.9` | same (see note below) |
| Rust | `rustup` honors `rust-toolchain.toml` | same via `rustup-init` |
| Debian only | `apt-get install git curl ca-certificates` | n/a |

Windows note: prefer `npm install --global` over `corepack` for pnpm. If
PowerShell blocks `pnpm.ps1`, run once as the current user:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Commands

```sh
pnpm install
pnpm build        # topological TypeScript builds
pnpm typecheck
pnpm test         # contract suites incl. §58.2 transition matrix
pnpm --filter @prism/schemas export:json  # regenerate generated/*.schema.json
```

CI runs the same four steps on Ubuntu 24.04, a Debian 12 container, and
Windows (`contracts-ubuntu`, `contracts-debian`, `contracts-windows`).

Contracts live in `packages/schemas` (Zod source of truth),
`packages/protocol` (endpoints, headers, `prism.v1`, negotiation),
`packages/shared`, and `packages/client`. Decisions are recorded in
`docs/adr/`. CI covers Ubuntu 24.04, Debian 12, and Windows.

## License

Apache-2.0. See `LICENSE`.
