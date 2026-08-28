import type { CompletionEventV1, Outcome } from "./completion.ts"
export type SessionEvent = { type?: string; sessionId?: string; correlationId?: string; status?: string; generation?: number; childBusy?: boolean }
type AggregateState = { generation: number; correlationId: string; busy: boolean; emitted: boolean }
const outcome = (status?: string): Outcome => status === "aborted" || status === "cancelled" ? "cancelled" : status === "error" || status === "failed" ? "failure" : "success"
export function normalizeStatus(event: SessionEvent): { correlationId: string; outcome: Outcome } | undefined {
  const id = event.correlationId
  if (!id || id === "ambiguous" || !/^[A-Za-z0-9._:-]+$/.test(id)) return undefined
  return { correlationId: id, outcome: outcome(event.status) }
}
export function aggregateEvent(event: SessionEvent, state?: AggregateState | CompletionEventV1): (CompletionEventV1 & { outcome: Outcome }) | undefined {
  const normalized = normalizeStatus(event); if (!normalized) return undefined
  if (state && "eventId" in state) return undefined
  const generation = event.generation ?? state?.generation ?? 0
  const next = state ?? { generation, correlationId: normalized.correlationId, busy: false, emitted: false }
  if (generation !== next.generation || next.correlationId !== normalized.correlationId) { next.generation = generation; next.busy = false; next.emitted = false }
  if (event.status === "busy") { next.busy = true; return undefined }
  if (next.emitted || event.childBusy || (event.type === "session.idle" && !next.busy && state === undefined)) return undefined
  next.emitted = true
  return { version: 1, eventId: `${normalized.correlationId}:${generation}`, correlationId: normalized.correlationId, outcome: normalized.outcome, projectLabel: "", completedAt: new Date().toISOString() }
}
