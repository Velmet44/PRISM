# PRISM Build Stages

Source of truth for behavior: `PRISM_V1_SPEC.md`.
Build order follows spec §57, contracts §59.1 / §58, platforms §8, acceptance §54, tests §47.

Goal: usable early release after Stage 3. Stages 4-8 are additive toward full V1.

Cross-platform rule applies to all stages: Linux native + Windows/WSL2 must build and pass.
Unlisted OS/runtime combo is unsupported and must fail preflight, per §8.
Platform-specific code stays in installer, supervisor/WorkspaceFS, secret store, and Node Manager helper.

---

## Stage 0 — Contracts + cross-platform skeleton

Objective: stop parallel work from diverging. No feature runtime yet.

In scope:
- `packages/schemas/`, `packages/protocol/`, `packages/client/`, `packages/shared/`
- `docs/adr/`
- CI + pinned toolchains

Do:
- Domain entities, stable IDs, `OwnerId` model (§58.1, §50.1).
- All §58.2 state machines: Node, Agent, Task, Run, Step Attempt, Approval, Model Installation, Update, Browser Session, Trigger, Secret Store.
- Generate legal/illegal transition matrix tests.
- Event envelope (§58.3), Node-local monotonic sequence, transactional outbox, cursor replay, `resync_required{snapshot_token,as_of_sequence,expires_at}`, consistent snapshot reads (§23.0, §58.10).
- Auth contracts (§58.12): full-request ES256 proofs with body digest, WS ticket + redemption proof, Tier-4 approval signatures, Tier-5 helper assertions.
- Policy model (§20.3): versioned snapshots, layer intersection, deny-overrides, approval precedence.
- Approval canonicalization + action hash (§58.4).
- Checkpoint + step journal + leases/fencing + `SIDE_EFFECT_UNCERTAIN` reconciliation (§27.2-27.3, §58.6, §58.9).
- Capability registry (§58.8), pagination/concurrency (§58.7), error codes including `RESYNC_REQUIRED`, `SECRETS_LOCKED` (§58.5).
- API idempotency/retry discipline (§58.11).
- ADRs closing §56 choices: distro matrix, container runtime, Node LTS, SQLite layer, secret backends, proxy backend, extractor, ticket storage.
- Pin Node.js LTS, Rust toolchain, package manager. Add `main` CI for Linux x86_64/arm64 and Windows/WSL2.

Exit:
- Schemas versioned, transition matrix green on Linux and WSL2.
- No feature code depending on uncommitted contracts.

## Stage 1 — Bootable Node + Node Manager

Objective: trustworthy local admin boundary.

In scope:
- `node/src/config/`, `storage/`, `identity/`, `auth/`, `devices/`, `node-manager/`, `api/` listener split
- `node/migrations/`, `node/installer/`
- `node/src/updates/` stubs for health reporting only

Do:
- Data root layout (§49), SQLite + WAL, online-backup-only rule.
- Node Ed25519 identity, pinning, rotation = re-pair (§22.9).
- Owner key `prism_ok_*` as keyed verifier only, shown once (§6.3, §22.1).
- DEK/KEK hierarchy (§21.1): unattended OS KEK where supported, else Argon2id passphrase + `DEGRADED/secrets_locked`, no plaintext fallback.
- Separate public vs Node Manager listeners/registries/middleware/audit (§6.1). Linux UDS + loopback bridge. Windows/WSL2 loopback + `prism-admin` helper.
- Fresh PAM / secure-desktop step-up, pinned helper key, 60s single-use action-bound assertions. Rotation revokes old key.
- Installer: service users, private runtime install, Ollama/Chromium/cloudflared as managed deps, idempotent re-run.
- Reboot: auto-start; secret-dependent work stays paused while locked (§7.2).

Exit:
- Node Manager usable locally with and without unlocked secrets.
- Tier-5 via public API always `UNAUTHORIZED`.
- Loopback alone never authenticates.
- WSL stop/start/sleep tested.

## Stage 2 — First usable agent

Objective: one Main Agent that can do durable work end to end.

In scope:
- `node/src/agents/`, `tasks/`, `runs/`, `scheduler/` basic, `orchestration/`, `events/`, `models/`, `resources/` basic
- `node/workers/agent/`, `node/workers/task/`, `node/workers/model/`
- `packages/client/`
- `web/app/`, `state/`, `lib/`, `features/main-agent/`, `features/tasks/`, `features/runs/`, `features/models/`, `features/nodes/`

