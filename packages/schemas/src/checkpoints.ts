import { z } from "zod";

export const FencingToken = z.string().regex(/^\d+:\d+$/);
export type FencingToken = z.infer<typeof FencingToken>;

export function parseFencingToken(token: string): {
  epoch: number;
  counter: number;
} {
  const parsed = FencingToken.safeParse(token);
  if (!parsed.success) throw new Error(`invalid fencing token: ${token}`);
  const separator = token.indexOf(":");
  return {
    epoch: Number(token.slice(0, separator)),
    counter: Number(token.slice(separator + 1)),
  };
}

/** Negative when a < b, positive when a > b, zero when equal. */
export function compareFencingToken(a: string, b: string): number {
  const left = parseFencingToken(a);
  const right = parseFencingToken(b);
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  return left.counter - right.counter;
}

export function isStaleFencingToken(
  presented: string,
  current: string,
): boolean {
  return compareFencingToken(presented, current) < 0;
}

export const FsIntent = z
  .object({
    temp_path: z.string().min(1),
    final_path: z.string().min(1),
    expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FsIntent = z.infer<typeof FsIntent>;

export const WorkspaceManifestEntry = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  mtime_ns: z.number().int().nonnegative(),
});
export type WorkspaceManifestEntry = z.infer<typeof WorkspaceManifestEntry>;

export const WorkspaceManifest = z.record(
  z.string().min(1),
  WorkspaceManifestEntry,
);
export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;

export const StepJournalRecord = z.object({
  step_id: z.string().min(1),
  step_attempt_id: z.string().min(1),
  attempt_no: z.number().int().nonnegative(),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotency_key: z.string().min(1).optional(),
  approval_ref: z.string().min(1).optional(),
  worker_lease: z.string().min(1),
  fencing_token: FencingToken,
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).optional(),
  result_receipt: z.string().min(1).optional(),
  reconciliation: z.enum(["none", "pending", "resolved"]),
});
export type StepJournalRecord = z.infer<typeof StepJournalRecord>;

export const Checkpoint = z.object({
  run_task_state_version: z.number().int().nonnegative(),
  completed_step_ids: z.array(z.string().min(1)),
  completed_attempt_ids: z.array(z.string().min(1)),
  next_step: z.string().min(1),
  context_ref: z.string().min(1),
  memory_ref: z.string().min(1),
  workspace_snapshot: WorkspaceManifest,
  outstanding_fs_intents: z.array(FsIntent),
  outstanding_approvals: z.array(z.string().min(1)),
  resource_requirements: z.string().min(1),
  idempotency_receipts: z.array(z.string().min(1)),
  reconciliation_states: z.array(z.string().min(1)),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
