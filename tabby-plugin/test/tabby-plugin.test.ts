import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import "@angular/compiler"
import { Injector } from "@angular/core"
import type { Server } from "node:http"
import { createRequire } from "node:module"
import type { ProfileProvider as OfficialProfileProviderType } from "tabby-core"
import type { BaseTerminalTabComponent as OfficialTerminalTabComponentType } from "tabby-terminal"
import type { CompletionEventV1 } from "../../src/domain/completion.ts"
import { createFrame } from "../../src/ipc/protocol.ts"
import { createTabbyCompletionPlugin, TabbyCompletionModule, TabbyCompletionProfileProvider, TabbyCompletionRecoveryProvider } from "../src/index.ts"
import { migrateNotifierRecoveryTokens, sanitizeLaunchProfile, createLaunchEnvironment } from "../src/profile-provider.ts"
import { RUNTIME_ENV_KEYS, TABBY_RUNTIME_OPTIONS, TabbyRuntimeManager } from "../src/runtime.ts"
import { TabRegistry } from "../src/tab-registry.ts"
import { TerminalTab } from "../src/terminal-tab.ts"
import { createHeadlessInjector } from "./setup.ts"

const require = createRequire(__filename)
const execFileAsync = promisify(execFile)
const { ProfileProvider: OfficialProfileProvider } = require("tabby-core") as { ProfileProvider: typeof OfficialProfileProviderType }
const { BaseTerminalTabComponent } = require("tabby-terminal") as { BaseTerminalTabComponent: typeof OfficialTerminalTabComponentType }
const manifest = require("../package.json") as {
  name: string
  author?: string | { name?: string }
  private?: boolean
  license?: string
  keywords?: string[]
  main?: string
  files?: string[]
}
const lockfile = require("../../package-lock.json") as {
  packages: Record<string, { name?: string; resolved?: string; link?: boolean }>
}

test("package manifest satisfies Tabby 1.0.235 discovery and loading contract", () => {
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name

  assert.match(manifest.name, /^tabby-/)
  assert.ok(author?.trim())
  assert.notEqual(manifest.private, true)
  assert.equal(manifest.license, "MIT")
  assert.ok(manifest.keywords?.includes("tabby-plugin"))
  assert.equal(manifest.main, "dist/index.js")
  assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"])
})

test("root lockfile links the Tabby workspace under its manifest name", () => {
  assert.equal(lockfile.packages["tabby-plugin"]?.name, manifest.name)
  assert.deepEqual(lockfile.packages[`node_modules/${manifest.name}`], {
    resolved: "tabby-plugin",
    link: true,
  })
})

type OrderingApp = {
  tabs: object[]
  activeTab: object | null
  parents: Map<TerminalTab, object>
  swaps: Array<readonly [object, object]>
  tabsIdentityChanges: number
  tabsIdentityChangesInZone: number
  zoneDepth: number
  zoneRunCount: number
  iconWritesInZone: number
  getParentTab(tab: TerminalTab): object | null
  swapTabs(a: object, b: object): void
}

const createOrderingApp = (): OrderingApp => {
  let tabs: object[] = []
  const app: OrderingApp = {
    get tabs() { return tabs },
    set tabs(value) {
      if (value !== tabs) {
        this.tabsIdentityChanges++
        if (this.zoneDepth > 0) this.tabsIdentityChangesInZone++
      }
      tabs = value
    },
    activeTab: null,
    parents: new Map(),
    swaps: [],
    tabsIdentityChanges: 0,
    tabsIdentityChangesInZone: 0,
    zoneDepth: 0,
    zoneRunCount: 0,
    iconWritesInZone: 0,
    getParentTab(tab) { return this.parents.get(tab) ?? null },
    swapTabs(a, b) {
      const aIndex = this.tabs.indexOf(a), bIndex = this.tabs.indexOf(b)
      assert.notEqual(aIndex, -1); assert.notEqual(bIndex, -1)
      this.tabs[aIndex] = b; this.tabs[bIndex] = a; this.swaps.push([a, b])
    },
  }
  return app
}

const makeTab = (
  correlationId: string,
  directory: string,
  options: { app?: OrderingApp; registry?: TabRegistry; runtimeManager?: TabbyRuntimeManager } = {},
): TerminalTab => {
  globalThis.document ??= { createElement: () => ({ src: "", load() {} }) } as unknown as Document
  const baseInjector = createHeadlessInjector() as { get(token: { name?: string }): unknown }
  const injector = options.app ? {
    get: (token: { name?: string }) => {
      if (token.name === "AppService") return options.app
      if (token.name === "NgZone") return {
        run: <T>(work: () => T): T => {
          options.app!.zoneRunCount++
          options.app!.zoneDepth++
          try { return work() } finally { options.app!.zoneDepth-- }
        },
        runOutsideAngular: <T>(work: () => T): T => work(),
      }
      return baseInjector.get(token)
    },
  } : baseInjector
  const tab = new TerminalTab(injector as never, undefined, options.registry, options.runtimeManager)
  Object.assign(tab, { correlationId, directory })
  return tab
}

const event = (
  correlationId: string,
  eventId = `${correlationId}-event`,
  overrides: Partial<Pick<CompletionEventV1, "outcome" | "completedAt">> = {},
): CompletionEventV1 => ({
  version: 1, eventId, correlationId, outcome: "success",
  projectLabel: "demo", completedAt: new Date().toISOString(), ...overrides,
})
const completedAt = (second: number): string => new Date(Date.UTC(2025, 0, 1, 0, 0, second)).toISOString()

test("verification defect: pending prioritization needs no hidden emitter and publishes tabs inside Angular zone", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp(), ordinary = { name: "ordinary" }
  const pending = makeTab("public-ordering", "/work", { app, registry })
  t.after(() => registry.dispose())
  app.tabs = [ordinary, pending]; app.activeTab = ordinary
  const originalTabs = app.tabs
  const identityChanges = app.tabsIdentityChanges
  const inZoneChanges = app.tabsIdentityChangesInZone
  let icon = pending.icon
  Object.defineProperty(pending, "icon", {
    configurable: true,
    get: () => icon,
    set: (value: string | null) => {
      if (app.zoneDepth > 0) app.iconWritesInZone++
      icon = value
    },
  })

  assert.equal("emitTabsChanged" in app, false)
  assert.equal(registry.complete(event(pending.correlationId, "public-ordering", { completedAt: completedAt(1) })), true)

  assert.deepEqual(app.tabs, [pending, ordinary])
  assert.notStrictEqual(app.tabs, originalTabs)
  assert.equal(app.tabsIdentityChanges, identityChanges + 1)
  assert.equal(app.tabsIdentityChangesInZone, inZoneChanges + 1)
  assert.equal(app.iconWritesInZone, 1)
  assert.equal(app.zoneRunCount, 1)
  assert.equal(app.activeTab, ordinary)
})

