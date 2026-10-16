import { z } from "zod";

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "RESOURCE_UNAVAILABLE",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "DEADLINE_EXCEEDED",
  "WORKER_FAILURE",
  "RECOVERY_REQUIRED",
  "SIDE_EFFECT_UNCERTAIN",
  "RESYNC_REQUIRED",
  "SECRETS_LOCKED",
  "CONFLICT",
  "NOT_FOUND",
  "INTEGRITY_FAILURE",
  "UPDATE_REJECTED",
  "UNSUPPORTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const RETRYABLE_CODES: readonly ErrorCode[] = [
  "TIMEOUT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "WORKER_FAILURE",
];

export function isRetryable(code: ErrorCode): boolean {
  return (RETRYABLE_CODES as readonly string[]).includes(code);
}

export const ProtocolError = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1),
  retryable: z.boolean(),
  correlation_id: z.string().min(1),
  remediation: z.unknown().optional(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;
