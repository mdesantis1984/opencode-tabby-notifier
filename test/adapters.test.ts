import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { sendOsNotification } from "../src/adapters/os.ts"
import { sendTelegramNotification } from "../src/adapters/telegram.ts"
import { sendIpcNotification } from "../src/adapters/ipc.ts"
import { fanOut } from "../src/fanout.ts"
import { createCompletionHandler } from "../src/index.ts"
import type { CompletionEventV1 } from "../src/domain/completion.ts"

const event: CompletionEventV1 = { version: 1, eventId: "e1", correlationId: "tab-1", outcome: "success", projectLabel: "demo", completedAt: "2026-01-01T00:00:00.000Z" }

test("OS adapter uses fixed argv and safe fields", async () => {
  const child = new EventEmitter()
  const calls: unknown[] = []
  await sendOsNotification(event, (command, args, options) => {
    calls.push(command, [...args], options)
    queueMicrotask(() => child.emit("close", 0))
    return child as never
  })
  assert.deepEqual(calls, ["notify-send", ["--app-name", "OpenCode", "OpenCode", "OpenCode finished: demo (success)"] , { shell: false, stdio: "ignore" }])
})

test("Telegram adapter sends only minimal JSON and times out", async () => {
  let request: Request | undefined
  await sendTelegramNotification(event, { token: "runtime-token", chatId: "runtime-chat", fetch: async (input, init) => {
    request = new Request(input, init)
    return new Response("ok", { status: 200 })
  } })
  const body = await request!.json() as Record<string, string>
  assert.equal(body.chat_id, "runtime-chat")
  assert.match(body.text, /^OpenCode finished: demo \(success\) at /)
  assert.equal(Object.keys(body).length, 2)
  assert.ok(!body.text.includes("tab-1"))
})

test("IPC adapter authenticates the frame and bounds the request", async () => {
  let body = ""
  await sendIpcNotification(event, { endpoint: "http://127.0.0.1:1/notify", secret: "s".repeat(64), fetch: async (_input, init) => {
    body = String(init?.body)
    return new Response(null, { status: 204 })
  } })
  assert.deepEqual(Object.keys(JSON.parse(body)), ["payload", "mac"])
})

test("fanout isolates channel failures and disposes timers", async () => {
  const calls: string[] = []
  const queue = fanOut({
    os: async () => { calls.push("os"); throw new Error("unavailable") },
    telegram: async () => { calls.push("telegram") },
    ipc: async () => { calls.push("ipc") },
  })
  const results = await queue.publish(event)
  queue.dispose()
  assert.deepEqual(calls.sort(), ["ipc", "os", "telegram"])
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
})

test("completion handler emits once for canonical status and legacy idle", async () => {
  const events: CompletionEventV1[] = []
  const handle = createCompletionHandler({ correlationId: "tab-1", publish: async (item) => { events.push(item) } })
  await handle({ type: "session.status", properties: { sessionID: "root", status: "busy" } })
  await handle({ type: "session.status", properties: { sessionID: "root", status: "idle" } })
  await handle({ type: "session.idle", properties: { sessionID: "root" } })
  assert.equal(events.length, 1)
  assert.equal(events[0].correlationId, "tab-1")
})