test("verification defect: registry removes the old correlation when a tab is reassigned", (t) => {
  const registry = new TabRegistry()
  const tab = makeTab("correlation-a", "/work", { registry })
  t.after(() => registry.dispose())

  tab.correlationId = "correlation-b"

  assert.equal(registry.size, 1)
  assert.equal(registry.complete(event("correlation-a", "old-correlation")), false)
  assert.equal(registry.complete(event("correlation-b", "new-correlation")), true)
})

test("verification defect: disposing a reassigned tab preserves later owners of both keys", (t) => {
  const registry = new TabRegistry()
  const reassigned = makeTab("owner-a", "/work", { registry })
  reassigned.correlationId = "owner-b"
  const laterA = makeTab("owner-a", "/other-a", { registry })
  const laterB = makeTab("owner-b", "/other-b", { registry })
  t.after(() => { reassigned.dispose(); laterA.dispose(); laterB.dispose(); registry.dispose() })

  reassigned.dispose()

  assert.equal(registry.complete(event("owner-a", "later-owner-a")), true)
  assert.equal(registry.complete(event("owner-b", "later-owner-b")), true)
})

test("completion activity remains visible until the notifier terminal receives focus", () => {
  const tab = makeTab("review-icon-tab", "/work")
  tab.icon = "fas fa-terminal"

  tab.setCompletionActivity()
  tab.setCompletionActivity()

  assert.equal(tab.icon, "fas fa-bell")
  assert.equal(tab.hasActivity, true)
  tab.clearActivity()
  assert.equal(tab.icon, "fas fa-bell")
  assert.equal(tab.hasActivity, true)
  tab.emitFocused()
  assert.equal(tab.icon, "fas fa-terminal")
  assert.equal(tab.hasActivity, false)
  assert.equal(tab.hasFocus, true)
  tab.emitBlurred()
  assert.equal(tab.hasFocus, false)
  tab.dispose()
})

test("state projection renders every state and focus acknowledges only its target", () => {
  const first = makeTab("state-first", "/first"), second = makeTab("state-second", "/second")
  first.setSessionState("waiting-permission")
  second.setSessionState("error")
  assert.equal(first.icon, "fas fa-hand-paper")
  assert.equal(first.color, "#f0ad4e")
  assert.equal(second.icon, "fas fa-exclamation-triangle")
  second.focus()
  assert.equal(second.icon, "fas fa-exclamation-triangle")
  assert.equal(first.icon, "fas fa-hand-paper")
  second.setSessionState("working", new Date().toISOString(), 1)
  assert.equal(second.icon, "fas fa-spinner")
  first.dispose(); second.dispose()
})

test("completion activity preserves and restores a null profile icon", () => {
  const tab = makeTab("null-icon-tab", "/work")
  assert.equal(tab.icon, null)

  tab.setCompletionActivity()
  tab.setCompletionActivity()
  assert.equal(tab.icon, "fas fa-bell")
  tab.emitFocused()

  assert.equal(tab.icon, null)
  assert.equal(tab.hasActivity, false)
  tab.dispose()
})

test("split completion projects icon and color to the focused leaf without touching siblings", () => {
  const visible = makeTab("split-visible", "/visible")
  const hidden = makeTab("split-hidden", "/hidden")
  const split = {
    parent: null,
    focused: visible as object,
    getFocusedTab() { return this.focused as TerminalTab },
  }
  visible.icon = "fas fa-terminal"
  visible.color = "#123456"
  hidden.icon = "fas fa-code"
  hidden.color = "#abcdef"
  hidden.parent = split as never

  hidden.setCompletionActivity("failure", completedAt(10))

  assert.equal(visible.icon, "fas fa-bell")
  assert.equal(visible.color, "#d9534f")
  assert.equal(hidden.icon, "fas fa-code")
  assert.equal(hidden.color, "#abcdef")

  hidden.emitFocused()

  assert.equal(visible.icon, "fas fa-terminal")
  assert.equal(visible.color, "#123456")
  assert.equal(hidden.icon, "fas fa-code")
  assert.equal(hidden.color, "#abcdef")
  visible.dispose(); hidden.dispose()
})

test("completion stays visible after an arbitrary long absence and ignores sibling focus", () => {
  const visible = makeTab("long-visible", "/visible")
  const notifier = makeTab("long-notifier", "/notifier")
  const split = {
    parent: null,
    focused: visible as object,
    getFocusedTab() { return this.focused as TerminalTab },
  }
  notifier.parent = split as never
  visible.icon = "fas fa-terminal"
  visible.color = "#123456"

  notifier.setCompletionActivity("success", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString())
  visible.emitFocused()

  assert.equal(visible.icon, "fas fa-bell")
  assert.equal(visible.hasActivity, true)
  notifier.emitFocused()
  assert.equal(visible.icon, "fas fa-terminal")
  assert.equal(visible.hasActivity, false)
  visible.dispose(); notifier.dispose()
})

test("completion reset has no time-based implementation", () => {
  const source = readFileSync(join(__dirname, "../src/terminal-tab.ts"), "utf8")
  assert.equal(/setTimeout|setInterval|animationend|clearTimeout/.test(source), false)
})

test("destroy acknowledges pending completion and restores the visible representative", () => {
  const visible = makeTab("destroy-visible", "/visible")
  const notifier = makeTab("destroy-notifier", "/notifier")
  const split = {
    parent: null,
    focused: visible as object,
    getFocusedTab() { return this.focused as TerminalTab },
  }
  notifier.parent = split as never
  visible.icon = "fas fa-terminal"
  visible.color = "#123456"

  notifier.setCompletionActivity("failure")
  notifier.dispose()

  assert.equal(visible.icon, "fas fa-terminal")
  assert.equal(visible.color, "#123456")
  assert.equal(visible.hasActivity, false)
  visible.dispose()
})

test("split completion projection keeps the visible leaf active until every pending child clears", () => {
  const visible = makeTab("concurrent-visible", "/visible")
  const first = makeTab("concurrent-first", "/first")
  const second = makeTab("concurrent-second", "/second")
  const split = {
    parent: null,
    focused: visible as object,
    getFocusedTab() { return this.focused as TerminalTab },
  }
  visible.icon = "fas fa-terminal"
  visible.color = "#123456"
  first.parent = split as never
  second.parent = split as never

  first.setCompletionActivity("success", completedAt(10))
  second.setCompletionActivity("cancelled", completedAt(20))
  first.emitFocused()

  assert.equal(visible.icon, "fas fa-bell")
  assert.equal(visible.color, "#f0ad4e")

  second.emitFocused()
  assert.equal(visible.icon, "fas fa-terminal")
  assert.equal(visible.color, "#123456")
  visible.dispose(); first.dispose(); second.dispose()
})

test("focus without pending completion preserves the current icon", () => {
  const tab = makeTab("ordinary-focus-tab", "/work")
  tab.icon = "fas fa-terminal"

  tab.emitFocused()

  assert.equal(tab.icon, "fas fa-terminal")
  assert.equal(tab.hasActivity, false)
  assert.equal(tab.hasFocus, true)
  tab.dispose()
})

