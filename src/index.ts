import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"

const APP_NAME = "OpenCode"
const DEFAULT_TITLE = "OpenCode work run finished"
const DEBOUNCE_MS = 2_000
const MAX_TRACKED_SESSIONS = 128

type Session = { parentID?: string; parentId?: string; parent_id?: string }
type SessionClient = {
  session?: { get?: (input: { path: { id: string } }) => Promise<unknown> }
}
type IdleEvent = {
  type?: string
  properties?: {
    sessionID?: string
    sessionId?: string
    parentID?: string
    parentId?: string
  }
  sessionID?: string
  sessionId?: string
  parentID?: string
  parentId?: string
}
type Notify = (title: string, body: string) => Promise<void>

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "")
}

export function sessionIdFromIdleEvent(event: IdleEvent): string | undefined {
  return firstDefined(
    event.properties?.sessionID,
    event.properties?.sessionId,
    event.sessionID,
    event.sessionId,
  )
}

function parentIdFromSession(session: Session | undefined): string | undefined {
  return firstDefined(session?.parentID, session?.parentId, session?.parent_id)
}

export async function isPrimarySession(
  event: IdleEvent,
  client: SessionClient | undefined,
): Promise<boolean> {
  const explicitParent = firstDefined(
    event.properties?.parentID,
    event.properties?.parentId,
    event.parentID,
    event.parentId,
  )
  if (explicitParent) return false

  const sessionID = sessionIdFromIdleEvent(event)
  const getSession = client?.session?.get
  if (!sessionID || !getSession) return true

  try {
    const response = await getSession({ path: { id: sessionID } }) as unknown
    const session = response && typeof response === "object" && "data" in response
      ? (response as { data?: Session }).data
      : response as Session
    return !parentIdFromSession(session)
  } catch {
    // Do not lose a notification because session metadata lookup failed.
    return true
  }
}

export class IdleDebouncer {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly debounceMs = DEBOUNCE_MS,
    private readonly maxEntries = MAX_TRACKED_SESSIONS,
  ) {}

  shouldNotify(sessionID: string, now = Date.now()): boolean {
    const previous = this.seen.get(sessionID)
    if (previous !== undefined && now - previous < this.debounceMs) return false

    this.seen.delete(sessionID)
    this.seen.set(sessionID, now)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }
}

export function notificationBody(directory?: string): string {
  return directory ? `Work run finished in ${directory}` : "Work run finished"
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export function sendLinuxNotification(
  title: string,
  body: string,
  spawnProcess: Spawn = spawn,
): Promise<void> {
  if (process.platform !== "linux") return Promise.resolve()

  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "notify-send",
      ["--app-name", APP_NAME, "--urgency", "normal", title, body],
      { shell: false, stdio: "ignore" },
    )
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`notify-send exited with code ${code ?? "unknown"}`))
    })
  })
}

export function createIdleHandler({
  client,
  directory,
  notify = (title, body) => sendLinuxNotification(title, body),
  debouncer = new IdleDebouncer(),
}: {
  client?: SessionClient
  directory?: string
  notify?: Notify
  debouncer?: IdleDebouncer
}): (event: IdleEvent) => Promise<void> {
  return async (event) => {
    if (event.type !== "session.idle") return
    const sessionID = sessionIdFromIdleEvent(event)
    if (!sessionID || !(await isPrimarySession(event, client))) return
    if (!debouncer.shouldNotify(sessionID)) return

    try {
      await notify(DEFAULT_TITLE, notificationBody(directory))
    } catch (error) {
      // Notification failure must never interrupt the OpenCode run.
      console.warn("OpenCode Linux notification failed:", error)
    }
  }
}

export const OpenCodeLinuxSessionNotify: Plugin = async ({ client, directory }) => {
  const handleIdle = createIdleHandler({
    client: client as unknown as SessionClient,
    directory,
  })
  return { event: async ({ event }) => handleIdle(event as IdleEvent) }
}

export default OpenCodeLinuxSessionNotify
