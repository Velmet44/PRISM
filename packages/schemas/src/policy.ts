import { z } from "zod";

export const TIERS = [0, 1, 2, 3, 4, 5] as const;
export type Tier = (typeof TIERS)[number];

export const PolicyMode = z.enum(["ask", "always", "ai", "never"]);
export type PolicyMode = z.infer<typeof PolicyMode>;

export const PolicyDecisionKind = z.enum(["allow", "deny", "require_approval"]);
export type PolicyDecisionKind = z.infer<typeof PolicyDecisionKind>;

export const PolicyDecision = z.object({
  policy_version: z.number().int().nonnegative(),
  matched_rule_ids: z.array(z.string().min(1)),
  matched_rule_digest: z.string().regex(/^[0-9a-f]{64}$/),
  capability: z.string().min(1),
  scope: z.string().min(1),
  taint_inputs: z.array(z.string().min(1)),
  tier: z.number().int().min(0).max(5),
  decision: PolicyDecisionKind,
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const Provenance = z.enum([
  "policy_constant",
  "extractor_derived",
  "dynamic_untrusted",
]);
export type Provenance = z.infer<typeof Provenance>;

const QueryRule = z.object({
  key: z.string().min(1),
  kind: z.enum(["const", "enum", "regex"]),
  values: z.array(z.string()).optional(),
});
export type QueryRule = z.infer<typeof QueryRule>;

/** Frozen read-only request scope (§18.3, §43.3.5). */
export const ReadOnlyScope = z.object({
  origin: z.string().url(),
  methods: z.array(z.enum(["GET", "HEAD"])).min(1),
  path: z.string().startsWith("/"),
  query: z.array(QueryRule),
  headers: z.record(z.string()),
  body_len: z.literal(0),
  credential: z.literal("none"),
});
export type ReadOnlyScope = z.infer<typeof ReadOnlyScope>;

export interface ReadOnlyRequest {
  origin: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  bodyLen: number;
  credential: string;
  provenances: Record<string, Provenance>;
}

function queryMatches(rule: QueryRule, value: string | string[]): boolean {
  const values = Array.isArray(value) ? value : [value];
  if (rule.kind === "const") {
    const expected = rule.values?.[0];
    return expected !== undefined && values.every((v) => v === expected);
  }
  if (rule.kind === "enum") {
    const allowed = new Set(rule.values ?? []);
    return values.every((v) => allowed.has(v));
  }
  const pattern = rule.values?.[0] ?? "^$";
  let regex: RegExp;
  try {
    regex = new RegExp(`^(?:${pattern})$`);
  } catch {
    return false;
  }
  return values.every((v) => regex.test(v));
}

export function isReadOnlyRequest(
  scope: ReadOnlyScope,
  request: ReadOnlyRequest,
): boolean {
  if (request.origin !== scope.origin) return false;
  if (!scope.methods.includes(request.method as "GET" | "HEAD")) return false;
  if (request.path !== scope.path) return false;
  if (request.bodyLen !== 0 || request.credential !== "none") return false;
  const scopeKeys = new Set(scope.query.map((rule) => rule.key));
  const requestKeys = Object.keys(request.query);
  if (
    requestKeys.length !== scopeKeys.size ||
    !requestKeys.every((key) => scopeKeys.has(key))
  ) {
    return false;
  }
  for (const rule of scope.query) {
    const value = request.query[rule.key];
    if (value === undefined || !queryMatches(rule, value)) return false;
  }
  for (const [name, expected] of Object.entries(scope.headers)) {
    if (request.headers[name] !== expected) return false;
  }
  return Object.values(request.provenances).every(
    (provenance) => provenance === "policy_constant",
  );
}

export const Promotion = z
  .object({
    agent_id: z.string().min(1),
    sha256_normalized_instructions: z.string().regex(/^[0-9a-f]{64}$/),
    sha256_skill_blobs: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    sha256_canonical_tool_config: z.string().regex(/^[0-9a-f]{64}$/),
    policy_version: z.number().int().nonnegative(),
    approver_device_sig: z.string().min(1),
  })
  .strict();
export type Promotion = z.infer<typeof Promotion>;

export interface QuarantineConfig {
  ingestsArbitrary: boolean;
  hasCredential: boolean;
  hasPrivateData: boolean;
  hasExternalSend: boolean;
}

export function quarantineCheck(
  config: QuarantineConfig,
): "allow" | "reject" {
  if (
    config.ingestsArbitrary &&
    (config.hasCredential || config.hasPrivateData || config.hasExternalSend)
  ) {
    return "reject";
  }
  return "allow";
}

const Observability = z.enum(["visible", "opaque"]);

export const CapabilityRecord = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  risk_tier: z.number().int().min(0).max(5),
  scope_schema: z.string().min(1),
  delegable: z.boolean(),
  caller_contexts: z.array(z.string().min(1)),
  resource_requirements: z.string().min(1),
  network_requirements: z.string().min(1),
  approval_mode: z.string().min(1),
  minimum_approval_assurance: z.string().min(1),
  legal_policy_modes: z.array(PolicyMode),
  taint_sensitivity: z.string().min(1),
  observability: z.object({
    dest: Observability,
    method: Observability,
    query_schema: Observability,
    body: Observability,
    credential_use: Observability,
    provenance: Observability,
  }),
  side_effect_class: z.string().min(1),
  secret_use: z.string().min(1),
  audit_classification: z.string().min(1),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;

export function mustNotClaimReadOnly(record: CapabilityRecord): boolean {
  const observability = Object.values(record.observability);
  return (
    record.network_requirements.length > 0 &&
    observability.includes("opaque")
  );
}