test("clearing native activity does not acknowledge completion", () => {
  const tab = makeTab("direct-clear-tab", "/work")
  tab.icon = "fas fa-terminal"
  tab.setCompletionActivity()

  tab.clearActivity()

  assert.equal(tab.icon, "fas fa-bell")
  assert.equal(tab.hasActivity, true)

  tab.emitFocused()
  assert.equal(tab.icon, "fas fa-terminal")
  assert.equal(tab.hasActivity, false)

  tab.icon = null
  tab.setCompletionActivity()
  tab.clearActivity()
  assert.equal(tab.icon, "fas fa-bell")
  tab.emitFocused()
  assert.equal(tab.icon, null)
  tab.dispose()
})

test("pending prioritization colors every outcome and restores exact nullable state", (t) => {
  const registry = new TabRegistry()
  const success = makeTab("outcome-success", "/work", { registry })
  const failure = makeTab("outcome-failure", "/work", { registry })
  const cancelled = makeTab("outcome-cancelled", "/work", { registry })
  t.after(() => registry.dispose())
  success.icon = null; success.color = null
  failure.icon = "fas fa-terminal"; failure.color = "#123456"
  cancelled.icon = null; cancelled.color = "#abcdef"

  assert.equal(registry.complete(event(success.correlationId, "success", { outcome: "success", completedAt: completedAt(1) })), true)
  assert.equal(registry.complete(event(failure.correlationId, "failure", { outcome: "failure", completedAt: completedAt(2) })), true)
  assert.equal(registry.complete(event(cancelled.correlationId, "cancelled", { outcome: "cancelled", completedAt: completedAt(3) })), true)
  assert.deepEqual(
    [success.icon, success.color, failure.icon, failure.color, cancelled.icon, cancelled.color],
      ["fas fa-bell", "#5cb85c", "fas fa-bell", "#d9534f", "fas fa-bell", "#f0ad4e"],
  )
  assert.equal(success.hasActivity && failure.hasActivity && cancelled.hasActivity, true)

  success.emitFocused()
  failure.emitFocused()
  cancelled.dispose()
  assert.deepEqual(
    [success.icon, success.color, failure.icon, failure.color, cancelled.icon, cancelled.color],
    [null, null, "fas fa-terminal", "#123456", null, "#abcdef"],
  )
  assert.equal(success.hasActivity || failure.hasActivity || cancelled.hasActivity, false)
})

test("pending prioritization preserves the earliest repeated completion and latest outcome", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp()
  const second = makeTab("repeat-second", "/work", { app, registry })
  const first = makeTab("repeat-first", "/work", { app, registry })
  t.after(() => registry.dispose())
  first.icon = "fas fa-code"; first.color = "#010203"
  app.tabs = [second, first]; app.activeTab = second
  const identityChanges = app.tabsIdentityChanges

  registry.complete(event(first.correlationId, "first-1", { outcome: "success", completedAt: completedAt(10) }))
  registry.complete(event(second.correlationId, "second-1", { outcome: "success", completedAt: completedAt(15) }))
  registry.complete(event(first.correlationId, "first-2", { outcome: "failure", completedAt: completedAt(20) }))
  assert.deepEqual(app.tabs, [first, second])
  assert.equal(first.color, "#d9534f")

  registry.complete(event(first.correlationId, "first-3", { outcome: "cancelled", completedAt: completedAt(25) }))
  assert.deepEqual(app.tabs, [first, second])
  assert.equal(first.color, "#f0ad4e")
  assert.equal(app.tabsIdentityChanges, identityChanges + 1)
  first.emitFocused()
  assert.equal(first.icon, "fas fa-code")
  assert.equal(first.color, "#010203")
  assert.equal(app.activeTab, second)
})

test("pending prioritization is a stable pending-before-ordinary partition", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp()
  const firstOrdinary = { name: "ordinary-1" }, secondOrdinary = { name: "ordinary-2" }, thirdOrdinary = { name: "ordinary-3" }
  const firstPending = makeTab("partition-first", "/work", { app, registry })
  const secondPending = makeTab("partition-second", "/work", { app, registry })
  t.after(() => registry.dispose())
  app.tabs = [firstOrdinary, firstPending, secondOrdinary, secondPending, thirdOrdinary]
  app.activeTab = secondOrdinary

  registry.complete(event(firstPending.correlationId, "partition-1", { completedAt: completedAt(10) }))
  registry.complete(event(secondPending.correlationId, "partition-2", { completedAt: completedAt(20) }))

  assert.deepEqual(app.tabs, [firstPending, secondPending, firstOrdinary, secondOrdinary, thirdOrdinary])
  assert.equal(app.activeTab, secondOrdinary)
})

test("pending prioritization follows completion time instead of arrival order", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp()
  const ordinary = { name: "ordinary" }
  const later = makeTab("arrival-later", "/work", { app, registry })
  const earlier = makeTab("arrival-earlier", "/work", { app, registry })
  t.after(() => registry.dispose())
  app.tabs = [ordinary, later, earlier]; app.activeTab = ordinary
  const identityChanges = app.tabsIdentityChanges
  const inZoneChanges = app.tabsIdentityChangesInZone

  registry.complete(event(later.correlationId, "later-arrived-first", { completedAt: completedAt(30) }))
  registry.complete(event(earlier.correlationId, "earlier-arrived-second", { completedAt: completedAt(5) }))

  assert.deepEqual(app.tabs, [earlier, later, ordinary])
  assert.equal(app.tabsIdentityChanges, identityChanges + 2)
  assert.equal(app.tabsIdentityChangesInZone, inZoneChanges + 2)
  assert.equal(app.zoneRunCount >= 2, true)
  assert.equal(app.activeTab, ordinary)
})

test("pending prioritization keeps reviewed tabs at the ordinary boundary without activation", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp()
  const firstOrdinary = { name: "ordinary-1" }, secondOrdinary = { name: "ordinary-2" }, thirdOrdinary = { name: "ordinary-3" }
  const earlier = makeTab("clear-earlier", "/work", { app, registry })
  const later = makeTab("clear-later", "/work", { app, registry })
  t.after(() => registry.dispose())
  app.tabs = [firstOrdinary, earlier, secondOrdinary, later, thirdOrdinary]
  app.activeTab = secondOrdinary
  registry.complete(event(earlier.correlationId, "clear-1", { completedAt: completedAt(10) }))
  registry.complete(event(later.correlationId, "clear-2", { completedAt: completedAt(20) }))
  assert.deepEqual(app.tabs, [earlier, later, firstOrdinary, secondOrdinary, thirdOrdinary])

  earlier.emitFocused()
  assert.deepEqual(app.tabs, [later, earlier, firstOrdinary, secondOrdinary, thirdOrdinary])
  assert.equal(app.activeTab, secondOrdinary)
  later.emitFocused()
  assert.deepEqual(app.tabs, [later, earlier, firstOrdinary, secondOrdinary, thirdOrdinary])
  assert.equal(app.activeTab, secondOrdinary)
})

