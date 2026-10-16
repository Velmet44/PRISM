/**
 * PRISM Node update stubs — Stage 1.
 *
 * Health reporting only (Stage 1 exit: Node Manager usable, update state
 * visible). No download, verify, stage, activate, or rollback lives here;
 * full signed update management lands in Stage 7 (§42).
 */

import { PRISM_VERSION, type UpdateChannel } from "../config/index.js";

export interface NodeHealth {
  version: string;
  channel: UpdateChannel;
  /** Always false in Stage 1: no update pipeline is wired yet. */
  pendingUpdate: boolean;
  /** Node lifecycle hint (§7.2): READY normally, DEGRADED while secrets_locked. */
  status: "READY" | "DEGRADED";
  degradedReason: string | null;
}

export interface HealthReport extends NodeHealth {
  reportedAt: string;
}

/**
 * Local health snapshot. `secretsLocked=true` maps to the §7.2 reboot
 * recovery state: DEGRADED with reason `secrets_locked`.
 */
export function getHealth(opts?: {
  channel?: UpdateChannel;
  secretsLocked?: boolean;
}): NodeHealth {
  const secretsLocked = opts?.secretsLocked ?? false;
  return {
    version: PRISM_VERSION,
    channel: opts?.channel ?? "stable",
    pendingUpdate: false,
    status: secretsLocked ? "DEGRADED" : "READY",
    degradedReason: secretsLocked ? "secrets_locked" : null,
  };
}

/** Health snapshot plus report timestamp for Node Manager polling. */
export function reportHealth(opts?: {
  channel?: UpdateChannel;
  secretsLocked?: boolean;
}): HealthReport {
  return { ...getHealth(opts), reportedAt: new Date().toISOString() };
}
