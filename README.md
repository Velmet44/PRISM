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

Early scaffold. Folders and spec only. No runtime implementation yet.

Implementation order follows spec §57: shared protocol/schemas, state machines, storage/event log, auth, policy, isolation, then agent runtime and surrounding systems.

## Development (Stage 0)

Prereqs: Node.js 22 (`nvm use`), pnpm 9.15.9, Rust stable (see
`rust-toolchain.toml`).

```sh
pnpm install
pnpm build        # topological TypeScript builds
pnpm typecheck
pnpm test         # contract suites incl. §58.2 transition matrix
pnpm --filter @prism/schemas export:json  # regenerate generated/*.schema.json
```

Contracts live in `packages/schemas` (Zod source of truth),
`packages/protocol` (endpoints, headers, `prism.v1`, negotiation),
`packages/shared`, and `packages/client`. Decisions are recorded in
`docs/adr/`. CI covers Ubuntu 24.04, Debian 12, and Windows.

## License

Apache-2.0. See `LICENSE`.