test("pending prioritization groups split children by wrapper and earliest child", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp()
  const ordinary = { name: "ordinary" }, firstWrapper = { name: "split-1" }, secondWrapper = { name: "split-2" }
  const firstLateChild = makeTab("split-first-late", "/work", { app, registry })
  const firstEarlyChild = makeTab("split-first-early", "/work", { app, registry })
  const secondChild = makeTab("split-second", "/work", { app, registry })
  const children = [firstLateChild, firstEarlyChild, secondChild]
  t.after(() => registry.dispose())
  app.parents.set(firstLateChild, firstWrapper); app.parents.set(firstEarlyChild, firstWrapper); app.parents.set(secondChild, secondWrapper)
  app.tabs = [ordinary, firstWrapper, secondWrapper]; app.activeTab = secondWrapper

  registry.complete(event(firstLateChild.correlationId, "split-late", { completedAt: completedAt(30) }))
  registry.complete(event(secondChild.correlationId, "split-other", { completedAt: completedAt(20) }))
  registry.complete(event(firstEarlyChild.correlationId, "split-early", { completedAt: completedAt(10) }))

  assert.deepEqual(app.tabs, [firstWrapper, secondWrapper, ordinary])
  assert.equal(app.swaps.some(([a, b]) => children.includes(a as TerminalTab) || children.includes(b as TerminalTab)), false)
  assert.equal(app.activeTab, secondWrapper)

  firstEarlyChild.emitFocused()
  assert.deepEqual(app.tabs, [secondWrapper, firstWrapper, ordinary])
  firstLateChild.emitFocused()
  assert.deepEqual(app.tabs, [secondWrapper, firstWrapper, ordinary])
})

test("pending prioritization safely retains local attention when no owner exists", (t) => {
  const registry = new TabRegistry(), app = createOrderingApp(), ordinary = { name: "ordinary" }
  const orphan = makeTab("missing-owner", "/work", { app, registry })
  t.after(() => registry.dispose())
  orphan.icon = "fas fa-terminal"; orphan.color = "#112233"
  app.tabs = [ordinary]; app.activeTab = ordinary
  const identityChanges = app.tabsIdentityChanges

  assert.equal(registry.complete(event(orphan.correlationId, "missing-owner", { outcome: "failure", completedAt: completedAt(10) })), true)
    assert.equal(orphan.icon, "fas fa-bell")
  assert.equal(orphan.color, "#d9534f")
  assert.equal(orphan.hasActivity, true)
  assert.deepEqual(app.tabs, [ordinary])
  assert.equal(app.tabsIdentityChanges, identityChanges)
  assert.equal(app.activeTab, ordinary)

  orphan.emitFocused()
  assert.equal(orphan.icon, "fas fa-terminal")
  assert.equal(orphan.color, "#112233")
  assert.deepEqual(app.tabs, [ordinary])
})

test("pending state isolates independent apps and removes disposed entries", (t) => {
  const firstRegistry = new TabRegistry(), secondRegistry = new TabRegistry()
  const firstApp = createOrderingApp(), secondApp = createOrderingApp()
  const firstOrdinary = { name: "first-ordinary" }, secondOrdinary = { name: "second-ordinary" }
  const first = makeTab("isolated-first", "/first", { app: firstApp, registry: firstRegistry })
  const second = makeTab("isolated-second", "/second", { app: secondApp, registry: secondRegistry })
  const pendingTabs = (TerminalTab as unknown as { pendingTabs: Set<TerminalTab> }).pendingTabs
  t.after(() => { firstRegistry.dispose(); secondRegistry.dispose() })
  firstApp.tabs = [firstOrdinary, first]; firstApp.activeTab = firstOrdinary
  secondApp.tabs = [secondOrdinary, second]; secondApp.activeTab = secondOrdinary

  firstRegistry.complete(event(first.correlationId, "isolated-first", { completedAt: completedAt(20) }))
  assert.deepEqual(firstApp.tabs, [first, firstOrdinary])
  assert.deepEqual(secondApp.tabs, [secondOrdinary, second])
  const firstSwapCount = firstApp.swaps.length

  secondRegistry.complete(event(second.correlationId, "isolated-second", { completedAt: completedAt(10) }))
  assert.deepEqual(secondApp.tabs, [second, secondOrdinary])
  assert.deepEqual(firstApp.tabs, [first, firstOrdinary])
  assert.equal(firstApp.swaps.length, firstSwapCount)
  assert.equal(pendingTabs.has(first), true)
  assert.equal(pendingTabs.has(second), true)
  assert.equal(firstApp.activeTab, firstOrdinary)
  assert.equal(secondApp.activeTab, secondOrdinary)

  first.dispose()
  assert.equal(pendingTabs.has(first), false)
  assert.equal(pendingTabs.has(second), true)
  second.emitFocused()
  assert.equal(pendingTabs.has(second), false)
})

test("launch secrets are environment-only and never serializable or recoverable", async (t) => {
  const profile = sanitizeLaunchProfile({ name: "demo", directory: "/work", correlationId: "tab-1", secret: "secret" })
  assert.deepEqual(profile, { name: "demo", directory: "/work" })
  assert.deepEqual(createLaunchEnvironment("tab-1", "secret"), {
    OPENCODE_NOTIFY_CORRELATION: "tab-1", OPENCODE_NOTIFY_IPC_SECRET: "secret",
  })
  const tab = makeTab("tab-1", "/work")
  t.after(() => tab.dispose())
  assert.deepEqual(await tab.getRecoveryToken(), { type: "opencode-tabby-notifier" })
  const recovery = JSON.stringify(await tab.getRecoveryToken())
  assert.equal(recovery.includes("secret"), false)
  assert.equal(recovery.includes("OPENCODE_NOTIFY_IPC_SECRET"), false)
})
test("registry maps two tabs sharing a directory and clears only focused activity", async () => {
  const first = makeTab("tab-1", "/work"), second = makeTab("tab-2", "/work")
  const registry = new TabRegistry()
  registry.register(first); registry.register(second)
  registry.complete(event("tab-1")); registry.complete(event("tab-2"))
  assert.equal(first.hasActivity, true); assert.equal(second.hasActivity, true)
  first.focus(); assert.equal(first.hasActivity, false); assert.equal(second.hasActivity, true)
  assert.deepEqual(registry.complete(event("tab-1")), false)
  first.dispose(); second.dispose(); assert.equal(registry.size, 0)
})

test("consumer rejects invalid, duplicate, unknown, mismatched, and unavailable frames", async () => {
  const tab = makeTab("tab-1", "/work"), registry = new TabRegistry()
  registry.register(tab)
  const plugin = createTabbyCompletionPlugin({ registry, secret: "secret", endpointAvailable: true })
  const valid = createFrame(event("tab-1"), "secret")
  assert.equal(await plugin.consume(valid), true)
  assert.equal(await plugin.consume(valid), false)
  assert.equal(await plugin.consume(createFrame(event("unknown"), "secret")), false)
  assert.equal(await plugin.consume(createFrame(event("tab-2"), "wrong")), false)
  assert.equal(await plugin.consume("not-json"), false)
  plugin.dispose(); tab.dispose()
  assert.equal(await plugin.consume(valid), false)
})