Do:
- Pairing: QR/single-use token, device ECDSA P-256, short sessions, revocation kills sessions/tickets/approvals (§22.2, §22.10).
- LAN TLS default. Rate limit + key lockout + audit (§22.8).
- Main Agent cognition loop (§17.1), L0-L6 precedence, provenance labels, compaction without laundering taint.
- Task/Run lifecycle + new attempt on restart, never resume terminal (§27.5).
- Approval consumption atomic with step `STARTED` + idempotency key; fencing epoch advances on restart; stale worker cannot dispatch/commit.
- Model Manager + Ollama adapter + shared weights; explicit model select + one auto profile. No BYOK families yet.
- WS multiplex: one socket per Node, durable replay + ephemeral deltas, partial-message recovery.
- Web: Nodes list, Main Agent chat, runs/approvals basic view. Sanitized markdown, sandboxed artifacts (§22.7).

Exit:
- Create agent, run task, observe live events, restart mid-run and reconcile.
- Same on Linux and WSL2.

## Stage 3 — Early release candidate

Objective: safe enough for real use. Release here if desired.

In scope:
- `node/src/permissions/`, `capabilities/`, `approvals/`, `taint/`, `tools/`, `skills/` registry, `artifacts/`, `files/`, `memory/`, `backups/`, `audit/`
- `web/features/agents/`, `artifacts/`, `activity/`, `approvals/`, `settings/`
- `node/src/remote-access/` quick tunnel only

Do:
- Tool registry with tier/scope/idempotency/approval/audit (§20.5). Tiers 0-3 + Tier-4 device signatures.
- Taint labels + high-water mark + default matrix (§43.3.2). Narrow owner relaxations only for exact read-only origin/method/path/query.
- Quarantined reader enforced: arbitrary ingestion cannot hold credentials/private-data/external-send. Authenticated browser config deferred to Stage 5.
- `.prism` import as untrusted boundary: attenuated, `unreviewed`, no egress/credentials, schedules disabled. Review grants nothing by itself.
- Artifacts immutable/content-addressed, taint-carrying, safe rendering.
- Memory entries `{label,source_run_id,written_by}`, owner inspect/promote.
- Basic schedules with timezone/DST/missed-run policy. Persistent wake/sleep.
- Resource pool config + host headroom. Hard/best-effort/accounting labels honest (§9.3, §48.2).
- Encrypted backup/restore: AES-GCM/libsodium stream + Argon2id, SQLite online snapshot, hardened extractor, atomic restore, no silent trust-root overwrite (§40).
- `quick_tunnel` temporary mode, endpoint independence, TLS visibility disclosure. No stable mode yet.
- Telemetry off by default.

Exit:
- §54 core demo passes: install, reboot, resource config, pairing, agent create/delegate (Main only), artifact transfer, approval, checkpoint recovery, backup/restore, rollback notification.
- Publish support manifest with tested combos.

## Stage 4 — Multi-agent + delegation trust

Objective: Main Agent supervision without confused deputy.

In scope:
- `node/src/messaging/`, `orchestration/` full, `agents/` specialists
- `web/features/main-agent/` delegation tree

Do:
- Specialist lifecycle: create/configure/pause/cancel/restart-from-checkpoint, reset preserves definition, delete = Tier-4.
- Config history + undo, subject to quarantine rejection.
- A2A durable bus, authorization graph, taint propagation, no direct specialist-to-specialist creation.
- Hop/depth/budget/deadline fan-out guards (§25.5, §29).
- Tainted Main Agent: all privileged control-plane actions need approval.
- Read-only live inspection + pause/cancel/intervene, no specialist direct chat.

Exit:
- Injection corpus via messages/memory/import causes no unauthorized credential/egress/policy change.
- Capability attenuation tests green.

## Stage 5 — Browser + egress isolation

Objective: close the largest exfiltration path.

In scope:
- `node/src/browser/`, `egress/`, `networking/`, `credentials/`, `tools/` browser tools
- `node/rust/supervisor/`, `sandbox/`, `network/`, `workspacefs/`, `resources/`
- `node/workers/parser/`
- `web/features/browser/`, `files/`

