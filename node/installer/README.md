# PRISM Node installer (Stage 1)

One-command install on a brand-new supported machine. The install is
**resumable and idempotent**: every step checks whether it is already done
and skips when satisfied, so re-running is always safe (§7).

Supported combinations are listed in [`manifest.json`](./manifest.json)
(signed versioned support manifest, §8.1). Anything unlisted is
`UNSUPPORTED`: preflight reports `missing_requirement` remediation, serves
status `DEGRADED`, and blocks sandbox admission.

## Prerequisites

- One of: Ubuntu 24.04 (x86_64/aarch64), Debian 12 (x86_64),
  WSL2 Ubuntu 24.04 (x86_64) — see `manifest.json`.
- systemd, cgroup v2 with controller delegation, unprivileged user
  namespaces with subuid/subgid ranges, kernel with `openat2` (≥ 5.6).
- WSL2 additionally: systemd enabled (`/etc/wsl.conf` `[boot]
  systemd=true`) and a Windows Scheduled Task/service trigger that starts
  the distribution on boot/login (§8.2).
- Persistent data lives inside the Linux filesystem (`/var/lib/prism` by
  default, or `$PRISM_DATA_ROOT`); never under `/mnt/c` (§8.2).

## Re-runnable steps

The programmatic plan lives in `src/installer/index.ts` (`installPlan()`).
Each step has a `check` command; executors skip satisfied steps:

1. **service-users** — create unprivileged users
   `prism`, `prism-sup`, `prism-model`, `prism-proxy`, `prism-worker`
   (§36.3). Check: `id prism && id prism-sup && …`.
2. **admin-group** — create the `prism-admin` OS group and add the initial
   local administrator (Linux PAM step-up for Node Manager, §6.1).
   Check: `getent group prism-admin`.
3. **data-dirs** — create the §49 layout under the data root with mode
   `0700` per identity (`node/`, `database/`, `agents/`, `artifacts/`,
   `models/`, `backups/`, `logs/`, `runtime/`). Check: data-root dirs exist.
4. **database-init** — initialize `database/prism.sqlite` with WAL plus
   `migrations/001_init.sql`. Backups use the SQLite online backup API;
   live WAL files are never file-copied (§40.3).
5. **nodejs-runtime** — ensure the pinned Node.js LTS runtime.
6. **container-runtime** — install the PRISM-managed private rootless
   container runtime under `prism-sup` (own storage + `0600` socket).
   The host engine is never reconfigured (§36.4).
7. **supervisor-binaries** — install Rust supervisor + WorkspaceFS binaries.
8. **ollama** — install/configure Ollama (runs as `prism-model`).
9. **chromium** — install Chromium/Playwright deps (sandbox retained;
   never `--no-sandbox`).
10. **cloudflared** — install cloudflared for tunnel remote-access modes
    (§38). Optional; installed by default.
11. **systemd-service** — install/enable [`prism-node.service`](./prism-node.service)
    for auto-start. Tolerates WSL stop/restart; reboot without an
    unattended KEK enters `DEGRADED/secrets_locked` until local unlock (§7.2).
12. **update-agent-marker** — write `node/installed.json` (`markInstalled()`)
    so later runs resume instead of repeating work.

## Appliance lifecycle after install (§7.1)

1. Node starts automatically (systemd).
2. Hardware detection, storage/database init, default config.
3. Workers/services start; secret store + identity keypair init.
4. Node Manager available locally (also while secrets are locked).
5. Web UI connects once identity/session material exists.
6. Small resource-pool setup via UI, then normal administration.

## Reboot recovery (§7.2)

Auto-start on boot. With an unattended OS-backed KEK, secrets unlock at
startup; otherwise the Node runs `DEGRADED` (`secrets_locked`), keeps
secret-dependent runs paused, and waits for local owner unlock — no
plaintext fallback, no weakened access controls.