test("Tabby integration uses official provider and terminal component contracts", () => {
  const tab = makeTab("tab-1", "/work")
  assert.equal(tab instanceof BaseTerminalTabComponent, true)
  assert.equal(TabbyCompletionProfileProvider.prototype instanceof OfficialProfileProvider, true)
  tab.displayActivity(); assert.equal(tab.hasActivity, true)
  tab.emitFocused(); assert.equal(tab.hasActivity, false)
  tab.destroy(); assert.equal(tab.hasActivity, false)
  const providers = (TabbyCompletionModule as typeof TabbyCompletionModule & { ɵinj: { providers: unknown[] } }).ɵinj.providers
  assert.equal(providers.some((provider) => (provider as { provide?: unknown }).provide === OfficialProfileProvider), true)
})

test("official provider creates a real terminal component with a full local profile input", async (t) => {
  const provider = new TabbyCompletionProfileProvider()
  t.after(async () => { await provider.shutdown() })
  const profile = {
    id: "demo", type: "opencode-tabby-notifier", name: "demo", group: "",
    options: {
      command: "/bin/sh", args: ["-l"], cwd: "/work", env: { KEEP_ME: "yes" },
      pauseAfterExit: false, runAsAdministrator: false,
    },
    icon: undefined, color: undefined, disableDynamicTitle: false,
    behaviorOnSessionEnd: "keep" as const, weight: 0, isBuiltin: false,
    isTemplate: false,
  }
  const parameters = await provider.getNewTabParameters(profile)
  const env = parameters.inputs.profile.options.env!
  assert.equal(parameters.type.prototype instanceof BaseTerminalTabComponent, true)
  assert.equal(parameters.inputs.profile.options.cwd, "/work")
  assert.deepEqual(parameters.inputs.profile.options.args, ["-l"])
  assert.equal(env.KEEP_ME, "yes")
  assert.match(env.OPENCODE_NOTIFY_CORRELATION, /^tab-/)
  assert.equal(env.OPENCODE_NOTIFY_IPC_SECRET.length, 64)
})

test("created terminal registers itself with the shared registry by correlation", () => {
  const registry = new TabRegistry()
  const tab = new TerminalTab(createHeadlessInjector() as never, undefined, registry)
  Object.assign(tab, { correlationId: "created-tab", directory: "/work" })
  assert.equal(registry.size, 1)
  tab.dispose()
})

test("loopback IPC server consumes the adapter frame and tears down", async () => {
  const tab = makeTab("tab-1", "/work"), registry = new TabRegistry()
  registry.register(tab)
  const plugin = createTabbyCompletionPlugin({ registry, secret: "server-secret" })
  const server = plugin.createServer(), port = await server.start()
  const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: createFrame(event("tab-1", "server-event"), "server-secret") })
  assert.equal(response.status, 204); assert.equal(tab.hasActivity, true)
  await server.dispose(); plugin.dispose(); tab.dispose(); assert.equal(await plugin.consume("{}"), false)
})

test("IPC startup errors reject and clear the failed server", async (t) => {
  const { IpcServer } = await import("../src/ipc-server.ts")
  const owner = new IpcServer("owner-secret", () => true)
  const contender = new IpcServer("contender-secret", () => true)
  t.after(async () => { await contender.dispose(); await owner.dispose() })
  const port = await owner.start()

  await assert.rejects(contender.start(port), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE")
  assert.equal((contender as unknown as { server: Server | null }).server, null)
})

test("IPC server contains post-bind errors and drops the failed listener", async (t) => {
  const { IpcServer } = await import("../src/ipc-server.ts")
  const server = new IpcServer("post-bind-secret", () => true)
  t.after(async () => { await server.dispose() })
  const port = await server.start()
  const state = server as unknown as { server: Server | null }
  const nativeServer = state.server
  assert.ok(nativeServer)
  const closed = new Promise<void>(resolve => nativeServer.once("close", () => resolve()))

  assert.doesNotThrow(() => nativeServer.emit("error", new Error("post-bind failure")))
  assert.equal(state.server, null)
  await closed
  assert.equal(nativeServer.listening, false)
  await assert.rejects(fetch(`http://127.0.0.1:${port}`))
})

test("IPC listener enforces route, correlation, replay, byte, time, and connection bounds", async (t) => {
  const { IpcServer } = await import("../src/ipc-server.ts")
  let registryMutations = 0
  const server = new IpcServer("bounded-secret", () => { registryMutations++; return true }, "bounded-tab")
  t.after(async () => { await server.dispose() })
  const port = await server.start()
  const endpoint = `http://127.0.0.1:${port}`
  const nativeServer = (server as unknown as {
    server: { maxConnections: number; requestTimeout: number; headersTimeout: number }
  }).server

  assert.equal(nativeServer.maxConnections, 8)
  assert.equal(nativeServer.requestTimeout > 0 && nativeServer.requestTimeout <= 5_000, true)
  assert.equal(nativeServer.headersTimeout > 0 && nativeServer.headersTimeout <= 5_000, true)
  assert.equal((await fetch(endpoint)).status, 400)
  assert.equal((await fetch(`${endpoint}/other`, { method: "POST", body: "{}" })).status, 400)
  assert.equal((await fetch(endpoint, { method: "POST", body: "x".repeat(4_097) })).status, 413)

  const mismatch = createFrame(event("other-tab", "bounded-mismatch"), "bounded-secret")
  assert.equal((await postFrame(endpoint, mismatch)).status, 400)
  assert.equal(registryMutations, 0)
  const frame = createFrame(event("bounded-tab", "bounded-delivery"), "bounded-secret")
  assert.equal((await postFrame(endpoint, frame)).status, 204)
  assert.equal((await postFrame(endpoint, frame)).status, 400)
  assert.equal(registryMutations, 1)

  await Promise.all([server.dispose(), server.dispose(), server.dispose()])
  await assert.rejects(postFrame(endpoint, frame))
})

const completeLocalProfile = (overrides: Record<string, unknown> = {}) => ({
  id: "manual-notifier",
  type: "opencode-tabby-notifier",
  name: "Manual notifier",
  group: "",
  icon: "fas fa-terminal",
  color: "#123456",
  disableDynamicTitle: false,
  behaviorOnSessionEnd: "keep" as const,
  weight: 0,
  isBuiltin: false,
  isTemplate: false,
  options: {
    restoreFromPTYID: null,
    command: "/usr/bin/fish",
    args: ["--login"],
    cwd: "/work/manual",
    env: { KEEP_ME: "yes" },
    width: null,
    height: null,
    shellType: "unix" as const,
    pauseAfterExit: false,
    runAsAdministrator: false,
  },
  ...overrides,
})

const postFrame = (endpoint: string, frame: string): Promise<Response> => fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: frame,
})

