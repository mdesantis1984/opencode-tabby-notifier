import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createFrame, type SessionState, type SessionStateEventV1 } from "../src/ipc/protocol.ts"

type CdpResponse = { id: number; result?: { result?: { value?: unknown } }; error?: unknown }

class CdpPage {
  private nextId = 0
  private readonly pending = new Map<number, (response: CdpResponse) => void>()
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const response = JSON.parse(String(event.data)) as CdpResponse
      this.pending.get(response.id)?.(response)
      this.pending.delete(response.id)
    })
  }
  command(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = ++this.nextId
    return new Promise((resolveResponse, reject) => {
      this.pending.set(id, resolveResponse)
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`CDP command timed out: ${method}`))
      }, 5_000).unref()
    })
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (response.error) throw new Error("CDP evaluation failed")
    return response.result?.result?.value as T
  }
  async pressKey(key: string, modifiers = 0): Promise<void> {
    await this.command("Input.dispatchKeyEvent", { type: "rawKeyDown", key, modifiers })
    await this.command("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers })
  }
  async click(selector: string, index: number): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number }>(`(() => { const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`)
    await this.command("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
    await this.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
  }
}

async function waitForPage(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
      const page = pages.find(candidate => candidate.type === "page")
      if (page) return page
    } catch { /* startup is expected to be asynchronous */ }
    await delay(100)
  }
  throw new Error("isolated Tabby did not expose a CDP page")
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read(); last = value
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error(`real DOM condition timed out: ${label}; last=${JSON.stringify(last)}`)
}

function isolatedConfig(workspace: string): string {
  return `version: 8
profiles:
  - id: opencode-tabby-notifier:shell
    name: Harness notifier
    type: opencode-tabby-notifier
    icon: fas fa-terminal
    color: '#123456'
    group: Harness
    options:
      command: /bin/sh
      args: ['-lc', 'sleep 30']
      cwd: ${workspace}
      env: {}
      shellType: unix
      pauseAfterExit: false
      runAsAdministrator: false
terminal:
  profile: opencode-tabby-notifier:shell
  showTabProfileIcon: true
appearance:
  tabsLocation: top
enableWelcomeTab: false
pluginBlacklist: []
`
}

