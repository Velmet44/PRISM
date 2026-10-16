import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CapabilityAdvertisement,
  ENDPOINTS,
  negotiateProtocol,
} from "@prism/protocol";
import type { ProtocolError } from "@prism/schemas";

export const KNOWN_FEATURES = [
  "durable-events",
  "ephemeral-streams",
  "device-proofs",
  "snapshot-resync",
] as const;

export interface ClientOptions {
  readonly baseUrl: string;
  readonly protocolVersion: string;
  readonly fetchImpl?: typeof fetch;
}

export function fingerprintHex(publicKeyRaw32: Uint8Array): string {
  return Array.from(sha256(publicKeyRaw32))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function verifyNodeSignature(
  publicKeyRaw32: Uint8Array,
  message: Uint8Array,
  signature64: Uint8Array,
): boolean {
  return ed25519.verify(signature64, message, publicKeyRaw32);
}

export function nodeIdBindingMessage(
  nodeId: string,
  clientNonceHex: string,
): Uint8Array {
  return new TextEncoder().encode(`${nodeId}:${clientNonceHex}`);
}

export class PrismClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCapabilities(): Promise<{
    advertisement: CapabilityAdvertisement;
    degraded: readonly string[];
  }> {
    const response = await this.fetchImpl(
      `${this.options.baseUrl}${ENDPOINTS.nodeCapabilities}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`capabilities request failed: ${response.status}`);
    }
    const parsed = CapabilityAdvertisement.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("capabilities response failed validation");
    }
    const negotiated = negotiateProtocol(
      this.options.protocolVersion,
      parsed.data,
      KNOWN_FEATURES,
    );
    if (!negotiated.ok) {
      const error: ProtocolError = {
        code: "UNSUPPORTED",
        message: negotiated.reason,
        retryable: false,
        correlation_id: crypto.randomUUID(),
      };
      throw new Error(
        `unsupported protocol [${error.code}]: ${error.message} (${error.correlation_id})`,
      );
    }
    return { advertisement: parsed.data, degraded: negotiated.degraded };
  }
}
