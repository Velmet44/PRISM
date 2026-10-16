# AGENTS.md

## Sources of truth

- `docs/PRISM_V1_SPEC.md` is normative for behavior, boundaries, security
  invariants, and protocol contracts. `docs/STAGES.md` defines build order.
  If they conflict, the spec wins.
- `packages/schemas` (Zod) is the source of truth for all §58 contracts.
  `packages/schemas/generated/*.schema.json` is produced by
  `pnpm --filter @prism/schemas export:json` — never hand-edit it.
- Architecture decisions live in `docs/adr/`. Changing a frozen contract
  (§59.1) requires an architectural record, not just code.

## Commands

```sh
pnpm install            # pnpm 9.15.9, Node.js 22 (see .nvmrc)
pnpm build              # topological; must run before typecheck/test
pnpm typecheck
pnpm test
```

- Required order: `build` → `export:json` → `typecheck` → `test`.
  Cross-package imports resolve to `dist`, so tests and typecheck fail on
  stale builds. Rebuild after touching `packages/*/src`.
- Focused checks: `pnpm --filter @prism/schemas test`,
  `pnpm --filter @prism/protocol build`, etc.
- CI (`contracts-ubuntu`, `contracts-debian`, `contracts-windows`) also
  runs `export:json` then `git diff --exit-code` on `generated/` —
  commit regenerated schemas with the change.
- Each package has two configs: `tsconfig.json` (composite emit of `src`
  only) and `tsconfig.typecheck.json` (`noEmit`, covers `src` + `tests`).

## Repo layout

- `packages/{schemas,protocol,shared,client}` — the only implemented code
  (Stage 0). `web/`, `node/`, `models/` are empty scaffold dirs kept alive
  by leaf `.gitkeep` files; delete the `.gitkeep` when a directory gains
  real files (never keep both).
- `node/` is the future authoritative backend; `web/` must never own
  canonical state (§53.1). Don't invert this when scaffolding.
- `packages/protocol` re-exports wire constants only; new contract shapes
  go in `packages/schemas` first.

## Environment quirks (this machine)

- Install pnpm with `npm install --global pnpm@9.15.9`; `corepack`
  fails with EPERM here.
- Shell is PowerShell: use `Select-Object -First N` instead of `head`,
  and expect git's stderr noise (`To https://...`) on push —
  `main -> main` in the output means success.
- Run long commands (`install`, `build`, `test`) in the background when
  other work can proceed in parallel.
- Line endings are forced LF via `.gitattributes`; don't fight it.