test("Angular constructor metadata explicitly injects every plugin-owned dependency", async (t) => {
  const { UACService } = require("tabby-local") as { UACService: unknown }
  const hasAnnotation = (
    target: object,
    index: number,
    predicate: (annotation: { ngMetadataName?: string; token?: unknown }) => boolean,
  ): boolean => {
    const parameters = (target as { __parameters__?: Array<Array<{ ngMetadataName?: string; token?: unknown }>> }).__parameters__
    return parameters?.[index]?.some(predicate) ?? false
  }
  const isOptional = (annotation: { ngMetadataName?: string }): boolean => annotation.ngMetadataName === "Optional"
  const injects = (token: unknown) => (annotation: { token?: unknown }): boolean => annotation.token === token

  assert.equal(hasAnnotation(TerminalTab, 1, injects(UACService)), true)
  assert.equal(hasAnnotation(TerminalTab, 1, isOptional), true)
  assert.equal(hasAnnotation(TerminalTab, 2, injects(TabRegistry)), true)
  assert.equal(hasAnnotation(TerminalTab, 2, isOptional), true)
  assert.equal(hasAnnotation(TerminalTab, 3, injects(TabbyRuntimeManager)), true)
  assert.equal(hasAnnotation(TerminalTab, 3, isOptional), true)
  assert.equal(hasAnnotation(TabbyRuntimeManager, 0, injects(TabRegistry)), true)
  assert.equal(hasAnnotation(TabbyRuntimeManager, 0, isOptional), true)
  assert.equal(hasAnnotation(TabbyRuntimeManager, 1, injects(TABBY_RUNTIME_OPTIONS)), true)
  assert.equal(hasAnnotation(TabbyCompletionProfileProvider, 0, injects(TabbyRuntimeManager)), true)
  assert.equal(hasAnnotation(TabbyCompletionProfileProvider, 0, isOptional), true)
  assert.equal(hasAnnotation(TabbyCompletionRecoveryProvider, 0, injects(TabbyRuntimeManager)), true)
  assert.equal(hasAnnotation(TabbyCompletionRecoveryProvider, 0, isOptional), true)
  assert.equal(hasAnnotation(TabbyCompletionModule, 0, injects(TabbyRuntimeManager)), true)

  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  t.after(async () => { await manager.shutdown(); registry.dispose() })
  const injector = Injector.create({ providers: [
    { provide: TabRegistry, useValue: registry },
    { provide: TabbyRuntimeManager, useValue: manager },
    { provide: TabbyCompletionProfileProvider, useClass: TabbyCompletionProfileProvider },
    { provide: TabbyCompletionModule, useClass: TabbyCompletionModule },
  ] })
  const provider = injector.get(TabbyCompletionProfileProvider)
  await provider.getNewTabParameters(completeLocalProfile() as never)
  assert.equal(manager.activeCount, 1)
  injector.get(TabbyCompletionModule).ngOnDestroy()
  await manager.waitForIdle()
  assert.equal(manager.activeCount, 0)
})

test("provider clones a complete local profile and injects runtime values only into the clone", async (t) => {
  const provider = new TabbyCompletionProfileProvider()
  t.after(async () => { await (provider as unknown as { shutdown(): Promise<void> }).shutdown() })
  const profile = completeLocalProfile()
  const original = structuredClone(profile)

  const parameters = await provider.getNewTabParameters(profile as never)
  const inputs = parameters.inputs as unknown as { correlationId: string; profile: typeof profile }
  const env = inputs.profile.options.env as Record<string, string>

  assert.deepEqual(profile, original)
  assert.notStrictEqual(inputs.profile, profile)
  assert.notStrictEqual(inputs.profile.options, profile.options)
  assert.notStrictEqual(inputs.profile.options.args, profile.options.args)
  assert.notStrictEqual(inputs.profile.options.env, profile.options.env)
  assert.equal(inputs.profile.options.command, "/usr/bin/fish")
  assert.deepEqual(inputs.profile.options.args, ["--login"])
  assert.equal(inputs.profile.options.cwd, "/work/manual")
  assert.equal(env.KEEP_ME, "yes")
  assert.equal(env.OPENCODE_NOTIFY_CORRELATION, inputs.correlationId)
  assert.equal(env.OPENCODE_NOTIFY_IPC_SECRET.length, 64)
  assert.match(env.OPENCODE_NOTIFY_IPC_ENDPOINT, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(env.OPENCODE_NOTIFY_PROJECT_LABEL, "Manual notifier")
  assert.deepEqual(Object.keys(parameters.inputs).sort(), ["correlationId", "profile"])
})

test("provider runtime environment reaches a real shell boundary", async (t) => {
  const provider = new TabbyCompletionProfileProvider()
  t.after(async () => { await provider.shutdown() })

  const parameters = await provider.getNewTabParameters(completeLocalProfile() as never)
  const profile = parameters.inputs.profile as unknown as ReturnType<typeof completeLocalProfile>
  const env = profile.options.env as Record<string, string>
  const { stdout } = await execFileAsync("/bin/sh", [
    "-c",
    "printf '%s\\n' \"$OPENCODE_NOTIFY_CORRELATION\" \"$OPENCODE_NOTIFY_IPC_SECRET\" \"$OPENCODE_NOTIFY_IPC_ENDPOINT\" \"$OPENCODE_NOTIFY_PROJECT_LABEL\"",
  ], { cwd: process.cwd(), env: { ...process.env, ...env } })

  assert.deepEqual(stdout.trim().split("\n"), [
    env.OPENCODE_NOTIFY_CORRELATION,
    env.OPENCODE_NOTIFY_IPC_SECRET,
    env.OPENCODE_NOTIFY_IPC_ENDPOINT,
    env.OPENCODE_NOTIFY_PROJECT_LABEL,
  ])
})

test("provider exposes exactly one complete built-in shell profile", async (t) => {
  const provider = new TabbyCompletionProfileProvider()
  t.after(async () => { await (provider as unknown as { shutdown(): Promise<void> }).shutdown() })

  const profiles = await provider.getBuiltinProfiles()

  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].type, "opencode-tabby-notifier")
  assert.equal(profiles[0].isBuiltin, true)
  assert.deepEqual(profiles[0].options, {
    restoreFromPTYID: null,
    command: process.env.SHELL || "/bin/bash",
    args: [],
    cwd: null,
    env: {},
    width: null,
    height: null,
    shellType: "unix",
    pauseAfterExit: false,
    runAsAdministrator: false,
  })
})

