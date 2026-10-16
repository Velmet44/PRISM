import { createHash } from "node:crypto";

/** SHA-256 hex of raw content octets (pre content-decoding). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Empty-body digest constant: SHA256(""). */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
