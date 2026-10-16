export const WS_SUBPROTOCOL = "prism.v1";
const MAX_SUBPROTOCOL_VALUE_BYTES = 4096;

export function packRedemption(
  ticketSecretB64: string,
  signatureB64: string,
): string {
  const value = `${WS_SUBPROTOCOL}, ${ticketSecretB64}.${signatureB64}`;
  if (new TextEncoder().encode(value).length > MAX_SUBPROTOCOL_VALUE_BYTES) {
    throw new Error("redemption value exceeds 4KB subprotocol limit");
  }
  return value;
}

export function parseRedemption(value: string): {
  ticketSecretB64: string;
  signatureB64: string;
} {
  const parts = value.split(",").map((part) => part.trim());
  const candidates = parts.filter((part) => part !== WS_SUBPROTOCOL);
  const redemption = candidates.find((part) => part.includes("."));
  if (redemption === undefined) throw new Error("redemption pair missing");
  const dot = redemption.indexOf(".");
  const ticketSecretB64 = redemption.slice(0, dot);
  const signatureB64 = redemption.slice(dot + 1);
  const b64url = /^[A-Za-z0-9_-]+$/;
  if (
    ticketSecretB64.length === 0 ||
    signatureB64.length === 0 ||
    !b64url.test(ticketSecretB64) ||
    !b64url.test(signatureB64)
  ) {
    throw new Error("redemption pair incomplete");
  }
  return { ticketSecretB64, signatureB64 };
}
