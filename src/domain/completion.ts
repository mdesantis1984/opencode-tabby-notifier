export type Outcome = "success" | "failure" | "cancelled"
export type CompletionEventV1 = {
  version: 1; eventId: string; correlationId: string; outcome: Outcome
  projectLabel: string; completedAt: string
}
