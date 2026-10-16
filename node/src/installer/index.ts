/**
 * PRISM Node installer model — Stage 1.
 *
 * Idempotent, re-runnable install plan (§7): every step can be skipped
 * when its `check` already holds, so installation is resumable and safe
 * to re-run. Privilege layout follows §36.3 (distinct OS identities,
 * `0700` directories); managed dependencies follow §7/§42.5.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIRECTORIES, PRISM_VERSION, resolveDataRoot } from "../config/index.js";

/** Dedicated unprivileged service users (§36.3). */
export const SERVICE_USERS = [
  "prism",
  "prism-sup",
  "prism-model",
  "prism-proxy",
  "prism-worker",
] as const;

export type ServiceUser = (typeof SERVICE_USERS)[number];

/** What each service user may access (summary of §36.3 matrix). */
export const SERVICE_USER_PURPOSES: Record<ServiceUser, string> = {
  prism: "control plane (Node.js): database, event log, secret store, listeners, supervisor IPC",
  "prism-sup": "supervisor + WorkspaceFS (Rust): private container runtime, workspace/profile roots",
  "prism-model": "model runtime (Ollama): model weights, GPU; loopback-only from control plane",
  "prism-proxy": "egress proxy: sandbox-facing network namespace, policy snapshot",
  "prism-worker": "agent workers: run-scoped control-plane channel only",
};

/** PRISM-managed dependencies installed when absent (§7, §42.5). */
export const MANAGED_DEPS = [
  "ollama",
  "chromium",
  "cloudflared",
  "container-runtime",
] as const;

export type ManagedDep = (typeof MANAGED_DEPS)[number];

export interface InstallStep {
  /** Stable id, used for resume/skip bookkeeping. */
  id: string;
  /** Human-readable description (also rendered in installer/README.md). */
  description: string;
  /** Shell-equivalent check proving the step is already done. */
  check: string;
  /** Always true in Stage 1: every step is safe to re-run. */
  idempotent: true;
}

export interface InstallPlanOptions {
  dataRoot?: string;
  /** Initial local administrator (Linux `prism-admin` group member). */
  adminUser?: string;
  /** Install cloudflared even when no tunnel mode is configured yet. */
  withCloudflared?: boolean;
}

/**
 * Ordered, idempotent install plan (§7 + §7.1 appliance lifecycle).
 * Executors run each step's `check` first and skip when satisfied.
 */
export function installPlan(opts?: InstallPlanOptions): InstallStep[] {
  const dataRoot = resolveDataRoot(opts?.dataRoot);
  const adminUser = opts?.adminUser ?? "<admin-user>";
  const withCloudflared = opts?.withCloudflared ?? true;

  const steps: InstallStep[] = [
    {
      id: "service-users",
      description: `Create dedicated service users: ${SERVICE_USERS.join(", ")} (unprivileged, no login shell).`,
      check: `id prism && id prism-sup && id prism-model && id prism-proxy && id prism-worker`,
      idempotent: true,
    },
    {
      id: "admin-group",
      description: `Designate the initial local administrator via the prism-admin OS group (member: ${adminUser}); Node Manager PAM step-up requires it (§6.1).`,
      check: `getent group prism-admin`,
      idempotent: true,
    },
    {
      id: "data-dirs",
      description: `Create the data root at ${dataRoot} with §49 layout (${DATA_DIRECTORIES.join(", ")}) owned per §36.3 with mode 0700.`,
      check: `test -d ${dataRoot}/database && test -d ${dataRoot}/agents`,
      idempotent: true,
    },
    {
      id: "database-init",
      description: `Initialize SQLite at ${dataRoot}/database/prism.sqlite with WAL and migrations/001_init.sql (online-backup-only; never copy WAL files).`,
      check: `test -f ${dataRoot}/database/prism.sqlite`,
      idempotent: true,
    },
    {
      id: "nodejs-runtime",
      description: "Ensure the pinned Node.js LTS runtime for the control plane is present.",
      check: "node --version",
      idempotent: true,
    },
    {
      id: "container-runtime",
      description:
        "Install the PRISM-managed private rootless container runtime under prism-sup (own storage + 0600 socket); never reconfigure the host engine (§36.4).",
      check: "test -S ~prism-sup/.local/share/prism-runtime/api.sock || podman --version",
      idempotent: true,
    },
    {
      id: "supervisor-binaries",
      description: "Install Rust supervisor + WorkspaceFS binaries (run as prism-sup).",
      check: "command -v prism-supervisor",
      idempotent: true,
    },
    {
      id: "ollama",
      description: "Install/configure Ollama V1 local model runtime (runs as prism-model).",
      check: "command -v ollama",
      idempotent: true,
    },
    {
      id: "chromium",
      description: "Install Chromium/Playwright browser dependencies (sandbox retained; never --no-sandbox).",
      check: "command -v chromium || command -v chromium-browser || command -v google-chrome",
      idempotent: true,
    },
  ];

  if (withCloudflared) {
    steps.push({
      id: "cloudflared",
      description:
        "Install cloudflared as an optional managed dependency for tunnel-based remote-access modes (§38).",
      check: "command -v cloudflared",
      idempotent: true,
    });
  }

  steps.push(
    {
      id: "systemd-service",
      description:
        "Install and enable the prism-node systemd unit (auto-start on boot; tolerates WSL stop/restart, §7.2/§8.2).",
      check: "systemctl is-enabled prism-node",
      idempotent: true,
    },
    {
      id: "update-agent-marker",
      description: "Record install state (version + plan) so later runs resume instead of repeating work.",
      check: `test -f ${dataRoot}/node/installed.json`,
      idempotent: true,
    },
  );

  return steps;
}

export interface InstallMarker {
  prismVersion: string;
  dataRoot: string;
  installedAt: string;
  completedSteps: string[];
}

/**
 * Record a completed (or re-verified) install. Overwrites the marker
 * atomically and is safe to call on every re-run.
 */
export function markInstalled(
  dataRoot?: string,
  completedSteps?: string[],
): InstallMarker {
  const root = resolveDataRoot(dataRoot);
  const markerPath = path.join(root, "node", "installed.json");
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const marker: InstallMarker = {
    prismVersion: PRISM_VERSION,
    dataRoot: root,
    installedAt: new Date().toISOString(),
    completedSteps: completedSteps ?? installPlan({ dataRoot: root }).map((step) => step.id),
  };
  const tmpPath = `${markerPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, markerPath);
  return marker;
}

/** Read the install marker written by {@link markInstalled}, if present. */
export function readInstallMarker(dataRoot?: string): InstallMarker | null {
  const markerPath = path.join(resolveDataRoot(dataRoot), "node", "installed.json");
  try {
    const raw = fs.readFileSync(markerPath, "utf8");
    return JSON.parse(raw) as InstallMarker;
  } catch {
    return null;
  }
}