test("provider-started endpoint authenticates, correlates, deduplicates, and reaches its tab", async (t) => {
  const { TabbyRuntimeManager } = await import("../src/runtime.ts")
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  const provider = new TabbyCompletionProfileProvider(manager)
  t.after(async () => { await manager.shutdown(); registry.dispose() })
  const parameters = await provider.getNewTabParameters(completeLocalProfile() as never)
  const inputs = parameters.inputs as unknown as {
    correlationId: string
    profile: ReturnType<typeof completeLocalProfile>
  }
  const env = inputs.profile.options.env as Record<string, string>
  const tab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(tab, inputs)

  const wrongSecret = await postFrame(env.OPENCODE_NOTIFY_IPC_ENDPOINT, createFrame(event(inputs.correlationId, "wrong-secret"), "wrong"))
  const mismatched = await postFrame(env.OPENCODE_NOTIFY_IPC_ENDPOINT, createFrame(event("another-correlation", "mismatch"), env.OPENCODE_NOTIFY_IPC_SECRET))
  const frame = createFrame(event(inputs.correlationId, "provider-delivery"), env.OPENCODE_NOTIFY_IPC_SECRET)
  const delivered = await postFrame(env.OPENCODE_NOTIFY_IPC_ENDPOINT, frame)
  const duplicate = await postFrame(env.OPENCODE_NOTIFY_IPC_ENDPOINT, frame)

  assert.equal(wrongSecret.status, 400)
  assert.equal(mismatched.status, 400)
  assert.equal(delivered.status, 204)
  assert.equal(duplicate.status, 400)
  assert.equal(tab.hasActivity, true)
  tab.dispose()
  await manager.waitForIdle()
  assert.equal(manager.activeCount, 0)
  await assert.rejects(postFrame(env.OPENCODE_NOTIFY_IPC_ENDPOINT, frame))
})

test("runtime leases can be claimed once and concurrent shutdown remains idempotent", async (t) => {
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  t.after(async () => { await manager.shutdown(); registry.dispose() })
  const runtime = await manager.createRuntime()

  const release = manager.claim(runtime.correlationId)
  assert.equal(typeof release, "function")
  assert.equal(manager.claim(runtime.correlationId), null)
  release?.()
  release?.()
  await manager.waitForIdle()
  assert.equal(manager.activeCount, 0)

  await Promise.all([manager.shutdown(), manager.shutdown()])
  assert.equal(manager.activeCount, 0)
  await assert.rejects(manager.createRuntime(), /shut down/)
})

test("runtime leases clean up exactly once on dispose, ngOnDestroy, and manager shutdown", async (t) => {
  const [{ TabbyRuntimeManager }, { IpcServer }] = await Promise.all([
    import("../src/runtime.ts"),
    import("../src/ipc-server.ts"),
  ])
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  const provider = new TabbyCompletionProfileProvider(manager)
  const originalDispose = IpcServer.prototype.dispose
  let disposeCalls = 0
  IpcServer.prototype.dispose = function (...args: Parameters<typeof originalDispose>) {
    disposeCalls++
    return originalDispose.apply(this, args)
  }
  t.after(async () => {
    IpcServer.prototype.dispose = originalDispose
    await manager.shutdown()
    registry.dispose()
  })
  const parameters = await provider.getNewTabParameters(completeLocalProfile() as never)
  const tab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(tab, parameters.inputs)

  tab.dispose()
  tab.dispose()
  tab.ngOnDestroy()
  await manager.shutdown()
  await manager.waitForIdle()

  assert.equal(disposeCalls, 1)
  assert.equal(manager.activeCount, 0)
})

test("runtime manager bounds unclaimed leases and module/service shutdown closes all listeners", async (t) => {
  const { TabbyRuntimeManager } = await import("../src/runtime.ts")
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 20 })
  const provider = new TabbyCompletionProfileProvider(manager)
  t.after(async () => { await manager.shutdown(); registry.dispose() })
  const unclaimed = await provider.getNewTabParameters(completeLocalProfile({ id: "unclaimed" }) as never)
  const unclaimedEnv = (unclaimed.inputs as unknown as { profile: ReturnType<typeof completeLocalProfile> }).profile.options.env as Record<string, string>

  await new Promise(resolve => setTimeout(resolve, 60))
  await manager.waitForIdle()

  assert.equal(manager.activeCount, 0)
  await assert.rejects(postFrame(unclaimedEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, "{}"))

  const first = await provider.getNewTabParameters(completeLocalProfile({ id: "shutdown-1" }) as never)
  const second = await provider.getNewTabParameters(completeLocalProfile({ id: "shutdown-2" }) as never)
  const endpoints = [first, second].map(parameters => (
    (parameters.inputs as unknown as { profile: ReturnType<typeof completeLocalProfile> }).profile.options.env as Record<string, string>
  ).OPENCODE_NOTIFY_IPC_ENDPOINT)
  assert.equal(manager.activeCount, 2)

  const module = new TabbyCompletionModule(manager)
  module.ngOnDestroy()
  await manager.waitForIdle()

  assert.equal(manager.activeCount, 0)
  for (const endpoint of endpoints) await assert.rejects(postFrame(endpoint, "{}"))
})

test("notifier terminal inherits the local PTY terminal and real base template", () => {
  const { TerminalTabComponent: LocalTerminalTabComponent, default: LocalTerminalModule } = require("tabby-local") as {
    TerminalTabComponent: new (...args: never[]) => unknown
    default: unknown
  }
  const { default: TabbyCoreModule } = require("tabby-core") as { default: unknown }
  const { default: TabbyTerminalModule } = require("tabby-terminal") as { default: unknown }
  const annotations = (TerminalTab as unknown as { __annotations__?: Array<{ template?: string }> }).__annotations__ ?? []
  const moduleDefinition = TabbyCompletionModule as typeof TabbyCompletionModule & {
    ɵinj: { imports: unknown[] }
    ɵmod: { declarations: unknown[] }
  }
  const flatten = (values: unknown[]): unknown[] => values.flatMap(value => Array.isArray(value) ? flatten(value) : [value])

  assert.equal(TerminalTab.prototype instanceof LocalTerminalTabComponent, true)
  assert.equal(annotations.at(-1)?.template, BaseTerminalTabComponent.template)
  assert.equal(flatten(moduleDefinition.ɵinj.imports).includes(TabbyCoreModule), true)
  assert.equal(flatten(moduleDefinition.ɵinj.imports).includes(TabbyTerminalModule), true)
  assert.equal(flatten(moduleDefinition.ɵinj.imports).includes(LocalTerminalModule), true)
  assert.equal(flatten(moduleDefinition.ɵmod.declarations).includes(TerminalTab), true)
})

test("recovery state excludes every runtime environment entry and preserves ordinary environment", async (t) => {
  const { TabbyRuntimeManager } = await import("../src/runtime.ts")
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  const provider = new TabbyCompletionProfileProvider(manager)
  t.after(async () => { await manager.shutdown(); registry.dispose() })
  const parameters = await provider.getNewTabParameters(completeLocalProfile() as never)
  const inputs = parameters.inputs as unknown as {
    correlationId: string
    profile: ReturnType<typeof completeLocalProfile>
  }
  const env = inputs.profile.options.env as Record<string, string>
  const tab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(tab, inputs)

  const recovery = await tab.getRecoveryToken()
  const serialized = JSON.stringify(recovery)

  for (const key of RUNTIME_ENV_KEYS) {
    assert.equal(serialized.includes(key), false)
  }
  for (const key of RUNTIME_ENV_KEYS.slice(0, 3)) {
    assert.equal(serialized.includes(env[key]), false)
  }
  const recoveryEnv = (recovery as unknown as { profile: { options: { env: Record<string, string> } } }).profile.options.env
  assert.deepEqual(recoveryEnv, { KEEP_ME: "yes" })
  tab.dispose()
})

