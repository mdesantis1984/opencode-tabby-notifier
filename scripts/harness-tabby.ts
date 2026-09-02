import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import "@angular/compiler"
import { createHeadlessInjector } from "../tabby-plugin/test/setup.ts"
import { createFrame } from "../src/ipc/protocol.ts"
import { createTabbyCompletionPlugin, TabbyCompletionProfileProvider, TabbyCompletionRecoveryProvider } from "../tabby-plugin/src/index.ts"
import { TabRegistry } from "../tabby-plugin/src/tab-registry.ts"
import { TerminalTab } from "../tabby-plugin/src/terminal-tab.ts"
import { TabbyRuntimeManager } from "../tabby-plugin/src/runtime.ts"

const execFileAsync = promisify(execFile)

const event = (id: string) => ({ version: 1 as const, eventId: `${id}-done`, correlationId: id, outcome: "success" as const, projectLabel: "harness", completedAt: new Date().toISOString() })
const registry = new TabRegistry(), first = Object.assign(new TerminalTab(createHeadlessInjector() as never), { correlationId: "first", directory: "/same" }), second = Object.assign(new TerminalTab(createHeadlessInjector() as never), { correlationId: "second", directory: "/same" })
registry.register(first); registry.register(second)
const plugin = createTabbyCompletionPlugin({ registry, secret: "harness-secret" })
assert.equal(await plugin.consume(createFrame(event("second"), "harness-secret")), true)
assert.equal(await plugin.consume(createFrame(event("first"), "harness-secret")), true)
assert.equal(first.hasActivity && second.hasActivity, true)
second.focus(); assert.equal(second.hasActivity, false); assert.equal(first.hasActivity, true)
first.dispose(); second.dispose(); assert.equal(registry.size, 0); plugin.dispose()

const provider = new TabbyCompletionProfileProvider()
const parameters = await provider.getNewTabParameters({
  id: "harness-profile", type: "opencode-tabby-notifier", name: "Harness profile", options: {
    command: "/bin/sh", args: [], cwd: process.cwd(), env: {},
  },
} as never)
const profile = parameters.inputs.profile as { options: { command: string; cwd?: string; env?: Record<string, string> } }
const env = profile.options.env ?? {}
const { stdout } = await execFileAsync(profile.options.command, [
  "-c",
  "test -n \"$OPENCODE_NOTIFY_CORRELATION\" && test -n \"$OPENCODE_NOTIFY_IPC_SECRET\" && test -n \"$OPENCODE_NOTIFY_IPC_ENDPOINT\" && test \"$OPENCODE_NOTIFY_PROJECT_LABEL\" = \"Harness profile\"",
], { cwd: profile.options.cwd, env: { ...process.env, ...env } })
assert.equal(stdout, "")
await provider.shutdown()

const recoveryManager = new TabbyRuntimeManager(new TabRegistry())
const recovery = new TabbyCompletionRecoveryProvider(recoveryManager)
const recoveredSource = new TerminalTab(createHeadlessInjector() as never)
Object.assign(recoveredSource, parameters.inputs)
const recoveredToken = await recoveredSource.getRecoveryToken({ includeState: false })
assert.equal(await recovery.applicableTo(recoveredToken!), true)
const recovered = await recovery.recover(recoveredToken!)
assert.equal(recovered.type.name, "TerminalTab")
assert.equal(recovered.inputs.profile.options.restoreFromPTYID, null)
assert.equal(recovered.inputs.profile.options.env?.OPENCODE_NOTIFY_CORRELATION, recovered.inputs.correlationId)
recoveredSource.dispose()
await recoveryManager.shutdown()
console.log("tabby harness: completion activity, shell environment boundary, and recovery contract passed")
