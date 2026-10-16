// Shared approval gate for web view-models (spec §20.2, §58.5).
//
// Tier 0-2: policy only (device-bound confirmation when "Ask every time").
// Tier 3: explicit confirmation in a device-bound session.
// Tier 4: device signature over the exact action hash, ONLY from a
//   `bundled` session or an owner-trusted origin.
// Tier 5: NEVER from web — Node Manager only. Web attempts are refused
//   (UNAUTHORIZED with nm_required remediation).

export type ApprovalTier = 0 | 1 | 2 | 3 | 4 | 5;

export type WebClientClass = "bundled" | "public_static" | "trusted-origin";

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly actionHash: string;
  readonly tier: ApprovalTier;
}

export type ApprovalGateResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: string; readonly remediation: string };

/**
 * Decide whether an approval may be submitted from a Web session.
 * Pure view-model logic: the Node re-verifies everything authoritatively.
 */
export function canSubmitApprovalFromWeb(
  approval: ApprovalRequest,
  clientClass: WebClientClass,
): ApprovalGateResult {
  if (approval.tier <= 3) {
    return {
      ok: true,
      path: "device-bound-session-confirmation",
    };
  }
  if (approval.tier === 4) {
    if (clientClass === "bundled" || clientClass === "trusted-origin") {
      return {
        ok: true,
        path: "device-signature-over-action-hash",
      };
    }
    return {
      ok: false,
      code: "TIER4_UNTRUSTED_ORIGIN",
      remediation:
        "Tier-4 approvals require a device signature from a bundled session or an owner-trusted origin.",
    };
  }
  return {
    ok: false,
    code: "TIER5_NM_ONLY",
    remediation:
      "nm_required: Tier-5 (human-only) actions can be satisfied only through Node Manager.",
  };
}

/** Single subscription descriptor over the multiplexed socket (§23.0). */
export interface MultiplexSubscription {
  /** One socket per Node; subscriptions multiplex over it. */
  readonly socket: "ws-multiplex-per-node";
  readonly nodeId: string;
  readonly filter: Record<string, string>;
  readonly cursor: number | null;
  /** Ephemeral deltas rejoin live; durable events replay from cursor. */
  readonly replayDurableFromCursor: true;
}

export function buildMultiplexSubscription(
  nodeId: string,
  filter: Record<string, string>,
  cursor: number | null,
): MultiplexSubscription {
  return {
    socket: "ws-multiplex-per-node",
    nodeId,
    filter: { ...filter },
    cursor,
    replayDurableFromCursor: true,
  };
}
