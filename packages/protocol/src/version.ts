export const PROTOCOL_VERSION = "1.0.0";
export const STAGE0_NODE_VERSION = "0.1.0";

export function protocolMajor(version: string): number {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major)) throw new Error(`invalid version: ${version}`);
  return major;
}
