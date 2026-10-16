import { z } from "zod";
import {
  AgentId,
  ApprovalId,
  EventId,
  NodeId,
  OwnerId,
  RunId,
  StepAttemptId,
  StepId,
  TaskId,
} from "./ids.js";

export const SecurityClass = z.enum(["normal", "sensitive", "security_audit"]);
export type SecurityClass = z.infer<typeof SecurityClass>;

export const DURABLE_EVENT_TYPES = [
  "run.started",
  "run.step.started",
  "run.step.completed",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.recovery_required",
  "tool.call.started",
  "tool.call.completed",
  "message.created",
  "browser.tab.changed",
  "browser.login_assist.started",
  "browser.login_assist.ended",
  "artifact.created",
  "task.created",
  "task.updated",
  "task.completed",
  "approval.requested",
  "approval.resolved",
  "device.paired",
  "device.revoked",
  "model.status.changed",
  "node.status.changed",
] as const;

export const EPHEMERAL_STREAMS = [
  "message.delta",
  "browser.frame",
  "resource.sample",
] as const;

export type DurableEventType = (typeof DURABLE_EVENT_TYPES)[number];
export type EphemeralStream = (typeof EPHEMERAL_STREAMS)[number];

export function isDurableEventType(value: string): value is DurableEventType {
  return (DURABLE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isEphemeralStream(value: string): value is EphemeralStream {
  return (EPHEMERAL_STREAMS as readonly string[]).includes(value);
}

export const EventEnvelope = z.object({
  event_id: EventId,
  sequence: z.number().int().nonnegative(),
  event_type: z.string().min(1),
  event_version: z.number().int().positive(),
  node_id: NodeId,
  owner_id: OwnerId,
  agent_id: AgentId.nullable(),
  task_id: TaskId.nullable(),
  run_id: RunId.nullable(),
  step_id: StepId.nullable(),
  step_attempt_id: StepAttemptId.nullable(),
  causation_id: EventId.nullable(),
  correlation_id: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  payload_ref: z.string().min(1),
  security_class: SecurityClass,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const ResyncRequired = z.object({
  snapshot_token: z.string().min(1),
  as_of_sequence: z.number().int().nonnegative(),
  expires_at: z.string().datetime({ offset: true }),
});
export type ResyncRequired = z.infer<typeof ResyncRequired>;

export const SnapshotRow = z.object({
  id: z.string().min(1),
  H: z.number().int().nonnegative(),
  filter_hash: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: z.string().datetime({ offset: true }),
  payload_ref: z.string().min(1),
});
export type SnapshotRow = z.infer<typeof SnapshotRow>;

export const SubscriptionFilter = z.object({
  node_id: NodeId.optional(),
  agent_id: AgentId.optional(),
  task_id: TaskId.optional(),
  run_id: RunId.optional(),
});
export type SubscriptionFilter = z.infer<typeof SubscriptionFilter>;
