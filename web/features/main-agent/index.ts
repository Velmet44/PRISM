// Main Agent chat view-model (spec §4.3, §17.1, §2.2).
//
// The Main Agent is the dominant conversational surface. Owner chat text
// enters context as L3 owner instructions; A2A content is L5 data-only
// with sender provenance and can never change instructions or policy.
// There is NO direct specialist chat surface (§2.2): the specialized-Agent
// live view is read-only plus operational escape hatches (pause / cancel /
// restart-from-checkpoint / intervene via the Main Agent).

export const DIRECT_SPECIALIST_CHAT_DENIED =
  "DIRECT_SPECIALIST_CHAT_DENIED" as const;

export type ProvenanceLevel = "L3" | "L5" | "L6";

export interface Provenance {
  readonly level: ProvenanceLevel;
  readonly sender?: string;
  readonly sourceRunId?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "main-agent";
  readonly bodyMarkdown: string;
  readonly provenance: Provenance;
  readonly createdAt: string;
}

export interface MainAgentSendPayload {
  readonly kind: "main-agent-message";
  /** Owner chat enters as L3 owner instructions, never as policy. */
  readonly instructionLevel: "L3-owner-instruction";
  readonly body: string;
}

/** Build the payload for sending chat to the Main Agent. Throws on empty. */
export function buildMainAgentMessage(body: string): MainAgentSendPayload {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new Error("message body must not be empty");
  }
  return {
    kind: "main-agent-message",
    instructionLevel: "L3-owner-instruction",
    body: trimmed,
  };
}

/**
 * Direct specialist chat is not a surface: any attempt is refused and the
 * caller must route through Main Agent intervention instead.
 */
export function attemptSpecialistChat(_agentId: string): {
  readonly ok: false;
  readonly code: typeof DIRECT_SPECIALIST_CHAT_DENIED;
  readonly remediation: string;
} {
  return {
    ok: false,
    code: DIRECT_SPECIALIST_CHAT_DENIED,
    remediation:
      "Specialized Agents have no direct chat surface. Use read-only live inspection plus pause/cancel/restart, or request Main Agent intervention.",
  };
}

export function formatProvenance(provenance: Provenance): string {
  const sender = provenance.sender ?? "unknown sender";
  const run = provenance.sourceRunId ?? "no run";
  switch (provenance.level) {
    case "L3":
      return `L3 owner instruction (${sender})`;
    case "L5":
      return `L5 agent message from ${sender} (data only, run ${run})`;
    case "L6":
      return `L6 external content (data only, run ${run})`;
  }
}

export function buildMainAgentChatViewModel(
  messages: readonly ChatMessage[],
): {
  readonly messages: readonly ChatMessage[];
  readonly count: number;
} {
  return {
    messages: messages.map((m) => ({
      ...m,
      provenance: { ...m.provenance },
    })),
    count: messages.length,
  };
}
