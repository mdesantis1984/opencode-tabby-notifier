import { Component, Inject, Injector, Optional } from "@angular/core"
import * as NodeModule from "node:module"
import type { BaseTabComponent, GetRecoveryTokenOptions, RecoveryToken } from "tabby-core"
import type {
  LocalProfile,
  TerminalTabComponent as LocalTerminalTabComponentType,
  UACService as UACServiceType,
} from "tabby-local"
import type { BaseTerminalTabComponent as BaseTerminalTabComponentType } from "tabby-terminal"
import type { Outcome, SessionState } from "../../src/domain/completion.ts"
import { RUNTIME_ENV_KEYS, TabbyRuntimeManager } from "./runtime.ts"
import { TabRegistry } from "./tab-registry.ts"

const require = NodeModule.createRequire(__filename)
const { TerminalTabComponent: LocalTerminalTabComponent, UACService } = require("tabby-local") as {
  TerminalTabComponent: typeof LocalTerminalTabComponentType
  UACService: typeof UACServiceType
}
const { BaseTerminalTabComponent } = require("tabby-terminal") as {
  BaseTerminalTabComponent: typeof BaseTerminalTabComponentType
}

// fa-bell is part of the installed Tabby Font Awesome bundle; no unsupported animation class is used.
const COMPLETION_ACTIVITY_ICON = "fas fa-bell"
const COMPLETION_ACTIVITY_COLORS: Record<Outcome, string> = {
  success: "#5cb85c",
  failure: "#d9534f",
  cancelled: "#f0ad4e",
}
export const SESSION_STATE_PRESENTATION: Record<SessionState, { icon: string; color: string }> = {
  working: { icon: "fas fa-spinner", color: "#337ab7" },
  "waiting-permission": { icon: "fas fa-hand-paper", color: "#f0ad4e" },
  "waiting-question": { icon: "fas fa-question-circle", color: "#f0ad4e" },
  retrying: { icon: "fas fa-redo", color: "#8e44ad" },
  error: { icon: "fas fa-exclamation-triangle", color: "#d9534f" },
  completed: { icon: "fas fa-bell", color: "#5cb85c" },
}

type CompletionProjection = {
  originalIcon: string | null
  originalColor: string | null
  originalActivity: boolean
  pending: Map<TerminalTab, { order: number; outcome: Outcome }>
}

type BaseTabWithFocus = BaseTabComponent & {
  getFocusedTab?: () => BaseTabComponent | null
}

/** A real local PTY terminal with notifier-only activity and runtime lifecycle state. */
@Component({
  selector: "opencode-notifier-terminal-tab",
  template: BaseTerminalTabComponent.template,
  styles: BaseTerminalTabComponent.styles,
  animations: BaseTerminalTabComponent.animations,
})
export class TerminalTab extends LocalTerminalTabComponent {
  static readonly sharedRegistry = new TabRegistry()
  private static readonly pendingTabs = new Set<TerminalTab>()
  private static readonly completionProjections = new Map<BaseTabComponent, CompletionProjection>()

  private _correlationId = ""
  private readonly registry: TabRegistry
  private runtimeRelease: (() => void) | null = null
  private fallbackDirectory = ""
  private fallbackEnvironment: Record<string, string> = {}
  private originalIcon: string | null = null
  private originalColor: string | null = null
  private completionActivityPending = false
  private sessionStatePending = false
  private sessionState: SessionState | null = null
  private sessionGeneration = -1
  private completionOrder: number | null = null
  private completionProjectionOwner: BaseTabComponent | null = null
  private disposed = false
  private disposeListeners: Array<() => void> = []

  constructor(
    injector: Injector,
    uac: UACServiceType | null | undefined = undefined,
    registry: TabRegistry | null = null,
    private readonly runtimeManager: TabbyRuntimeManager | null = null,
  ) {
    super(injector, uac ?? undefined)
    this.registry = registry ?? TerminalTab.sharedRegistry
  }

  get correlationId(): string { return this._correlationId }
  set correlationId(value: string) {
    if (value === this._correlationId) {
      this.registry.register(this)
      return
    }
    this.releaseRuntime()
    this._correlationId = value
    this.registry.register(this)
    this.runtimeRelease = value ? this.runtimeManager?.claim(value) ?? null : null
  }

  /** Compatibility accessor; the actual launch directory lives in profile.options.cwd. */
  get directory(): string {
    return this.profile?.options.cwd ?? this.fallbackDirectory
  }
  set directory(value: string) {
    this.fallbackDirectory = value
    if (this.profile?.options) this.profile.options.cwd = value
  }

  /** Compatibility accessor; runtime credentials live only in profile.options.env. */
  get environment(): Record<string, string> {
    return this.profile?.options.env ?? this.fallbackEnvironment
  }
  set environment(value: Record<string, string>) {
    this.fallbackEnvironment = value
    if (this.profile?.options) this.profile.options.env = value
  }

