import Module from "node:module"
import { Subject } from "rxjs"

// The installed nightly Tabby bundle externalizes any-promise without declaring it.
// Keep the headless test harness dependency-neutral by supplying the native Promise.
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleLoader = Module as unknown as { _load: ModuleLoader }
const originalLoad = moduleLoader._load
moduleLoader._load = function (request, parent, isMain): unknown {
  if (request === "any-promise") return Promise
  return originalLoad.call(this, request, parent, isMain)
}

const windowObject = globalThis as typeof globalThis & { window?: typeof globalThis }
const domNode = () => ({ src: "", textContent: "", load() {}, setAttribute() {}, appendChild() {}, remove() {} })
windowObject.window = globalThis as unknown as Window & typeof globalThis
;(globalThis as unknown as { self?: typeof globalThis }).self = globalThis
windowObject.addEventListener ??= (() => {}) as typeof windowObject.addEventListener
windowObject.removeEventListener ??= (() => {}) as typeof windowObject.removeEventListener
windowObject.document ??= { createElement: domNode, createTextNode: (text: string) => ({ textContent: text }), querySelector: () => domNode(), head: domNode(), body: domNode(), documentElement: domNode() } as unknown as Document
export const createHeadlessInjector = () => {
  const s = <T>() => new Subject<T>()
  const values = new Map<string, unknown>([["ConfigService", { store: { terminal: { frontend: "xterm" } } }], ["ElementRef", { nativeElement: { querySelector: () => null } }], ["NgZone", { run: (fn: () => unknown) => fn(), runOutsideAngular: (fn: () => unknown) => fn() }], ["AppService", {}], ["HostAppService", {}], ["HotkeysService", { unfilteredHotkey$: s<string>(), hotkey$: s<string>() }], ["PlatformService", { themeChanged$: s<void>(), displayMetricsChanged$: s<void>() }], ["NotificationsService", {}], ["LogService", { create: () => ({}) }], ["TerminalDecorator", []], ["TabContextMenuItemProvider", []], ["HostWindowService", { windowMoved$: s<void>() }], ["TranslateService", { instant: (value: string) => value }], ["MultifocusService", { cancel() {} }], ["ThemesService", {}]])
  return { get: (token: { name?: string }) => values.get(token.name ?? "") }
}
