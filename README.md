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

## License

Apache-2.0. See `LICENSE`.
