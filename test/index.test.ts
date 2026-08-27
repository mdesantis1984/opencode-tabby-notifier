import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import {
  createIdleHandler,
  IdleDebouncer,
  sendLinuxNotification,
} from "../src/index.ts"

const idle = { type: "session.idle", properties: { sessionID: "root" } }

test("notifies for a primary session", async () => {
  const notifications: string[][] = []
  const handle = createIdleHandler({
    client: { session: { get: async () => ({ data: { id: "root" } }) } },
    notify: async (...args) => { notifications.push(args) },
  })

  await handle(idle)
  assert.deepEqual(notifications, [["OpenCode work run finished", "Work run finished"]])
})

test("suppresses child sessions", async () => {
  let count = 0
  const handle = createIdleHandler({
    client: { session: { get: async () => ({ data: { id: "child", parentID: "root" } }) } },
    notify: async () => { count++ },
  })

  await handle({ type: "session.idle", properties: { sessionID: "child" } })
  assert.equal(count, 0)
})

test("suppresses duplicate idle events within the debounce window", async () => {
  let count = 0
  const handle = createIdleHandler({
    notify: async () => { count++ },
    debouncer: new IdleDebouncer(2_000),
  })

  await handle(idle)
  await handle(idle)
  assert.equal(count, 1)
})

test("fails open when session metadata lookup fails", async () => {
  let count = 0
  const handle = createIdleHandler({
    client: { session: { get: async () => { throw new Error("server unavailable") } } },
    notify: async () => { count++ },
  })

  await handle(idle)
  assert.equal(count, 1)
})

test("does not reject when the notifier fails", async () => {
  const handle = createIdleHandler({ notify: async () => { throw new Error("no display") } })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    await assert.doesNotReject(() => handle(idle))
  } finally {
    console.warn = originalWarn
  }
})

test("passes notify-send arguments as separate argv tokens without a shell", async () => {
  const child = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] }
  const calls: unknown[] = []
  const spawnProcess = (command: string, args: readonly string[], options: object) => {
    calls.push(command, [...args], options)
    queueMicrotask(() => child.emit("close", 0))
    return child as never
  }

  await sendLinuxNotification("Title with spaces", "Body; still one argument", spawnProcess)
  assert.deepEqual(calls[0], "notify-send")
  assert.deepEqual(calls[1], [
    "--app-name", "OpenCode", "--urgency", "normal",
    "Title with spaces", "Body; still one argument",
  ])
  assert.deepEqual(calls[2], { shell: false, stdio: "ignore" })
})
