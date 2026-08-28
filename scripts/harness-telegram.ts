import assert from "node:assert/strict"
import { createServer } from "node:http"
import { sendTelegramNotification } from "../src/adapters/telegram.ts"
import type { CompletionEventV1 } from "../src/domain/completion.ts"

const event: CompletionEventV1 = { version: 1, eventId: "harness", correlationId: "tab", outcome: "failure", projectLabel: "local", completedAt: new Date().toISOString() }
let received = ""
const server = createServer((request, response) => {
  request.setEncoding("utf8")
  request.on("data", (chunk) => { received += chunk })
  request.on("end", () => { response.writeHead(200); response.end("ok") })
})
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await sendTelegramNotification(event, { token: "never-real", chatId: "local-chat", endpoint: `http://127.0.0.1:${address.port}/send`, timeoutMs: 500 })
  const body = JSON.parse(received) as Record<string, string>
  assert.equal(body.chat_id, "local-chat")
  assert.ok(!received.includes("never-real"))
  assert.match(body.text, /^OpenCode finished: local \(failure\) at /)
  console.log("Telegram harness passed: local endpoint received safe status payload")
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