Do:
- Per-Agent filesystem/subvolume hardlink domains. WorkspaceFS `openat2` no-follow + mount/device/ownership checks. Byte-copy transfers/backups only.
- Private rootless runtime under `prism-sup`, declarative supervisor IPC with `start/fence/stop`, `SO_PEERCRED`, vetted templates.
- Distinct OS users, `0700` dirs, no DB/runtime/workspace cross-access (§36.3).
- Parser sandbox: no network, caps, taint-labelled output.
- Internal-only sandbox net, proxy-owned DNS, validate-then-pin, redirect revalidation, UDP/ICMP drop, no TLS interception.
- Run-bound egress grants: lease revoke closes connections before replacement admitted.
- Chromium in sandbox, no `--no-sandbox`, QUIC off, WebRTC non-proxied UDP blocked.
- Pre-transmission request interception for page/service-worker/subresource/nav. Exact origin/path/method/query allowlists. Read-only = explicit scope + no credentials/body/dynamic data.
- Origin-bound credential injection, placeholders to model. Login Assist: Tier-4 gated, domain-locked, model-blinded, unlogged input, 10-min default.
- `shell.network` denied from tainted contexts. Package installs allowlisted mirrors only.

Exit:
- SSRF/rebinding/redirect/DNS-tunnel/UDP/QUIC corpus fails closed.
- Symlink/hardlink/race/zip-slip/bomb tests leak no host data.
- Login Assist E2E with masking + audit boundaries.

## Stage 6 — Models, budgets, triggers

Objective: production inference and automation.

In scope:
- `node/src/models/` full, `resources/` full, `triggers/`, `scheduler/` full, `notifications/` beacon only
- `web/features/models/`, `settings/` providers

Do:
- Provider families: OpenAI-compatible, Anthropic, Gemini, Ollama local. Validate OpenCode Go compat, do not assume.
- Routing profiles: fast/reasoning/vision/long-context/cheap/local + explicit override. Expose final selection.
- Cost estimate then reconcile, versioned pricing, unknown marked unknown. Hard budgets stop/pause, never silent overspend.
- GPU best-effort unless backend enforces; VRAM estimates queue work; admission = sandbox + inference + network.
- Triggers: schedules, webhooks with HMAC/timestamp/replay/rate-limit, file watchers, event/A2A runs. Webhooks disabled on `quick_tunnel` unless owner accepts instability.
- Endpoint beacon signed webhook/ntfy/SMTP, no secrets.

Exit:
- Budget exhaustion stops run.
- DST, missed-run, quota-class tests green.

## Stage 7 — Stable remote + updates

Objective: leave temporary-only access and unsafe updates behind.

In scope:
- `node/src/remote-access/` stable modes, `updates/`, `node-manager/` update UX

Do:
- `named_tunnel` and/or `external_proxy`. Ingress allowlist `/v1/*`, `/ws`, `/hooks/*`, bundled assets only.
- Reconnect without re-pair on stable origins. Ephemeral `quick_tunnel` origins must re-pair with explanation.
- Tunnel TLS-visibility disclosure. Identity pinning detects impersonation, not passive observation.
- Headless bootstrap via short single-use pairing code, never key in args/logs/QR/URL.
- Signed updates: TUF-like metadata, rotation/revocation, anti-downgrade floor, pinned bootstrap trust.
- Drain/stage/health-check/commit, expand/contract migrations, verified pre-migration snapshot, auto rollback, user-visible failure.

Exit:
- Broken update rolls back + notifies.
- Corrupt/tampered restore recovers or safely aborts.
- Stable endpoint + restart tested on WSL2.

## Stage 8 — V1 hardening and acceptance

Objective: prove §54 + §47.

Do:
- Full E2E §47.3: install through failed-update rollback.
- Deterministic mock-model harness + failure injection.
- Security corpus: prompt injection, `.prism` escalation, child capability escalation, approval TOCTOU/replay, pairing/WS replay, CSP/no embedded secrets, backup/update attacks, session theft, content isolation, Login Assist blindness, taint persistence, brute-force lockout, worker privilege separation.
- Recovery/resource tests: every step boundary crash, fencing before/after dispatch, snapshot resync under retention pressure, concurrent writers, `RECOVERY_REQUIRED` resolutions, unattended timeout to `FAILED`.
- Publish release support manifest + evidence per combo. Freeze release signing.

Exit:
- V1 acceptance green on every listed Linux + WSL2 combo.
- No silent weakening: missing baseline refuses sandboxes with reason.
