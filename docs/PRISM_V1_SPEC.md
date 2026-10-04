# PRISM V1 — Product & Technical Specification

**Status:** V1 product and technical specification
**Scope:** PRISM V1
**Repository model:** One monorepo containing PRISM Web and PRISM Node

> This document is the V1 product and architecture contract. It is intentionally detailed. Implementation details may evolve, but behavior, boundaries, security invariants, and protocol contracts defined here should be treated as requirements unless explicitly revised.

### Normative language

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / MUST NOT** define release-blocking requirements and invariants.
- **SHOULD / SHOULD NOT** define strong defaults; deviation requires a documented engineering reason and equivalent protection.
- **MAY** identifies an implementation option that does not change externally observable contracts.
- Security, authorization, isolation, durability, and protocol requirements are normative even when an implementation mechanism remains open.

PRISM must fail closed when a required security or authorization decision cannot be determined.

### Terminology

- **Node** (capitalized) always means PRISM Node. The JavaScript runtime is always written **Node.js**.
- **Owner key** is the long-lived Node API key: a bootstrap/recovery credential that is displayed once and is never a day-to-day session credential (§22.1).
- **Device** is a paired client that holds a non-extractable device key. **Session** is a short-lived credential constrained to a device (§22.2). **Automation token** is a scoped, expiring credential for non-browser clients that can never satisfy approvals (§22.10).
- **Durable event** is a recorded, replayable entry in the Node event log. **Ephemeral stream** is live-only data such as token deltas and browser frames (§23.0).
- **Tainted** content and contexts are defined in §43.3. **WorkspaceFS** is defined in §16.1, the **egress proxy** in §37.3, and **Login Assist** in §18.4.

## 1. Product Definition

PRISM is an open-source, self-hosted AI workspace/runtime platform for persistent autonomous agents.

PRISM is not primarily a chatbot, coding IDE, model provider, or hosted SaaS assistant. Its primary abstraction is a persistent **Agent Workspace**: an agent identity plus isolated state, tools, permissions, resources, memory, browser state, schedules, and execution capability.

V1 is single-user at the Node level and requires no PRISM cloud account.

The system is divided into exactly two top-level products in the same repository:

1. **PRISM Web** — the client application/interface.
2. **PRISM Node** — the self-hosted authoritative backend/runtime.

The Web application is not authoritative for state. The Node owns the durable state and exposes the canonical PRISM protocol/API.

### 1.1 Core principles

- Node-first architecture.
- Self-hosting is a first-class deployment mode, not a development-only mode.
- No mandatory PRISM-operated backend for V1.
- One Web client can connect to multiple Nodes.
- Public PRISM Web and Node-bundled Web use the same application code/build.
- The Main Agent is a privileged Agent, not a separate architectural species.
- Specialized Agents are persistent workers controlled by the Main Agent.
- Agent execution is durable and recoverable.
- Tool access is capability-based and policy-mediated.
- Human approval can be mandatory and cannot be overridden by model output.
- Agent workspaces are isolated; explicit artifact/file transfer is used between agents.
- Local model inference is provider-abstracted. Ollama is the V1 local runtime adapter.
- PRISM automatically manages its required runtime dependencies and updates them as a tested bundle.
- No inbound port forwarding is required for remote access.
- Trust is anchored in the Node identity key and paired-device keys, never in a network endpoint URL.
- Agent-produced content is untrusted data in every rendering surface.

## 2. V1 Scope

V1 is intentionally broad. The release delivers the complete V1 workspace/runtime experience defined in this document.

### 2.1 Included in V1

- PRISM Web application.
- PRISM Node self-hosted appliance.
- Main Agent.
- Persistent specialized Agents.
- Agent-to-agent messaging.
- Main Agent supervision of multi-agent execution.
- Agent creation/configuration/deletion.
- Agent configuration history and undo.
- Agent export/import via `.prism` packages.
- Node/full-state backup via encrypted ZIP-style backup packages.
- Agent reset while preserving definition.
- Isolated per-agent workspaces.
- Persistent memory/state.
- Persistent browser profiles when enabled.
- Browser automation using Chromium + Playwright.
- Live browser state viewing, not screenshot-only viewing.
- Login Assist: time-boxed, model-blinded, audited human login into Agent browser profiles.
- Read-only live inspection of specialized-agent execution.
- Shell/command execution inside agent sandbox when permitted.
- Tool/skill system.
- Capability and permission tiers.
- Human approval workflow with device-signed Tier-4 approvals and Node-Manager-only Tier-5 actions.
- Taint/provenance tracking with deterministic policy responses.
- Scheduler.
- Long-running, scheduled, event-driven, webhook, file-triggered, and agent-to-agent runs.
- Durable checkpoints and restart recovery.
- Resource pool management.
- CPU/RAM/storage/network/GPU resource policies.
- Shared local model installations.
- Local model catalog/manifest.
- Ollama V1 runtime adapter.
- BYOK providers including NVIDIA NIM, OpenRouter, OpenAI, Anthropic, Gemini, OpenCode Go, and generic OpenAI-compatible providers, through the provider adapter contract defined in this specification.
- Automatic model routing plus explicit model selection/override.
- Per-agent/task capability overrides.
- Per-agent BYOK cost controls.
- Local-only Node Manager with OS-backed step-up authentication.
- Node API authentication: a single owner bootstrap/recovery key, plus paired-device sessions with device-bound credentials, device management, and scoped automation tokens.
- QR pairing (single-use token; never the owner key).
- Provider-abstracted remote access: Cloudflare Quick Tunnel (temporary) and at least one stable-endpoint mode (named tunnel or external proxy).
- Automatic PRISM/dependency updates.
- Signed/verified update artifacts.
- Automatic rollback after failed update health checks.
- User-facing update failure notification within PRISM Web.
- Automatic model-download resume.
- Rootless OCI container sandboxing on a PRISM-managed private container runtime.
- Rust low-level supervisor/resource/network components, including the WorkspaceFS host-file-access component.
- SQLite persistence with WAL.
- WebSocket event streaming.

### 2.2 Explicitly not required in V1

- PRISM cloud accounts.
- Multi-user authentication on a Node.
- Teams/RBAC for multiple human users.
- PRISM-operated paid relay infrastructure.
- Mandatory port forwarding.
- Mandatory stable public domain.
- Hosted PRISM VPS marketplace/service.
- Social-platform notification system.
- Marketplace/plugin marketplace.
- Kubernetes as a required runtime.
- Distributed multi-Node scheduling as a V1 requirement.
- Graphical desktop virtualization for agents.
- Direct user chat UI for specialized Agents.

## 3. Repository Architecture

The repository is a monorepo with two product roots and a small set of shared protocol/schema packages.

```text
prism/
├── web/
│   ├── app/
│   ├── components/
│   ├── features/
│   │   ├── main-agent/
│   │   ├── agents/
│   │   ├── tasks/
│   │   ├── runs/
│   │   ├── models/
│   │   ├── browser/
│   │   ├── files/
│   │   ├── artifacts/
│   │   ├── activity/
│   │   ├── nodes/
│   │   ├── settings/
│   │   └── approvals/
│   ├── state/
│   ├── lib/
│   ├── public/
│   └── tests/
│
├── node/
│   ├── src/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── devices/
│   │   ├── identity/
│   │   ├── node-manager/
│   │   ├── agents/
│   │   ├── runs/
│   │   ├── tasks/
│   │   ├── scheduler/
│   │   ├── orchestration/
│   │   ├── messaging/
│   │   ├── approvals/
│   │   ├── permissions/
│   │   ├── taint/
│   │   ├── memory/
│   │   ├── artifacts/
│   │   ├── files/
│   │   ├── tools/
│   │   ├── skills/
│   │   ├── browser/
│   │   ├── models/
│   │   ├── resources/
│   │   ├── networking/
│   │   ├── notifications/
│   │   ├── updates/
│   │   ├── audit/
│   │   ├── backups/
│   │   ├── capabilities/
│   │   ├── credentials/
│   │   ├── egress/
│   │   ├── remote-access/
│   │   ├── triggers/
│   │   ├── events/
│   │   ├── storage/
│   │   └── config/
│   ├── workers/
│   │   ├── agent/
│   │   ├── task/
│   │   ├── model/
│   │   └── parser/
│   ├── rust/
│   │   ├── supervisor/
│   │   ├── sandbox/
│   │   ├── resources/
│   │   ├── workspacefs/
│   │   └── network/
│   ├── migrations/
│   ├── installer/
│   └── tests/
│
├── packages/
│   ├── protocol/
│   ├── schemas/
│   ├── client/
│   └── shared/
│
├── models/
│   └── manifest.json
│
├── docs/
│   └── adr/
└── LICENSE
```

This is a **modular monolith**, not a microservice fleet. Internal modules have strict interfaces, but most remain inside one Node deployment for easier installation, testing, upgrades, and recovery.

`node/src/node-manager/` holds the Node Manager listener, route registry, middleware, and authorization policy; it shares no route registry or middleware instance with `node/src/api/` (§6.1). `node/workers/parser/` holds the sandboxed untrusted-content parsers (§36.6). Architecture decisions that close the open choices in §56 are recorded as ADRs under `docs/adr/`.

### 3.1 Language/runtime decisions

- Web: TypeScript + React + Vite SPA.
- The Web build must be fully static-deployable; it must not require a server-side Next.js runtime for the public GitHub Pages deployment.
- Node control plane: TypeScript + Node.js.
- Low-level system supervisor: Rust.
- Local inference: external runtime adapter; V1 = Ollama.
- Agent sandbox may contain arbitrary user/agent tools/languages and is not restricted to PRISM's implementation languages.
- PRISM Core has no mandatory Python runtime in V1.
- Host-side access to Agent workspaces is implemented in Rust (WorkspaceFS, §16.1) because Node.js does not expose the required no-follow path-resolution primitives.

Node.js should be pinned to a supported LTS release by the distribution system rather than relying on an arbitrary system installation.

## 4. PRISM Web

PRISM Web is a frontend client for a PRISM Node.

### 4.1 Deployment forms

PRISM Web must work in all of the following forms:

1. Public static deployment, e.g. GitHub Pages.
2. Node-bundled/local deployment served by PRISM Node.
3. A future separate client such as mobile, desktop, or social interface consuming the same Node API.

The Node-bundled Web UI must not be a different application. Forms 1 and 2 correspond to the session client classes `public_static` and `bundled` (§22.6). A future separate client registers as a device with a Node-assigned client class and is treated as `public_static` unless the owner trusts it.

### 4.2 State ownership

PRISM Web may cache display state for responsiveness, but the Node is authoritative for:

- Agents.
- Agent definitions.
- Runs.
- Tasks.
- Messages.
- Memory.
- Files.
- Artifacts.
- Models.
- Providers/credentials metadata.
- Permissions/policies.
- Schedules.
- Browser sessions.
- Resource state.
- Update state.
- Audit/activity history.

### 4.3 Main interface

The default interface is a hybrid dashboard + Main Agent workspace.

The Main Agent is the dominant conversational surface. Navigation should expose at least:

- Main Agent.
- Agents.
- Tasks/Runs.
- Artifacts.
- Activity.
- Models.
- Nodes.
- Settings.
- Approvals when pending.

The Main Agent task view must be capable of rendering a delegation tree such as:

```text
User request
└── Main Agent
    ├── Research Agent — working
    ├── Analyst Agent — waiting
    └── Writer Agent — queued
```

### 4.4 Specialized Agent inspection

Specialized agents do not receive a primary user-facing chat interface.

Instead, the user can open a specialized Agent in **read-only live mode** and inspect:

- Model-generated visible messages/output.
- Tool calls.
- Tool arguments where safe to expose.
- Tool results.
- Browser activity/state.
- Files/artifacts created.
- State transitions.
- Delegation/messages.
- Timing/resource usage.
- Errors.
- Memory reads/writes with provenance labels (§43.3.4).

PRISM must never expose hidden chain-of-thought merely because it is an autonomous system. The UI exposes model outputs, tool activity, traces, and other inspectable runtime information that the model/runtime actually emits and that policy permits.


### 4.5 Specialized-Agent control without direct chat

The specialized-Agent live view remains read-only with respect to messaging, but the user MUST have operational escape hatches for the selected Agent/run:

- Pause.
- Cancel.
- Restart from the latest valid checkpoint (creates a new Run attempt; §27.5).
- Retry a failed step when retry semantics permit.
- Request Main Agent intervention.
- Resolve recovery-required state using the actions defined in §27.5.

These controls act on the durable Task/Run state and do not turn the specialized-Agent view into a direct chat surface.

## 5. PRISM Node

PRISM Node is the authoritative self-hosted runtime.

It is designed as an appliance: after installation and initial resource/bootstrap setup, routine administration happens through Web UI.

### 5.1 Node responsibilities

The Node is responsible for:

- API server.
- Authentication, device registry, and automation tokens.
- Agent lifecycle.
- Main Agent runtime.
- Specialized Agent runtime.
- Task/runs.
- Durable execution/checkpoints.
- Scheduler.
- Agent-to-agent messaging.
- Permission policy.
- Approvals.
- Tool execution mediation.
- Browser orchestration.
- Model management.
- Resource management.
- Storage.
- Memory.
- Artifacts/files.
- Update management.
- Remote access integration.
- Egress policy enforcement.
- Event streaming.
- Node Manager.
- Audit/activity.

### 5.2 Control plane vs workers

The Node is one installation but uses isolated processes/workers where appropriate.

```text
PRISM Node
│
├── Control Plane
│   ├── API
│   ├── Authentication
│   ├── Agent registry
│   ├── Scheduler
│   ├── Policy engine
│   ├── Model manager
│   ├── Storage
│   └── Event bus
│
├── Agent Workers
│   ├── Main Agent
│   ├── Specialized Agent A
│   └── Specialized Agent B
│
├── Task/Run Workers
│
├── Browser Workers
│
└── Rust Supervisor
    ├── Sandbox A
    ├── Sandbox B
    └── Resource/network enforcement
```

Agent identity is persistent even when execution workers are stopped or replaced.

Process identities, privileges, and IPC boundaries among these components are defined in §36.3–§36.6.

## 6. Node Manager

PRISM Node includes a dedicated **Node Manager local-administration surface**. It is a privileged local management interface with a distinct trust boundary from the public Node API.

### 6.1 Security model

Node Manager MUST use a separate local listener and route registry from the remotely reachable Node API. On Linux, the listener MUST use a Unix-domain socket with peer credentials; on Windows/WSL2, it MUST use a dedicated loopback listener plus the authenticated Windows-side administration helper defined below. The listener MUST NOT share the public API's route registry, middleware, authorization policy, or audit stream.

Because a browser cannot connect directly to a Unix-domain socket, Linux MUST provide a separate loopback-only browser bridge to the Node Manager UI. The bridge proxies only to the Node Manager UDS, has no administrative authority of its own, and is not reachable through the public API, tunnel, LAN, or reverse proxy. Loopback reachability to the bridge does not establish an authenticated administrative session; every session and Tier-5 operation still requires the OS-backed assertion below.

Node Manager MUST NOT be reachable through the public Node API route space, Cloudflare Tunnel, LAN binding, reverse proxy, or any remote-access path.

“Localhost” is transport isolation, not authentication. Node Manager authentication and every Tier-5 action MUST require fresh OS-backed local step-up, independent of the owner API key and Web device session. On native Linux, the root-owned `prism-admin` helper MUST authenticate the invoking account through PAM and require membership in the configured `prism-admin` OS group; its control channel MUST verify peer credentials. On Windows/WSL2, the Windows-side `prism-admin` service/helper MUST require Windows user reauthentication through the secure desktop and communicate with the Node over an authenticated local channel. Each helper holds a per-install ECDSA P-256 signing key protected by the OS; the Node pins its public key during installation. The helper signs a short-lived assertion bound to the Node, OS principal, local administrative session, exact action hash, and challenge nonce. The assertion is presented to the local Node Manager UI and is invalid after 60 seconds or one use. The helper private key MUST be inaccessible to the Node process, browser, Agents, and unprivileged local processes. A model, Agent, public API request, loopback reachability, socket access alone, or possession of the public Node API key does not count as human local authentication. If the platform cannot provide the required OS-backed step-up and protected signing key, Node Manager MUST fail closed and Tier-5 actions MUST remain unavailable.

Helper-key rotation or re-enrollment MUST require fresh OS authentication on the host and an explicit local Node Manager confirmation. It MUST revoke the former helper key immediately and MUST NOT be available through the public API, Web session, automation token, or backup restore.

Node Manager MUST enforce strict Host and Origin validation and reject unexpected values. Public and local route registries, middleware, audit streams, and authorization policies MUST remain separate.

Node Manager is the sole surface that can satisfy Tier-5 (human-only) actions (§20.2). On Windows/WSL2, Windows-side processes can reach WSL loopback listeners; therefore the authenticated Windows-side helper and action-bound assertion are mandatory. Loopback reachability and socket permissions alone never authenticate an administrator.

The long-lived Node API key MUST NOT be the only reusable credential held by the browser. Node Manager displays a newly generated API key exactly once (§6.3), and normal Web sessions MUST use short-lived, scoped, device-bound session credentials (§22.2).

### 6.2 Node Manager capabilities

The Node Manager must allow the operator to visually:

- View Node status and health.
- View detected hardware and resource-pool configuration.
- Start/stop/restart managed services where permitted.
- View/update status and rollback state.
- View the current remote-access endpoint.
- Regenerate the Node API key; the new key is displayed exactly once and the prior key is revoked.
- Revoke the current Node API key without issuing a replacement.
- Start/complete local pairing.
- List paired devices and revoke any device.
- Create, list, and revoke scoped automation tokens.
- Resolve Tier-5 (human-only) actions.
- Mark specific Web origins as trusted for Tier-4 approvals and Login Assist input (§22.6).
- Configure remote-access mode and the optional endpoint beacon (§38).
- Create/restore encrypted backups.
- Inspect security/audit status.

Operations that read, generate, rotate, or restore secret material MUST require the secret store to be unlocked; the local unlock operation is the sole exception. Node Manager remains usable while locked to perform local unlock and non-secret diagnostics; it MUST NOT report a key rotation or credential operation as successful while secrets are unavailable.

### 6.3 API-key storage and display

The Node MUST store only a keyed verifier of the long-lived owner API key (HMAC-SHA-256 under a Node-local pepper held in the secret store) and MUST NOT persist a reversible copy. Consequently the key can be shown exactly once, at generation. Key generation, verification, and regeneration require an unlocked secret store. If the user loses the key, Node Manager regenerates it (revoking the prior key) rather than recovering the old secret. The key carries a recognizable prefix and checksum so secret scanners can detect leaked keys (§22.1).

### 6.4 QR and pairing

QR codes MUST NOT encode the long-lived Node API key. A QR contains a short-lived, single-use pairing token and the current Node endpoint.

The pairing token MUST:

- expire quickly;
- be single-use;
- be bound to the Node and intended pairing flow;
- have sufficient entropy;
- be invalidated after successful exchange or explicit cancellation.

The Web client generates its device keypair, exchanges the pairing token together with the device public key for a scoped, device-bound session (§22.2), and then discards the token. The Node's identity fingerprint is pinned in the client during this exchange (§22.9). A captured QR therefore cannot become a reusable owner credential.

## 7. Node Installation

The target is a brand-new supported Linux machine where the user runs one installer command.

The installer must automatically install/configure required dependencies when absent, rather than requiring users to manually install them.

Expected dependency responsibilities include:

- PRISM Node binaries/application.
- Pinned Node.js runtime if needed.
- PRISM-managed private rootless container runtime, installed under a dedicated service user. The installer MUST NOT reconfigure the host's existing container engine or its daemon-wide settings (§36.4).
- Ollama V1 local model runtime.
- Chromium/Playwright dependencies.
- Rust supervisor binaries.
- Local database initialization.
- OS service/autostart integration.
- Dedicated unprivileged service users and filesystem permissions for the control plane, supervisor, egress proxy, and workers (§36.3).
- Designate the initial local administrator for Node Manager (Linux `prism-admin` OS group/PAM identity; Windows local administrator for the secure-desktop helper).
- Update agent.
- Cloudflared when a tunnel-based remote-access mode is enabled, or installed as an optional managed dependency.

Installation must be resumable/idempotent and safe to re-run.

