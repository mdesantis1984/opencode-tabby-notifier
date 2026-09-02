import { Inject, Injectable, InjectionToken, OnDestroy, Optional } from "@angular/core"
import { randomBytes } from "node:crypto"
import { IpcServer } from "./ipc-server.ts"
import { TabRegistry } from "./tab-registry.ts"

const DEFAULT_UNCLAIMED_TIMEOUT_MS = 30_000
const MAX_UNCLAIMED_TIMEOUT_MS = 120_000

export const RUNTIME_ENV_KEYS = [
  "OPENCODE_NOTIFY_CORRELATION",
  "OPENCODE_NOTIFY_IPC_SECRET",
  "OPENCODE_NOTIFY_IPC_ENDPOINT",
  "OPENCODE_NOTIFY_PROJECT_LABEL",
] as const

export type RuntimeManagerOptions = {
  unclaimedTimeoutMs?: number
}

export const TABBY_RUNTIME_OPTIONS = new InjectionToken<RuntimeManagerOptions>("TABBY_RUNTIME_OPTIONS")

export type RuntimeLaunch = {
  correlationId: string
  secret: string
  endpoint: string
}

type RuntimeEntry = {
  server: IpcServer
  unclaimedTimer: ReturnType<typeof setTimeout>
  claimed: boolean
}

/** Owns per-tab IPC listeners and makes every lease release idempotent. */
@Injectable()
export class TabbyRuntimeManager implements OnDestroy {
  private readonly registry: TabRegistry
  private readonly unclaimedTimeoutMs: number
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly pendingDisposals = new Set<Promise<void>>()
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null

  constructor(
    registry: TabRegistry | null = null,
    options: RuntimeManagerOptions | null = null,
  ) {
    this.registry = registry ?? new TabRegistry()
    const requestedTimeout = options?.unclaimedTimeoutMs ?? DEFAULT_UNCLAIMED_TIMEOUT_MS
    this.unclaimedTimeoutMs = Math.min(
      MAX_UNCLAIMED_TIMEOUT_MS,
      Math.max(1, Math.floor(Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_UNCLAIMED_TIMEOUT_MS)),
    )
  }

  get activeCount(): number { return this.entries.size }

  async createRuntime(): Promise<RuntimeLaunch> {
    if (this.shuttingDown) throw new Error("Tabby runtime manager is shut down")

    const correlationId = `tab-${randomBytes(12).toString("hex")}`
    const secret = randomBytes(32).toString("hex")
    const server = new IpcServer(
      secret,
      completion => this.registry.apply(completion),
      correlationId,
    )
    let port: number
    try {
      port = await server.start()
    } catch (error) {
      await server.dispose()
      throw error
    }
    if (this.shuttingDown) {
      await server.dispose()
      throw new Error("Tabby runtime manager is shut down")
    }

    const unclaimedTimer = setTimeout(() => {
      void this.release(correlationId).catch(() => undefined)
    }, this.unclaimedTimeoutMs)
    unclaimedTimer.unref?.()
    this.entries.set(correlationId, { server, unclaimedTimer, claimed: false })

    const launch = {
      correlationId,
      secret,
      endpoint: `http://127.0.0.1:${port}`,
    }
    if (process.env.TABBY_NOTIFIER_HARNESS === "1") {
      const key = "__tabbyNotifierHarnessRuntimes"
      const target = globalThis as typeof globalThis & { [key]?: RuntimeLaunch[] }
      target[key] ??= []
      target[key].push(launch)
    }
    return launch
  }

  /** Claims a provider-created listener and returns an exactly-once release callback. */
  claim(correlationId: string): (() => void) | null {
    const entry = this.entries.get(correlationId)
    if (!entry || entry.claimed || this.shuttingDown) return null
    entry.claimed = true
    clearTimeout(entry.unclaimedTimer)
    let released = false
    return () => {
      if (released) return
      released = true
      void this.release(correlationId, entry).catch(() => undefined)
    }
  }

  private release(correlationId: string, expected?: RuntimeEntry): Promise<void> {
    const entry = this.entries.get(correlationId)
    if (!entry || (expected && entry !== expected)) return Promise.resolve()
    this.entries.delete(correlationId)
    clearTimeout(entry.unclaimedTimer)

    const disposal = entry.server.dispose()
    this.pendingDisposals.add(disposal)
    void disposal.then(
      () => { this.pendingDisposals.delete(disposal) },
      () => { this.pendingDisposals.delete(disposal) },
    )
    return disposal
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingDisposals.size > 0) {
      await Promise.all([...this.pendingDisposals])
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    const entries = [...this.entries]
    this.shutdownPromise = (async () => {
      await Promise.all(entries.map(([correlationId, entry]) => this.release(correlationId, entry)))
      await this.waitForIdle()
    })()
    return this.shutdownPromise
  }

  ngOnDestroy(): void {
    void this.shutdown()
  }
}

// Apply the equivalent of @Optional() @Inject(...) without requiring this source-only
// workspace to enable legacy parameter-decorator transforms.
Inject(TabRegistry)(TabbyRuntimeManager, undefined, 0)
Optional()(TabbyRuntimeManager, undefined, 0)
Inject(TABBY_RUNTIME_OPTIONS)(TabbyRuntimeManager, undefined, 1)
Optional()(TabbyRuntimeManager, undefined, 1)