  setCompletionActivity(outcome: Outcome = "success", completedAt = new Date().toISOString()): void {
    const update = (): void => {
      if (this.disposed) return
      const eventOrder = TerminalTab.parseCompletionOrder(completedAt)
      if (!this.completionActivityPending) {
        this.originalIcon = this.icon
        this.originalColor = this.color
        this.completionActivityPending = true
        this.completionOrder = eventOrder
        TerminalTab.pendingTabs.add(this)
      } else {
        this.completionOrder = Math.min(this.completionOrder ?? eventOrder, eventOrder)
      }

      const owner = this.visibleIconOwner()
      if (this.completionProjectionOwner && this.completionProjectionOwner !== owner) {
        this.removeCompletionProjection(this.completionProjectionOwner)
      }
      this.completionProjectionOwner = owner
      let projection = TerminalTab.completionProjections.get(owner)
      if (!projection) {
        projection = {
          originalIcon: owner.icon,
          originalColor: owner.color,
          originalActivity: owner.hasActivity,
          pending: new Map(),
        }
        TerminalTab.completionProjections.set(owner, projection)
      }
      projection.pending.set(this, { order: this.completionOrder ?? eventOrder, outcome })
      const latest = [...projection.pending.values()].sort((a, b) => a.order - b.order).at(-1)!
      owner.icon = COMPLETION_ACTIVITY_ICON
      owner.color = COMPLETION_ACTIVITY_COLORS[latest.outcome]
      this.displayActivity()
      if (owner !== this) owner.displayActivity()
      this.reorderPendingTabs()
    }
    const zone = this.zone as { run?: <T>(work: () => T) => T } | undefined
    if (typeof zone?.run === "function") zone.run(update)
    else update()
  }

  setSessionState(state: SessionState, _occurredAt = new Date().toISOString(), generation = 0): void {
    if (state === "completed") {
      if (this.sessionStatePending) {
        this.icon = this.originalIcon
        this.color = this.originalColor
        this.sessionStatePending = false
      }
      this.sessionState = state
      this.sessionGeneration = Math.max(this.sessionGeneration, generation)
      this.setCompletionActivity("success", _occurredAt)
      return
    }
    const update = (): void => {
      if (this.disposed) return
      const newGeneration = generation > this.sessionGeneration
      if (newGeneration && this.sessionStatePending) {
        this.icon = this.originalIcon
        this.color = this.originalColor
        this.sessionStatePending = false
      }
      if (!this.sessionStatePending && !this.completionActivityPending) {
        this.originalIcon = this.icon
        this.originalColor = this.color
        this.sessionStatePending = true
      }
      this.sessionGeneration = Math.max(this.sessionGeneration, generation)
      this.sessionState = state
      const presentation = SESSION_STATE_PRESENTATION[state]
      this.icon = presentation.icon
      this.color = presentation.color
      this.displayActivity()
    }
    const zone = this.zone as { run?: <T>(work: () => T) => T } | undefined
    if (typeof zone?.run === "function") zone.run(update)
    else update()
  }

  clearActivity(): void {
    if (this.completionActivityPending || this.sessionStatePending || TerminalTab.completionProjections.has(this)) return
    super.clearActivity()
  }

  private acknowledgeCompletion(): void {
    const wasCompletionPending = this.completionActivityPending
    if (wasCompletionPending) {
      const owner = this.completionProjectionOwner
      if (owner) this.removeCompletionProjection(owner)
      this.originalIcon = null
      this.originalColor = null
      this.completionActivityPending = false
      this.completionOrder = null
      TerminalTab.pendingTabs.delete(this)
    }
    if (wasCompletionPending || (!TerminalTab.completionProjections.has(this) && !this.sessionStatePending)) super.clearActivity()
    if (wasCompletionPending) this.reorderPendingTabs(this)
    if (this.sessionStatePending && this.sessionState === "completed") {
      this.sessionStatePending = false
      this.icon = this.originalIcon
      this.color = this.originalColor
      this.originalIcon = null
      this.originalColor = null
      super.clearActivity()
    }
  }

  private visibleIconOwner(): BaseTabComponent {
    let owner: BaseTabComponent = this.topmostParent ?? this
    let getFocusedTab = (owner as BaseTabWithFocus).getFocusedTab
    while (typeof getFocusedTab === "function") {
      const focused = getFocusedTab.call(owner)
      if (!focused || focused === owner) break
      owner = focused
      getFocusedTab = (owner as BaseTabWithFocus).getFocusedTab
    }
    return owner
  }

  private removeCompletionProjection(owner: BaseTabComponent): void {
    const projection = TerminalTab.completionProjections.get(owner)
    if (!projection) return
    projection.pending.delete(this)
    if (projection.pending.size > 0) {
      const latest = [...projection.pending.values()].sort((a, b) => a.order - b.order).at(-1)!
      owner.icon = COMPLETION_ACTIVITY_ICON
      owner.color = COMPLETION_ACTIVITY_COLORS[latest.outcome]
      return
    }
    owner.icon = projection.originalIcon
    owner.color = projection.originalColor
    TerminalTab.completionProjections.delete(owner)
    if (owner !== this) owner.clearActivity()
    if (projection.originalActivity) owner.displayActivity()
  }

