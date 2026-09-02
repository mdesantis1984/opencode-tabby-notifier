import assert from "node:assert/strict"
import { createServer } from "node:http"
import { sendTelegramNotification } from "../src/adapters/telegram.ts"
import type { CompletionEventV1 } from "../src/domain/completion.ts"

const event: CompletionEventV1 = {
  version: 1,
  eventId: "private-harness-event",
  correlationId: "private-tab-correlation",
  outcome: "failure",
  projectLabel: 'Profile <local> & "QA"',
  completedAt: "2026-01-02T03:04:05.000Z",
}

let requestCount = 0
let received: {
  method?: string
  url?: string
  contentType: string
  body: Buffer
} | undefined

const server = createServer((request, response) => {
  requestCount += 1
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
  request.on("end", () => {
    received = {
      method: request.method,
      url: request.url,
      contentType: String(request.headers["content-type"] ?? ""),
      body: Buffer.concat(chunks),
    }
    response.writeHead(200)
    response.end("ok")
  })
})

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")

  await sendTelegramNotification(event, {
    token: "never-real-token",
    chatId: "local-chat",
    endpoint: `http://127.0.0.1:${address.port}/sendMessage`,
    timeoutMs: 2_000,
  })

  assert.equal(requestCount, 1)
  assert.ok(received)
  assert.equal(received.method, "POST")
  assert.equal(received.url, "/sendMessage")
  assert.equal(received.contentType, "application/json")
  const rawBody = received.body.toString("utf8")
  for (const privateValue of ["never-real-token", event.eventId, event.correlationId]) {
    assert.ok(!rawBody.includes(privateValue))
  }

  const body = JSON.parse(rawBody) as Record<string, string>
  assert.deepEqual(Object.keys(body), ["chat_id", "text", "parse_mode"])
  assert.deepEqual(body, {
    chat_id: "local-chat",
    text: [
       "<b>⚠️ OPENCODE REQUIRES ATTENTION</b>",
       "<i>The OpenCode work run ended with an error.</i>",
      "",
       "<b>Origin:</b> <code>Profile &lt;local&gt; &amp; &quot;QA&quot;</code>",
       "<b>Completed:</b> <code>02 Jan 2026, 03:04 UTC</code>",
       "<b>Action:</b> Review the result before continuing.",
    ].join("\n"),
    parse_mode: "HTML",
  })

   console.log("Telegram harness passed: one local sendMessage JSON request carried only the private, escaped English HTML status")
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
