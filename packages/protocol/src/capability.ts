import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";

const SEMVER = z.string().regex(/^\d+\.\d+\.\d+$/);

export const CapabilityAdvertisement = z.object({
  protocol_version: SEMVER,
  node_version: SEMVER,
  features: z.array(z.string().min(1)),
  models: z.array(z.string().min(1)),
  extensions: z.array(z.string().min(1)).optional(),
  remote_access: z.object({
    mode: z.enum(["quick_tunnel", "named_tunnel", "external_proxy"]),
    limits: z.array(z.string().min(1)),
  }),
});
export type CapabilityAdvertisement = z.infer<typeof CapabilityAdvertisement>;

export type NegotiateResult =
  | { readonly ok: true; readonly degraded: readonly string[] }
  | { readonly ok: false; readonly code: "UNSUPPORTED"; readonly reason: string };

export function negotiateProtocol(
  clientProtocol: string,
  advertisement: CapabilityAdvertisement,
  knownFeatures: readonly string[] = [],
): NegotiateResult {
  const clientMajor = Number(clientProtocol.split(".")[0]);
  const nodeMajor = Number(advertisement.protocol_version.split(".")[0]);
  if (!Number.isInteger(clientMajor) || !Number.isInteger(nodeMajor)) {
    return { ok: false, code: "UNSUPPORTED", reason: "invalid semver" };
  }
  if (clientMajor !== nodeMajor) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      reason: `major mismatch: client ${clientProtocol} vs node ${advertisement.protocol_version}`,
    };
  }
  const known = new Set(knownFeatures);
  const degraded = advertisement.features.filter((feature) => !known.has(feature));
  void PROTOCOL_VERSION;
  return { ok: true, degraded };
}
