// Nodes list view-model (spec §22.9).
//
// Trust is anchored in the Node identity key, never in a network endpoint
// URL. The client pins the Node fingerprint during pairing with an
// out-of-band fingerprint comparison (first pair requires explicit user
// fingerprint match), re-verifies on every endpoint change, and re-pairs
// on IDENTITY_ROTATED — rotation is never silent.

import { fingerprintHex } from "@prism/client";

export { fingerprintHex };

export type NodePairStatus =
  | "paired"
  | "unpaired"
  | "re-pair-required";

export interface NodePin {
  readonly nodeId: string;
  /** Current endpoint URL (display only; never the trust anchor). */
  readonly endpoint: string;
  /** hex(SHA256(raw 32-byte pubkey)) pinned at pairing time. */
  readonly fingerprint: string;
}

export interface NodeListEntry {
  readonly pin: NodePin;
  readonly status: NodePairStatus;
  /** Human reason shown when status is re-pair-required. */
  readonly statusReason?: string;
  readonly lastSeen?: string;
}

export type RePairCause =
  | "IDENTITY_ROTATED"
  | "endpoint-change"
  | "fingerprint-mismatch";

/**
 * Fingerprint-match UX state for pairing and endpoint-change flows.
 * The user must explicitly confirm the fingerprint out of band on first
 * pair; a mismatch always blocks pairing.
 */
export function fingerprintMatchUx(
  pinnedFingerprint: string,
  presentedPublicKeyRaw32: Uint8Array,
): {
  readonly match: boolean;
  readonly presentedFingerprint: string;
  readonly requiresExplicitConfirm: boolean;
} {
  const presentedFingerprint = fingerprintHex(presentedPublicKeyRaw32);
  const match = presentedFingerprint === pinnedFingerprint;
  return { match, presentedFingerprint, requiresExplicitConfirm: true };
}

/** Any identity rotation or endpoint/fingerprint change forces re-pairing. */
export function describeRePairCause(cause: RePairCause): string {
  switch (cause) {
    case "IDENTITY_ROTATED":
      return "Node identity rotated. Re-pairing is required for every device.";
    case "endpoint-change":
      return "Node endpoint changed. Verify the Node identity before re-pairing.";
    case "fingerprint-mismatch":
      return "Presented fingerprint does not match the pin. Possible impersonation — do not pair.";
  }
}

export function markRePairRequired(
  entry: NodeListEntry,
  cause: RePairCause,
): NodeListEntry {
  return {
    ...entry,
    pin: { ...entry.pin },
    status: "re-pair-required",
    statusReason: describeRePairCause(cause),
  };
}

export function buildNodesListViewModel(entries: readonly NodeListEntry[]): {
  readonly nodes: readonly NodeListEntry[];
  readonly rePairCount: number;
} {
  const nodes = entries.map((entry) => ({
    ...entry,
    pin: { ...entry.pin },
  }));
  return {
    nodes,
    rePairCount: nodes.filter((n) => n.status === "re-pair-required").length,
  };
}
