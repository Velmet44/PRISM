// Runs / approvals basic view-model: status, live events via the WS
// multiplex subscribe, approve/deny (spec §20.2, §23.0, §27.5).
//
// Restart creates a NEW attempt from the latest valid checkpoint and never
// resumes a terminal run. Tier-5 is never submittable from web.

import {
  buildMultiplexSubscription,
  canSubmitApprovalFromWeb,
  type ApprovalRequest,
  type ApprovalTier,
  type MultiplexSubscription,
  type WebClientClass,
} from "../tasks/index.js";

export type {
  ApprovalTier,
  WebClientClass,
  ApprovalRequest,
  MultiplexSubscription,
};

export { buildMultiplexSubscription, canSubmitApprovalFromWeb };

export interface RunView {
  readonly runId: string;
  readonly taskId: string;
  readonly status: string;
  readonly attempt: number;
}

export interface ApprovalView {
  readonly approval: ApprovalRequest;
  readonly status: "pending" | "approved" | "denied";
}

const TERMINAL_RUN_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TERMINAL",
]);

export function buildRunSubscription(
  nodeId: string,
  runId: string,
  cursor: number | null,
): MultiplexSubscription {
  return buildMultiplexSubscription(nodeId, { run: runId }, cursor);
}

export function buildRunViewModel(
  run: RunView,
  approvals: readonly ApprovalView[],
  subscription: MultiplexSubscription,
): {
  readonly run: RunView;
  readonly approvals: readonly ApprovalView[];
  readonly pendingApprovals: number;
  readonly subscription: MultiplexSubscription;
} {
  return {
    run: { ...run },
    approvals: approvals.map((a) => ({
      ...a,
      approval: { ...a.approval },
    })),
    pendingApprovals: approvals.filter((a) => a.status === "pending").length,
    subscription,
  };
}

/**
 * Approve/deny from web. Tier<=3 confirms in the device-bound session;
 * Tier-4 additionally needs bundled-or-trusted-origin; Tier-5 is refused.
 */
export function decideRunApprovalFromWeb(
  approval: ApprovalRequest,
  decision: "approve" | "deny",
  clientClass: WebClientClass,
): ReturnType<typeof canSubmitApprovalFromWeb> & {
  readonly decision?: "approve" | "deny";
} {
  const gate = canSubmitApprovalFromWeb(approval, clientClass);
  if (!gate.ok) return gate;
  return { ...gate, decision };
}

/**
 * Describe a restart: always a new attempt from the latest valid
 * checkpoint, never a resume of the terminal run itself.
 */
export function describeRestart(run: RunView): {
  readonly newAttempt: true;
  readonly fromAttempt: number;
  readonly note: string;
} {
  void TERMINAL_RUN_STATUSES.has(run.status);
  return {
    newAttempt: true,
    fromAttempt: run.attempt,
    note: `Restart creates attempt ${run.attempt + 1} from the latest valid checkpoint; terminal runs are never resumed.`,
  };
}
