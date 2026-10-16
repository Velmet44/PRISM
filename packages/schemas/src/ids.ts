import { z } from "zod";

const opaqueId = <Brand extends string>(name: string) =>
  z.string().min(1).describe(name).brand<Brand>();

export const NodeId = opaqueId<"NodeId">("NodeId");
export const OwnerId = opaqueId<"OwnerId">("OwnerId");
export const AgentId = opaqueId<"AgentId">("AgentId");
export const TaskId = opaqueId<"TaskId">("TaskId");
export const RunId = opaqueId<"RunId">("RunId");
export const StepId = opaqueId<"StepId">("StepId");
export const StepAttemptId = opaqueId<"StepAttemptId">("StepAttemptId");
export const MessageId = opaqueId<"MessageId">("MessageId");
export const EventId = opaqueId<"EventId">("EventId");
export const ApprovalId = opaqueId<"ApprovalId">("ApprovalId");
export const ArtifactId = opaqueId<"ArtifactId">("ArtifactId");
export const CredentialRef = opaqueId<"CredentialRef">("CredentialRef");
export const BrowserSessionId =
  opaqueId<"BrowserSessionId">("BrowserSessionId");
export const TriggerId = opaqueId<"TriggerId">("TriggerId");
export const ModelId = opaqueId<"ModelId">("ModelId");
export const UpdateId = opaqueId<"UpdateId">("UpdateId");
export const DeviceId = opaqueId<"DeviceId">("DeviceId");
export const AutomationTokenId =
  opaqueId<"AutomationTokenId">("AutomationTokenId");
export const LoginAssistId = opaqueId<"LoginAssistId">("LoginAssistId");
export const SessionId = opaqueId<"SessionId">("SessionId");
export const ChallengeId = opaqueId<"ChallengeId">("ChallengeId");
export const TicketId = opaqueId<"TicketId">("TicketId");
export const SnapshotId = opaqueId<"SnapshotId">("SnapshotId");

export type NodeId = z.infer<typeof NodeId>;
export type OwnerId = z.infer<typeof OwnerId>;
export type AgentId = z.infer<typeof AgentId>;
export type TaskId = z.infer<typeof TaskId>;
export type RunId = z.infer<typeof RunId>;
export type StepId = z.infer<typeof StepId>;
export type StepAttemptId = z.infer<typeof StepAttemptId>;
export type MessageId = z.infer<typeof MessageId>;
export type EventId = z.infer<typeof EventId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type ArtifactId = z.infer<typeof ArtifactId>;
export type CredentialRef = z.infer<typeof CredentialRef>;
export type BrowserSessionId = z.infer<typeof BrowserSessionId>;
export type TriggerId = z.infer<typeof TriggerId>;
export type ModelId = z.infer<typeof ModelId>;
export type UpdateId = z.infer<typeof UpdateId>;
export type DeviceId = z.infer<typeof DeviceId>;
export type AutomationTokenId = z.infer<typeof AutomationTokenId>;
export type LoginAssistId = z.infer<typeof LoginAssistId>;
export type SessionId = z.infer<typeof SessionId>;
export type ChallengeId = z.infer<typeof ChallengeId>;
export type TicketId = z.infer<typeof TicketId>;
export type SnapshotId = z.infer<typeof SnapshotId>;
