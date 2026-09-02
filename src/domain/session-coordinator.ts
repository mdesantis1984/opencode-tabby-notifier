import type { AttentionKind, SessionState } from "./completion.ts"

export type CoordinatorEvent = {
  type?: string
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export type CoordinatorState = {
  generation: number
  active: boolean
  state?: SessionState
  terminal: boolean
  pendingPermissions: Set<string>
  pendingQuestions: Set<string>
  seen: Set<string>
}

export type StateTransition = { state: SessionState; attention?: AttentionKind; generation: number }

const statusOf = (event: CoordinatorEvent): string | undefined => {
  const status = event.properties?.status ?? event.status
  const result = typeof status === "string" ? status : status && typeof status === "object" && "type" in status && typeof status.type === "string" ? status.type : undefined
  return result?.toLowerCase()
}
const value = (event: CoordinatorEvent, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const candidate = event.properties?.[key] ?? event[key]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}
const requestId = (event: CoordinatorEvent): string | undefined => {
  const reply = ["permission.replied", "permission.rejected", "question.replied", "question.rejected"].includes(event.type ?? "")
  return value(event, ...(reply ? ["requestID", "requestId", "permissionID", "permissionId"] : ["requestID", "requestId", "id"]))
}
const explicitGeneration = (event: CoordinatorEvent): number | undefined => {
  const candidate = event.properties?.generation ?? event.generation
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined
}

export function createCoordinatorState(): CoordinatorState {
  return { generation: 0, active: false, terminal: false, pendingPermissions: new Set(), pendingQuestions: new Set(), seen: new Set() }
}

function hasPending(state: CoordinatorState): boolean {
  return state.pendingPermissions.size > 0 || state.pendingQuestions.size > 0
}

export function reduceSession(state: CoordinatorState, event: CoordinatorEvent): StateTransition | undefined {
  const type = event.type ?? ""
  const status = statusOf(event)
  const explicit = explicitGeneration(event)
  const next = (transition: SessionState, attention?: AttentionKind): StateTransition => {
    state.state = transition
    return { state: transition, attention, generation: state.generation }
  }

  if (type === "session.status" && ["busy", "working", "running"].includes(status ?? "")) {
    const startsNew = !state.active || state.terminal || state.state === "completed"
    if (startsNew) {
      state.generation = Math.max(state.generation + (state.active ? 1 : 0), explicit ?? 0)
      state.active = true
      state.terminal = false
      state.pendingPermissions.clear(); state.pendingQuestions.clear()
    } else if (explicit !== undefined && explicit > state.generation) {
      state.generation = explicit; state.active = true; state.terminal = false
      state.pendingPermissions.clear(); state.pendingQuestions.clear()
    }
    return next("working")
  }
  if (type === "permission.asked") {
    const id = requestId(event); if (!id) return undefined
    if (state.pendingPermissions.has(id)) return undefined
    state.pendingPermissions.add(id); return next("waiting-permission", "waiting-permission")
  }
  if (type === "question.asked") {
    const id = requestId(event); if (!id) return undefined
    if (state.pendingQuestions.has(id)) return undefined
    state.pendingQuestions.add(id); return next("waiting-question", "waiting-question")
  }
  if (type === "permission.replied" || type === "permission.rejected") {
    const id = requestId(event); if (!id || !state.pendingPermissions.delete(id)) return undefined
    return hasPending(state) ? next(state.pendingQuestions.size ? "waiting-question" : "waiting-permission") : next("working")
  }
  if (type === "question.replied" || type === "question.rejected") {
    const id = requestId(event); if (!id || !state.pendingQuestions.delete(id)) return undefined
    return hasPending(state) ? next(state.pendingPermissions.size ? "waiting-permission" : "waiting-question") : next("working")
  }
  if ((type === "session.status" && ["retry", "retrying"].includes(status ?? "")) || type === "session.retry" || type === "retry") {
    if (!state.active || state.terminal || hasPending(state)) return undefined
    return next("retrying")
  }
  if ((type === "session.status" && ["error", "failed"].includes(status ?? "")) || type === "session.error" || type === "error" || type === "session.abort" || type === "session.aborted" || type === "abort") {
    if (!state.active || state.terminal) return undefined
    state.pendingPermissions.clear(); state.pendingQuestions.clear(); state.terminal = true
    return next("error", "error")
  }
  if (type === "session.idle" || (type === "session.status" && status === "idle")) {
    if (!state.active || state.terminal || hasPending(state)) return undefined
    if (state.state === "completed") return undefined
    state.active = false
    return next("completed", "completed")
  }
  return undefined
}

export function eventRequestId(event: CoordinatorEvent): string | undefined { return requestId(event) }