### 7.1 Appliance lifecycle

After installation:

1. Node starts automatically.
2. Node detects hardware.
3. Node initializes storage/database.
4. Node initializes default configuration.
5. Node starts required workers/services.
6. Node initializes the secret store and loads/generates its identity keypair (§22.9). The owner API key is generated after the secret store is unlocked and displayed once via Node Manager.
7. Node Manager becomes available locally through the separate OS-authenticated administration path (§6.1), including when secrets are locked.
8. Web UI can connect after the Node identity and session-authentication material are available.
9. User performs small initial resource-pool setup via UI.
10. Normal administration moves to PRISM Web/Node Manager.

### 7.2 Reboot recovery

After reboot, the Node MUST automatically start and restore eligible persistent Agents/tasks. When the platform provides an unattended OS-backed KEK, the Node unlocks secrets during service startup. Otherwise it enters `DEGRADED` with reason `secrets_locked`; Node Manager remains available for local unlock, but no secret is released and secret-dependent Runs, credential use, and remote sessions remain paused or disabled until unlock.

After secrets are available, active runs must resume from the latest valid checkpoint when safe. While secrets are locked, non-secret runtime state may be recovered, but a Run requiring a secret MUST remain paused and MUST NOT substitute missing credentials or proceed with weaker policy. The recovery guarantee is **logical task/run recovery**, not arbitrary continuation of every in-flight OS process, browser process, or external side effect at the exact instruction pointer.

Runs that cannot safely resume must enter an explicit recovery/error state rather than silently duplicating side effects. Side-effecting operations should use idempotency keys, execution receipts, or provider-specific idempotency facilities where available. Uncertain external outcomes must be represented explicitly so the Agent cannot assume success merely because a worker crashed.

## 8. Operating System Targets

### 8.1 Linux

Linux is the primary native V1 deployment target. The installer configures persistent storage, service startup, runtime dependencies, sandboxing, and update supervision.

V1 baseline platform requirements: x86_64 or aarch64; systemd; cgroup v2 with controller delegation to the PRISM service user; unprivileged user namespaces with subuid/subgid ranges; a kernel providing `openat2` (Linux 5.6 or later); and a workspace-storage backend that provides per-Agent filesystem/subvolume hardlink isolation (§16.1). Every PRISM release MUST publish a machine-readable support manifest enumerating the exact Linux distribution/release, architecture, kernel floor, systemd version, private container-runtime version, workspace filesystem/backend, Node Manager helper/authentication integration, secret-store/unlock mode, and required configuration combinations that passed the release suite. A combination not listed in that manifest is unsupported; PRISM MUST NOT imply support based only on matching the baseline. The installer and Node preflight MUST identify the missing or unsupported requirement and refuse to start sandboxes rather than silently running with weaker isolation. A release MUST NOT be published without its support manifest and passing test evidence for every listed combination.

### 8.2 Windows

Windows V1 runs PRISM Node through WSL2. Each Windows release MUST publish a machine-readable support manifest naming the tested Windows release/build, WSL version and kernel, PRISM Linux distribution, architecture, workspace filesystem/backend, Windows `prism-admin` helper/authentication integration, secret-store/unlock mode, and required WSL/systemd/cgroup configuration. Unlisted combinations are unsupported and MUST be reported as such by preflight. The supported boot path is:

```text
Windows boot / user login
        ↓
Windows Scheduled Task or service trigger
        ↓
WSL distribution startup
        ↓
systemd/service manager
        ↓
PRISM Node
```

The installer MUST configure an idempotent startup mechanism and MUST tolerate WSL instances being stopped and restarted. PRISM MUST detect degraded WSL/network state rather than reporting the Node as healthy when the Node API is unavailable. Node Manager connectivity and localhost/tunnel behavior MUST be tested under WSL sleep, shutdown, and restart conditions. The Windows-side `prism-admin` helper and its secure-desktop reauthentication flow (§6.1) are part of the supported platform contract and MUST be included in those tests.

Persistent PRISM data SHOULD live inside the WSL Linux filesystem by default rather than under `/mnt/c`.

### 8.3 macOS

The architecture must retain a path for macOS support where the required sandbox and supervisor guarantees can be provided. Platform-specific limitations MUST be surfaced rather than silently weakening isolation.

## 9. Node Resource Pool

A Node owns a configurable resource pool.

Initial configuration covers:

- Total CPU cores allocated to PRISM.
- Total RAM allocated to PRISM.
- Total storage allocated to PRISM.
- Network bandwidth policy/limit.
- Auto-detected GPU(s) and available GPU resources.

The Node should reserve host headroom so that PRISM cannot starve the host of essential resources.

### 9.1 Agent resource profile

Each Agent has both requested and maximum resources.

Example:

```text
Agent profile
├── requested CPU: 2 cores
├── max CPU: 8 cores
├── requested RAM: 4 GB
├── max RAM: 16 GB
├── storage quota: 20 GB
├── network policy: restricted
└── GPU inference: allowed
```

The scheduler may grant more than the requested amount up to the maximum when the pool allows it. In V1, GPU access means model inference through the Model Manager; sandboxes receive no GPU device access (§36.2).

### 9.2 GPU sharing

Multiple Agents may use the same GPU concurrently when supported by the runtime/model and when GPU memory/resource scheduling permits it.

GPU allocation is **best-effort unless the selected runtime/backend provides enforceable isolation**. PRISM must not claim per-Agent VRAM quotas that Ollama or the host GPU stack cannot actually enforce. The scheduler may reserve estimated VRAM capacity and queue runs when estimates indicate insufficient capacity, but runtime oversubscription/failure must be handled explicitly.

The model manager must account for GPU memory requirements and avoid promising impossible concurrent allocations.

### 9.3 Enforcement

Resource accounting covers both execution and inference. The Resource Pool MUST model, as applicable:

- CPU quota/weight.
- RAM reservation/limit.
- Persistent storage quota.
- Network bandwidth/accounting quota.
- GPU device access.
- GPU memory estimates/budget.
- Concurrent model requests.
- Loaded-model slots and model residency.

Run admission is the intersection of sandbox resource availability, inference capacity, and network policy. Ollama concurrency/load limits MUST be respected. GPU VRAM allocation is best-effort where the underlying runtime cannot enforce per-Agent VRAM; PRISM MUST expose that limitation rather than claiming hard isolation.

Each resource dimension is explicitly labeled as **hard-enforced**, **best-effort**, or **accounting-only** on each supported platform.

Resource limits that cannot be perfectly enforced on a particular host/OS must be represented honestly in the UI. PRISM should enforce limits at the strongest layer available rather than merely recording desired numbers.

## 10. Agent Model

An Agent is a persistent entity with a stable identity.

Agent state is conceptually divided into:

```text
Agent
├── Definition
│   ├── identity
│   ├── instructions/personality
│   ├── model policy
│   ├── capabilities
│   ├── browser configuration
│   ├── resource profile
│   └── metadata
│
├── Runtime State
│   ├── active runs
│   ├── checkpoints
│   └── current status
│
├── Persistent State
│   ├── memory
│   ├── conversation/run history
│   ├── schedules
│   └── preferences
│
├── Private Workspace
│   └── files
│
├── Browser State
│   └── persistent Chromium profile when enabled
│
└── Credential References
```

Stopping/restarting an Agent must not destroy its identity or persistent state.

An Agent stopped for a long period and later resumed remains the same Agent unless the user explicitly deletes/resets it.

## 11. Main Agent

The Main Agent is the primary user-facing Agent and top-level orchestrator.

It is implemented using the same Agent abstraction but receives privileged system capabilities.

### 11.1 Main Agent capabilities

Subject to Node policy, Main Agent may:

- Create specialized Agents.
- Configure specialized Agents.
- Delete specialized Agents after required human approval.
- Delegate work.
- Inspect Agent runs.
- Observe Agent-to-Agent communication.
- Intervene in running work.
- Stop/cancel runs.
- Transfer artifacts/files.
- Configure schedules.
- Choose models or routing policies.
- Request tool permissions.
- Request human approvals.
- Request narrowly allowlisted Node-level operational behavior; this does not include authentication, trust-root, deterministic deny-rule, sandbox, audit-integrity, or update-signing changes.
- Create specialized Agents in response to specialized-Agent requests.

### 11.2 Human approval boundary

Main Agent has the highest Agent-level permissions, but cannot bypass Node actions that are categorically human-approved.

The policy engine is authoritative.

## 12. Agent Creation

Agents can be created by the user or by the Main Agent.

Main Agent natural-language creation should produce a structured proposed configuration before final creation where the creation flow benefits from user visibility.

An Agent definition should include at minimum:

- Name.
- Stable ID.
- Description.
- Identity/personality/instructions.
- Model policy.
- Tool/skill capability policy.
- Browser policy.
- Network policy.
- Resource profile.
- Memory behavior.
- Schedule settings if any.
- Metadata.

## 13. Agent Deletion and Reset

Deletion is destructive.

Deleting an Agent removes:

- Definition.
- Workspace/files.
- Browser profile/cookies/localStorage.
- Memory.
- Conversation/run history.
- Scheduled tasks.
- Task/run history owned by that Agent where deletion semantics permit it.
- Other Agent-specific persistent state.

Shared model weights are not deleted.

### 13.1 Approval

Deletion of any Agent requires human acceptance as a Tier-4 approval (device-signed, §45).

This includes deletion proposed or initiated by the Main Agent.

The Main Agent itself cannot be deleted; it may only be reconfigured/reset through the supported administrative mechanisms, with destructive actions subject to the same human approval model.

### 13.2 Reset

The user must be able to reset an Agent's workspace/state while preserving its definition/configuration.

Reset produces a fresh empty execution environment without requiring the user to recreate the Agent definition.

## 14. Agent Configuration History

PRISM does not require formal releases/versioning for Agents.

Instead, configuration changes are recorded as reversible history entries.

The user can inspect previous configuration changes and undo supported changes.

Creation can be undone by deletion, subject to deletion approval.

## 15. Agent Export/Import

### 15.1 `.prism` package

`.prism` is a portable Agent definition package. By default it contains:

- Manifest and package format version.
- Agent identity.
- Instructions/personality.
- Model reference/policy.
- Skills.
- Tool configuration.
- Requested permissions/capabilities.
- Resource profile.
- Portable schedule definitions.
- Metadata.

It does not contain private runtime state by default.

Import is a **policy and supply-chain boundary**. Instructions, skills, tool permissions, schedules, model references, and resource requests contained in a package are treated as untrusted requests until validated against Node policy. Import MUST display or otherwise make reviewable requested elevated capabilities, and MUST present a diff-style review of imported instructions, skills, and tool configuration, because these are themselves an injection vector. Imported configuration MUST be attenuated to Node policy and the importing user's policy. A package MUST NOT self-authorize a capability, credential, network destination, or resource class that the Node does not permit.

Import creates a new Agent with an empty workspace/state unless the user chooses a supported state-restore path. Package identity MUST NOT silently replace the Node's owner or trust root.

An imported Agent starts in an `unreviewed` trust state: it has no egress or credential capability, and its imported schedules are created disabled, until the owner marks it reviewed (Tier-3 confirmation). Review removes only the `unreviewed` lifecycle restriction; it does not grant requested capabilities or promote imported content. Imported instructions and skill text remain `external_untrusted` until the owner explicitly promotes the exact reviewed content through the audited Tier-3 operation in §43.3.3. While such content remains untrusted, the Agent is subject to quarantined-reader restrictions (§43.3.5). Package extraction uses the hardened extractor (§16.1).

### 15.2 Full backup

A full encrypted backup package may contain private runtime state, including workspace and memory. Credentials/secrets are handled only through the explicit backup rules in Section 40.

## 16. Agent Workspaces and Files

Every Agent has a private filesystem/workspace.

No Agent may directly browse or mount another Agent's workspace.

Inter-Agent file movement is explicit.

Example:

```text
Research Agent
   ↓ creates
research.pdf
   ↓ artifact/file transfer
Main Agent
   ↓
Writer Agent
```

Transfers must create auditable events and may be restricted by policy. Transfers copy bytes through WorkspaceFS into the immutable artifact store (§16.1, §34); taint labels travel with the artifact (§43.3).

### 16.1 Host-side workspace access (WorkspaceFS)

Agent-controlled directory trees are hostile input to every host-side component. An Agent can plant symlinks, hardlinks, special files, or racing renames, so host-side code MUST NOT trust any path inside a workspace or browser profile.

- The control plane MUST NOT open workspace or browser-profile paths directly. All host-side reads, writes, copies, listings, snapshots, and archive operations go through **WorkspaceFS**, a Rust component running under the supervisor identity (§36.3) and reached over IPC.
- WorkspaceFS opens each workspace or browser-profile root as a directory file descriptor and resolves every path beneath it with `openat2` using `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`. It rejects non-regular files for read/copy (FIFOs, devices, sockets), applies size caps, and operates on the opened descriptor so there is no check-then-open race. Because path-resolution flags do not prevent hardlinks, each Agent's workspace and browser profile MUST reside within that Agent's dedicated filesystem or kernel-enforced isolated subvolume, which is a separate hardlink domain: no other Agent's workspace/profile or host/control-plane file may reside in that domain, and the sandbox MUST see only its own Agent mounts. The platform MUST prevent hardlink creation across that boundary; if it cannot, PRISM MUST refuse to start the sandbox. WorkspaceFS MUST verify the opened descriptor's mount identity/device and expected ownership against the registered per-Agent boundary before reading or copying. Internal hardlinks within one Agent's isolated domain may be read, but transfers and backups always copy file bytes and never preserve hardlink relationships.
- Reads are handed to the control plane as validated read-only file descriptors (descriptor passing). Writes into a workspace are performed by WorkspaceFS using descriptor-relative creation with no-follow semantics, from a source descriptor passed by the control plane (for example an artifact being delivered to another Agent).
- Artifact transfer copies bytes into the control-plane-owned, content-addressed artifact store. Hardlinks and bind mounts are never used for transfer. Stored artifacts are immutable and record their content hash.
- Workspace volumes are mounted `nodev,nosuid`, and `noexec` unless the sandbox profile requires executing workspace binaries.
- A single **hardened extractor** is used for every archive entering PRISM (`.prism` import, backup restore, user uploads). It rejects absolute paths, `..` components, symlinks, hardlinks, and device/FIFO/socket entries; enforces limits on total uncompressed size, compression ratio, entry count, path depth, and name length; and creates entries descriptor-relative inside a fresh directory.
- Files served to clients carry `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` by default. Inline display is allowed only for an allowlisted set of safe types; HTML, SVG, and PDF render only inside the sandboxed context in §22.7.
- Backup walks use the same no-follow and inode-boundary rules and store symlinks as links, never dereferencing them. They copy regular-file bytes and never follow or serialize hardlinks as references outside the isolated workspace.

## 17. Memory

Persistent filesystem state is foundational memory.

PRISM should support higher-level memory features without making a vector database mandatory for every Agent.

Potential memory forms include:

- Structured facts.
- Notes.
- Preferences.
- Conversation history.
- Files/documents.
- Optional semantic retrieval indexes.

Memory belongs to the Agent unless explicitly transferred.

### 17.1 Agent cognition and context management

The Agent runtime must explicitly separate **persistent identity/memory** from **per-run working context**. A V1 Agent loop must define at least:

1. Wake/trigger acquisition.
2. State/context loading.
3. Instruction hierarchy assembly.
4. Context selection and retrieval.
5. Model invocation.
6. Tool proposal and policy evaluation.
7. Tool execution and result ingestion.
8. Progress/checkpoint persistence.
9. Context compaction/summarization when limits are reached.
10. Completion, sleep, retry, escalation, or delegation.

Prompt assembly MUST preserve the following precedence, highest first. L0 and L1 are enforced by the runtime and policy engine outside the prompt; prompts may describe them but never rely on the model to uphold them.

- **L0** Runtime/system policy.
- **L1** Node and owner policy.
- **L2** Agent definition (identity and instructions).
- **L3** Owner instructions.
- **L4** Delegated task state from the Main Agent (trusted task state).
- **L5** Agent-to-Agent messages: data with sender provenance. They cannot change instructions or policy.
- **L6** External/untrusted content: data only.

Provenance labels (§43.3.1) attach to content as it enters context. Context compaction must not silently elevate untrusted content into instructions or into a higher provenance label.

Long-running Agents must be able to continue across multiple model contexts by persisting compacted working state and durable task state rather than depending on an indefinitely growing conversation window.

### 17.2 Memory provenance

Every memory entry records provenance: `{label, source_run_id, written_by}` (§43.3.4). Entries written from a tainted context default to `external_untrusted`, and loading such an entry taints the loading context. The owner MUST be able to inspect, edit, delete, and promote memory entries in PRISM Web, including for specialized Agents (this is separate from read-only live inspection of Runs).

## 18. Browser Subsystem

Browser capability is configured at Agent creation and may be narrowed for individual invocations.

### 18.1 Agent-level browser policy

An Agent may be configured as:

- Browser disabled.
- Browser enabled with persistent profile.
- Browser enabled with restricted domains.
- Browser enabled with broader/full Internet access.

Cookies/localStorage/session persistence are opt-in and associated with the Agent's browser profile.

An Agent that uses an authenticated website MUST be explicitly configured as an authenticated browser Agent with exact origin/identity-provider allowlists, origin-bound credential references, and explicit read-only request scopes including query schemas and permitted static headers. It cannot simultaneously be configured as an arbitrary-content quarantined reader with private-data or general external-send authority (§43.3.5).

### 18.2 Task-level browser policy

Effective browser capabilities are:

```text
Agent maximum capabilities
        ∩
Task-requested capabilities
        ∩
Creator/delegator capabilities
        ∩
Node policy
```

A task can narrow capabilities but never broaden the Agent's maximum authority.

### 18.3 Browser control and isolation

Browser automation uses Playwright against an isolated Chromium instance/profile. Chromium MUST run inside the Agent's sandbox boundary or an equivalently isolated browser worker with no host-control capability. The implementation MUST NOT use `--no-sandbox` as a security workaround.

Each browser profile is isolated by Agent. A profile may be persistent across runs, but profile state MUST NOT be shared between Agents. Browser workers MUST use the same egress/SSRF policy as other network-capable Agent tools, MUST route all traffic through the egress proxy, and MUST launch Chromium with QUIC disabled and a WebRTC policy that prevents non-proxied UDP (§37.3). Before a browser profile is exposed to a page or any request is transmitted, browser-worker interception MUST be active and validate the origin, redirect chain, method, query schema, credential use, and policy scope; page-script, service-worker, subresource, and navigation requests are subject to the same check. A request is read-only only when its exact origin, method, path, query schema, and permitted headers are explicitly declared read-only, it carries no credentials/body or dynamic Agent/owner data, and it cannot cause an external side effect. HTTP method alone (including `GET`) is not proof that a request has no side effect. An interception failure MUST block the request.

The V1 user-facing browser view is a live read-only inspection surface showing actual current tabs/page state, not a screenshot archive. It MUST NOT expose cookies, storage values, authorization headers, or other secret material merely because a page is visible (§18.5).

V1 includes the live read-only surface. The only human-input mode defined for V1 is Login Assist (§18.4); any other form of human takeover is outside V1.

### 18.4 Login Assist

Persistent browser profiles are only useful if a human can establish a session (password, 2FA, CAPTCHA, OAuth consent), and credential injection cannot complete every such flow. Login Assist is the single, tightly bounded human-input mode in V1.

