import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import type { AttentionNotificationV1, SessionState, SessionStateEventV1 } from "./domain/completion.ts"
import { loadConfig, type Config } from "./config.ts"
import { createDelivery } from "./delivery.ts"
import { sendIpcNotification } from "./adapters/ipc.ts"
import { createCoordinatorState, reduceSession, type CoordinatorEvent, type CoordinatorState } from "./domain/session-coordinator.ts"

const APP_NAME = "OpenCode"
const DELIVERY_TIMEOUT_MS = 3_000
const MAX_TRACKED_SESSIONS = 128
const MAX_PROJECT_LABEL_LENGTH = 80
const MAX_REQUESTS = 64

type Session = { id?: string; parentID?: string; parentId?: string; parent_id?: string }
type SessionClient = { session?: { get?: (input: { path: { id: string } }) => Promise<unknown> } }
type Notify = (title: string, body: string) => Promise<void>

function firstDefined(...values: Array<string | undefined>): string | undefined { return values.find(value => value !== undefined && value !== "") }
export function sessionIdFromIdleEvent(event: CoordinatorEvent): string | undefined {
  const info = event.properties?.info
  return firstDefined(
    typeof info === "object" && info !== null && typeof (info as Session).id === "string" ? (info as Session).id : undefined,
    typeof event.properties?.sessionID === "string" ? event.properties.sessionID : undefined,
    typeof event.properties?.sessionId === "string" ? event.properties.sessionId : undefined,
    typeof event.sessionID === "string" ? event.sessionID : undefined,
    typeof event.sessionId === "string" ? event.sessionId : undefined,
    typeof event.id === "string" ? event.id : undefined,
  )
}
function parentId(session?: Session): string | undefined { return firstDefined(session?.parentID, session?.parentId, session?.parent_id) }
function sessionFromEvent(event: CoordinatorEvent): Session | undefined {
  const info = event.properties?.info
  return info && typeof info === "object" ? info as Session : undefined
}

export function projectLabelFromDirectory(directory?: string): string {
  const basename = directory?.split(/[\\/]/).filter(Boolean).at(-1)?.trim() ?? ""
  return basename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_PROJECT_LABEL_LENGTH)
}
export function notificationBody(directory?: string): string {
  const label = projectLabelFromDirectory(directory)
  return label ? `Work run finished in ${label}` : "Work run finished"
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
export function sendLinuxNotification(title: string, body: string, spawnProcess: Spawn = spawn, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "linux") return Promise.resolve()
  return new Promise((resolve, reject) => {
    const child = spawnProcess("notify-send", ["--app-name", APP_NAME, "--urgency", "normal", title, body], { shell: false, stdio: "ignore" })
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("notify-send failed")))
  })
}

function boundedLabel(label: string): string { return projectLabelFromDirectory(label) || "work" }
function eventId(event: CoordinatorEvent, sessionID: string, generation: number, state: SessionState): string {
  const supplied = typeof event.eventId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(event.eventId) ? event.eventId : `${sessionID}:${generation}:${state}`
  return supplied
}
function occurredAt(event: CoordinatorEvent): string {
  const value = event.timestamp ?? event.properties?.timestamp
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString()
}

async function boundedPublish<T>(publish: (event: T) => Promise<unknown>, event: T): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([publish(event).then(() => undefined, () => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, DELIVERY_TIMEOUT_MS); timer.unref?.() })]) }
  finally { if (timer) clearTimeout(timer) }
}

export function createSessionStateHandler({
  correlationId, projectLabel = "", client, publish, publishAttention,
}: {
  correlationId?: string; projectLabel?: string; client?: SessionClient
  publish: (event: SessionStateEventV1) => Promise<unknown>
  publishAttention?: (event: AttentionNotificationV1) => Promise<unknown>
}): (event: CoordinatorEvent) => Promise<void> {
  const states = new Map<string, CoordinatorState>()
  const terminalAttention = new Set<string>()
  const metadata = new Map<string, Session>()
  const queues = new Map<string, Promise<void>>()
  const remember = (id: string, session: Session): void => { metadata.set(id, session); while (metadata.size > MAX_TRACKED_SESSIONS) metadata.delete(metadata.keys().next().value!) }
  const primary = async (id: string, event: CoordinatorEvent): Promise<boolean> => {
    const explicit = sessionFromEvent(event)
    if (explicit) remember(id, explicit)
    let session = metadata.get(id)
    if (!session && client?.session?.get) {
      try {
        const response = await client.session.get({ path: { id } })
        session = response && typeof response === "object" && "data" in response ? (response as { data?: Session }).data : response as Session
        if (session) remember(id, session)
      } catch { return false }
    }
    return Boolean(session && !parentId(session))
  }
  return async event => {
    const id = sessionIdFromIdleEvent(event)
    if (!id) return
    if (event.type === "session.created" || event.type === "session.updated") { const session = sessionFromEvent(event); if (session) remember(id, session); return }
    const previous = queues.get(id) ?? Promise.resolve()
    const task = previous.then(async () => {
      if (!correlationId || !(await primary(id, event))) return
      const state = states.get(id) ?? createCoordinatorState()
      const suppliedEventId = typeof event.eventId === "string" ? event.eventId : undefined
      if (suppliedEventId && state.seen.has(suppliedEventId)) return
      const transition = reduceSession(state, event)
      if (suppliedEventId) { state.seen.add(suppliedEventId); while (state.seen.size > 256) state.seen.delete(state.seen.values().next().value!) }
      states.set(id, state); while (states.size > MAX_TRACKED_SESSIONS) states.delete(states.keys().next().value!)
      if (!transition) return
      const now = occurredAt(event)
      await boundedPublish(publish, { version: 1, eventId: eventId(event, id, transition.generation, transition.state), correlationId, state: transition.state, projectLabel: boundedLabel(projectLabel), occurredAt: now, generation: transition.generation })
      const attentionKey = `${id}:${transition.generation}:${transition.attention}`
      if (transition.attention && publishAttention && (!['completed', 'error'].includes(transition.attention) || !terminalAttention.has(attentionKey))) {
        if (transition.attention === "completed" || transition.attention === "error") { terminalAttention.add(attentionKey); while (terminalAttention.size > MAX_TRACKED_SESSIONS * 2) terminalAttention.delete(terminalAttention.values().next().value!) }
        await boundedPublish(publishAttention, { version: 1, eventId: `attention:${eventId(event, id, transition.generation, transition.state)}`, correlationId, kind: transition.attention, outcome: transition.attention === "completed" ? "success" : transition.attention === "error" ? "failure" : undefined, projectLabel: boundedLabel(projectLabel), occurredAt: now, generation: transition.generation })
      }
    })
    const settled = task.then(() => undefined, () => undefined); queues.set(id, settled)
    try { await task } finally { if (queues.get(id) === settled) queues.delete(id) }
  }
}

export const OpenCodeLinuxSessionNotify: Plugin = async ({ client, directory }) => {
  const config: Config = loadConfig()
  const delivery = createDelivery(config)
  const projectLabel = config.projectLabel ?? projectLabelFromDirectory(directory)
  const handle = createSessionStateHandler({
    client: client as unknown as SessionClient, correlationId: config.correlationId, projectLabel,
    publish: event => config.endpoint && config.ipcSecret ? sendIpcNotification(event, { endpoint: config.endpoint, secret: config.ipcSecret }) : Promise.resolve(),
    publishAttention: delivery.publish,
  })
  return { event: async ({ event }) => handle(event as CoordinatorEvent), dispose: async () => delivery.dispose() }
}

export default OpenCodeLinuxSessionNotify