test("recovery creates a fresh notifier terminal instead of bypassing the profile provider", async (t) => {
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 1_000 })
  const provider = new TabbyCompletionProfileProvider(manager)
  const recoveryProvider = new TabbyCompletionRecoveryProvider(manager)
  t.after(async () => { await manager.shutdown(); registry.dispose() })

  const original = await provider.getNewTabParameters(completeLocalProfile() as never)
  const originalInputs = original.inputs as unknown as { profile: ReturnType<typeof completeLocalProfile>; correlationId: string }
  const tab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(tab, originalInputs)
  const token = await tab.getRecoveryToken({ includeState: false })
  tab.dispose()

  assert.equal(token?.type, "opencode-tabby-notifier:recovery")
  assert.equal(await recoveryProvider.applicableTo(token!), true)
  const recovered = await recoveryProvider.recover(token!)
  const recoveredProfile = recovered.inputs.profile
  const recoveredEnv = recoveredProfile.options.env as Record<string, string>
  assert.equal(recovered.type, TerminalTab)
  assert.equal(recovered.inputs.correlationId !== originalInputs.correlationId, true)
  assert.equal(recoveredProfile.options.restoreFromPTYID, null)
  assert.equal(recoveredEnv.OPENCODE_NOTIFY_CORRELATION, recovered.inputs.correlationId)
  assert.equal(recoveredEnv.OPENCODE_NOTIFY_IPC_SECRET.length, 64)
  assert.match(recoveredEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test("Angular recovery provider claims the module runtime listener through terminal lifetime", async (t) => {
  const registry = new TabRegistry()
  const manager = new TabbyRuntimeManager(registry, { unclaimedTimeoutMs: 100 })
  const profileProvider = new TabbyCompletionProfileProvider(manager)
  t.after(async () => { await manager.shutdown(); registry.dispose() })

  const original = await profileProvider.getNewTabParameters(completeLocalProfile() as never)
  const originalTab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(originalTab, original.inputs)
  const token = await originalTab.getRecoveryToken({ includeState: false })
  originalTab.dispose()

  const injector = Injector.create({ providers: [
    { provide: TabRegistry, useValue: registry },
    { provide: TabbyRuntimeManager, useValue: manager },
    { provide: TabbyCompletionRecoveryProvider, useClass: TabbyCompletionRecoveryProvider },
  ] })
  const recoveryProvider = injector.get(TabbyCompletionRecoveryProvider)
  const recovered = await recoveryProvider.recover(token!)
  const repeatedRecovery = await recoveryProvider.recover(token!)
  const recoveredEnv = recovered.inputs.profile.options.env as Record<string, string>
  const repeatedEnv = repeatedRecovery.inputs.profile.options.env as Record<string, string>
  const recoveredTab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  const repeatedTab = new TerminalTab(createHeadlessInjector() as never, undefined, registry, manager)
  Object.assign(recoveredTab, recovered.inputs)
  Object.assign(repeatedTab, repeatedRecovery.inputs)

  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(manager.activeCount, 2)
  assert.notEqual(recoveredEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, repeatedEnv.OPENCODE_NOTIFY_IPC_ENDPOINT)
  assert.equal((await postFrame(recoveredEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, createFrame(
    event(recovered.inputs.correlationId, "angular-recovery-delivery"),
    recoveredEnv.OPENCODE_NOTIFY_IPC_SECRET,
  ))).status, 204)
  assert.equal((await postFrame(repeatedEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, createFrame(
    event(repeatedRecovery.inputs.correlationId, "repeated-angular-recovery-delivery"),
    repeatedEnv.OPENCODE_NOTIFY_IPC_SECRET,
  ))).status, 204)
  assert.equal(recoveredTab.hasActivity, true)
  assert.equal(repeatedTab.hasActivity, true)

  recoveredTab.dispose()
  repeatedTab.dispose()
  await manager.waitForIdle()
  assert.equal(manager.activeCount, 0)
  await assert.rejects(postFrame(recoveredEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, "{}"))
  await assert.rejects(postFrame(repeatedEnv.OPENCODE_NOTIFY_IPC_ENDPOINT, "{}"))
})

test("startup migrates legacy generic local recovery tokens before Tabby selects a provider", () => {
  let saved = JSON.stringify([
    { type: "app:local-tab", profile: { type: "opencode-tabby-notifier" } },
    { type: "app:local-tab", profile: { type: "local" } },
  ])
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }

  migrateNotifierRecoveryTokens(storage)

  assert.deepEqual(JSON.parse(saved), [
    { type: "opencode-tabby-notifier:recovery", profile: { type: "opencode-tabby-notifier" } },
    { type: "app:local-tab", profile: { type: "local" } },
  ])
})

test("startup migrates notifier recovery tokens nested in split-tab children without changing ordinary children", () => {
  let saved = JSON.stringify([{
    type: "app:split-tab",
    ratios: [0.5, 0.5],
    orientation: "h",
    children: [
      { type: "app:local-tab", profile: { type: "local", name: "ordinary" }, state: { focused: true } },
      {
        type: "app:split-tab",
        ratios: [0.3, 0.7],
        orientation: "v",
        children: [
          { type: "app:local-tab", profile: { type: "opencode-tabby-notifier", name: "OpenCode notifier shell" } },
          { type: "app:local-tab", profile: { type: "opencode-tabby-notifier", name: "OpenCode notifier shell 2" } },
        ],
      },
    ],
  }])
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }

  migrateNotifierRecoveryTokens(storage)

  assert.deepEqual(JSON.parse(saved), [{
    type: "app:split-tab",
    ratios: [0.5, 0.5],
    orientation: "h",
    children: [
      { type: "app:local-tab", profile: { type: "local", name: "ordinary" }, state: { focused: true } },
      {
        type: "app:split-tab",
        ratios: [0.3, 0.7],
        orientation: "v",
        children: [
          { type: "opencode-tabby-notifier:recovery", profile: { type: "opencode-tabby-notifier", name: "OpenCode notifier shell" } },
          { type: "opencode-tabby-notifier:recovery", profile: { type: "opencode-tabby-notifier", name: "OpenCode notifier shell 2" } },
        ],
      },
    ],
  }])
})

test("startup ignores malformed and irrelevant recovery records", () => {
  let saved = "[{\"type\":\"app:split-tab\",\"children\":null},null,42]"
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }

  assert.doesNotThrow(() => migrateNotifierRecoveryTokens(storage))
  assert.equal(saved, "[{\"type\":\"app:split-tab\",\"children\":null},null,42]")

  saved = "not-json"
  assert.doesNotThrow(() => migrateNotifierRecoveryTokens(storage))
  assert.equal(saved, "not-json")
})