- **Trigger.** The Agent requests it with the `browser.login_assist.request` capability for a named origin, or the owner starts it from the browser view.
- **Gate.** A Tier-4 approval (device-signed, §45) from a `bundled` session or an owner-trusted origin (§22.6), or Node Manager confirmation. This applies whether the Agent or the owner starts the session. Any active Run using the profile is held `PAUSED` with reason `login_assist` for the duration; once an Agent-requested approval is granted, the waiting Run moves directly from `WAITING_APPROVAL` to `PAUSED`.
- **Domain lock.** The browser profile is restricted to the target origin plus identity-provider domains declared in the approved request. Navigation elsewhere is blocked. The locked origin is shown prominently to the human. Login Assist does not widen the profile's egress policy beyond those declared domains.
- **Request enforcement.** Browser-worker interception remains active during Login Assist. Human-originated requests are allowed only to the approved origin/identity-provider set and under the approved domain lock; redirects or requests outside that set are blocked. This does not expose the request or input to the model or expand the approval beyond its stated scope.
- **Model blinded.** While active, no frames, DOM, URL, page text, or browser events are delivered to the model, and the Agent's browser tools are disabled. The Agent's context receives only "login assist in progress" and, afterwards, the outcome.
- **Input path.** Keyboard and pointer input travels over a dedicated `browser.control` stream scope and is injected into the browser worker. It is never logged, never persisted, and never emitted as events. The audit record contains only start, end, origin, duration, approving device, and outcome.
- **Limits.** Time-boxed (default 10 minutes), a single viewer, and an explicit end action. When it ends or times out, profile state persists according to the profile's policy and the Run re-enters admission (`PAUSED → QUEUED`).
- **Optional import path.** The owner may upload a Playwright `storageState` captured on their own machine through Node Manager. It is credential material: encrypted at rest, and included in backups only if the owner chooses secret-inclusive backup.
- **Events.** `browser.login_assist.started` and `browser.login_assist.ended` are durable `security_audit` events.

### 18.5 Live view and credential injection

