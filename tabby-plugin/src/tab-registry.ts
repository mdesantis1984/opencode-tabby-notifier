import type { CompletionEventV1, SessionStateEventV1, TabbyEventV1 } from "../../src/domain/completion.ts"
import type { TerminalTab } from "./terminal-tab.ts"

export class TabRegistry {
  private tabs = new Map<string, TerminalTab>()
  private keysByTab = new Map<TerminalTab, string>()
  private observedTabs = new WeakSet<TerminalTab>()
  private completed = new Set<string>()
  private states = new Set<string>()
  register(tab: TerminalTab): void {
    const previousKey = this.keysByTab.get(tab)
    if (previousKey !== undefined && this.tabs.get(previousKey) === tab) this.tabs.delete(previousKey)

    const correlationId = tab.correlationId
    if (!correlationId) {
      this.keysByTab.delete(tab)
      return
    }

    const previousOwner = this.tabs.get(correlationId)
    if (previousOwner && previousOwner !== tab && this.keysByTab.get(previousOwner) === correlationId) {
      this.keysByTab.delete(previousOwner)
    }
    this.tabs.set(correlationId, tab)
    this.keysByTab.set(tab, correlationId)
    if (!this.observedTabs.has(tab)) {
      this.observedTabs.add(tab)
      tab.onDispose(() => this.unregisterTab(tab))
    }
  }
  unregister(correlationId: string): void {
    const tab = this.tabs.get(correlationId)
    if (!tab) return
    this.tabs.delete(correlationId)
    if (this.keysByTab.get(tab) === correlationId) this.keysByTab.delete(tab)
  }
  private unregisterTab(tab: TerminalTab): void {
    const correlationId = this.keysByTab.get(tab)
    if (correlationId !== undefined && this.tabs.get(correlationId) === tab) this.tabs.delete(correlationId)
    this.keysByTab.delete(tab)
  }
  get size(): number { return this.tabs.size }
  complete(event: CompletionEventV1): boolean {
    if (this.completed.has(event.eventId)) return false
    const tab = this.tabs.get(event.correlationId)
    if (!tab || tab.correlationId !== event.correlationId) return false
    this.completed.add(event.eventId)
    tab.setCompletionActivity(event.outcome, event.completedAt)
    return true
  }

  apply(event: TabbyEventV1): boolean {
    return "state" in event ? this.setState(event) : this.complete(event)
  }

  setState(event: SessionStateEventV1): boolean {
    const tab = this.tabs.get(event.correlationId)
    if (!tab || tab.correlationId !== event.correlationId || this.states.has(event.eventId)) return false
    this.states.add(event.eventId)
    tab.setSessionState(event.state, event.occurredAt, event.generation)
    return true
  }

  /** Test-only control, enabled by the isolated renderer harness and never exposed in normal runs. */
  completeForHarness(outcome: CompletionEventV1["outcome"] = "success"): boolean {
    for (const tab of this.tabs.values()) {
      if (this.complete({
        version: 1,
        eventId: `harness:${Date.now()}:${Math.random()}`,
        correlationId: tab.correlationId,
        outcome,
        projectLabel: "harness",
        completedAt: new Date().toISOString(),
      })) return true
    }
    return false
  }
  dispose(): void {
    for (const tab of new Set(this.tabs.values())) tab.dispose()
    this.tabs.clear()
    this.keysByTab.clear()
    this.completed.clear()
    this.states.clear()
  }
}
