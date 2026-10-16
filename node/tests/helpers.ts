/**
 * Shared helpers for Stage 1 tests: P-256 helper-key fixtures, Tier-5
 * assertion signing, and a real loopback HTTP server for handler tests.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { tier5SigningBytes } from "../src/node-manager/index.js";
import type { Tier5AssertionDoc } from "@prism/schemas";

export interface HelperKeyPair {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

/** Fresh per-install ECDSA P-256 helper key (fixture for the real thing). */
export function generateHelperKeyPair(): HelperKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Sign a Tier-5 assertion document with a helper private key (hex DER). */
export function signTier5Assertion(
  doc: Tier5AssertionDoc,
  privateKeyPem: string,
): string {
  const signer = createSign("sha256");
  signer.update(tier5SigningBytes(doc));
  signer.end();
  return signer.sign(privateKeyPem).toString("hex");
}

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Serve a handler on an ephemeral 127.0.0.1 port (real loopback). */
export async function serveOnLoopback(handler: HttpHandler): Promise<TestServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}
