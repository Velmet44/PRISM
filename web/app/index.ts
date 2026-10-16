// Web bootstrap (Stage 2: logic + view-models only, no framework wiring).
//
// Owns no canonical state: it constructs the display-cache store and the
// Nodes view-model over a PrismClient, and exposes the Node identity pin
// display plus the fingerprint-match UX state (§22.9). Vite wiring is
// deferred but this module is the entry the future shell will call.

import { PrismClient } from "@prism/client";
import { DisplayCacheStore } from "../state/index.js";
import {
  fingerprintMatchUx,
  type NodeListEntry,
} from "../features/nodes/index.js";

export type { PrismClient };

export interface BootstrapDeps {
  readonly baseUrl: string;
  readonly protocolVersion: string;
  readonly fetchImpl?: typeof fetch;
}

export interface BootstrappedApp {
  readonly client: PrismClient;
  readonly displayCache: DisplayCacheStore;
  readonly nodes: readonly NodeListEntry[];
}

export function bootstrapApp(deps: BootstrapDeps): BootstrappedApp {
  const client = new PrismClient({
    baseUrl: deps.baseUrl,
    protocolVersion: deps.protocolVersion,
    fetchImpl: deps.fetchImpl,
  });
  return { client, displayCache: new DisplayCacheStore(), nodes: [] };
}

export type IdentityPinDisplay =
  | {
      readonly state: "unverified";
      readonly nodeId: string;
      readonly endpoint: string;
      readonly pinnedFingerprint: string;
    }
  | {
      readonly state: "matched" | "mismatch";
      readonly nodeId: string;
      readonly endpoint: string;
      readonly pinnedFingerprint: string;
      readonly presentedFingerprint: string;
    };

/**
 * Identity pin display: shows the pinned fingerprint and, once a handshake
 * presents a key, whether it matches. First pair always requires explicit
 * user confirmation of the fingerprint out of band.
 */
export function identityPinDisplay(
  nodeId: string,
  endpoint: string,
  pinnedFingerprint: string,
  presentedPublicKeyRaw32?: Uint8Array,
): IdentityPinDisplay {
  if (presentedPublicKeyRaw32 === undefined) {
    return { state: "unverified", nodeId, endpoint, pinnedFingerprint };
  }
  const { match, presentedFingerprint } = fingerprintMatchUx(
    pinnedFingerprint,
    presentedPublicKeyRaw32,
  );
  return {
    state: match ? "matched" : "mismatch",
    nodeId,
    endpoint,
    pinnedFingerprint,
    presentedFingerprint,
  };
}