function waitForExit(process: ChildProcess): Promise<boolean> {
  if (process.exitCode !== null) return Promise.resolve(true)
  return Promise.race([
    new Promise<boolean>(resolveExit => process.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ])
}

function signalOwnedProcessGroup(process: ChildProcess, signal: NodeJS.Signals): void {
  if (process.pid === undefined) return
  try {
    // The isolated child is detached, so its process group contains only harness-owned processes.
    globalThis.process.kill(-process.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function stop(process: ChildProcess, page: CdpPage | undefined): Promise<string> {
  if (process.exitCode !== null) return "already-exited"
  if (page) {
    const gracefulRequest = page.command("Browser.close").then(response => response.error ? "unsupported" : "requested").catch(() => "unsupported")
    const gracefulResult = await Promise.race([gracefulRequest, waitForExit(process).then(exited => exited ? "exited" : "timeout")])
    if (gracefulResult === "requested" || gracefulResult === "exited") {
      if (await waitForExit(process)) return "cdp Browser.close"
    }
  }
  if (process.exitCode !== null) return "already-exited"
  signalOwnedProcessGroup(process, "SIGTERM")
  if (await waitForExit(process)) return "SIGTERM fallback (owned process group)"
  signalOwnedProcessGroup(process, "SIGKILL")
  await waitForExit(process)
  return "SIGKILL fallback (owned process group)"
}

const workspace = resolve(dirname(new URL(import.meta.url).pathname), "..")
const pluginPath = join(workspace, "tabby-plugin")
const tempRoot = await mkdtemp(join(tmpdir(), "opencode-tabby-dom-"))
const port = 43000 + Math.floor(Math.random() * 1000)
const configDirectory = join(tempRoot, "config")
const userDataDirectory = join(tempRoot, "user-data")
const xdgDirectory = join(tempRoot, "xdg")
await Promise.all([
  writeFile(join(tempRoot, "config.yaml"), isolatedConfig(workspace)),
  writeFile(join(tempRoot, "isolation-marker"), "isolated"),
])
// --no-sandbox is required by this isolated harness because the local Tabby chrome-sandbox
// helper lacks the SUID permission; it is an environment-specific harness necessity, not product behavior.
const child = spawn("/opt/Tabby/tabby", ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`], {
  cwd: workspace,
  env: {
    ...process.env,
    TABBY_CONFIG_DIRECTORY: tempRoot,
    XDG_CONFIG_HOME: xdgDirectory,
    TABBY_PLUGINS: pluginPath,
    TABBY_NOTIFIER_HARNESS: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
})
let stderr = ""
child.stderr?.on("data", chunk => { stderr += String(chunk) })
let socket: WebSocket | undefined
let page: CdpPage | undefined
let cleanupPath = "not-started"
try {
  const pageInfo = await waitForPage(port)
  assert.match(pageInfo.webSocketDebuggerUrl, new RegExp(`127\\.0\\.0\\.1:${port}`))
  socket = new WebSocket(pageInfo.webSocketDebuggerUrl)
  const cdpSocket = socket
  await new Promise<void>((resolveOpen, rejectOpen) => { cdpSocket.onopen = () => resolveOpen(); cdpSocket.onerror = () => rejectOpen(new Error("CDP websocket failed")) })
  page = new CdpPage(cdpSocket)
  const cdpPage = page
  await waitFor(() => cdpPage.evaluate<string>("document.body.innerText"), text => typeof text === "string" && text.includes("Harness notifier"), "real notifier tab")
  const initial = await cdpPage.evaluate<{ headers: number; profileIcons: number; iconClasses: string[]; colors: Array<string | null>; activity: boolean[] }>(`({
    headers: document.querySelectorAll('tab-header').length,
    profileIcons: document.querySelectorAll('tab-header profile-icon').length,
    iconClasses: Array.from(document.querySelectorAll('tab-header profile-icon i')).map(node => node.className),
    colors: Array.from(document.querySelectorAll('tab-header profile-icon i')).map(node => getComputedStyle(node).color),
    activity: Array.from(document.querySelectorAll('tab-header')).map(node => Boolean(node.querySelector('.activity-indicator'))),
  })`)
  assert.equal(initial.headers, 1)
  assert.equal(initial.profileIcons, 1)
  assert.equal(initial.iconClasses.length, 1)
  assert.deepEqual(initial.iconClasses[0].split(/\s+/).sort(), ["fa-terminal", "fa-fw", "fas", "icon", "ng-star-inserted"].sort())
  assert.equal(initial.colors[0], "rgb(18, 52, 86)")
  assert.deepEqual(initial.activity, [false])
  await cdpPage.pressKey("t", 10)
  const siblings = await waitFor(() => cdpPage.evaluate<{ headers: number; icons: number }>(`({
    headers: document.querySelectorAll('tab-header').length,
    icons: document.querySelectorAll('tab-header profile-icon').length,
  })`), value => value.headers >= 2 && value.icons >= 2, "second real top-level tab")
  assert.equal(siblings.headers, 2)
  assert.equal(siblings.icons, 2)
  const siblingBaseline = await cdpPage.evaluate<Array<{ className: string; color: string; activity: boolean }>>(`(Array.from(document.querySelectorAll('tab-header')).map(header => {
    const icon = header.querySelector('profile-icon i')
    return { className: String(icon?.className ?? ''), color: getComputedStyle(icon).color, activity: Boolean(header.querySelector('.activity-indicator')) }
  }))`)
  assert.equal(siblingBaseline[1]?.color, "rgb(18, 52, 86)")
  assert.equal(siblingBaseline[1]?.className.split(/\s+/).includes("fa-terminal"), true)
  assert.equal(siblingBaseline[1]?.activity, false)
  const launches = await cdpPage.evaluate<{ correlationId: string; secret: string; endpoint: string }[]>("globalThis.__tabbyNotifierHarnessRuntimes ?? []")
  assert.ok(launches.length >= 2)
  const launch = launches[0]!
  const expected: Record<SessionState, { icon: string; color: string }> = {
    working: { icon: "fa-spinner", color: "rgb(51, 122, 183)" },
    "waiting-permission": { icon: "fa-hand-paper", color: "rgb(240, 173, 78)" },
    "waiting-question": { icon: "fa-question-circle", color: "rgb(240, 173, 78)" },
    retrying: { icon: "fa-redo", color: "rgb(142, 68, 173)" },
    error: { icon: "fa-exclamation-triangle", color: "rgb(217, 83, 79)" },
    completed: { icon: "fa-bell", color: "rgb(92, 184, 92)" },
  }
  const readFirst = () => cdpPage.evaluate<{ className: string; color: string; activity: boolean }>(`(() => { const header = document.querySelector('tab-header'); const icon = header?.querySelector('profile-icon i'); return { className: String(icon?.className ?? ''), color: getComputedStyle(icon).color, activity: Boolean(header?.querySelector('.activity-indicator')) } })()`)
  for (const state of ["working", "waiting-permission", "waiting-question", "retrying", "error", "completed"] as SessionState[]) {
    const event: SessionStateEventV1 = { version: 1, eventId: `dom-${state}`, correlationId: launch.correlationId, state, projectLabel: "dom", occurredAt: new Date().toISOString(), generation: 0 }
    const status = await cdpPage.evaluate<number>(`fetch(${JSON.stringify(launch.endpoint)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(createFrame(event, launch.secret))} }).then(response => response.status)`)
    assert.equal(status, 204)
    const view = await waitFor(readFirst, value => value.className.split(/\s+/).includes(expected[state].icon) && value.color === expected[state].color, `rendered ${state}`)
    assert.equal(view.color, expected[state].color)
    if (state === "waiting-permission" || state === "waiting-question" || state === "error") {
      await cdpPage.click("tab-header", 0)
      const persistent = await readFirst()
      assert.equal(persistent.className.split(/\s+/).includes(expected[state].icon), true)
      assert.equal(persistent.color, expected[state].color)
      await cdpPage.click("tab-header", 1)
    }
  }
  for (let cycle = 0; cycle < 20; cycle++) {
    const stable = await readFirst()
    assert.equal(stable.className.split(/\s+/).includes("fa-bell"), true)
    assert.equal(stable.color, "rgb(92, 184, 92)")
    assert.equal(stable.activity, false)
    await delay(25)
  }
  const persisted = await cdpPage.evaluate<Array<{ className: string; color: string; activity: boolean }>>(`(Array.from(document.querySelectorAll('tab-header')).map(header => {
    const icon = header.querySelector('profile-icon i')
    return { className: String(icon?.className ?? ''), color: getComputedStyle(icon).color, activity: Boolean(header.querySelector('.activity-indicator')) }
  }))`)
  assert.equal(persisted[0]?.color, "rgb(92, 184, 92)")
   assert.equal(persisted[0]?.activity, false)
  assert.equal(persisted[1]?.color, "rgb(18, 52, 86)")
  assert.equal(persisted[1]?.className.split(/\s+/).includes("fa-terminal"), true)
  assert.equal(persisted[1]?.activity, false)
   const pendingHeaderIndex = await cdpPage.evaluate<number>(`Array.from(document.querySelectorAll('tab-header')).findIndex(header => header.querySelector('profile-icon i')?.className.includes('fa-bell'))`)
  assert.equal(pendingHeaderIndex >= 0, true)
  await cdpPage.click("tab-header", pendingHeaderIndex === 0 ? 1 : 0)
  await delay(250)
  const afterSiblingFocus = await cdpPage.evaluate<{ color: string; activity: boolean }>(`(() => {
    const header = document.querySelectorAll('tab-header')[0]
    const icon = header.querySelector('profile-icon i')
    return { color: getComputedStyle(icon).color, activity: Boolean(header.querySelector('.activity-indicator')) }
  })()`)
  assert.equal(afterSiblingFocus.color, "rgb(92, 184, 92)")
   assert.equal(afterSiblingFocus.activity, false)
  await cdpPage.click("tab-header", pendingHeaderIndex)
  const restored = await waitFor(() => cdpPage.evaluate<{ className: string; color: string; activity: boolean }>(`(() => {
    const header = document.querySelectorAll('tab-header')[0]
    const icon = header.querySelector('profile-icon i')
    return { className: String(icon?.className ?? ''), color: getComputedStyle(icon).color, activity: Boolean(header.querySelector('.activity-indicator')) }
  })()`), value => value.className.split(/\s+/).includes("fa-terminal") && value.color === "rgb(18, 52, 86)" && !value.activity, "target focus baseline restoration")
  assert.deepEqual({ ...restored, className: restored.className.split(/\s+/).sort().join(" ") }, { className: siblingBaseline[0]?.className.split(/\s+/).sort().join(" "), color: "rgb(18, 52, 86)", activity: false })
} finally {
  cleanupPath = await stop(child, page)
  socket?.close()
  const marker = await readFile(join(tempRoot, "isolation-marker"), "utf8")
  assert.equal(marker, "isolated")
  await rm(tempRoot, { recursive: true, force: true })
   console.log(JSON.stringify({ architecture: "isolated-tabby-electron-cdp", assertions: ["top-level DOM baseline class/color", "authenticated IPC-rendered all six state classes/colors", "20-cycle persistence", "top-level sibling isolation", "completed target focus restores exact baseline"], states: ["working", "waiting-permission", "waiting-question", "retrying", "error", "completed"], cleanup: cleanupPath, stderr: stderr.includes("secret") ? "unexpected-sensitive-diagnostic" : "bounded" }))
}
