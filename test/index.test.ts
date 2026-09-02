import assert from "node:assert/strict"
import test from "node:test"
import { createSessionStateHandler, projectLabelFromDirectory, sendLinuxNotification } from "../src/index.ts"
import type { AttentionNotificationV1, SessionStateEventV1 } from "../src/domain/completion.ts"

const metadata = { type: "session.created", properties: { info: { id: "root" } } }
const event = (type: string, properties: Record<string, unknown> = {}) => ({ type, properties: { sessionID: "root", ...properties } })
function machine() {
  const states: SessionStateEventV1[] = []; const attention: AttentionNotificationV1[] = []
  const handle = createSessionStateHandler({ correlationId: "tab-a", publish: async item => { states.push(item) }, publishAttention: async item => { attention.push(item) } })
  return { handle, states, attention }
}

test("startup idle is a no-op", async () => { const m = machine(); await m.handle(metadata); await m.handle(event("session.idle")); assert.equal(m.states.length, 0); assert.equal(m.attention.length, 0) })

test("busy wait survives stale status and legacy idle without completion", async () => {
  const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("permission.asked", { id: "p1" })); await m.handle(event("session.status", { status: "idle" })); await m.handle(event("session.idle"))
  assert.deepEqual(m.states.map(item => item.state), ["working", "waiting-permission"]); assert.deepEqual(m.attention.map(item => item.kind), ["waiting-permission"])
})

test("unmatched replies do not clear waiting and matching replies do", async () => {
  const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("permission.asked", { id: "p1" })); await m.handle(event("permission.replied", { requestID: "other" })); assert.equal(m.states.at(-1)?.state, "waiting-permission"); await m.handle(event("permission.replied", { requestID: "p1" })); assert.equal(m.states.at(-1)?.state, "working")
})

test("multiple pending waits clear independently and retain remaining attention", async () => {
  const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("permission.asked", { id: "p1" })); await m.handle(event("question.asked", { id: "q1" })); await m.handle(event("permission.rejected", { requestID: "p1" })); assert.equal(m.states.at(-1)?.state, "waiting-question"); await m.handle(event("question.replied", { requestID: "q1" })); assert.equal(m.states.at(-1)?.state, "working")
})

test("error then idle emits only terminal error", async () => { const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.error")); await m.handle(event("session.idle")); assert.deepEqual(m.states.map(item => item.state), ["working", "error"]); assert.deepEqual(m.attention.map(item => item.kind), ["error"]) })

test("busy after error starts a new generation and can complete", async () => { const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.error")); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.idle")); assert.deepEqual(m.states.map(item => item.state), ["working", "error", "working", "completed"]); assert.equal(m.states.at(-1)?.generation, 1) })

test("retry then resumed busy then idle completes", async () => { const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.retry")); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.idle")); assert.deepEqual(m.states.map(item => item.state), ["working", "retrying", "working", "completed"]) })

test("canonical and legacy idle are deduplicated", async () => { const m = machine(); await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); await m.handle(event("session.status", { status: "idle" })); await m.handle(event("session.idle")); await m.handle(event("session.idle")); assert.equal(m.attention.filter(item => item.kind === "completed").length, 1) })

test("child and unknown metadata are suppressed, cached metadata remains usable", async () => {
  const m = machine(); await m.handle({ type: "session.created", properties: { info: { id: "child", parentID: "root" } } }); await m.handle(event("session.status", { sessionID: "child", status: "busy" })); assert.equal(m.states.length, 0)
  await m.handle(metadata); await m.handle(event("session.status", { status: "busy" })); assert.equal(m.states.length, 1)
  const unknown = createSessionStateHandler({ correlationId: "x", client: { session: { get: async () => { throw new Error("offline") } } }, publish: async () => { throw new Error("must not publish") } }); await unknown(event("session.status", { sessionID: "unknown", status: "busy" }))
})

test("async events serialize per session", async () => { const m = machine(); await m.handle(metadata); const first = m.handle(event("session.status", { status: "busy" })); const second = m.handle(event("session.idle")); await Promise.all([first, second]); assert.deepEqual(m.states.map(item => item.state), ["working", "completed"]) })

test("project labels are bounded and private paths are excluded", () => { const path = "/home/alice/private/" + "x".repeat(200); assert.equal(projectLabelFromDirectory(path).length, 80); assert.doesNotMatch(projectLabelFromDirectory(path), /alice|private/) })

test("notify-send uses fixed argv and shell false on Linux", async () => { const calls: unknown[] = []; const child = { once: (_name: string, callback: (code?: number) => void) => { if (_name === "close") queueMicrotask(() => callback(0)); return child } } as never; await sendLinuxNotification("Title", "Body", (command, args, options) => { calls.push(command, [...args], options); return child }, "linux"); assert.deepEqual(calls, ["notify-send", ["--app-name", "OpenCode", "--urgency", "normal", "Title", "Body"], { shell: false, stdio: "ignore" }]) })

test("legacy sendLinuxNotification is a no-op on non-Linux platforms", async () => { let spawned = false; await sendLinuxNotification("Title", "Body", () => { spawned = true; throw new Error("must not spawn") }, "win32"); assert.equal(spawned, false) })
