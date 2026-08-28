import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, createServer, type Server } from "node:net"
import { createFrame, verifyFrame, type CompletionEventV1 } from "../src/ipc/protocol.ts"

const secret = "h".repeat(64)
const payload: CompletionEventV1 = {
  version: 1,
  eventId: "harness-event-1",
  correlationId: "tab-harness-1",
  outcome: "success",
  projectLabel: "harness",
  completedAt: new Date().toISOString(),
}

type ServerState = { accepted: CompletionEventV1[]; rejected: number }

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
}

function send(socketPath: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath)
    let response = ""
    client.setEncoding("utf8")
    client.on("data", (chunk: string) => { response += chunk })
    client.once("error", reject)
    client.once("close", () => resolve(response.trim()))
    client.once("connect", () => client.end(`${frame}\n`))
  })
}

async function main(): Promise<void> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "tabby-ipc-harness-"))
  const socketPath = join(runtimeDir, "completion.sock")
  const state: ServerState = { accepted: [], rejected: 0 }
  const seen = new Set<string>()
  const server = createServer((socket) => {
    let input = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      input += chunk
      const newline = input.indexOf("\n")
      if (newline < 0) return
      const frame = input.slice(0, newline)
      try {
        state.accepted.push(verifyFrame(frame, secret, { seen }))
        socket.end("accepted\n")
      } catch {
        state.rejected += 1
        socket.end("rejected\n")
      }
    })
  })

  try {
    await listen(server, socketPath)
    assert.equal(await send(socketPath, createFrame(payload, secret)), "accepted")
    assert.equal(await send(socketPath, "{}"), "rejected")
    assert.equal(await send(socketPath, createFrame(payload, "w".repeat(64))), "rejected")
    assert.equal(await send(socketPath, createFrame(payload, secret)), "rejected")
    assert.equal(state.accepted.length, 1)
    assert.equal(state.accepted[0]?.eventId, payload.eventId)
    assert.equal(state.rejected, 3)
    console.log("IPC harness passed: 1 authenticated frame accepted; invalid, unauthenticated, and replayed frames rejected")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(runtimeDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