- **Transport.** The live view is a pixel frame stream per tab (an ephemeral stream, never stored; §23.0) plus durable structured metadata: tab list, titles, sanitized URLs, and navigation state. Frames cannot expose cookies, storage, or headers by construction. Only screenshots the Agent deliberately captures become artifacts, and they carry taint labels.
- **Masking.** The browser worker masks password-field regions server-side before frames leave it, using element bounding boxes. This is best-effort and the UI MUST label it as such (consistent with §9.3's honesty rule). Displayed URLs strip query and fragment by default, with a reveal toggle.
- **Credential injection.** For password and TOTP flows the credential broker fills fields inside the browser worker and only when the page origin matches the credential's bound origin. The model sees placeholders, never values, and never sees generated TOTP codes.
- **Request mediation.** The browser worker intercepts the effective request before transmission and binds any approval to the exact origin, path, method, credential reference, and body digest (§43.3.5, §58.4). It blocks a request if interception, canonicalization, or policy evaluation fails.

## 19. Agent Shell / Linux Environment

Agents may execute arbitrary shell commands inside their own sandbox when the appropriate capability is enabled.

The V1 Agent environment is a basic Linux environment rather than a full graphical desktop.

The browser may provide visual rendering, but the Agent sandbox itself is not a remote desktop VM.

## 20. Permission and Tool Policy System

PRISM uses deterministic capability-based access control combined with risk-based approval. The LLM cannot grant itself authority.

### 20.0 Capability enforcement boundary

```text
LLM / model output
        ↓
Agent Runtime
        ↓
Tool Invocation Layer
        ↓
Policy Engine
        ↓
Capability Broker
        ↓
Sandbox / external service / credential broker
```

The Agent runtime MUST NOT directly access the Node database, host filesystem, container engine socket, host credentials, or privileged control-plane APIs.

### 20.1 Capability model

Capabilities are stable identifiers such as `files.read`, `files.write`, `shell.basic`, `shell.network`, `browser.navigate`, `network.http`, `credentials.use`, `agent.delegate`, `agent.create.request`, `browser.login_assist.request`, and `node.admin.request`. Each capability has a defined scope and risk class.

Capability delegation MUST satisfy:

```text
child capabilities
⊆ creator/delegator delegable capabilities
∩ requested capabilities
∩ Node policy
∩ owner policy
```

A child Agent MUST NOT receive broader authority than the creator can delegate. The Main Agent MUST NOT create a specialist with broader authority than the Main Agent or Node policy permits.

The Main Agent MUST NOT directly modify trust roots, authentication policy, deterministic deny rules, audit-retention policy, sandbox escape controls, or update signing trust. Requests affecting those boundaries require the designated human/admin path.

### 20.2 Conceptual risk tiers

```text
Tier 0 — Read-only / observation
Tier 1 — Safe local operations
Tier 2 — Network/external interactions
Tier 3 — Sensitive operations
Tier 4 — Destructive/high-impact operations
Tier 5 — Human-only actions
```

Tier 5 means the action cannot be satisfied by model output, Agent reasoning, or any Web session. It requires the authenticated local administrative session of Node Manager (§6.1). Tier-5 actions MUST NOT be exposed in the public API route space at all.

Approval assurance rises with the tier:

| Tier | Approval assurance required |
|---|---|
| 0–2 | Policy only. If the policy mode is "Ask every time", confirmation in a device-bound session. |
| 3 | Confirmation in a device-bound session (any client class), or in Node Manager. |
| 4 | Device signature over the exact action hash (§58.12), from a `bundled` session or an owner-trusted origin (§22.6), or confirmation in Node Manager. |
| 5 | Node Manager only. Never satisfiable through the public API, any Web session, or any automation token. |

Legal policy modes by tier: Tiers 0–3 may use any mode (Always allow only within an exact configured scope); Tier 4 permits only "Ask every time" or "Never allow"; Tier 5 has no policy mode because it is human-only.

### 20.3 Policy evaluation

Every tool/action request is evaluated against a single immutable policy snapshot identified by a monotonically increasing `policy_version`. Policy grants are attenuated by intersection: the effective capability and scope MUST be within the Agent grant, task/run request, creator/delegator ceiling, owner policy, and Node policy. A policy layer may narrow or deny authority but cannot widen a narrower layer's grant.

Conflict resolution is deterministic and deny-overrides. An applicable hard deny, `Never allow`, unavailable capability, or protected-destination rule denies the action regardless of any allow rule. Otherwise, any applicable `Ask every time` rule or mandatory taint/approval requirement requires the corresponding human approval. `AI decides` may select only among actions already authorized by deterministic policy and can never reduce an approval requirement. `Always allow` applies only when every authority layer permits the exact bounded scope; it does not imply permission outside that scope. If no complete allow path can be established, the result is deny. When equally applicable rules conflict, the more restrictive outcome wins; rule ordering, database order, and model output MUST NOT affect the result.

The policy decision record MUST include the policy version, matched rule IDs and digests, effective capability/scope, taint inputs, risk tier, and resulting decision. The canonical matched-rule digest is used by approval hashing (§58.4). Immediately before execution, the Node MUST re-evaluate the action against the current policy snapshot. A new deny or stricter approval requirement wins; an approval never overrides a deterministic deny. The exact policy composition and precedence are covered by contract tests.

Every tool/action request follows:

```text
Agent requests action
        ↓
Capability check
        ↓
Delegation/scope attenuation check
        ↓
Resource check
        ↓
Network/egress/target validation
        ↓
Risk classification
        ↓
Taint evaluation (§43.3.2)
        ↓
Deterministic Node/owner policy
        ↓
Approval binding / human approval requirement
        ↓
Execute / deny / wait
```

A deterministic deny cannot be overridden by an Agent, Main Agent, imported package, prompt, or model output.

### 20.4 Policy modes

- **Ask every time:** human approval is required for each matching action.
- **Always allow:** the bounded action is pre-authorized within its exact configured scope.
- **AI decides:** the model may choose only among actions already authorized by a deterministic allow policy; the model is choosing execution, not granting permission or deciding whether an unsafe action is safe.
- **Never allow:** authoritative deny.

No policy mode can override a taint-forced approval (§43.3.2), a Tier-4 requirement, or a Tier-5 requirement. The legal modes for each tier are in §20.2.

### 20.5 Tool registry and action contracts

Every executable tool MUST declare:

- Stable tool/action ID and version.
- Input/output schema.
- Required capability.
- Risk tier.
- Scope model.
- Resource requirements.
- Network/egress behavior.
- Secret/credential requirements.
- Idempotency/replay semantics.
- Approval semantics.
- Audit fields.
- Allowed caller contexts.
- Taint sensitivity (§43.3.2).
- Minimum approval assurance and legal policy modes (§20.2).
- Request-observation/interception behavior, including whether the broker can inspect the effective destination, method, credential use, payload, query schema, and source provenance before transmission; opaque side effects MUST be denied from tainted contexts.

The execution implementation MUST validate inputs independently of the model and policy layer.

### 20.6 Control-plane vs sandbox tools

Tools are classified as either:

1. **Control-plane tools:** mediated Node operations such as agent creation requests, scheduling, model installation, approvals, artifact transfer, and provider calls.
2. **Sandbox tools:** commands/processes executed inside an Agent sandbox, such as shell, local package managers, browser workers, and user-installed utilities.

A sandbox process MUST NOT obtain a direct database/control-plane connection. Control-plane requests from an Agent are explicit capability-mediated calls.

## 21. Credentials and Secrets

Agents must not receive raw Node owner/API credentials. Secrets are capability-scoped and mediated.

### 21.1 Secret storage

Secrets MUST be encrypted under a random Node data-encryption key (DEK); the DEK MUST be wrapped by a key-encryption key (KEK) held by an OS-backed machine secret store. The KEK and unwrapped DEK MUST never be available to Agent workers, sandboxes, model runtimes, or parser sandboxes. The secret store MUST support unattended service startup only when its machine-bound protection is available (for example, a platform key store or hardware-backed sealing); ordinary filesystem permissions on a plaintext master key do not qualify as encryption at rest.

On a supported platform without an unattended OS-backed KEK, the Node MUST derive a 256-bit KEK from the owner passphrase with Argon2id using a unique random salt and versioned KDF parameters, then wrap the DEK with authenticated encryption using a unique nonce. The Node MUST start in `DEGRADED` with reason `secrets_locked` after boot until an owner unlocks it through Node Manager. While locked, no secret may be released, credential-dependent Runs and remote sessions MUST remain paused/disabled, and the UI MUST identify the unavailable functionality. The Node MUST NOT fall back to a plaintext key file or weaken access controls to achieve unattended startup. The platform support manifest (§8) MUST state which unlock mode is supported.

On such a platform, first-run setup MUST collect and confirm the owner passphrase through the authenticated local Node Manager flow; it MUST NOT accept the passphrase in a URL, command-line argument, environment variable, log, or Agent context. If no passphrase is configured, secret storage remains `LOCKED` and credential-dependent setup cannot complete. Incorrect unlock attempts are rate-limited and audited without recording passphrase material.

Every key has a version and purpose. KEK rotation MUST rewrap the DEK; DEK rotation MUST re-encrypt all secret payloads and wrap the new DEK under the active KEK. Rotation MUST be atomic/recoverable and MUST NOT expose plaintext to Agents; old key material is destroyed only after the new envelope is verified. Recovery and restore MUST require the corresponding OS-backed key or owner passphrase. A secret-inclusive backup uses an independent authenticated backup envelope (§40) and never exports the live KEK.

Secrets MUST be protected in four states:

- **At rest:** encrypted or OS-protected; not stored as ordinary plaintext database fields.
- **In transit:** HTTPS/TLS or an equivalent protected local channel.
- **At runtime:** available only to the credential broker/tool that needs them; never injected into general Agent prompts.
- **In backups:** included only when explicitly selected and always inside the authenticated encrypted backup envelope.

A credential reference is not itself a secret. Logs, events, prompts, artifacts, and error messages MUST use references/redaction rather than secret values.

### 21.2 Credential broker

A tool invocation may request use of a credential through a broker. The broker verifies capability, scope, target, and policy before releasing or using the secret. Prefer proxy/use-in-place semantics so the raw secret never reaches the Agent process.

Browser cookies/session state are sensitive credential material and follow the same isolation, deletion, and backup rules.

For browser login flows, the broker injects credentials inside the browser worker, only when the page origin matches the credential's bound origin (§18.5). Flows that need a human (OAuth consent, CAPTCHA, hardware 2FA) use Login Assist (§18.4).

## 22. Node API Authentication

V1 is single-owner at the Node level and does not require PRISM cloud accounts.

### 22.1 Long-lived owner bootstrap

A Node has one high-entropy owner API key for bootstrap and recovery. It MUST be generated with cryptographically secure randomness and MUST NOT be placed in URLs during normal operation. The format is `prism_ok_<key-id>_<secret>_<checksum>`: a fixed recognizable prefix, a non-secret key identifier, at least 256 bits of random secret, and a checksum that reduces secret-scanner false positives. The key is displayed exactly once at generation and stored only as a keyed verifier (§6.3). Verification uses constant-time comparison.

### 22.2 Device-bound browser sessions

At pairing (or recovery bootstrap) the Web client generates a non-extractable device keypair in the browser (WebCrypto ECDSA P-256) and registers the public key with the Node. The client exchanges the owner API key or a one-time pairing token for a short-lived, scoped session that is **sender-constrained** to that device key: every API request carries a proof-of-possession over the complete canonical request, including the exact body bytes (§58.12), and the Node rejects a proof that is missing, stale, replayed, bound to a different Node/session, or signed by a different key. A stolen session token or modified request body alone is not usable.

The owner key SHOULD be held only in protected client storage during initial setup/recovery and SHOULD NOT be copied into every request. It is never needed after pairing.

Session scope MUST identify at least Node, session, device, client class (`bundled` or `public_static`, §22.6), permitted domains/actions, issuance time, expiry, and revocation state. Sessions are bound to NodeId and DeviceId, not to the Node's network endpoint (§38.3).

Limits, stated honestly: a malicious script running in a live, trusted origin can still use the non-extractable key while the page is open. The device key prevents exfiltration and later replay of credentials, not in-page abuse. In-page abuse is bounded by client-class limits (§22.6), the Tier-4/5 rules (§20.2), and content isolation (§22.7). Device keys live in per-origin browser storage, which has consequences for ephemeral origins (§38.3).

### 22.3 Key generation and rotation

The owner key MUST have at least 256 bits of entropy. Node Manager can regenerate the key, which revokes the prior key. If the key is lost, it is regenerated; it is not recovered from reversible storage. Regeneration does not by itself revoke paired devices, so Node Manager MUST offer to revoke every device and session established using the prior key. Device revocation is otherwise independent (§22.10).

### 22.4 WebSocket authentication

WebSocket clients MUST use a short-lived, single-use ticket issued over an authenticated HTTPS request carrying a device proof-of-possession (§58.12). The ticket MUST be bound to the session, device, Node, and requested stream/control scopes. Ticket redemption MUST include a second device signature over the ticket digest and a fresh Node-supplied nonce. Browser clients carry the ticket and redemption proof in `Sec-WebSocket-Protocol` values, never in the URL; the server selects only the fixed `prism.v1` subprotocol and MUST NOT echo the ticket or proof. The Node verifies the proof and atomically consumes the ticket as part of a successful upgrade; an invalid proof cannot subscribe, replay events, or receive any application data. Tickets and nonces expire within 60 seconds.

### 22.5 LAN transport

If the Node API is exposed beyond loopback on a LAN, TLS MUST be enabled by default. Plaintext bearer credentials over arbitrary LAN HTTP are not an acceptable default. The setup flow may provide a managed local certificate or a user-supplied certificate.

### 22.6 Web client threat model

Because the public Web deployment may be served from a static host, it MUST be treated as potentially compromised. The public Web build MUST use a strict Content Security Policy, MUST avoid third-party executable scripts/analytics by default, SHOULD use Trusted Types where practical, and MUST contain no embedded long-lived Node secrets. Short-lived scoped sessions reduce the impact of a compromised static client.

Sessions carry a client class. `bundled` means the UI is served by the Node itself. `public_static` means the UI is served from a stable third-party static origin. A `public_static` session can satisfy approvals only up to Tier 3 unless the owner has marked that specific origin as trusted for Tier 4 in Node Manager, with the compromise risk explained at that moment. Login Assist input (§18.4) likewise requires a `bundled` session, an owner-trusted origin, or Node Manager.

### 22.7 Agent-produced content isolation

Agent output (markdown, HTML/SVG/PDF artifacts, terminal and log text, browser frames) is untrusted data, and is the most practical route to script execution in an authenticated origin. Therefore:

- Markdown renders through a sanitizer with no raw HTML. Remote images are blocked or fetched through an egress-controlled image proxy, since markdown image URLs are a known exfiltration channel. Links open with `rel="noopener noreferrer"` and show their destination.
- Rich artifacts (HTML, SVG, PDF, and any other active format) render only inside an `<iframe sandbox>` without `allow-same-origin` and without top-navigation. The Node serves them with `Content-Security-Policy: sandbox` and a policy that denies network access by default, plus `X-Content-Type-Options: nosniff`.
- Terminal and log views escape control sequences.
- Live browser view is pixel frames only, never DOM mirroring (§18.5).
- Agent content never executes in an origin that holds a session or device key.

### 22.8 Authentication abuse controls

- Rate limits apply to key exchange, pairing, session refresh, WebSocket ticket, and approval-submission endpoints, per source and globally, with exponential backoff.
- After a threshold of failed owner-key attempts (default 5 within 10 minutes) the Node enters temporary key lockout and raises a Node Manager alert. Pairing initiated through Node Manager still works during lockout.
- Credential comparisons are constant-time.
- The client source address is taken from forwarded-address headers only for requests arriving on the tunnel/proxy listener, never on the LAN or loopback listeners, so the header cannot be spoofed there.
- Failures are recorded as `security_audit` events without secret material. Webhook rate limits (§26.4) are separate.

### 22.9 Node identity

At install the Node generates a long-lived Ed25519 identity keypair, stored per §21.1. Its fingerprint (SHA-256 of the public key) is displayed in Node Manager and pinned by the client during pairing. On every connection establishment the client supplies a fresh nonce and the Node signs it together with its NodeId; the client refuses to proceed, with an explicit warning, if the signature does not verify against the pinned key. This detects impersonation of the Node by a tunnel or proxy; it does not prevent passive observation (§38.7). Identity rotation requires re-pairing every device, and restore MUST NOT silently overwrite the identity (§40.4).

### 22.10 Paired devices and automation tokens

Each paired device has a record: `DeviceId`, name, public key, client class, created-at, last-seen, scopes, and status. The owner can list and revoke devices from Node Manager, and may revoke other devices from an owner-scoped device session. Revocation immediately terminates the device's sessions and WebSocket tickets and cancels any `APPROVED`, unconsumed approvals signed by that device.

Automation tokens serve the CLI and other non-browser clients. They are created through Node Manager or a Tier-4 approval, carry an explicit scope list and a mandatory expiry, are shown once, stored only as a keyed verifier, and use a recognizable prefix. Automation tokens can never satisfy any approval and receive an approval-required error for any action that needs one. Webhook secrets remain a separate credential class (§26.4).

## 23. WebSocket Protocol

PRISM Web should use WebSockets for live runtime/event streams rather than HTTP polling wherever continuous updates are required.

### 23.0 Event classes and log semantics

PRISM distinguishes two classes of runtime data.

**Durable events** are recorded in the Node's durable, ordered event log. They are the replayable record of lifecycle and security-relevant activity: Run/Task/Approval/Node state changes, tool-call start and completion, completed messages (`message.created`), artifact creation, browser tab/navigation state changes, device pairing and revocation, and Login Assist boundaries. Every durable event has the envelope in §58.3, including at minimum: a Node-local monotonic sequence number, event ID, timestamp, event type/version, aggregate/entity ID(s), Run/Task/Agent correlation IDs where applicable, payload schema version, and a redaction/security classification.

**Ephemeral streams** carry high-rate data that has little value after the fact: token deltas (`message.delta`), browser frames (`browser.frame`), and resource telemetry samples (`resource.sample`). They are delivered live only, are never written to the event log, and are not replayable. Each ephemeral stream carries a per-subscription counter so clients can detect gaps. A completed message is persisted exactly once as a durable `message.created`. An in-progress message is exposed as run state (a partial-message snapshot obtainable over the API), so a reconnecting client fetches the partial snapshot and rejoins the live delta stream.

**Sequencing.** Durable events share one Node-local monotonic sequence. The number is assigned inside the transaction that commits the state change, and the event is published to subscribers only after that transaction commits (transactional outbox), so a subscriber can never observe sequence N+1 before N is durable.

**Subscriptions and cursors.** A subscription has a filter (Node, Agent, Task, or Run) and a cursor. The server delivers matching durable events with `sequence > cursor`, in order. Gaps in the sequence a subscriber sees are normal (events outside its filter, redaction) and are not errors: the contract is "every matching event after the cursor, in order", not contiguous numbering. Clients deduplicate by `event_id` and acknowledge the highest sequence they have applied.

**Redaction.** Payloads are held by reference and each event carries a security classification. The delivery layer applies per-session redaction, and `security_audit` events are delivered only to sessions holding the corresponding audit-read scope.

**Retention and resynchronization.** Event retention MUST have explicit per-Node time and size limits. If a client's cursor has fallen outside retention, the Node atomically establishes a consistent API read snapshot at the current committed event head `H` and responds with `resync_required{snapshot_token,as_of_sequence:H,expires_at}`. The token is opaque, short-lived (five minutes maximum), and bound to the Node, session, and subscription filter. It MUST be sent only in an authenticated request header or authenticated WebSocket control frame, never in a URL, log, event payload, or model context. Every resource API used for resynchronization MUST accept the token and return data from that same snapshot; it MUST NOT silently return newer current state as if it were state at `H`. Snapshot pagination retains the token and deterministic ordering. The client replaces its local state from that snapshot and subscribes from `H`; the Node pins events after `H` for the token's lifetime so the client can replay the gap. If the token expires, the client starts a new resynchronization. Referenced durable-event payloads MUST remain available for the event's retention period and while a valid snapshot/replay requires them. The Node never silently skips matching events. The security-audit hash chain (§35.2) is stored separately and is not subject to event-log compaction.

The same transport is used for:

- Agent output streaming.
- Tool events.
- Task state.
- Approval events.
- Browser session events/control as appropriate.
- Artifacts becoming available.
- Node status.
- Run completion/failure.

Event types follow `<domain>.<entity>.<verb>`. Examples of durable events:

```text
run.started
run.step.started
run.step.completed
run.paused
run.completed
run.failed
run.recovery_required
tool.call.started
tool.call.completed
message.created
browser.tab.changed
browser.login_assist.started
browser.login_assist.ended
artifact.created
task.created
task.updated
task.completed
approval.requested
approval.resolved
device.paired
device.revoked
model.status.changed
node.status.changed
```

Ephemeral streams:

```text
message.delta
browser.frame
resource.sample
```

The protocol and schemas live under shared packages so future clients do not need Node internals.

## 24. PRISM Protocol/API

The API is a stable product boundary.

The public Web application, Node-bundled Web, future mobile app, CLI, desktop app, and future social clients must all consume the same canonical Node API/protocol.

The protocol should expose stable domain objects rather than implementation details such as internal process IDs.

### 24.1 Required domains

The V1 API must cover at least:

- Node identity/status.
- Authentication/bootstrap.
- Paired devices and automation tokens.
- Agents.
- Agent configuration.
- Agent configuration history/undo.
- Tasks.
- Runs.
- Delegation tree.
- Agent messages.
- Tool calls/results.
- Approvals.
- Files.
- Artifacts.
- Browser sessions/tabs.
- Models.
- Model installation/load/unload state.
- Provider configuration.
- Resource pool.
- Agent resource profiles.
- Schedules.
- Activity/audit.
- Backup/restore.
- Update status.
- Remote-access mode, limits, and endpoint.
- Memory entries and provenance labels.
- Node Manager-only local operations.
- Consistent API snapshots used for WebSocket resynchronization.

## 25. Agent-to-Agent Communication

Agent-to-Agent communication uses a durable supervised message layer. Communication is not an unrestricted mesh.

### 25.1 Authorization graph

Each message is authorized against an explicit relationship:

- sender Agent;
- recipient Agent;
- creator/delegator;
- delegation chain;
- allowed target set;
- capability scope;
- data classification/taint;
- deadline and budget.

The Node MUST reject a message to an unauthorized target even if the model requests it.

### 25.2 Taint propagation

Taint/provenance MUST propagate across Agent messages, artifact transfers, tool results, and derived summaries. Summarizing, translating, OCR-ing, or copying untrusted material does not automatically make it trusted. Labels, context taint, and the decision rules are defined in §43.3. Agent-to-Agent messages are data with sender provenance (instruction level L5, §17.1) and cannot modify instructions or policy.

### 25.3 Messaging architecture

Agent A → durable message bus → Agent B, with Main Agent observation/supervision. The Main Agent need not synchronously process every message.

### 25.4 Supervision and specialist creation

Specialized Agents cannot directly create other specialized Agents. They can submit a creation request to the Main Agent. The request is evaluated through the same capability attenuation and policy rules as any other privileged action.

### 25.5 Loop/fan-out protection

Delegated work carries hop depth, parent task/run, chain ID, remaining delegation budget, message/rate budget, and deadline. The Node MUST reject or pause work that exceeds any configured limit. Creating a new message path MUST NOT reset these values.

## 26. Task and Run System

A **Task** is the durable unit of requested work. A **Run** is an execution instance/attempt associated with a Task and Agent.

### 26.1 Run properties

A Run MUST have stable IDs, Agent/owner IDs, parent/delegation references, status, timestamps, deadline/timeout or persistent mode, effective resource reservation, model/provider reference, cost counters where applicable, checkpoint reference, event sequence, artifacts, recovery/error state, and attempt linkage (`attempt_no`, `restart_of_run_id`, `from_checkpoint_id`; §27.5).

### 26.2 Supported run modes

V1 supports one-shot, scheduled, event-triggered, webhook-triggered, file-triggered, long-running, self-waking, and Agent-to-Agent delegated execution.

### 26.3 Waiting states and resources

When a Run enters any `WAITING_*` state (approval, child, message, resources, budget, sleep), `PAUSED`, or `RECOVERY_REQUIRED`, it MUST persist its state and release reclaimable CPU/RAM/GPU reservations. The Run reacquires resources through normal admission when it re-enters `QUEUED`. Browser profile/session persistence is a separate policy and may remain available if needed for continuity.

### 26.4 Webhook triggers

Webhook triggers MUST use a dedicated endpoint and per-hook secret. Preferred validation is HMAC over a canonical request representation with a timestamp and replay window. Each hook MUST support rate limiting and replay protection. Webhooks MUST NOT authenticate with the long-lived Node owner API key. In `quick_tunnel` remote-access mode, hook URLs change whenever the tunnel hostname changes, so webhook triggers are disabled in that mode unless the owner explicitly accepts that instability (§38.1).

### 26.5 File triggers

File-triggered tasks MUST define the watched scope, event type, debounce/coalescing behavior, and duplicate-event handling.

## 27. Durable Execution and Recovery

Durability is a V1 requirement. Logical work survives Node process failure, host reboot, and worker replacement.

### 27.1 Event-sourced run record

A Run's durable record is the Run-filtered view of the Node event log (§23.0); there is no separate per-Run sequence. Every durable event has a Node-local monotonic sequence, stable event ID, Run/Task/Agent/owner IDs, timestamp, event type/version, causality fields, and payload reference.

The event stream must support replay/resynchronization and reconstruct the current logical state.

### 27.2 Checkpoint and filesystem consistency

A checkpoint MUST define the logical Agent/Run state plus a filesystem consistency point. A checkpoint is committed transactionally with its metadata before the Run can claim the corresponding step is durable.

Every executable step has a durable step-journal record with its stable `StepId`, unique `StepAttemptId`, attempt number, canonical request hash, idempotency key where applicable, approval reference, worker/lease identity, monotonically increasing fencing token, start/finish timestamps, result or provider receipt, and reconciliation status. A database uniqueness constraint MUST prevent two active attempts from owning the same step. The Node grants a bounded execution lease; every tool-broker dispatch and result commit MUST present its current fencing token. Fencing tokens are durably monotonic per Node, and a Node restart advances the fencing epoch and invalidates all prior worker leases. Lease revocation MUST also fence the sandbox: the supervisor stops or freezes the run worker, and the egress proxy revokes the Run-bound network grant and closes its active connections before another attempt can be admitted. A stale worker MUST be rejected from starting a new side effect or committing state. Lease expiry after a side effect has started does not prove that the side effect failed; absent a verifiable receipt, the step becomes `SIDE_EFFECT_UNCERTAIN`.

The transaction that consumes an approval MUST also append the step-journal `STARTED` record, persist the idempotency key/request hash, and publish the corresponding durable event (§45, §58.6). The external side effect is dispatched only after that transaction commits. Retries of the same canonical request reuse its idempotency key when the tool/provider supports it. A changed request requires a new `StepId` and, where applicable, a new approval. A started opaque step is never automatically replayed solely because its worker lease expired.

For filesystem side effects that cannot be atomically committed with SQLite, the step MUST use one of:

- an idempotent/replay-safe operation;
- a step journal with reconciliation state; or
- a workspace snapshot/reference sufficient to restore a consistent point.

A recovered Run MUST NOT silently mix a newer filesystem state with an older logical checkpoint. Ambiguous state enters `RECOVERY_REQUIRED` until reconciled.

### 27.3 Recovery semantics

PRISM does not promise instruction-level continuation of arbitrary native processes or browser execution after a crash. Each recoverable step declares replay, idempotency, or reconciliation semantics. External side effects use idempotency keys/receipts where supported.

After restart, a step found `STARTED` without a committed result is reconciled according to its declared semantics: a valid provider/tool receipt resolves the outcome; a tool with guaranteed idempotency may be retried using the same request hash and key; otherwise the step enters `SIDE_EFFECT_UNCERTAIN` and follows the Task's `recovery_policy`. The Node MUST NOT infer success or failure from worker exit, lease expiry, timeout, or missing response alone. Only the current fencing token may commit a result or checkpoint.

### 27.4 State machines

Agent, Task, Run, Step Attempt, Approval, Model Installation, Update, Node, Browser Session, Trigger, and Secret Store lifecycle state machines MUST be explicitly enumerated in the contract artifact in Section 58. Invalid transitions are rejected deterministically. The definitions in §58.2 are the source of truth; the prose in §26–§28 MUST conform to them.

### 27.5 Recovery resolution and Run attempts

Restarting from a checkpoint, whether automatic after a crash or requested by the owner, always creates a **new Run attempt** (`attempt_no + 1`, `restart_of_run_id`, `from_checkpoint_id`). It never resumes a Run that reached a terminal state. Within a non-terminal Task the new attempt is a new Run under the same Task (for example when a Run fails and the retry policy permits another attempt). For a Task that has already reached a terminal state, an owner-requested restart creates a successor Task (`restarted_from_task_id`) with a new Run seeded from the checkpoint.

`RECOVERY_REQUIRED` always has a resolver. Every Task and schedule carries a `recovery_policy`:

- `auto_reconcile`: the Run's context receives a crash notice ("step N may have partially executed; the workspace may be modified"), and the Agent performs a reconciliation step before continuing. Only steps whose tools declare idempotency or a verifiable receipt resume automatically.
- `escalate`: a UI item is raised offering these owner actions: resume from checkpoint, retry the step, mark the step succeeded (an audited attestation), mark the step failed, or abandon.
- `fail`: the Run moves to `FAILED`.

Unattended Runs also carry a `recovery_timeout`. If no resolution arrives in time the Run moves to `FAILED` with reason `abandoned`, so the next scheduled occurrence can proceed instead of stalling. Opaque steps (shell and arbitrary process execution) default to `side_effect: uncertain` (§58.6).

## 28. Scheduler

The scheduler manages scheduled tasks, delayed wakeups, retries, deadlines, persistent runs, triggers, and resource admission.

Every schedule stores an explicit IANA timezone. DST behavior MUST be deterministic:

- nonexistent local times are shifted forward to the next valid instant;
- repeated local times execute at most once unless the schedule explicitly requests both occurrences.

Every recurring task has a missed-run policy: `skip`, `run_once_on_recovery`, or `catch_up_all` with a configured maximum catch-up count.

The scheduler MUST persist next-fire state transactionally with task state so restart does not create uncontrolled duplicate runs.

If resources are unavailable, a Run queues, follows an explicit degradation policy, or fails clearly. It MUST NOT claim resources it does not have.

## 29. Delegation Budgets

Main Agent orchestration should support bounded execution budgets including:

- Maximum number of concurrently active specialized Agents.
- Maximum delegated tasks.
- Maximum delegation depth.
- Maximum run duration.
- Maximum provider spend for BYOK work.
- Maximum model-call count where configured.
- Maximum resource consumption where appropriate.

Defaults must be conservative enough to prevent an accidental recursive runaway system.

## 30. BYOK Provider System

BYOK and self-hosted inference are first-class provider paths.

V1 provider targets include:

- NVIDIA NIM.
- OpenRouter.
- OpenCode Go.
- OpenAI.
- Anthropic.
- Gemini.
- Generic OpenAI-compatible APIs.

Provider support must be implemented behind a stable provider interface.

Agent configuration references a provider/model abstraction rather than hardcoding provider-specific transport details throughout the Agent runtime.

### 30.1 Cost control

BYOK Agents may have:

- Per-run spend budget.
- Per-day spend budget.
- Per-task spend budget.
- Model-call limits.
- Provider-specific restrictions.

Before an expensive model call, PRISM should compute a conservative cost estimate from the selected model's current pricing metadata, token limits, requested generation cap, and known usage. After the call, actual usage/cost is reconciled against the estimate. The estimate is advisory until a provider confirms usage, while hard pre-call limits such as maximum output tokens and maximum calls remain enforceable.

Pricing metadata must be versioned with an effective timestamp/source. If a provider does not expose reliable pricing or usage, PRISM must mark cost as estimated/unknown rather than inventing precision.

When the budget is exhausted or the next action would exceed a hard budget, the run must stop, pause for approval, or follow an explicit fallback policy. It must not continue spending silently.

Self-hosted model inference is not treated as API-billed provider spend, but consumes Node CPU/RAM/GPU resources and therefore remains subject to resource scheduling.

## 31. Model Manager

PRISM owns a model abstraction and model catalog.

The Agent stores a model ID/reference such as:

```text
qwen3-30b
```

not an Ollama-specific implementation name.

The Model Manager determines which runtime/provider is used.

### 31.1 V1 local runtime

**Ollama is the V1 local inference runtime.**

It is hidden behind a runtime adapter.

Future adapters can target llama.cpp, vLLM, or other runtimes without changing Agent definitions.

### 31.2 Runtime/provider abstraction

Provider support should be organized around a small number of adapter families rather than duplicating nearly identical transport code:

```text
PRISM Model Manager
├── Ollama local-runtime family
├── OpenAI-compatible provider family
│   ├── OpenAI
│   ├── NVIDIA NIM
│   ├── OpenRouter
│   ├── OpenCode Go (subject to implementation compatibility validation)
│   └── other compatible endpoints
├── Anthropic provider family
└── Gemini provider family
```

A provider preset may supply endpoint/model metadata, headers, capabilities, and pricing information without creating a new core adapter when the wire contract is compatible. The exact OpenCode Go API/compatibility contract must be validated against its current official documentation during implementation rather than assumed from its product name.

The exact division between model providers and runtime adapters should remain clean: a local runtime is an execution backend; a BYOK provider is a remote inference provider.

### 31.3 Installed vs loaded

PRISM distinguishes:

- Model catalog entry.
- Installed model weights.
- Currently loaded/running model session.

Model weights are shared at Node level.

Agents reference shared model IDs and do not each maintain separate copies of the same local model weights.

The Node may unload models when resources are constrained and reload them later.

### 31.4 Model installation UI

User workflow:

```text
Models
→ Add Model
→ Choose catalog entry
→ PRISM checks compatibility
→ Download
→ Verify
→ Install
→ Register
```

No manual runtime CLI commands are required.

Interrupted downloads resume.

### 31.5 Hardware compatibility

The model manifest must include machine-readable requirements such as:

- Model ID.
- Display name.
- Capabilities.
- Context length.
- Quantization/variant.
- Download size.
- Minimum RAM.
- Recommended RAM.
- VRAM requirements where relevant.
- CPU architecture constraints.
- GPU/backend constraints.
- Runtime compatibility.
- Provider compatibility.

The UI must distinguish exact compatibility from approximate recommendations.

## 32. Model Routing

Both explicit model selection and automatic routing are supported.

An Agent can specify:

- Explicit provider/model.
- Automatic routing profile.

Possible routing profiles include:

- Fast.
- Reasoning.
- Vision.
- Long-context.
- Cheap.
- Local.

The caller of an Agent may override the model/routing policy for a particular task where permitted.

This means:

```text
Agent default model policy
        ↓
Caller/task override
        ↓
Node provider/model policy
        ↓
Actual selected model
```

The Node must expose the final selected model/provider in run metadata.

## 33. Tool and Skill System

Tools are executable capabilities mediated by the Node.

Skills are higher-level agent capabilities/configuration bundles that may describe workflows, instructions, tool availability, or reusable behavior.

V1 should support developer extensibility without requiring a public marketplace.

Tool implementations must not run with unnecessary control-plane privileges.

Community/user tools should execute in isolation from the Node control plane whenever their risk warrants it.

MCP-compatible tool integration may be implemented where useful, but the V1 specification does not require a marketplace or public plugin catalog.

## 34. Artifact System

Artifacts are durable outputs created by Agent work.

Examples:

- Documents.
- Images.
- Data files.
- Reports.
- Archives.
- Generated source trees.
- Browser-extracted datasets.

Specialized Agents generally create artifacts and hand them to the Main Agent or another authorized Agent. The Main Agent is the normal user-facing presentation layer for specialized-Agent results.

Artifacts must have stable IDs and metadata and be traceable to the creating run. Artifacts are immutable and content-addressed (the content hash is recorded), are stored in the control-plane-owned artifact store and never in a sandbox-writable location (§16.1), carry taint labels (§43.3), and are served and rendered under the isolation rules in §22.7.

## 35. Activity and Audit

PRISM records a detailed activity trail.

### 35.1 Audit classes

The system distinguishes:

- **Agent payload/history:** task content, prompts, files, artifacts, and ordinary run data; deletable according to Agent deletion policy.
- **Security audit metadata:** authentication events, Node Manager step-up and helper-key enrollment/rotation, secret-store lock/unlock and key rotation (never passphrase material), device pairing/revocation and key regeneration, policy decisions, approvals, credential-use references, Login Assist session boundaries (never input content), taint declassification/promotion, Agent deletion/reset events, update events, and other records required to explain security-relevant behavior.

Security audit metadata MUST remain available after Agent deletion for the retention period defined by Node policy. It must contain no unnecessary secret values.

### 35.2 Integrity

Security audit records SHOULD use a tamper-evident hash chain or equivalent append-only integrity mechanism. Verification failures MUST be visible as a security event.

The activity system covers user actions, Main Agent actions, specialized Agent actions, tool calls/results, policy decisions, approvals, file transfers, browser events, model selection, resource changes, updates, restarts, failures, and recovery.

Users can inspect appropriate activity in PRISM Web.

## 36. Browser and Runtime Isolation

Agents execute in isolated environments. V1 uses container/process isolation rather than full VMs.

### 36.1 Agent filesystem and execution lifecycle

An Agent has persistent identity/state and persistent workspace data, but execution workers are replaceable. The default lifecycle is hybrid:

```text
Persistent Agent definition/state/workspace
                 ↓
Replaceable execution container/worker
                 ↓
Checkpointed logical progress
```

Agent package/environment state that must survive worker replacement MUST be stored in the declared Agent workspace or a managed package/cache layer, not only in container-local ephemeral state.

### 36.2 Sandbox capability boundary

Arbitrary shell access is controlled by capabilities, not by a fragile command-name blacklist. Examples include `shell.basic`, `shell.network`, package-install capability, and host-mediated capabilities.

The Agent sandbox MUST NOT have privileged access to PRISM databases, owner keys, host secrets, other Agent workspaces, arbitrary host root paths, host process control, devices, or container-engine sockets unless a narrowly scoped mediated capability explicitly permits it.

Rootless OCI containers on PRISM's private runtime (§36.4) are the primary V1 sandbox mechanism but are not treated as a complete boundary. Every sandbox MUST: run unprivileged (no privileged mode), drop all capabilities (adding back only declared minimal ones), set `no-new-privileges`, apply a restrictive seccomp profile (at least the runtime default), avoid sharing host PID/IPC/network namespaces, use minimal mounts, and have no container-engine socket. The hardened baseline SHOULD additionally use user namespaces with subuid mapping, AppArmor/SELinux profiles where available, and read-only root filesystems where practical.

The Rust supervisor is the only PRISM component that directly coordinates low-level container/process lifecycle. It applies deny-by-default mounts/devices/capabilities/network profiles. Its interface is defined in §36.4.

Chromium MUST retain its own sandbox and MUST NOT be launched with `--no-sandbox` to work around container/runtime incompatibilities. Browser workers inherit the Agent network and capability policy.

The architecture retains an upgrade path to stronger isolation such as gVisor/Sysbox or VM-backed sandboxes.

### 36.3 Process identities and privilege matrix

| Component | OS identity | MAY access | MUST NOT access |
|---|---|---|---|
| Control plane (Node.js) | `prism` service user | Database, event log, secret store, artifact store, public and Node Manager listeners, the supervisor IPC socket | The container-runtime socket; workspace and browser-profile directories (filesystem permissions deny it) |
| Supervisor + WorkspaceFS (Rust) | `prism-sup` | PRISM's private container runtime, workspace and profile roots | Database, secret store, owner keys, artifact store |
| Model runtime (Ollama) | `prism-model` | Model weights directory, GPU | Database, workspaces, secrets; it is reachable only by the control plane (loopback or Unix socket), never from sandboxes |
| Egress proxy | `prism-proxy` | Sandbox-facing network namespace, its policy snapshot | Database, workspaces, secrets |
| Agent worker | `prism-worker` | A run-scoped Unix-socket channel to the control plane | Database, runtime socket, workspaces, host filesystem beyond its own scratch space |
| Sandbox | rootless container user | Its workspace mount, the egress proxy | Everything else |
| Parser sandbox | ephemeral rootless container | A single input stream | Everything else; no network |

Each identity owns its directories with mode `0700` or tighter. No component holds a privilege it does not need for its row.

### 36.4 Private container runtime and supervisor interface

PRISM installs and manages its own rootless container runtime (rootless Podman or a rootless Docker daemon) under the `prism-sup` user, with its own storage and socket. It MUST NOT use, reconfigure, or depend on the host's system container engine, and MUST NOT apply daemon-wide settings (such as `userns-remap`) to it. The runtime socket is mode `0600`, owned by `prism-sup`, and reachable only by the supervisor.

The supervisor accepts requests only over a Unix socket whose peer is authenticated by `SO_PEERCRED` against the control plane's uid. The interface is declarative: lifecycle requests name an operation (`start`, `fence`, or `stop`), a vetted `template_id` where applicable, and `{agent_id, run_id, resource_grant, fencing_token}`. It never accepts raw container flags, image references outside the vetted templates, or host paths. Mounts are derived from IDs under the data root. Unknown fields are rejected, every call is audited, and the schema is versioned and frozen per §59.1. `fence` and `stop` are idempotent and acknowledge only after the worker cannot execute further instructions. The control plane separately revokes the Run-bound egress grant and MUST wait for both acknowledgements before admitting a replacement attempt. Hardened templates are versioned with the PRISM release.

### 36.5 Agent worker channel

At spawn, each Agent worker receives a short-lived per-run capability token over an inherited Unix-socket descriptor. The control plane derives the Agent and Run identity from that token and never from the request body. Step/tool requests carry the current `StepAttemptId` and fencing token; the control plane and broker validate them against the durable lease before dispatch or result commit. The token expires with the Run, and the worker never holds a database handle.

### 36.6 Untrusted content parsing

PDF, OCR, HTML, image, Office, and archive parsing runs in an ephemeral parser sandbox (no network, read-only input, size/time/memory caps) and returns structured data carrying a taint label. Such parsing MUST NOT run in the control plane or in Agent workers.

## 37. Network Model

### 37.1 Agent network

Agent network access is capability- and policy-controlled. All egress MUST cross a policy boundary that can validate destination host/IP, port, protocol, DNS resolution, redirect targets, and proxy behavior.

By default, sandbox network policy denies loopback, localhost, link-local, RFC1918/private ranges, cloud metadata endpoints, Unix-socket bridges, and other control-plane addresses. DNS resolution and final destination IP MUST both be checked to prevent DNS rebinding/SSRF bypass. Redirects are revalidated at every hop.

The egress proxy (§37.3) is mandatory. It records effective destinations and enforces allowlists. Domain allowlists do not replace private-address blocking.

Untrusted/tainted data combined with an egress or credential capability MUST cause the policy engine to apply the configured safe behavior: deny, require human approval, or allow only within an explicit destination/scope policy. Taint MUST NOT itself grant authority. The default decision matrix is in §43.3.2.

### 37.2 Node networking

LAN-exposed Node APIs use TLS by default. Public listeners use strict Host/Origin validation and explicit allowed origins. Remote access uses the outbound-only modes in §38; manual port forwarding is not required.

### 37.3 Egress architecture

The following architecture is mandatory. The concrete proxy implementation remains an open choice (§56).

1. **No direct route.** Sandboxes attach to an internal-only network with no default gateway. Network-layer rules (for example nftables on the sandbox bridge or namespace) permit traffic only to the egress proxy's address and port and drop everything else, including all UDP and ICMP. Proxy environment variables are a convenience, not the enforcement mechanism.
2. **Proxy-owned DNS.** The sandbox resolver resolves nothing itself; names are resolved by the egress proxy. This closes DNS-tunnelling exfiltration.
3. **Validate, then pin.** The proxy resolves the hostname, checks every returned A/AAAA record against the deny set, and connects to the validated address without a second lookup. The deny set covers at least loopback, link-local, RFC1918, CGNAT (`100.64.0.0/10`), `0.0.0.0/8`, multicast, IPv6 unique-local, IPv4-mapped/compatible forms of all of these, and cloud metadata addresses.
4. **Redirects.** Each redirect hop is a new connection revalidated under rule 3 and the Agent's destination policy. Control-plane HTTP tools use a hardened fetcher with a redirect cap and per-hop validation.
5. **No TLS interception by default.** The egress proxy's HTTPS policy is host- and port-level; it cannot inspect path, header, or body. Browser requests are separately intercepted inside the browser worker before encryption and evaluated by the capability/policy layer (§18.3, §43.3.5). Non-browser HTTPS tools MUST declare their effective request scope and cannot claim path/body enforcement from the proxy. The UI and documentation MUST say that an allowed domain hosting user-writable content remains an exfiltration route; quarantined-reader isolation and taint policy (§43.3) are mandatory defenses, not a claim that the proxy can inspect HTTPS.
6. **Chromium.** Chromium is launched with the proxy, QUIC disabled, and a WebRTC policy that prevents non-proxied UDP. Rule 1 makes these defence-in-depth rather than the sole control.
7. **Capability semantics.** `network.http` is a policy-mediated HTTP(S) operation whose request target and body are visible to the control-plane fetcher. `shell.network` is proxy-mediated outbound TCP to allowed host:port only; raw sockets and UDP are never available in V1. Because HTTPS payloads from this capability are opaque to the proxy, `shell.network` is denied from tainted contexts. The package-install capability reaches allowlisted package mirrors only and cannot be used to send arbitrary user data.
8. **Run-bound enforcement and accounting.** Every sandbox egress grant is bound to the active Run lease. Revoking or expiring the lease removes the route and closes active connections before a replacement attempt is admitted. The proxy counts bytes and connections per Agent and Run. These feed the network resource dimension (§9.3) and anomaly alerts.

## 38. Remote Access V1

Remote access is provided by a provider-abstracted Remote Access Manager. A remote endpoint is disposable connection metadata. Trust is anchored in the Node identity key (§22.9) and paired-device keys (§22.10), never in the endpoint URL.

### 38.1 Modes

| Mode | Purpose | Endpoint | Notes |
|---|---|---|---|
| `quick_tunnel` | Zero-configuration, temporary access | Ephemeral hostname that changes when the tunnel restarts | Labelled "Temporary" in the UI. Cloudflare documents Quick Tunnels as testing/development infrastructure, with a hard limit on concurrent in-flight requests (200 at the time of writing) and no Server-Sent Events support. PRISM MUST NOT depend on SSE and MUST stay within the request limit. Webhook triggers are disabled in this mode unless the owner explicitly accepts that hook URLs change on restart (§26.4). |
| `named_tunnel` | Stable remote access | Stable hostname on the owner's own Cloudflare account | Outbound-only. The owner supplies a tunnel token through Node Manager. |
| `external_proxy` | Tailscale, a user-managed reverse proxy, or similar | Owner-configured base URL | The Node validates and records the base URL. The owner is responsible for the proxy's TLS and exposure. |

The V1 release MUST ship `quick_tunnel` and at least one stable mode (`named_tunnel` or `external_proxy`). Third-party limits can change, so the implementation MUST verify against current provider documentation and the test suite MUST exercise WebSocket behaviour through a real Quick Tunnel, because Cloudflare's published limits do not describe WebSocket capacity.

### 38.2 No port forwarding

PRISM V1 does not require router port forwarding or manual inbound NAT configuration.

### 38.3 Endpoint independence and reconnection

Sessions are bound to NodeId and DeviceId, not to the endpoint (§22.2). If the endpoint changes, the Node records the new endpoint and the client reconnects to it and verifies the Node's identity signature (§22.9); no re-pairing is needed.

Device keys are stored in per-origin browser storage. A client served from a stable origin (the public static Web, or a Node-bundled Web in a stable mode) keeps its device key across endpoint changes. A Node-bundled Web served from an ephemeral `quick_tunnel` hostname is a new origin after every hostname change and MUST re-pair, through Node Manager or owner-key recovery. The UI MUST explain this when `quick_tunnel` is selected. Note that `public_static` sessions are capped below Tier 4 unless the owner trusts that origin (§22.6).

### 38.4 Ingress allowlist

Tunnel and proxy adapters forward only to the public listener. The public route set is `/v1/*`, `/ws`, `/hooks/*`, and the bundled Web static assets. Node Manager routes are not registered on that listener at all (§6.1).

### 38.5 Endpoint beacon

The owner may configure a beacon channel (a generic webhook, an ntfy-style topic, or SMTP) in Node Manager. When the endpoint changes, the Node sends the node display name, the new endpoint URL, and a timestamp, signed with the Node identity key. The payload contains no credential, token, or pairing material. This solves the case of a Node that reboots while its owner is away. The beacon is a connectivity aid, not a general notification system (§2.2).

### 38.6 WebSocket transport and capacity

Live events use authenticated WebSockets with single-use tickets, ordered sequence numbers, replay, and resynchronization (§22.4, §23.0). The Web client multiplexes all subscriptions over one WebSocket per Node and bounds its concurrent HTTP requests. The Node advertises remote-access mode and limits in its capability advertisement (§50).

### 38.7 Provider visibility

Tunnel providers terminate TLS and can observe or alter traffic in transit: prompts, outputs, files, and live browser frames. The setup UI MUST disclose this for every tunnel-based mode. Node identity pinning (§22.9) detects impersonation of the Node but not passive observation. Application-layer end-to-end encryption between client and Node is a candidate future hardening and not a V1 requirement.

### 38.8 Headless bootstrap

A headless Node MUST be bootstrappable without exposing the owner API key in process arguments, logs, QR codes, or URLs. The supported flow is a short-lived single-use pairing code/token obtained through a local authenticated admin path.

### 38.9 Future remote-access adapters

Remote Access Manager is provider-abstracted so another tunnel/relay adapter can be added without changing the Web/Node API.

## 39. Bootstrap and Connection UX

Primary bootstrap options are:

1. Local Web/Node Manager pairing.
2. Short-lived headless pairing token.
3. Manual Node URL + owner API key for recovery/advanced setup.

QR convenience uses only the short-lived pairing token and current endpoint. Scanning a QR never embeds a reusable owner credential.

The Web client generates its device keypair, exchanges the pairing token and device public key for a scoped, device-bound session, pins and displays the Node identity fingerprint (§22.9), and invalidates the token after exchange.

## 40. Backup and Restore

V1 provides one-click Node backup/restore. The package is a versioned encrypted archive; “ZIP-style” describes the user-facing container, not the cryptographic construction. ZipCrypto is forbidden.

### 40.1 Backup format

The backup pipeline is:

```text
files/database snapshot
        ↓
metadata manifest
        ↓
compression (zstd where appropriate)
        ↓
chunked authenticated encryption
        ↓
archive/package
```

The cryptographic envelope MUST use a modern authenticated construction such as AES-256-GCM with unique nonces per encrypted chunk, or an equivalent misuse-resistant authenticated stream such as libsodium secretstream. The password KDF MUST be memory-hard such as Argon2id. Each backup contains format version, KDF parameters, salt, nonce/stream metadata, authenticated manifest, chunk integrity data, and failure-safe validation.

### 40.2 Backup scope

Backups may include Node configuration, database, Agent definitions/state/workspaces, memory, task/run metadata, schedules, artifacts, model catalog state, and selected browser profiles. Model weights are optional because they are large/shared.

Secrets are excluded unless the user explicitly chooses a secret-inclusive backup. If included, they remain encrypted within the same authenticated envelope and restore only into the local secret store.

### 40.3 Consistent database snapshot

SQLite backup MUST use the online backup API or an equivalent transactionally consistent snapshot. Live WAL files MUST NOT be copied as an ad-hoc database backup. Workspace and browser-profile data are read only through WorkspaceFS no-follow, inode-boundary, and per-Agent hardlink-domain rules, with symlinks stored as links and never dereferenced (§16.1).

### 40.4 Restore semantics

Restore is an administrative operation. By default, the Node enters a restore mode in which new Runs are stopped/blocked and active workers are drained. The restore process validates the entire manifest, cryptographic integrity, compatibility, schema version, and required storage before replacing state.

Restore MUST be atomic at the Node state level: either the prior state remains active or the validated restore becomes active. Partial Agent restore is supported only when the data dependencies can be isolated safely; otherwise restore is Node-wide.

Node identity, Node Manager helper trust key, owner key, credentials, model weights, and browser profiles are independently selectable restore domains with explicit defaults. The platform helper private key is never included in a backup. Restoring a backup MUST NOT silently overwrite the current Node identity or local-administrator trust key; restoring to a different host requires fresh local OS-authenticated enrollment of that host's helper key before Tier-5 actions are available.

A pre-restore snapshot MUST be created so a failed restore can return to the prior state. Restore extraction uses the hardened extractor (§16.1).

## 41. Storage

SQLite is the V1 Node database.

WAL mode should be used for robust concurrent read/write behavior where supported.

The database must be treated as a durable component, not disposable cache.

Large binary data should not be forced into SQLite where filesystem/object storage is more appropriate. The data model should use IDs/references for large workspace/artifact payloads while maintaining transactional metadata in SQLite.

The storage abstraction should avoid scattering raw SQL throughout the application and should keep a path open to a future PostgreSQL backend if scale requires it.

## 42. Updates

PRISM automatically updates itself and managed dependencies.

### 42.1 Signed update chain

Artifacts MUST be cryptographically verified before installation using trusted release metadata, integrity checks, compatibility checks, and anti-downgrade/version floors. Signing trust MUST support protected key custody, rotation, revocation, recovery, and compromise response. A TUF-like separation of root/repository/targets metadata is preferred.

The initial installer MUST verify its bootstrap artifact using a pinned trust root/checksum/signature obtained from a trusted distribution channel. `curl | sh` style execution is not the security model; the installer artifact itself MUST be verifiable before it runs privileged installation steps.

### 42.2 Drain, stage, and health check

Before an update, the Node MUST enter an update-drain state:

1. stop admitting new nonessential Runs;
2. persist checkpoints for eligible active Runs;
3. wait for or safely terminate non-drainable workers according to policy;
4. create a rollback point;
5. stage and verify the update;
6. atomically switch versions;
7. start services;
8. run measurable health checks;
9. commit the update only after health checks pass.

Health checks MUST include API availability, database migration success, worker startup, event-log integrity, policy engine availability, and required dependency compatibility.

### 42.3 Rollback and migration safety

Failed health checks automatically roll back to the previous known-good binary and compatible database state. Database migrations use expand/contract or an equivalent compatibility strategy. Destructive migrations require a verified pre-migration backup/snapshot. A binary rollback without a compatible database state is not a valid rollback.

### 42.4 Update modes

V1 defaults to automatic updates. The user may defer a non-security update only within a bounded policy; security updates MUST retain a defined automatic path. A permanently disabled update state is not a supported security default.

### 42.5 Managed dependency validation

Bundled Chromium, Ollama, cloudflared, and other managed dependencies are updated only to versions covered by PRISM compatibility/health tests.

## 43. Security Threat Model

PRISM assumes Agents can encounter malicious external content and can produce unsafe or incorrect plans. Security boundaries MUST therefore be enforced outside model reasoning.

### 43.1 Trust-boundary matrix

| Actor/threat | Asset | Boundary | Required defense |
|---|---|---|---|
| Compromised/malicious Web content | credentials, Agent authority | browser → Agent | taint/provenance, capability isolation, credential broker, egress policy |
| Malicious Agent output | host/control plane | Agent → policy broker | deterministic capability enforcement, no direct privileged APIs |
| Compromised static Web client | Node control | Web → Node API | scoped short-lived sessions, strict CSP, no embedded owner secret, TLS |
| Sandbox escape | Node/other Agents | container → host | rootless/userns/caps/seccomp/LSM, no host sockets, Rust supervisor |
| SSRF/DNS rebinding | LAN/metadata/control plane | sandbox → network | IP validation, redirect revalidation, egress gateway |
| Malicious `.prism` package | Node policy | import → Agent config | untrusted import, capability attenuation, human review for elevated requests |
| Approval TOCTOU | sensitive side effect | UI → executor | canonical action object + action hash |
| Stolen pairing token | Node session | bootstrap → session | short expiry, single-use, scope binding |
| Update signing compromise | software supply chain | updater → binary | signed metadata, rotation/revocation, anti-downgrade, rollback |
| Script in agent-rendered content (XSS) | session and approval authority | Agent output → Web UI | markdown sanitizer, sandboxed iframes, CSP, device-bound sessions (§22.7) |
| Stolen or replayed session token | Node session | network → API | proof-of-possession per request, device revocation (§22.2, §22.10) |
| Request-body/path tampering by an intermediary | tool/action integrity | client → Node API | device signature over the canonical full request, including body digest and Node/session binding (§58.12) |
| Unauthenticated local process reaching Node Manager | Tier-5 authority | local process → Node Manager | fresh OS-backed step-up and action-bound single-use assertion; loopback is not authentication (§6.1) |
| Covert egress channels (DNS, UDP, QUIC, WebRTC) | private data | sandbox → network | internal-only network, proxy-owned DNS, UDP drop, IP pinning (§37.3) |
| Symlink, cross-boundary hardlink, path, or archive abuse | host files | workspace → control plane | WorkspaceFS no-follow plus inode/device/ownership boundary, isolated per-Agent hardlink domains, hardened extractor (§16.1) |
| Memory or instruction poisoning | Agent authority | persistence → context | provenance labels, taint high-water mark, import review (§43.3, §15.1) |
| Page-script or service-worker exfiltration | credentials/private data | browser → network | pre-transmission browser-worker request interception, origin-bound credentials, quarantined-reader separation (§18.3, §43.3.5) |
| Stale worker repeats or commits a side effect | external state | worker → tool broker | durable leases/fencing tokens, idempotency receipts, explicit uncertain-side-effect reconciliation (§27.2–§27.3) |
| Cursor loss or event-retention gap | client state consistency | event log → client | snapshot-token reads consistent as of sequence plus replay retention (§23.0, §58.10) |
| Keystore unavailable during boot | credentials and identity | service startup → secret store | `DEGRADED/secrets_locked`, no secret release or plaintext fallback (§21.1) |
| Tunnel provider observing or impersonating the Node | confidentiality, session integrity | Node ↔ client via tunnel | identity-key pinning, disclosure, stable modes (§22.9, §38.7) |
| Compromised or malformed model-provider output | tool-call integrity | provider → runtime | provider output treated as untrusted; tool calls validated against contracts and policy |
| Compromised worker or sandbox escalating to the host | database, secrets, runtime | worker → control plane / supervisor | distinct OS identities, declarative supervisor IPC, run-scoped tokens (§36.3–§36.5) |

### 43.2 Untrusted content

Web pages, files, emails, documents, external API responses, and tool-returned text are data, not trusted instructions.

### 43.3 Deterministic taint rules

Taint/provenance is attached to external content and propagates through extraction, OCR, summarization, translation, browser capture, artifact transfer, and Agent-to-Agent messaging.

The following are mandatory rules:

1. Tainted data MUST NOT become trusted solely because a model summarized or quoted it.
2. Tainted instructions MUST NOT modify Node policy, trust roots, authentication, sandbox policy, or approval requirements.
3. If a requested action combines tainted input with a credential-use, external-write, destructive, or otherwise sensitive capability, the policy engine MUST apply the configured deterministic response: deny, require human approval, or constrain the action to an explicitly allowed destination/scope.
4. A model-generated claim that content is trusted is not a trust transition.
5. Trust promotion, where supported, is an explicit non-model operation with auditable provenance and policy authorization.

#### 43.3.1 Labels and granularity

Every content item (message, tool result, memory entry, artifact, or file ingested into context) carries one provenance label from this ordered set, highest trust first: `trusted_system`, `trusted_owner`, `agent_derived`, `external_untrusted`. `agent_derived` means generated by an Agent whose context was untainted at the time. Labels attach to content items, not to individual tokens. Derived content (a summary, translation, OCR output, extraction, or compaction result) inherits the lowest-trust label among its sources.

#### 43.3.2 Context taint and decision matrix

A model context is **tainted** as soon as it contains any `external_untrusted` item, and remains tainted until it is rebuilt from trusted items only. Taint is a high-water mark: compaction cannot launder it. Policy evaluation (§20.3) consults the context's taint state together with each action's own taint sensitivity.

Default responses when the requesting context is tainted. Node policy MAY be stricter. An owner allow rule may relax only an allowlisted, unauthenticated read within its exact origin/method/path/query-schema scope and with no dynamic Agent/owner data; it MUST NOT relax quarantine isolation, credential-use or external-write approval, the opaque-network denial, or Tier-4/Tier-5 requirements:

| Action class | Default |
|---|---|
| Reads, workspace writes, artifact creation, delegation within the existing authorization graph | Allow; taint propagates to the results |
| `network.http` or browser requests explicitly declared read-only for an exact origin/method/path/query schema, carrying no credentials and no dynamic Agent/owner data | Allow, scoped; the browser worker still validates each request |
| Opaque `shell.network`/raw TCP from a tainted context | Deny; an approval cannot make an uninspectable payload safe |
| `network.http` to other destinations; credential use; external writes (sending messages, posting, purchases); any request transmitting dynamic values from a tainted context; authenticated-browser requests not covered by an explicitly read-only scope | Require human approval (Tier 3 minimum) |
| Destructive actions; creating or modifying schedules, triggers, Agents, capabilities, or policies; `agent.create.request`; `node.admin.request` | Require human approval; never satisfiable by "Always allow" or "AI decides" |
| Changes to trust roots, authentication, sandbox policy, audit integrity, or update signing | Denied for Agents; human-only (Tier 5) |

#### 43.3.3 Declassification and promotion

Only non-model operations can raise a label: (a) an explicit owner action (Tier-3 confirmation, audited), or (b) a deterministic extractor that emits a schema-constrained typed value (an enum, a bounded number, an ID matching a pattern, or a URL matching an allowlist), whose output is labelled `agent_derived`. The model never decides that something is safe.

#### 43.3.4 Memory provenance

Memory entries store `{label, source_run_id, written_by}`. Writes from a tainted context default to `external_untrusted`. Loading an `external_untrusted` entry taints the loading context. Only owner promotion (§43.3.3) can raise an entry's label.

#### 43.3.5 Configuration-time isolation and browser requests

An Agent configured to ingest arbitrary external content (browser, email, arbitrary web fetch, inbound webhooks, or imported untrusted instructions) is a **quarantined reader**. It MUST have no credential references/use capability, no access to owner files or other Agents' private data beyond its own isolated workspace/profile, and no external-send capability. The Node MUST reject configurations, `.prism` imports, and configuration-history undos that combine arbitrary untrusted ingestion with any of those authorities; a Tier-3 acknowledgement cannot override this separation. The reader hands off only schema-validated outputs or artifacts carrying their original taint labels through the authorized transfer mechanism. A receiving Agent does not gain trust or authority from that transfer.

An Agent intended to operate an owner-selected authenticated website is a separate, narrowly scoped **authenticated browser Agent**, not a quarantined reader. Its credential references MUST be origin-bound; it MUST have no unrelated private-data or general external-send capability. Every browser-originated request, including requests initiated by page scripts, service workers, redirects, or subresources, MUST pass through browser-worker request interception before transmission. The worker validates the exact origin, path, method, query schema, credential use, and egress scope; blocks undeclared cross-origin requests; and submits credential-bearing or potentially state-changing requests to deterministic policy evaluation. A request is read-only only if an exact origin/method/path/query schema is explicitly configured as read-only, the request carries no credentials or body, and it contains no dynamic Agent/owner data; `GET` alone does not establish read-only behavior. Request values whose provenance cannot be established as fixed, policy-declared read-only data MUST be treated as dynamic and untrusted. In a tainted context, every credential-bearing request and every request transmitting a non-constant value from the context requires explicit human approval for that canonical request; page-script requests whose payload cannot be proven to fit an explicitly read-only schema are blocked or require approval. `Always allow` and `AI decides` cannot satisfy this requirement. The worker MUST NOT expose credential values to the model. The egress proxy remains the network-layer SSRF/private-address boundary and cannot be treated as inspecting HTTPS paths or bodies (§37.3).

The UI MUST explain that an authenticated website can observe and act on requests made to its own origin. The owner must explicitly configure the origin and credentials; this does not convert page content into trusted instructions or grant authority to other origins.

### 43.4 Tool mediation and secret isolation

Actual execution passes through policy/capability enforcement. Node owner keys and unrelated Agent secrets are never injected into general prompts.

### 43.5 SSRF and egress

HTTP/browser tools reject protected destinations by default, revalidate DNS/IP and redirect chains, and prevent bypass through alternate DNS, IPv6, proxy, or Unix-socket paths. The mandatory architecture is defined in §37.3.

### 43.6 Main-Agent confused-deputy prevention

The Main Agent is an orchestrator, not a trust-root administrator. It cannot self-escalate, rewrite deterministic deny rules, change authentication/trust roots, weaken sandbox isolation, disable audit integrity, or approve its own human-only action.

The Main Agent is the prime injection target because it ingests every specialist result and holds the broadest authority. When its context is tainted (§43.3.2), every control-plane action it requests (creating, configuring, or deleting Agents; granting or changing capabilities; creating schedules or triggers; provider or credential configuration; Node-level operations) requires human approval regardless of policy mode. Browsing and other untrusted-content ingestion should be delegated to quarantined reader Agents (§43.3.5).

## 44. Main Agent Supervision Semantics

The Main Agent is the primary coordinator but should not be implemented as a synchronous bottleneck for every internal operation.

It should observe the event/task graph and make decisions where orchestration requires reasoning.

Examples:

- Route a research request to a Research Agent.
- Ask an Analyst Agent to process the Research Agent output.
- Stop an Agent whose work has gone outside scope.
- Create a new specialist after a specialized Agent requests one.
- Ask the human for approval.
- Consolidate artifacts/results.
- Present the final result to the user.

## 45. Human Approval System

Approval requests are first-class durable objects.

An approval should identify:

- Requesting Agent.
- Parent task/run.
- Action/tool.
- Proposed scope.
- Relevant arguments/targets.
- Risk classification.
- Policy reason for requiring approval.
- Expiration/deadline.
- Canonical action hash.
- Policy version and matched-rule digest used for the decision.
- Required approval assurance level (§20.2).
- Approving device and signature (Tier 4).
- Result: approved, denied, expired, cancelled.

Approval decisions are persisted and auditable.

An approval is valid only for the exact canonical action hash and scope shown to the human. Changes to the tool, arguments, target, credential reference, policy-relevant scope, or other hashed fields require a new approval.

The UI should minimize approval fatigue by grouping only genuinely equivalent actions and showing the concrete target/scope rather than forcing users to approve opaque tool names.

For browser-originated approvals, the canonical action object includes the normalized origin/request target, method, credential reference, body digest, and a safe redacted preview where available. The UI MUST NOT display or persist secret values or Login Assist input. If the effective request cannot be represented and hashed without exposing a secret, the request is denied rather than approved through model-written prose.

A human approval requirement cannot be satisfied merely because the Main Agent claims the action is safe.

The approval UI MUST render from the canonical machine-readable action object used to compute the action hash, not from model-written approval prose. The UI MUST show the effective target, arguments/scope, credential reference (without secret value), risk tier, expiry, and requesting Agent.

Tier-5/human-only actions can be satisfied only through Node Manager (§6.1); no Web session, automation token, or model output can satisfy them. Tier-4 approvals require a device signature (§58.12) over the exact action hash, from a `bundled` session or an owner-trusted origin (§22.6). Tier-3 approvals require an explicit confirmation in a device-bound session. Node Manager's authenticated local session can satisfy approvals at any tier. Automation tokens never satisfy approvals. The model cannot impersonate any of these steps.

Approval acceptance MUST consume the exact action hash once. Consumption is committed in the same transaction that writes the step-journal "execution started" entry carrying the idempotency key (§58.6). If the executor crashes after that commit, the step becomes `SIDE_EFFECT_UNCERTAIN` and the approval is not reusable. An `APPROVED` approval that is not consumed before its expiry becomes `EXPIRED`.

The hash covers the matched-rule digest, so unrelated policy edits do not invalidate pending approvals. The executor nonetheless re-evaluates deterministic policy immediately before execution, and a deny (including a newly added deny) wins over an existing approval. A changed or replayed action requires a new approval.

## 46. Service Lifecycle

The Node should manage its internal services/workers through a supervised lifecycle.

States should include at least:

- Starting.
- Ready.
- Degraded.
- Stopping.
- Stopped.
- Updating.
- Restoring.
- Recovering.
- Failed.

A single component failure should not necessarily bring down all PRISM functionality.

The Rust supervisor and Node control plane should restart recoverable worker processes according to bounded retry/backoff policies.

## 47. Testing Requirements

Because PRISM is an autonomous runtime, testing must cover both normal behavior and crash/recovery behavior.

### 47.1 Unit tests

Cover:

- Policy decisions.
- Resource admission.
- Model routing.
- Cost accounting.
- Scheduling.
- Serialization/schema validation.
- Agent lifecycle rules.
- Export/import.
- Backup metadata.
- API authentication.

### 47.2 Integration tests

Cover:

- Web ↔ Node API.
- WebSocket event delivery.
- Agent worker ↔ control plane.
- Sandbox lifecycle.
- Browser session lifecycle.
- Model runtime integration.
- Tool broker.
- Approval workflow.
- Checkpoint/recovery.
- Update/rollback.
- Cloudflare tunnel connectivity where testable.

### 47.3 End-to-end tests

At minimum:

1. Install Node.
2. Start Node.
3. Configure resource pool.
4. Connect PRISM Web.
5. Create Agent.
6. Install a local model.
7. Run Agent task.
8. Observe live events.
9. Create browser-enabled Agent.
10. Execute browser task.
11. Delegate to second Agent.
12. Transfer artifact.
13. Trigger a human approval.
14. Restart Node during a run.
15. Recover from checkpoint.
16. Backup Node.
17. Restore Node.
18. Perform a simulated failed update.
19. Verify rollback.

### 47.4 Deterministic runtime test harness

PRISM must include a deterministic mock-model/replay harness for autonomous runtime tests. It must be possible to replay a run with predetermined model outputs/tool decisions and verify policy, state-machine, checkpoint, event, and recovery behavior without depending on a live external model.

The harness should support failure injection at model calls, tool execution, worker crash, database restart, browser failure, network timeout, approval expiration, and update-health-check boundaries.

### 47.5 Agent behavior evaluations

V1 should maintain a small evaluation suite covering tool selection, permission adherence, prompt-injection resistance, delegation-loop prevention, context compaction, artifact transfer, recovery behavior, and cost-budget adherence. Local models must not be assumed to be reliable at tool calling merely because the provider/runtime accepts the request.


### 47.6 Security acceptance corpus

The release test suite MUST include deterministic tests for:

- SSRF to localhost, RFC1918, link-local, metadata, IPv6 variants, DNS rebinding, and redirect chains.
- Sandbox escape attempts, container-engine socket access, host mounts/devices, and namespace abuse.
- Prompt injection that attempts credential exfiltration, policy changes, trust-root changes, or destructive actions.
- `.prism` packages requesting capabilities beyond Node policy.
- Child-Agent capability escalation and unauthorized Agent-to-Agent targets.
- Approval action-hash TOCTOU and replay.
- Pairing-token replay/expiry and WebSocket-ticket replay.
- Compromised/static Web-client assumptions, including CSP checks and absence of embedded owner secrets.
- Backup tampering/wrong-password/partial-corruption recovery.
- Backup restore cannot silently replace the current Node identity or Node Manager helper trust key; restoring onto another host requires local helper enrollment.
- Update signature failure, downgrade attempts, failed migrations, failed health checks, and rollback.
- Workspace host-access abuse: symlink to a host file, symlink swapped during a race, a hardlink to an inode outside the workspace, cross-Agent hardlink attempts, unexpected device/ownership, FIFO/device entries, zip-slip, and decompression bombs are all refused with no host data leaked; internal hardlinks remain workspace-local and are copied as bytes (§16.1).
- Egress covert channels: DNS tunnelling, UDP/QUIC/WebRTC, IPv4-mapped IPv6 literals, rebinding between validation and connect, redirects to metadata addresses, and raw sockets to public IPs all fail (§37.3).
- Session theft and request integrity: a session token, WebSocket ticket, or approval replayed from a different key is rejected; changing any signed request body byte, method, path, query, NodeId, or session fails proof verification; duplicate/replayed `jti` values fail; a revoked device fails within one request; a Tier-5 action attempted via the Web is refused; a Tier-4 approval from an untrusted `public_static` origin is refused.
- Agent-content isolation: scripted markdown or artifacts cannot reach the API or send requests; remote-image exfiltration is blocked (§22.7).
- Login Assist: nothing reaches the model transcript during a session, keystrokes are absent from logs and events, navigation outside the locked origins is blocked, and password regions are masked (§18.4, §18.5).
- Taint and browser mediation: an injection corpus delivered via browsing, memory, and `.prism` instructions produces no unauthorized credential use or egress; quarantined-reader configurations cannot receive credentials/private-data/external-send capabilities; page-script, service-worker, redirect, and subresource requests are intercepted before transmission; undeclared cross-origin requests and tainted dynamic query/path/body values are blocked or require exact human approval; tainted authenticated-browser credential use and state-changing requests require exact human approval; a tainted memory entry stays tainted across Runs; a tainted Main Agent needs approval for privileged control-plane actions (§18.3, §43.3).
- Authentication abuse: brute-force simulation triggers lockout and a Node Manager alert; the owner key cannot be retrieved after its single display (§22.8).
- Node Manager local authentication: Tier-5 is denied without fresh Linux PAM or Windows secure-desktop step-up; loopback/socket reachability alone is insufficient; only assertions signed by the pinned OS-protected helper key are accepted; assertions are Node/action/nonce-bound, expire within 60 seconds, and are single-use; helper-key rotation requires local step-up and revokes the old key (§6.1, §58.12).
- Secret-store lifecycle: unattended KEK protection works on every manifest-listed platform that claims it; passphrase-backed platforms boot `DEGRADED/secrets_locked`, release no secrets, and recover only after local unlock; no plaintext master-key fallback exists (§21.1).
- Policy conflicts: deny-overrides, scope intersection, mandatory approval precedence, and deterministic matching produce identical decisions regardless of rule insertion order or model output (§20.3).
- Privilege separation: a compromised worker cannot open the database, the runtime socket, or another Agent's workspace, and the supervisor rejects a crafted request carrying a host path (§36.3, §36.4).

### 47.7 Recovery and resource tests

Tests MUST cover crash at every durable step boundary, duplicate event delivery, worker replacement, stale-worker fencing, lease expiry before and after dispatch, sandbox termination and active-egress closure before replacement admission, filesystem/checkpoint inconsistency, approval waits releasing resources, GPU/inference admission, quota enforcement classification, scheduler DST transitions, and missed-run policies. They MUST also include a transition matrix generated from the §58.2 definitions (every legal edge succeeds and every other edge is rejected), event ordering under concurrent writers, snapshot-consistent resynchronization under concurrent writes and retention pressure, partial-message recovery on client reconnect, and each recovery-resolution action in §27.5.

### 47.8 Contract conformance

Protocol/state-machine schemas are tested independently of the UI. A deterministic mock model and replay fixture set MUST make tool-call, policy, approval, event, and recovery behavior reproducible without relying on local model quality.

## 48. Operational Defaults

V1 defaults should favor safe operation and low surprise.

Recommended defaults:

- Main Agent enabled.
- New specialized Agent network access determined by creation settings rather than implicit unrestricted access.
- Browser disabled unless selected during Agent creation.
- Arbitrary external-content ingestion defaults to the quarantined-reader profile; authenticated websites require the separate origin-bound browser profile.
- Persistent cookies/localStorage disabled unless browser persistence is intentionally enabled.
- High-risk tools require user approval.
- Paired-device session or scoped automation token required for remote Web/API access; the owner key is a recovery credential.
- Imported Agents start `unreviewed`, with schedules disabled.
- Webhook triggers are disabled in `quick_tunnel` remote-access mode.
- Node Manager uses a separate local listener and requires fresh OS-backed step-up; loopback reachability alone is never authentication.
- Secrets use the §21.1 DEK/KEK lifecycle; where unattended OS-backed unlock is unavailable, the Node starts `DEGRADED` with `secrets_locked` until local owner unlock.
- Automatic updates enabled.
- Automatic rollback enabled.
- Model downloads resumable.
- Resource pool reserves host headroom.


### 48.1 Privacy and telemetry

Telemetry is **OFF by default**. V1 MUST NOT send prompts, Agent files, browser contents, credentials, tool arguments, or model inputs/outputs outside the Node unless an explicit user-configured provider/tool operation requires that transfer. Crash diagnostics, if enabled, MUST be separately configurable and scrub secrets. The one structural exception is remote access: when the owner enables a tunnel-based mode, client-to-Node traffic (including prompts, outputs, files, and live browser frames) transits the tunnel provider and is visible to it (§38.7). Stable-endpoint modes that do not use a third-party tunnel avoid this.

### 48.2 Resource enforcement labels

Every quota/resource control is labeled per platform as hard-enforced, best-effort, or accounting-only. UI must not describe best-effort controls as guarantees.

## 49. Data Directory Concept

The exact filesystem paths are platform-specific, but the Node should maintain a clear persistent root containing conceptually:

```text
PRISM data root/
├── node/
│   ├── identity-public-metadata
│   ├── config
│   └── update-state
├── database/
│   └── prism.sqlite
├── agents/
│   ├── <agent-id>/
│   │   ├── definition/
│   │   ├── state/
│   │   ├── workspace/
│   │   ├── memory/
│   │   └── browser/
│   └── ...
├── artifacts/        # content-addressed, immutable, control-plane-owned
├── models/
│   ├── catalog/
│   └── installed/
├── backups/
├── logs/
└── runtime/
```

Sensitive credentials MUST use the encrypted key hierarchy and platform unlock behavior in §21.1 rather than ordinary unprotected text files.
The Node identity private key, owner-key verifier pepper, provider credentials, and browser credential material are held through the secret store; the data directory contains only non-secret identity metadata and references.

## 50. Protocol and Versioning

The PRISM API/protocol is versioned independently of internal implementation modules.

### 50.1 Owner model

Even though V1 has one human owner per Node, durable domain objects should carry an `owner_id`/owner reference where appropriate. In self-hosted V1 this resolves to the single Node owner. This keeps the domain model compatible with a future hosted/account-authenticated deployment without retrofitting ownership into every table later.

The Node should advertise:

- Protocol version.
- Node version.
- Capability/features.
- Installed model/runtime capabilities.
- Optional extensions.
- Active remote-access mode and its limits.

Clients should fail gracefully when a Node lacks an optional feature.

A future PRISM mobile application should be able to connect to the same Node without requiring server-side changes purely because the client is mobile.

## 51. Extensibility

The architecture must leave clear extension points for:

- Additional model runtimes.
- Additional BYOK providers.
- Additional remote-access providers.
- Additional tool/skill implementations.
- Additional clients.
- PostgreSQL storage.
- Distributed/multi-Node execution.
- Kubernetes or other schedulers at a future scale.
- Notification integrations.

These are extensions of the V1 architecture, not reasons to make them mandatory V1 dependencies.

## 52. Future Hosted PRISM Compatibility

Although V1 is self-hosted and account-free, the architecture must remain compatible with a future paid hosted PRISM offering.

A future hosted service should be able to provision PRISM Nodes/VMs and add human account/authentication at an outer service layer without requiring the Agent model or core Node protocol to be redesigned.

The V1 single-user owner model should therefore be treated as an authentication/deployment profile, not as a fundamental limitation of every internal domain object.

## 53. Design Invariants

The following are architectural invariants for V1:

1. PRISM Web does not own authoritative Agent state.
2. PRISM Node is the backend authority.
3. The Main Agent is a privileged Agent.
4. Specialized Agents cannot directly create Specialized Agents.
5. Specialized Agents can request creation through Main Agent.
6. Human-only policy actions cannot be overridden by Main Agent.
7. Deleting an Agent requires human approval.
8. Main Agent cannot be deleted.
9. Agent workspaces are isolated.
10. Model weights are shared at Node level.
11. Agents never need the Node owner API key.
12. The V1 Node has one owner API key: a bootstrap/recovery credential that is displayed once and never used as an everyday session credential.
13. Node Manager is local-only and uses a separate authenticated administrative session rather than the public API key.
14. Remote access never requires port forwarding.
15. V1 remote access is provider-abstracted and ships a temporary Quick Tunnel mode plus at least one stable-endpoint mode.
16. Live runtime updates use WebSockets.
17. V1 local inference uses the Ollama adapter.
18. PRISM is not hardcoded to Ollama internally.
19. Automatic updates include PRISM-managed required dependencies.
20. Failed updates automatically roll back.
21. Public Web, bundled Web, and future clients use the same Node protocol.
22. Agents persist independently of individual worker processes.
23. Runs are durable and recoverable.
24. Tool execution is mediated by deterministic policy.
25. External/untrusted content cannot itself grant new capabilities.
26. Node Manager and the public Node API are separate trust boundaries/listeners.
27. Browser WebSocket sessions use short-lived single-use tickets rather than long-lived API keys in URLs.
28. WebSocket/event streams use ordered sequence numbers and replay/resynchronization semantics.
29. Approval execution is bound to an exact canonical action hash.
30. Sandbox network egress enforces SSRF/private-address/metadata protections below the Agent layer.
31. Container execution does not expose container-engine control sockets to Agents.
32. Core Node/Agent/Task/Run/Step Attempt/Approval/Model Installation/Update/Browser Session/Trigger/Secret Store lifecycles use explicit state-machine transitions.
33. Logical run recovery is guaranteed through durable events/checkpoints; arbitrary native-process continuation is not promised.
34. Security audit history is Node-level durable history and is not deleted merely because an Agent is deleted.
35. Sessions and approvals are bound to a paired device key and the Node identity, not to the Node's network endpoint.
36. Agent-produced content is rendered only in sanitized or sandboxed contexts and never with API-session authority.
37. Durable events and ephemeral streams are distinct classes, and only durable events are replayable.
38. A restart from checkpoint creates a new Run attempt; terminal Runs and Tasks never resume.
39. Host-side access to Agent workspaces goes only through WorkspaceFS no-follow and inode-boundary semantics; cross-Agent/host hardlinks are prevented by per-Agent hardlink domains.
40. Sandboxes have no route to any destination except through the egress proxy, and no UDP.
41. The control plane, supervisor, workers, and sandboxes run under distinct OS identities with no privileges beyond their declared IPC.
42. Device request proofs bind the complete canonical HTTP request, including body bytes, to the Node, session, and device key.
43. Event-cursor resynchronization uses a consistent snapshot token and replays every matching event after its snapshot sequence.
44. Policy decisions are deterministic, deny-overrides, and intersect capability/scope grants across authority layers.
45. Arbitrary-content quarantined readers cannot hold credentials, owner/other-Agent private-data authority, or general external-send authority; authenticated-browser Agents are limited to origin-bound credentials and per-request policy (§43.3.5).
46. Side effects are journaled behind execution leases/fencing; uncertain outcomes are never silently replayed or marked successful.
47. Secret material is available only through the DEK/KEK hierarchy; a locked secret store never causes a plaintext fallback.
48. Every published release identifies the exact supported platform/runtime combinations in a tested support manifest.


### 53.1 Security invariants

1. No Agent/model output can directly bypass the capability broker.
2. Child capabilities are a subset of delegator capabilities, requested capabilities, and Node/owner policy.
3. Main Agent cannot self-escalate or modify trust roots/deterministic deny rules.
4. Tainted content never becomes trusted through model summarization alone.
5. Human-only (Tier-5) actions can be satisfied only through Node Manager, and Tier-4 approvals require a device signature over the exact action hash.
6. Approval is bound to an exact canonical action hash and is single-use.
7. Public Web clients never require a reusable owner secret for ordinary requests.
8. Sandbox processes cannot access container-engine control sockets or Node control-plane state directly.
9. Protected network destinations are denied unless explicitly and narrowly authorized.
10. Security audit metadata survives Agent deletion for its retention period.
11. Context taint is a high-water mark; only non-model operations can declassify or promote content.
12. When the Main Agent's context is tainted, privileged control-plane actions require human approval regardless of policy mode.
13. No sandbox traffic bypasses the egress proxy, including DNS, UDP, and QUIC.
14. Login Assist input is never visible to the model and never logged.
15. Imported Agents are `unreviewed`, with no egress or credential capability and schedules disabled; review alone grants no capability and does not promote imported instructions.
16. Node Manager and Tier-5 actions require fresh platform OS-backed step-up; local network reachability is not authentication.
17. Device request proofs cover method, full request target, body digest, Node/session binding, and replay state.
18. Browser requests are intercepted before transmission; opaque `shell.network`/raw-TCP payloads from tainted contexts are denied.
19. Quarantined readers cannot be granted credentials, private-data access, or external-send authority, including through import or configuration undo.
20. Secret-store failure or locked state never falls back to plaintext and never releases a secret.
21. Policy conflict resolution is deterministic, deny-overrides, and independent of rule ordering or model output.

### 53.2 Durability invariants

1. Every durable Run step has an event and recovery state.
2. A checkpoint cannot claim a step durable before its required metadata/filesystem consistency state is committed.
3. Uncertain external side effects never become silent success.
4. WebSocket consumers can resynchronize from a consistent snapshot token and durable event sequence.
5. Waiting, paused, and recovery states release reclaimable execution resources.
6. Approval consumption and the step-journal "execution started" entry commit atomically.
7. Event sequence numbers are assigned inside the committing transaction and published only after commit.
8. A stale worker cannot dispatch a new side effect or commit a result after its execution lease is fenced.
9. A started step without a verified result enters reconciliation or `SIDE_EFFECT_UNCERTAIN`; it is never assumed complete.

### 53.3 Import/update invariants

1. `.prism` packages request authority; they do not grant authority.
2. Updates cannot install unsigned/untrusted artifacts or downgrade past a configured floor.
3. A failed update or restore cannot leave an intentionally half-migrated active state.
4. Every archive entering PRISM (import, restore, upload) passes through the hardened extractor.

## 54. V1 Acceptance Criteria

PRISM V1 is functionally acceptable only when the following can be demonstrated on a supported self-hosted Node:

- A user can install PRISM with the intended one-command installation flow.
- PRISM starts automatically after reboot; when a platform lacks an unattended OS-backed KEK, it starts `DEGRADED` with `secrets_locked` and releases no credentials until local unlock.
- Every published release includes a support manifest, and every listed platform/runtime combination passes its required install, sandbox, authentication, recovery, and update tests.
- The user can configure the Node resource pool visually.
- Node Manager uses a separate local listener and requires fresh platform-specific OS step-up; localhost reachability and the API key alone do not authenticate it.
- The user can regenerate the API key (displayed exactly once; the prior key is revoked) and generate a QR pairing payload.
- PRISM Web can connect through the scoped pairing/session flow; manual Node URL + owner API key is available only as a recovery/advanced bootstrap path.
- One PRISM Web client can manage multiple Nodes.
- Main Agent can create and delegate to specialized Agents.
- Specialized Agents can communicate with one another.
- Specialized Agents cannot directly create other specialized Agents.
- A specialized Agent can request Main Agent creation of another specialist.
- Agents retain identity/state across restarts.
- Agent workspaces are isolated.
- Agents can explicitly transfer artifacts/files.
- User can inspect specialized-agent activity live in read-only mode.
- User can inspect live browser state where browser is enabled.
- Tool actions pass through permission/policy evaluation.
- Mandatory human approvals cannot be bypassed by Main Agent.
- Agent deletion requires human acceptance and removes the defined persistent Agent state.
- Agent deletion does not erase the Node-level security/audit record required to explain the deletion and its preceding actions.
- Agent configuration changes can be undone.
- `.prism` export/import works without unintentionally including private state.
- Full Node backup/restore works via encrypted ZIP-style packages.
- Local model installation happens through Web UI.
- Interrupted model downloads resume.
- Installed model weights are shared between Agents.
- Automatic model routing and explicit model selection both work.
- BYOK cost budgets can stop a run when exceeded.
- Scheduled, event-triggered, webhook/file-triggered, persistent, and Agent-to-Agent execution are supported.
- A Node restart can recover an eligible interrupted task from checkpoint.
- Node can automatically restart recoverable workers.
- Automatic updates verify signed artifacts.
- A deliberately broken update triggers rollback and visible notification.
- Remote access works without router port forwarding in `quick_tunnel` mode (labelled temporary) and in at least one stable-endpoint mode. A paired device reconnects after an endpoint change without re-pairing, where the client origin is stable.
- A remote Web client can pair via a single-use pairing token and thereafter authenticate with a device-bound session; the owner API key works only for recovery bootstrap.


Additional release-blocking acceptance criteria:

- QR/pairing tokens are single-use and do not contain the owner API key.
- LAN API exposure uses TLS by default.
- WebSocket sessions authenticate through short-lived single-use tickets.
- Webhook triggers use per-hook authentication and replay protection.
- Child-Agent capability attenuation and Agent-to-Agent target authorization are enforced below the model.
- Prompt-injection tests demonstrate that tainted content cannot cause unauthorized credential use, egress, policy changes, or destructive actions.
- Browser workers retain Chromium sandboxing and cannot use host-control sockets; all page-script, service-worker, redirect, and subresource requests are mediated before transmission.
- Quarantined readers cannot be configured with credentials, private-data access, or external-send authority; authenticated browser Agents are origin-bound, read-only scopes include query schemas, and tainted credential use, dynamic request data, and state-changing requests require exact approval.
- Device request proofs bind the Node/session, method, complete request target, body digest, and security-sensitive headers; body tampering and replay are rejected.
- Deterministic policy conflict tests prove deny-overrides, capability/scope intersection, and approval precedence independently of rule insertion order.
- Resource admission accounts for inference/model residency as well as sandbox resources.
- Backup restore is transactionally validated and can recover from corruption/tampering.
- Update drain, migration compatibility, health checks, and rollback are tested.
- WSL2 reboot/shutdown/startup behavior is tested.
- Telemetry is disabled by default and no unexpected user content leaves the Node.
- Security audit metadata remains explainable after Agent deletion.
- Tier-4 approvals require a valid device signature; Tier-5 actions are refused on every Web route and succeed only via Node Manager.
- A session token, WebSocket ticket, or approval replayed from another key is rejected, and a revoked device loses access within one request.
- Paired devices and automation tokens can be listed and revoked, and repeated failed owner-key attempts trigger lockout and a Node Manager alert.
- Agent-produced markdown and artifacts cannot execute script in an authenticated origin or reach the API.
- Durable events replay by cursor with `resync_required` on retention loss; the response provides a snapshot token and sequence, all snapshot reads are consistent as of that sequence, and subsequent events replay without gaps; token deltas and browser frames are never in the event log; a reconnecting client recovers a partial message.
- Every `RECOVERY_REQUIRED` Run has a resolution path, and unattended Runs time out to `FAILED` rather than stalling.
- Workspace symlink, cross-boundary hardlink, ownership/device mismatch, race, and archive-bomb attacks are refused by WorkspaceFS and the hardened extractor; internal workspace hardlinks, when supported by the isolated filesystem, are copied as bytes and never preserved across transfers/backups.
- Step execution uses durable journal attempts, approval-consumption atomicity, execution leases, fencing tokens, and explicit uncertain-side-effect reconciliation; stale workers cannot dispatch or commit.
- A sandbox cannot reach any destination except through the egress proxy; DNS tunnelling, UDP, and QUIC attempts fail.
- Login Assist works end to end with the model blinded and input unlogged, and persistent browser profiles survive across Runs.
- An imported Agent starts with no egress or credential capability; review alone grants none, and imported instructions remain quarantined until explicitly promoted through the audited owner action. An injection corpus run through browsing, memory, and imported instructions causes no unauthorized credential use or egress.

## 55. Current Technology Decisions Summary

| Area | V1 decision |
|---|---|
| Repository | One monorepo |
| Product split | PRISM Web + PRISM Node |
| Web language | TypeScript |
| Web framework | React + Vite SPA |
| Node language | TypeScript |
| Node runtime | Node.js LTS |
| Systems language | Rust |
| Core Python requirement | None |
| Node architecture | Modular monolith + isolated workers |
| Database | SQLite + WAL |
| Sandbox | Rootless OCI containers on a PRISM-managed private runtime |
| Local model runtime | Ollama V1 |
| Model abstraction | PRISM Model Manager + adapters |
| Local model weights | Shared Node-level installation |
| Browser | Chromium + Playwright |
| Agent browser | Optional, persistent when enabled |
| Agent workspace | Private persistent filesystem |
| Main Agent | Privileged Agent |
| Agent hierarchy | Main Agent can create specialists; specialists request Main Agent for new specialists |
| Agent communication | Durable message/event layer |
| Agent supervision | Main Agent observes/intervenes; not every message blocks on Main Agent |
| Permissions | Capability + risk + deterministic policy |
| Human approval | Mandatory for designated actions; device-signed (Tier 4), Node Manager only (Tier 5) |
| Node auth | Owner bootstrap/recovery key (shown once) + paired-device keys + device-bound scoped sessions + scoped automation tokens |
| Node Manager auth | Separate local trust boundary; fresh OS-backed step-up and action-bound single-use assertion (Linux PAM; Windows secure-desktop helper); no API-key or loopback-only authentication |
| Web transport | HTTP API + WebSockets: full-request device proofs, durable events with snapshot-token resync, ephemeral streams, single-use device-bound WS tickets |
| Remote access | Provider-abstracted: Quick Tunnel (temporary) plus a stable mode (named tunnel or external proxy) |
| Host file access | WorkspaceFS (Rust), `openat2` no-follow resolution, per-Agent hardlink-isolated filesystem/subvolume, inode/device/ownership checks, byte-copy transfer, hardened extractor |
| Egress | Internal-only sandbox network, proxy-owned DNS, UDP dropped, validated-IP pinning; browser requests intercepted before transmission |
| Policy | Versioned immutable decisions; deny-overrides, capability/scope intersection, approval precedence |
| Durable execution | Step journal with leases/fencing, request/idempotency receipts, explicit uncertain-side-effect reconciliation |
| Secret lifecycle | Random DEK wrapped by an OS-backed machine KEK; passphrase unlock and `DEGRADED/secrets_locked` when unattended protection is unavailable |
| Platform support | Per-release machine-readable OS/runtime support manifest with passing tests for every listed combination |
| Browser login | Login Assist (model-blinded, time-boxed, audited) |
| Port forwarding | Not required/permitted as a required setup mechanism |
| Connection UX | Scoped session/pairing token; QR convenience uses single-use token |
| Backups | Versioned authenticated encrypted archive; AES-256-GCM/chunked stream + Argon2id; atomic restore |
| Agent portable export | `.prism` |
| Updates | Automatic, signed, staged, health-checked, rollback-capable |
| Notifications | Not a V1 product area |
| Human accounts | Not in self-hosted V1 |
| Multi-user Node | Not in V1 |

## 56. Implementation Choices That Remain Open

The following are explicitly **not** allowed to weaken the security/protocol requirements merely because the implementation choice is still open.

- The concrete state-machine library, if any.
- The concrete event-log implementation.
- The concrete WS ticket storage mechanism.
- The concrete egress proxy/network backend.
- The concrete hardened container profile on each supported OS.
- The concrete backup container/ZIP library.


The following are implementation details to resolve during engineering, not reasons to redesign the product:

- Exact private container runtime (rootless Podman or rootless Docker) and version; it MUST be PRISM-managed and private (§36.4).
- Exact Node.js LTS version pinned for a release.
- Exact SQLite schema/ORM/query layer, provided it supports the required transactional invariants and owner/audit/run/event entities.
- Exact durable execution/checkpoint implementation, provided it supports durable ordered run events, step-level recovery semantics, and explicit idempotency/reconciliation states.
- Exact frame encoding/compression and framing of the browser live-view stream (the stream is pixel-based per §18.5).
- Exact OS secret-store backend on each supported platform, provided it satisfies the DEK/KEK, unattended-unlock, locked-mode, rotation, and recovery contract in §21.1. The selected backend and unlock mode MUST be recorded in that release's support manifest (§8).
- Exact installer packaging mechanism and artifact format.
- Exact Cloudflare `cloudflared` supervision/configuration details.
- Exact model catalog contents and hardware thresholds.
- Exact provider SDK/HTTP implementation details.
- Exact skill manifest schema.
- Exact tool registry schema, provided every tool declares capability/risk/input-output/idempotency/approval/audit semantics.
- Exact API endpoint naming and JSON schema field names, provided the shared protocol remains versioned and supports idempotency, pagination, stable IDs, and explicit error codes.
- Snapshot-token implementation, provided reads are consistent as of the advertised event sequence and retention preserves replay after that sequence for the token lifetime.
- Local helper packaging and IPC implementation, provided Linux PAM and Windows secure-desktop step-up, action binding, expiry, and single-use behavior satisfy §6.1 and §58.12.
- Request-proof transport/header encoding, provided the canonical full-request body-bound ES256 contract in §58.12 is preserved.
- Exact CI matrix.
- Exact release signing mechanism.

These choices must conform to the invariants and behavior defined above.

## 57. Recommended Engineering Sequence

The implementation should proceed in dependency order rather than feature-list order:

1. Shared protocol/schema package, domain IDs/owner model, and ADRs closing the architecture-relevant open choices (§56).
2. Explicit lifecycle state machines (§58.2) and legal-transition tests.
3. Core SQLite schema: owners, devices, automation tokens, Agents, tasks, runs, steps/step attempts and leases, events, snapshot tokens, approvals, versioned policies, tool registry, credential references/key envelopes, artifacts, memory provenance, audit records, models, schedules, updates.
4. Durable event log (transactional outbox, cursors, consistent snapshot-token resync), checkpoint model, step journal, leases/fencing, idempotency/error/reconciliation states.
5. Node bootstrap/config/storage, Node identity key and DEK/KEK lifecycle, separate public/Node Manager listeners, and platform-specific Node Manager step-up.
6. Node API authentication: owner key lifecycle, pairing, full-request device proofs, device-bound WebSocket tickets, abuse controls.
7. Policy engine with deterministic deny-overrides/scope intersection, capability broker, tool registry, taint labels and decision matrix, approval action hashing and assurance levels.
8. Privileged-component layout: private rootless container runtime, supervisor IPC, WorkspaceFS inode/hardlink boundary, egress proxy and egress/SSRF enforcement, browser request interception, hardened extractor, sandbox/container profiles, parser sandboxes, and worker supervision.
9. Model Manager + Ollama adapter + provider-family abstraction (freezing the provider interface before the cognition loop targets it).
10. Agent cognition loop: prompt assembly, context management, compaction, memory with provenance, wake/sleep.
11. Main Agent runtime.
12. Task/run execution, checkpoint/recovery (including §27.5 resolution), and scheduler.
13. Agent-to-agent messaging/delegation with loop/fan-out budgets.
14. Workspace/memory/artifact transfer.
15. Browser subsystem: live read-only view, masking, origin-bound credential injection, pre-transmission request interception, quarantined-reader separation, and Login Assist.
16. BYOK routing/budgets/cost estimate-reconcile.
17. Resource scheduler/GPU accounting.
18. Backups/export/import with authenticated encryption and SQLite online backup.
19. Remote-access modes, Node-identity pinning, and the endpoint beacon.
20. Signed auto-update, migration-safe rollback, signing-key rotation/recovery.
21. Deterministic mock-model/replay harness and adversarial security tests.
22. Full integration/E2E/recovery testing.
23. Packaging and V1 release hardening.

The order can be parallelized by AI coding agents and human engineers, but protocol, storage, lifecycle, policy, isolation, and recovery foundations must be established before broad feature implementation.

## 58. V1 Contract Specification

This section is the normative implementation contract. The repository MUST materialize these definitions as versioned schemas/tests under `packages/schemas` and `packages/protocol`.

### 58.1 Core entity identity

All durable entities use opaque, globally unique IDs. At minimum:

```text
NodeId
OwnerId
AgentId
TaskId
RunId
StepId
StepAttemptId
MessageId
EventId
ApprovalId
ArtifactId
CredentialRef
BrowserSessionId
TriggerId
ModelId
UpdateId
DeviceId
AutomationTokenId
LoginAssistId
```

Every entity that can cross an API boundary carries its owning Node/owner context. IDs are never derived from filesystem paths or database row order.

### 58.2 Required state machines

These definitions are the source of truth; prose elsewhere MUST conform to them.

**Node:** `STARTING → READY | DEGRADED | FAILED`; `READY ↔ DEGRADED`; `READY/DEGRADED → UPDATING | RESTORING`; `UPDATING → READY | DEGRADED | RECOVERING`; `RESTORING → READY | DEGRADED | RECOVERING`; `READY/DEGRADED → STOPPING → STOPPED`; `RECOVERING → READY | DEGRADED | FAILED`. Clearing the `secrets_locked` or health-degradation reason permits `DEGRADED → READY` only after health checks pass.

**Agent:** `CREATING → READY | FAILED`; `READY ↔ PAUSED`; `READY/PAUSED → STOPPED`; `STOPPED → READY`; `READY/PAUSED/STOPPED → DELETING → DELETED`; `READY/PAUSED → RESETTING → READY`; `READY → FAILED → RECOVERING → READY | FAILED`. `DELETING` is tombstoned first and its cleanup steps are idempotent, so it is crash-resumable and cannot revert. Main Agent cannot enter `DELETING` or `DELETED`.

**Task:** `PENDING → RUNNABLE → RUNNING`; `RUNNING → WAITING | PAUSED | CANCELLING | RECOVERY_REQUIRED | SUCCEEDED | FAILED`; `WAITING` carries a reason (`approval | child | message | resources | budget | sleep`); `WAITING → PAUSED` (an approved Login Assist request); `WAITING/PAUSED → RUNNABLE`; `RUNNING → RUNNABLE` when a Run attempt fails and the retry policy permits a new attempt; `CANCELLING → CANCELLED`; `RECOVERY_REQUIRED → RUNNABLE | FAILED | CANCELLED` only through a §27.5 resolution action. Terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`.

**Run:** `QUEUED → ADMITTED → RUNNING`; `QUEUED/ADMITTED → CANCELLED`; `RUNNING ↔ CHECKPOINTING`; `RUNNING → WAITING_APPROVAL | WAITING_CHILD | WAITING_MESSAGE | SLEEPING | WAITING_RESOURCES | WAITING_BUDGET | PAUSING | CANCELLING | SUCCEEDED | FAILED | RECOVERY_REQUIRED`; `PAUSING → PAUSED`; `WAITING_APPROVAL → PAUSED` (an approved Login Assist request, §18.4); `CANCELLING → CANCELLED`; every `WAITING_*`/`SLEEPING`/`PAUSED` state `→ QUEUED` (re-admission, resources reacquired) or `→ CANCELLED` (no sandbox teardown is needed because reservations are already released, §26.3); `RECOVERY_REQUIRED → QUEUED | FAILED | CANCELLED` only through a §27.5 resolution action. Terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`. No terminal state may return to execution; a restart is a new Run attempt (§27.5).

**Step attempt:** `PENDING → READY | WAITING_APPROVAL | CANCELLED`; `WAITING_APPROVAL → READY | DENIED | EXPIRED | CANCELLED`; `READY → STARTED`; `STARTED → SUCCEEDED | FAILED | SIDE_EFFECT_UNCERTAIN`; `FAILED → RETRYABLE` only when the failure is known and the tool's declared retry contract permits it; `SIDE_EFFECT_UNCERTAIN → RECONCILING`; `RECONCILING → SUCCEEDED | FAILED | RETRYABLE`; `RETRYABLE → READY` only when the tool's declared idempotency/reconciliation contract permits it. The transition to `STARTED` is atomic with approval consumption and persistence of the request hash/idempotency key. A retry is a new journal attempt under the same logical `StepId`; a changed request is a new step. A stale worker/fencing token cannot dispatch or commit. `SIDE_EFFECT_UNCERTAIN` cannot be cleared without a receipt or an explicit §27.5 resolution.

**Approval:** `PENDING → APPROVED | DENIED | EXPIRED | CANCELLED`; `APPROVED → CONSUMED | EXPIRED`; only `CONSUMED` can authorize one matching execution. Consumption commits atomically with the step-journal "execution started" entry (§45).

**Model installation:** `DISCOVERED → QUEUED → DOWNLOADING → VERIFYING → INSTALLED`; `INSTALLED ↔ LOADED`; `QUEUED/DOWNLOADING → CANCELLED`; `INSTALLED/LOADED → UNINSTALLING → UNINSTALLED`; failures may transition to `FAILED`; failed verification MUST NOT produce `INSTALLED`.

**Update:** `AVAILABLE → DOWNLOADING → VERIFIED → STAGED → DRAINING → ACTIVATING → HEALTH_CHECK → COMMITTED`; `DOWNLOADING/VERIFIED → REJECTED` (signature, anti-downgrade, or compatibility failure); `DOWNLOADING/STAGED → FAILED` for transport or staging errors; `DRAINING/ACTIVATING/HEALTH_CHECK → ROLLING_BACK → ROLLED_BACK | ROLLBACK_FAILED`; `ROLLBACK_FAILED → MANUAL_RECOVERY_REQUIRED`.

**Browser session:** `STARTING → READY | FAILED`; `READY ↔ NAVIGATING ↔ ACTIVE`; `READY/ACTIVE → LOGIN_ASSIST → READY` (on end or timeout); any non-terminal state `→ CLOSED | FAILED`. Browser state does not bypass Agent/run policy.

**Trigger:** `DISABLED ↔ ENABLED`; `ENABLED → ERRORED → ENABLED | DISABLED` (repeated delivery or validation failure); delivery creates a Task/Run under normal admission/policy.

**Secret store:** `INITIALIZING → UNLOCKED | LOCKED | FAILED`; `LOCKED → UNLOCKED | FAILED`; `UNLOCKED → LOCKED | ROTATING | FAILED`; `ROTATING → UNLOCKED | FAILED`; `FAILED → INITIALIZING` only through an audited owner recovery/restore action. `LOCKED → UNLOCKED` requires successful platform or passphrase unlock; `UNLOCKED → LOCKED` occurs on explicit lock or service shutdown. Failed unlock attempts remain `LOCKED` and are rate-limited. Interrupted key rotation MUST recover to either the previously verified envelope or the fully verified new envelope, never a mixed key state.

The implementation MUST encode legal transitions in code and test every invalid transition. Task and Run state are separate aggregates: a Task's `RUNNING` state means it has an active Run attempt; `WAITING`/`PAUSED` on a Task summarize the corresponding active Run state, while detailed wait reasons, checkpoints, and side-effect reconciliation are tracked on that Run and its step journal. State changes affecting both aggregates MUST commit atomically or use an explicit recoverable transition event.

### 58.3 Event envelope

Every durable event MUST contain:

```json
{
  "event_id": "EventId",
  "sequence": 123,
  "event_type": "run.step.started",
  "event_version": 1,
  "node_id": "NodeId",
  "owner_id": "OwnerId",
  "agent_id": "AgentId",
  "task_id": "TaskId",
  "run_id": "RunId",
  "step_id": "StepId|null",
  "step_attempt_id": "StepAttemptId|null",
  "causation_id": "EventId|null",
  "correlation_id": "string",
  "occurred_at": "RFC3339 timestamp",
  "payload_ref": "opaque or inline payload reference",
  "security_class": "normal|sensitive|security_audit"
}
```

The envelope applies to durable events only; ephemeral streams (§23.0) are not enveloped or stored. `sequence` is monotonic per Node, assigned inside the committing transaction and published after commit. Consumers persist the last applied sequence and resume by cursor; they MUST NOT expect contiguous numbers. If the cursor falls outside retention, the server establishes a consistent resource snapshot and sends `resync_required{snapshot_token,as_of_sequence,expires_at}` (§23.0). All reads made with that snapshot token MUST reflect one state exactly as of `as_of_sequence`; after loading it, the client subscribes from that sequence.

### 58.4 Canonical action object and approval hash

The approval hash is computed over canonical serialization of:

```text
tool_id
tool_version
capability
requesting_agent
creator/delegator
target/resource scope
canonical arguments
effective HTTP method/target/body digest when the action is a network or browser request
credential reference
matched policy rule digest
risk tier
expiration
```

The canonical representation MUST have deterministic field ordering, normalized encoding, and no model-authored free text fields. The executor recomputes the hash immediately before side effect execution. The hash uses the matched-rule digest; the approval record also stores the full policy version and the approving device's signature (§58.12).

### 58.5 Error codes

The protocol defines stable machine-readable classes including:

`INVALID_ARGUMENT`, `UNAUTHENTICATED`, `UNAUTHORIZED`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `RESOURCE_UNAVAILABLE`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`, `DEADLINE_EXCEEDED`, `WORKER_FAILURE`, `RECOVERY_REQUIRED`, `SIDE_EFFECT_UNCERTAIN`, `RESYNC_REQUIRED`, `SECRETS_LOCKED`, `CONFLICT`, `NOT_FOUND`, `INTEGRITY_FAILURE`, `UPDATE_REJECTED`, and `UNSUPPORTED`.

Errors MUST include a stable code, human-safe message, retryability classification, correlation ID, and optional structured remediation data. Secrets and raw provider credentials MUST NOT appear. A Tier-5 action attempted on a Web route returns `UNAUTHORIZED` with remediation data naming Node Manager; a revoked or unknown device returns `UNAUTHENTICATED`; lockout and rate limits return `RATE_LIMITED`; use of a secret-dependent operation while the keystore is locked returns `SECRETS_LOCKED`; an expired or unavailable snapshot token returns `RESYNC_REQUIRED` with instructions to begin a new snapshot.

### 58.6 Idempotency and side effects

Side-effecting API/tool calls MUST support an idempotency key or equivalent receipt where duplicate execution is possible. The durable step records the key, request hash, result/receipt, and reconciliation status. A retry with the same key but different arguments MUST fail with `CONFLICT`. Opaque steps (shell and arbitrary process execution) default to `side_effect: uncertain`; only tools that declare idempotency or a verifiable receipt may resume automatically after a crash (§27.5).

### 58.7 Pagination and concurrency

Collection APIs use stable cursor pagination with deterministic ordering. Mutations that depend on current resource versions carry an expected version/ETag and return `CONFLICT` on stale writes.

### 58.8 Capability registry contract

Every capability record includes ID, version, risk tier, scope schema, delegable flag, caller contexts, resource/network requirements, approval mode, minimum approval assurance, legal policy modes, taint sensitivity, secret-use behavior, and audit classification.

### 58.9 Checkpoint contract

A checkpoint records Run/Task state version, completed step IDs and attempt IDs, next executable step, context/memory references, workspace consistency reference, outstanding approvals, resource requirements, idempotency receipts, and reconciliation states. Checkpoints are immutable snapshots referenced by the Run; newer checkpoints supersede older ones but do not mutate historical event records. Worker leases are never restored from a checkpoint. Restarting from a checkpoint creates a new Run attempt seeded from it (§27.5).

### 58.10 WebSocket subscription and replay contract

A client connects with a single-use ticket (§22.4), then subscribes with a filter and its last-applied cursor. The server replays all matching durable events with `sequence > cursor`, in order, then switches to live delivery. The client acknowledges the highest applied sequence. Reconnects are safe because duplicates are ignored by `event_id`. If the cursor is outside retention, the server returns `resync_required{snapshot_token,as_of_sequence,expires_at}` (§23.0). The client MUST fetch all required state using that token, replace its local projection, and resubscribe from `as_of_sequence`; an expired token requires a fresh resynchronization. Ephemeral streams are never replayed: after reconnecting, the client re-obtains state from the API and rejoins live streams. A client MUST NOT assume that connection continuity implies event continuity, and MUST NOT assume sequence numbers are contiguous.

### 58.11 API idempotency and retry discipline

All mutating endpoints declare whether they are idempotent. Retries are allowed only when the error is retryable and the operation's idempotency semantics permit it.

### 58.12 Device proof-of-possession and approval signatures

Device keys are ECDSA P-256 (ES256), generated non-extractable in the client; the Node stores the public key in the device record.

**Request proof.** Every API request from a device-bound session carries an ES256 signature over the UTF-8 bytes of `"PRISM-HTTP-POP-V1\n" || JCS(proof)`, where JCS is RFC 8785 JSON Canonicalization Scheme. The signature is the fixed-width 64-byte P-1363 `r || s` encoding returned by WebCrypto, base64url-encoded without padding for transport. The proof object contains exactly the version, NodeId, session ID, uppercase HTTP method, canonical origin-form request target (path plus the complete query), SHA-256 digest of the exact HTTP body content octets after transfer framing is removed and before content decoding (including the empty body), normalized `Content-Type` and `Content-Encoding`, issued-at time, unique proof ID (`jti`), and SHA-256 digest of the presented session token. Header normalization lowercases field names, trims optional whitespace from values, and rejects duplicate security-sensitive fields; the resulting values are included exactly in the JCS proof. The request target uses RFC 3986 normalization: uppercase percent-encoding, decoding percent-encoded unreserved characters, removal of dot segments, and preservation of query parameter order and duplicates; client and Node MUST use the same representation and the Node MUST reject a request whose raw target does not match it. Authentication material MUST NOT appear in a query string. The client and Node MUST reject non-canonical/ambiguous request targets, duplicate security-sensitive headers, unsupported content encodings, and bodies whose received-byte digest does not match the proof. The request target is bound independently of the network endpoint so a legitimate endpoint change does not require re-pairing.

The Node verifies the signature against the registered, non-revoked device key; checks NodeId, session/device binding, session-token digest, scope, and request target; rejects proofs older than 60 seconds; and atomically records each `jti` to prevent replay for the full acceptance window. WebSocket-ticket issuance returns a fresh, single-use Node nonce for redemption. The redemption signature is over `"PRISM-WS-POP-V1\n" || JCS({node_id,session_id,device_id,ticket_sha256,nonce,requested_scopes})`; it is verified as part of upgrade and the ticket is consumed only on successful verification. Approval submission and Tier-5 local step-up also bind a fresh, single-use Node challenge nonce. Missing, stale, replayed, malformed, body-mismatched, or wrongly scoped proofs fail closed before request execution.

**Approval signature.** A Tier-4 signature is computed over the UTF-8 bytes of `"PRISM-APPROVAL-V1\n" || JCS({node_id, approval_id, action_hash, approval_expiry, nonce})`, using the same ES256/P-1363 signature encoding. The Node verifies it against the registered device public key, checks the client class and that the device is not revoked, and only then moves the approval to `APPROVED`.

**Tier-5 local step-up assertion.** The Node creates a cryptographically random 256-bit, single-use challenge bound to `NodeId`, the exact canonical action hash, the local administrative session, a fresh nonce, and a 60-second expiry. Only the authenticated platform helper in §6.1 can satisfy it after fresh OS reauthentication. The helper signs UTF-8 bytes of `"PRISM-LOCAL-ADMIN-V1\n" || JCS({node_id,challenge_id,session_id,action_hash,os_principal,nonce,issued_at,expires_at})` with its OS-protected per-install ECDSA P-256 key, using the same P-1363 encoding as device proofs. `os_principal` is canonicalized as `linux-uid:<decimal>` or `windows-sid:<canonical-SID>` and MUST match the enrolled administrator. Node Manager submits the signed assertion with the challenge and action. The Node verifies the pinned helper public key, authorized OS principal, challenge binding, expiry, and nonce, then consumes the challenge atomically with the authorized Tier-5 action. Replaying the assertion, changing the action, using another Node/session, or missing the expiry fails closed. The assertion is never placed in a URL, event payload, log, or model context.

**Revocation.** Revoking a device invalidates its sessions and tickets and cancels any `APPROVED`, unconsumed approvals it signed (§22.10).

## 59. AI Coding Implementation Contract

Because PRISM is intended to be implemented with AI coding agents as well as human engineers, the repository must expose deterministic contracts before parallel implementation expands.

### 59.1 Contracts to freeze first

The implementation baseline must freeze:

- Domain entities and stable IDs.
- Node/Agent/Task/Run/Step Attempt/Approval/Model Installation/Update/Browser Session/Trigger/Secret Store state machines and legal transitions.
- Event envelope, sequence semantics, replay/resynchronization behavior, and event versioning.
- Snapshot-token API semantics, consistent as-of-sequence reads, token expiry, and event-retention pinning.
- HTTP authentication/bootstrap flow and WebSocket ticket handshake.
- Full-request device-proof canonicalization, body hashing, WebSocket redemption proof, and Tier-5 local assertion formats.
- Platform-specific Node Manager OS step-up and helper IPC contract.
- Capability/tool registry and policy decision model.
- Policy-layer grant intersection, deny-overrides conflict resolution, and mandatory-approval precedence.
- Approval action canonicalization and action-hash rules.
- Checkpoint schema, step-attempt journal, execution leases/fencing, and recovery/error model.
- Idempotency-key/receipt conventions for side-effecting tools.
- API pagination, filtering, idempotency, error codes, and concurrency/conflict semantics.
- Credential-broker interface.
- Sandbox capability contract and network-egress policy interface.
- Browser-worker request interception, authenticated-browser origin scopes, and quarantined-reader capability constraints.
- WorkspaceFS device/ownership boundary, per-Agent hardlink isolation, and byte-copy transfer contract.
- DEK/KEK hierarchy, locked-secret behavior, OS unlock mode, and release support-manifest fields.
- Model-provider interface and usage/cost reporting contract.
- Device key, proof-of-possession, and approval-signature formats (§58.12).
- Taint label set and the default decision matrix (§43.3).
- Supervisor IPC schema and the WorkspaceFS API (§16.1, §36.4).
- Durable-event versus ephemeral-stream classification of every event type (§23.0).

### 59.2 Error and retry model

Errors must distinguish at least:

- Invalid input.
- Policy denied.
- Approval required.
- Approval expired/invalidated.
- Resource unavailable.
- Provider unavailable.
- Rate limited.
- Timeout/deadline.
- Transient worker failure.
- Permanent execution failure.
- Uncertain external side effect requiring reconciliation.
- Recovery required.

Retries must be driven by error classification and declared tool idempotency, not by a generic “try again” loop.

### 59.3 API discipline

Collection APIs must support stable IDs, deterministic pagination, explicit ordering, and versioned schemas. Mutating operations that can be retried by clients must expose idempotency semantics where duplicate execution would be harmful.

### 59.4 Parallel-agent development rule

AI coding agents may work in parallel only after these shared contracts are committed. Feature branches/worktrees must consume the shared protocol rather than inventing local variants. Cross-module changes to the frozen contracts require an explicit architectural change record.

## 60. Definition of Done for the V1 Specification

This specification defines the intended PRISM V1 product, architecture, security model, deployment model, and major runtime behavior. The V1 feature scope in Section 2 is intentionally preserved in full; the hardening changes in the specification do not defer or remove those capabilities.

Implementation should not begin by casually changing these foundational boundaries. Any change affecting authentication, Agent identity/state, isolation, permission enforcement, API protocol, model abstraction, backup semantics, or update rollback should be treated as an architectural change and documented as such.
