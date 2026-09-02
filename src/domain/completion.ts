export type Outcome = "success" | "failure" | "cancelled"

export type SessionState =
  | "working"
  | "waiting-permission"
  | "waiting-question"
  | "retrying"
  | "error"
  | "completed"

/** Minimal transport-neutral completion data. */
export type CompletionNotificationV1 = {
  version: 1
  eventId: string
  correlationId?: string
  outcome: Outcome
  projectLabel: string
  completedAt: string
}

export type AttentionKind = "waiting-permission" | "waiting-question" | "error" | "completed"

/** Transport-neutral attention notification. It never carries prompts, errors, paths, or request IDs. */
export type AttentionNotificationV1 = {
  version: 1
  eventId: string
  correlationId?: string
  kind: AttentionKind
  projectLabel: string
  occurredAt: string
  generation: number
  outcome?: Outcome
}

/** Correlated completion events retain the original v1 contract used by OpenCode and Tabby IPC. */
export type CompletionEventV1 = CompletionNotificationV1 & { correlationId: string }

/** Per-session state projection sent to Tabby. It is intentionally separate from completion notifications. */
export type SessionStateEventV1 = {
  version: 1
  eventId: string
  correlationId: string
  state: SessionState
  projectLabel: string
  occurredAt: string
  generation: number
}

export type TabbyEventV1 = CompletionEventV1 | SessionStateEventV1
