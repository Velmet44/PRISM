/**
 * Minimal JSON Canonicalization Scheme support for PRISM proof documents.
 * Our signed documents contain only objects, arrays, strings, and integers,
 * so a sorted-key serializer is sufficient. Objects outside this subset
 * (floats, undefined, exotic types) are rejected.
 */
export function toCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("toCanonicalJson: only integer numbers are supported");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => toCanonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${toCanonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`toCanonicalJson: unsupported value type ${typeof value}`);
}
