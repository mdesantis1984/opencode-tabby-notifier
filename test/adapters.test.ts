import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { sendOsNotification } from "../src/adapters/os.ts"
import { sendTelegramNotification, telegramPresentation } from "../src/adapters/telegram.ts"
import { sendIpcNotification } from "../src/adapters/ipc.ts"
import { fanOut } from "../src/fanout.ts"
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

test("Telegram adapter sends exactly one private HTML message through sendMessage", async () => {
  const requests: Request[] = []
  const notificationEvent = {
    ...event,
    eventId: "private-event-id",
    correlationId: "private-correlation-id",
    projectLabel: 'Profile <stable> & "team"',
    prompt: "private-prompt",
    cwd: "/private/full/cwd",
    secret: "private-secret",
  }

  await sendTelegramNotification(notificationEvent, {
    token: "runtime-token",
    chatId: "runtime-chat",
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response("ok", { status: 200 })
    },
  })

  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.url, "https://api.telegram.org/botruntime-token/sendMessage")
  assert.equal(request.method, "POST")
  assert.equal(request.headers.get("content-type"), "application/json")

  const expectedText = [
    "<b>✅ OPENCODE FINISHED</b>",
    "<i>The OpenCode work run completed successfully.</i>",
    "",
    "<b>Origin:</b> <code>Profile &lt;stable&gt; &amp; &quot;team&quot;</code>",
    "<b>Completed:</b> <code>01 Jan 2026, 00:00 UTC</code>",
    "<b>Action:</b> No action is required.",
  ].join("\n")
  const rawBody = await request.text()
  assert.equal(rawBody, JSON.stringify({
    chat_id: "runtime-chat",
    text: expectedText,
    parse_mode: "HTML",
  }))
  const body = JSON.parse(rawBody) as Record<string, string>
  assert.deepEqual(Object.keys(body), ["chat_id", "text", "parse_mode"])
  assert.ok(body.text.length < 1_024)

  for (const privateValue of [
    "runtime-token",
    "private-event-id",
    "private-correlation-id",
    "private-prompt",
    "/private/full/cwd",
    "private-secret",
  ]) {
    assert.ok(!rawBody.includes(privateValue))
  }
})

test("Telegram HTML normalizes hostile labels and preserves every outcome copy", async () => {
  const hostileEvent: CompletionEventV1 = {
    ...event,
    projectLabel: `Ｐｒｏｆｉｌｅ <script>alert("private")</script> & '\u0000${"x".repeat(200)}\ud800\ufffe`,
  }
  const presentation = telegramPresentation(hostileEvent)
  assert.equal([...presentation.origin].length, 72)
  assert.ok(presentation.origin.startsWith("Profile "))
  assert.ok(!presentation.origin.includes("Ｐ"))
  assert.ok(!presentation.origin.includes("\u0000"))
  assert.ok(!presentation.origin.includes("\ud800"))

  let hostileRequest: Request | undefined
  await sendTelegramNotification(hostileEvent, {
    token: "token",
    chatId: "chat",
    fetch: async (input, init) => {
      hostileRequest = new Request(input, init)
      return new Response(null, { status: 200 })
    },
  })
  const hostileBody = await hostileRequest!.json() as Record<string, string>
  assert.ok(!hostileBody.text.includes("<script>"))
  assert.ok(!hostileBody.text.includes("\u0000"))
  assert.ok(!hostileBody.text.includes("\ud800"))
  assert.match(hostileBody.text, /Profile &lt;script&gt;alert\(&quot;private&quot;\)&lt;\/script&gt; &amp; &#39;/)

  const cases = [
    ["success", "✅ OPENCODE FINISHED", "The OpenCode work run completed successfully.", "No action is required."],
    ["failure", "⚠️ OPENCODE REQUIRES ATTENTION", "The OpenCode work run ended with an error.", "Review the result before continuing."],
    ["cancelled", "⛔ OPENCODE WAS CANCELLED", "The OpenCode work run was cancelled.", "Start another run only if you still need it."],
  ] as const
  for (const [outcome, title, description, action] of cases) {
    let request: Request | undefined
    await sendTelegramNotification({ ...event, outcome }, {
      token: "token",
      chatId: "chat",
      fetch: async (input, init) => {
        request = new Request(input, init)
        return new Response(null, { status: 200 })
      },
    })
    assert.deepEqual(await request!.json(), {
      chat_id: "chat",
      text: [
        `<b>${title}</b>`,
        `<i>${description}</i>`,
        "",
        "<b>Origin:</b> <code>demo</code>",
        "<b>Completed:</b> <code>01 Jan 2026, 00:00 UTC</code>",
        `<b>Action:</b> ${action}`,
      ].join("\n"),
      parse_mode: "HTML",
    })
  }
})

test("Telegram adapter aborts its only attempt on timeout and never retries failures", async () => {
  let timeoutAttempts = 0
  await assert.rejects(
    sendTelegramNotification(event, {
      token: "token",
      chatId: "chat",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        timeoutAttempts += 1
        const signal = init?.signal
        assert.ok(signal)
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => reject(signal.reason)
          if (signal.aborted) rejectAbort()
          else signal.addEventListener("abort", rejectAbort, { once: true })
        })
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  )
  assert.equal(timeoutAttempts, 1)

  let failedAttempts = 0
  await assert.rejects(
    sendTelegramNotification(event, {
      token: "token",
      chatId: "chat",
      fetch: async () => {
        failedAttempts += 1
        return new Response(null, { status: 500 })
      },
    }),
    /telegram request failed/,
  )
  assert.equal(failedAttempts, 1)
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

test("waiting attention is transport-neutral and contains no request data", async () => {
  let request: Request | undefined
  await sendTelegramNotification({ version: 1, eventId: "attention-1", correlationId: "tab-1", kind: "waiting-question", projectLabel: "demo", occurredAt: "2026-01-01T00:00:00.000Z", generation: 0 }, { token: "token", chatId: "chat", fetch: async (input, init) => { request = new Request(input, init); return new Response(null, { status: 200 }) } })
  const text = String((await request!.json()).text); assert.match(text, /NEEDS INPUT|needs your input/i); assert.ok(!text.includes("attention-1"))
})