  private static parseCompletionOrder(completedAt: string): number {
    const parsed = Date.parse(completedAt)
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
  }

  private reorderPendingTabs(reviewedTab?: TerminalTab): void {
    const app = this.app
    const reorder = (): void => {
      if (!app || !Array.isArray(app.tabs) || typeof app.getParentTab !== "function" || typeof app.swapTabs !== "function") return
      const tabs = [...app.tabs]
      const ownerOf = (tab: TerminalTab): BaseTabComponent | null => {
        if (tabs.includes(tab)) return tab
        try {
          const parent = app.getParentTab(tab)
          return parent && tabs.includes(parent) ? parent : null
        } catch {
          return null
        }
      }
      const priorityByOwner = new Map<BaseTabComponent, number>()
      for (const pendingTab of TerminalTab.pendingTabs) {
        const owner = ownerOf(pendingTab), order = pendingTab.completionOrder
        if (!owner || order === null) continue
        const previous = priorityByOwner.get(owner)
        if (previous === undefined || order < previous) priorityByOwner.set(owner, order)
      }
      const pendingOwners = tabs.filter(tab => priorityByOwner.has(tab))
      pendingOwners.sort((a, b) => {
        const aOrder = priorityByOwner.get(a)!, bOrder = priorityByOwner.get(b)!
        return aOrder < bOrder ? -1 : aOrder > bOrder ? 1 : 0
      })
      const ordinaryTabs = tabs.filter(tab => !priorityByOwner.has(tab))
      const reviewedOwner = reviewedTab ? ownerOf(reviewedTab) : null
      if (reviewedOwner && !priorityByOwner.has(reviewedOwner)) {
        const reviewedIndex = ordinaryTabs.indexOf(reviewedOwner)
        if (reviewedIndex >= 0) ordinaryTabs.splice(reviewedIndex, 1)
        ordinaryTabs.unshift(reviewedOwner)
      }
      const target = [...pendingOwners, ...ordinaryTabs]
      const working = [...tabs]
      const swaps: Array<readonly [BaseTabComponent, BaseTabComponent]> = []
      for (let index = 0; index < target.length; index++) {
        if (working[index] === target[index]) continue
        const desiredIndex = working.indexOf(target[index], index + 1)
        if (desiredIndex < 0) return
        const current = working[index], desired = working[desiredIndex]
        swaps.push([current, desired])
        working[index] = desired
        working[desiredIndex] = current
      }
      if (swaps.length === 0 || app.tabs.length !== tabs.length || tabs.some((tab, index) => app.tabs[index] !== tab)) return
      for (const [a, b] of swaps) app.swapTabs(a, b)
      app.tabs = [...app.tabs]
    }
    reorder()
  }

  emitFocused(): void { this.acknowledgeCompletion(); super.emitFocused() }
  focus(): void { this.emitFocused() }
  emitBlurred(): void {
    super.emitBlurred()
    if (this.sessionStatePending) this.displayActivity()
  }

  async getRecoveryToken(options?: GetRecoveryTokenOptions): Promise<RecoveryToken | null> {
    if (!this.profile?.options) return { type: "opencode-tabby-notifier" }
    const token = await super.getRecoveryToken(options) as RecoveryToken & { profile?: LocalProfile }
    if (!token?.profile?.options?.env) return token
    const env = { ...token.profile.options.env }
    for (const key of RUNTIME_ENV_KEYS) delete env[key]
    return {
      ...token,
      type: "opencode-tabby-notifier:recovery",
      profile: {
        ...token.profile,
        options: {
          ...token.profile.options,
          env,
        },
      },
    }
  }

  async destroy(): Promise<void> {
    this.dispose()
    if (this.content?.nativeElement) await super.destroy()
  }

  ngOnDestroy(): void {
    this.dispose()
    super.ngOnDestroy()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.acknowledgeCompletion()
    if (this.sessionStatePending) {
      this.icon = this.originalIcon
      this.color = this.originalColor
      this.sessionStatePending = false
      this.sessionState = null
      this.originalIcon = null
      this.originalColor = null
      super.clearActivity()
    }
    this.releaseRuntime()
    for (const listener of this.disposeListeners.splice(0)) listener()
  }

  onDispose(listener: () => void): void {
    if (this.disposed) {
      listener()
      return
    }
    this.disposeListeners.push(listener)
  }

  private releaseRuntime(): void {
    const release = this.runtimeRelease
    this.runtimeRelease = null
    release?.()
  }
}

// Runtime forms of @Inject and @Optional keep Angular's constructor metadata explicit
// while this source-only workspace remains on standard TypeScript decorators.
Inject(Injector)(TerminalTab, undefined, 0)
Inject(UACService)(TerminalTab, undefined, 1)
Optional()(TerminalTab, undefined, 1)
Inject(TabRegistry)(TerminalTab, undefined, 2)
Optional()(TerminalTab, undefined, 2)
Inject(TabbyRuntimeManager)(TerminalTab, undefined, 3)
Optional()(TerminalTab, undefined, 3)
