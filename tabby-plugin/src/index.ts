import { CommonModule } from "@angular/common"
import { ApplicationRef, Inject, NgModule, OnDestroy, Optional, type Type } from "@angular/core"
import * as NodeModule from "node:module"
import type TabbyCoreModuleType from "tabby-core"
import type { ProfileProvider as ProfileProviderType, TabRecoveryProvider as TabRecoveryProviderType } from "tabby-core"
import type TabbyLocalModuleType from "tabby-local"
import type TabbyTerminalModuleType from "tabby-terminal"
import type { CompletionEventV1, TabbyEventV1 } from "../../src/domain/completion.ts"
import { ReplayCache, verifyFrame } from "../../src/ipc/protocol.ts"
import { IpcServer } from "./ipc-server.ts"
import { migrateNotifierRecoveryTokens, TabbyCompletionProfileProvider, TabbyCompletionRecoveryProvider } from "./profile-provider.ts"
import { TabbyRuntimeManager } from "./runtime.ts"
import { TabRegistry } from "./tab-registry.ts"
import { NOTIFIER_ICON_CLASS, TerminalTab } from "./terminal-tab.ts"

const require = NodeModule.createRequire(__filename)
const { default: TabbyCoreModule, ProfileProvider, TabRecoveryProvider } = require("tabby-core") as {
  default: typeof TabbyCoreModuleType
  ProfileProvider: typeof ProfileProviderType
  TabRecoveryProvider: typeof TabRecoveryProviderType
}
const { default: LocalTerminalModule } = require("tabby-local") as {
  default: typeof TabbyLocalModuleType
}
const { default: TabbyTerminalModule } = require("tabby-terminal") as {
  default: typeof TabbyTerminalModuleType
}

export const ACTIVE_TAB_STYLE_ID = "tabby-opencode-notifier-active-tab-style"
const ACTIVE_TAB_CSS = `
app-root .main.content > .tab-bar > .tabs > tab-header.active {
  background-color: var(--opencode-active-tab-bg, var(--theme-primary, #0d6efd)) !important;
  color: var(--opencode-active-tab-fg, var(--theme-primary-fg, #ffffff)) !important;
}

app-root .main.content > .tab-bar > .tabs > tab-header.active .index {
  color: inherit !important;
  opacity: 1 !important;
}

app-root .main.content > .tab-bar > .tabs > tab-header:has(profile-icon .${NOTIFIER_ICON_CLASS}) > .colorbar {
  display: none !important;
}

app-root .main.content > .content > tab-body.content-tab-active::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 10;
  box-sizing: border-box;
  border: 3px solid var(--opencode-active-tab-bg, var(--theme-primary, #0d6efd));
  pointer-events: none;
}
`

export function installActiveTabStyle(targetDocument: Document): () => void {
  if (targetDocument.getElementById?.(ACTIVE_TAB_STYLE_ID)) return () => {}
  const style = targetDocument.createElement("style")
  style.id = ACTIVE_TAB_STYLE_ID
  style.textContent = ACTIVE_TAB_CSS
  targetDocument.head.appendChild(style)
  return () => style.remove()
}

/** Headless adapter retained for protocol-level tests and non-Angular harnesses. */
export function createTabbyCompletionPlugin(options: {
  registry: TabRegistry
  secret: string
  endpointAvailable?: boolean
}) {
  const seen = new ReplayCache()
  let disposed = false
  const isAvailable = (): boolean => !disposed && options.endpointAvailable !== false
  const consume = async (frame: string): Promise<boolean> => {
    if (!isAvailable()) return false
    try {
      const completion = verifyFrame(frame, options.secret, { seen, remoteAddress: "127.0.0.1" })
      return options.registry.apply(completion)
    } catch {
      return false
    }
  }
  return {
    consume,
    dispose: () => {
      if (disposed) return
      disposed = true
      seen.clear()
      options.registry.dispose()
    },
    createServer: () => new IpcServer(
      options.secret,
      completion => isAvailable() && options.registry.apply(completion),
    ),
  }
}

/** Tabby discovers plugin modules through this Angular provider graph. */
@NgModule({
  imports: [
    CommonModule,
    TabbyCoreModule,
    TabbyTerminalModule,
    // Tabby's declaration gives this runtime NgModule a private constructor.
    LocalTerminalModule as unknown as Type<unknown>,
  ],
  declarations: [TerminalTab],
  exports: [TerminalTab],
  providers: [
    { provide: TabRegistry, useValue: TerminalTab.sharedRegistry },
    TabbyRuntimeManager,
    { provide: ProfileProvider, useClass: TabbyCompletionProfileProvider, multi: true },
    { provide: TabRecoveryProvider, useClass: TabbyCompletionRecoveryProvider, multi: true },
  ],
})
export class TabbyCompletionModule implements OnDestroy {
  private removeActiveTabStyle: () => void = () => {}

  constructor(private readonly runtimeManager: TabbyRuntimeManager, private readonly applicationRef: ApplicationRef | null = null) {
    if (typeof document !== "undefined") this.removeActiveTabStyle = installActiveTabStyle(document)
    if (typeof localStorage !== "undefined") migrateNotifierRecoveryTokens(localStorage)
    if (process.env.TABBY_NOTIFIER_HARNESS === "1") {
      let harnessCompleted = false
      ;(globalThis as typeof globalThis & { __tabbyNotifierHarnessComplete?: (outcome?: CompletionEventV1["outcome"]) => boolean }).__tabbyNotifierHarnessComplete = (outcome = "success") => {
        if (harnessCompleted) return false
        const completed = TerminalTab.sharedRegistry.completeForHarness(outcome)
        if (completed) harnessCompleted = true
        this.applicationRef?.tick()
        return completed
      }
    }
  }

  ngOnDestroy(): void {
    this.removeActiveTabStyle()
    void this.runtimeManager.shutdown()
  }
}

Inject(TabbyRuntimeManager)(TabbyCompletionModule, undefined, 0)
Inject(ApplicationRef)(TabbyCompletionModule, undefined, 1)
Optional()(TabbyCompletionModule, undefined, 1)

export default TabbyCompletionModule
export type { CompletionEventV1 }
export { IpcServer } from "./ipc-server.ts"
export { TabbyCompletionProfileProvider } from "./profile-provider.ts"
export { TabbyCompletionRecoveryProvider } from "./profile-provider.ts"
export { TabbyRuntimeManager } from "./runtime.ts"
export { TabRegistry } from "./tab-registry.ts"
export { TerminalTab } from "./terminal-tab.ts"
