import assert from "node:assert/strict"
import { createServer, type Server, type ServerResponse } from "node:http"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { IpcServer } from "../tabby-plugin/src/ipc-server.ts"

const workspace = resolve(dirname(new URL(import.meta.url).pathname), "..")
const opencode = process.env.OPENCODE_BIN ?? "opencode"
const secret = "harness-opencode-secret"
const correlationId = "harness-opencode-primary"
const modelId = "deterministic-model"
const timeoutMs = 20_000
const createdAt = 1_756_841_600
const scenarioMarkers = ["PERMISSION_MARKER", "QUESTION_MARKER", "RETRY_MARKER", "ERROR_MARKER", "ABORT_MARKER"] as const
type Scenario = "success" | "permission" | "question" | "retry" | "error" | "abort"

type Event = { type?: string; properties?: Record<string, unknown>; [key: string]: unknown }
type Child = { id: string; parentID?: string; parentId?: string }
type NumericVersion = readonly [major: number, minor: number, patch: number]

function parseNumericVersion(value: string, label: string): NumericVersion {
  const match = value.trim().match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/)
  assert.ok(match, `${label} must contain a numeric semantic version: ${value.trim()}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: NumericVersion, right: NumericVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function formatVersion(version: NumericVersion): string {
  return version.join(".")
}

function scenarioFromBody(body: string): Scenario {
  if (body.includes("PERMISSION_MARKER")) return "permission"
  if (body.includes("QUESTION_MARKER")) return "question"
  if (body.includes("RETRY_MARKER")) return "retry"
  if (body.includes("ERROR_MARKER")) return "error"
  if (body.includes("ABORT_MARKER")) return "abort"
  return "success"
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function mockProvider(): { server: Server; port: Promise<number>; requests: Array<{ path: string; scenario: Scenario; status: number }> } {
  const requests: Array<{ path: string; scenario: Scenario; status: number }> = []
  const attempts = new Map<Scenario, number>()
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      json(response, 200, { object: "list", data: [{ id: modelId, object: "model", owned_by: "harness" }] })
      return
    }
    if (request.method !== "POST") {
      json(response, 404, { error: "not found" })
      return
    }
    const body = await new Promise<string>((resolveBody, rejectBody) => {
      const chunks: Buffer[] = []
      request.on("data", chunk => chunks.push(Buffer.from(chunk)))
      request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")))
      request.on("error", rejectBody)
    })
    const scenario = scenarioFromBody(body)
    const followUp = body.includes('"type":"function_call_output"') || body.includes('"type": "function_call_output"') || body.includes('"role":"tool"') || body.includes('"role": "tool"')
    const attempt = (attempts.get(scenario) ?? 0) + 1
    attempts.set(scenario, attempt)
    const requestRecord = { path: request.url ?? "", scenario, status: 200 }
    requests.push(requestRecord)
    if (scenario === "retry" && attempt === 1) {
      requestRecord.status = 500
      response.writeHead(500, { "content-type": "application/json", "retry-after-ms": "25" }).end(JSON.stringify({ error: { message: "deterministic transient failure", type: "server_error" } }))
      return
    }
    if (scenario === "error") {
      requestRecord.status = 400
      json(response, 400, { error: { message: "deterministic invalid prompt", type: "invalid_request_error", code: "invalid_prompt" } })
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    if (request.url === "/v1/responses") {
      const responseId = "resp_harness"
      if (scenario === "abort") {
        response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: responseId, created_at: createdAt, model: modelId } })}\n\n`)
        return
      }
      if ((scenario === "permission" || scenario === "question") && !followUp) {
        const callName = scenario === "question" ? "question" : "bash"
        const callArguments = scenario === "question"
          ? JSON.stringify({ questions: [{ question: "Choose the deterministic option.", header: "Harness", options: [{ label: "Continue", description: "Continue the isolated harness" }] }] })
          : JSON.stringify({ command: "true" })
        const item = { type: "function_call", id: `fc_${scenario}`, call_id: `call_${scenario}`, name: callName, arguments: callArguments, status: "completed" }
        const functionPayload = { id: responseId, object: "response", status: "completed", model: modelId, output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }
        const chunks = [
          { type: "response.created", response: { id: responseId, created_at: createdAt, model: modelId } },
          { type: "response.output_item.added", item: { ...item, arguments: "" }, output_index: 0 },
          { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: callArguments },
          { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: callArguments },
          { type: "response.output_item.done", item, output_index: 0 },
          { type: "response.completed", response: functionPayload },
        ]
        for (const chunk of chunks) response.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`)
        response.end()
        return
      }
      const payload = { id: responseId, object: "response", status: "completed", model: modelId, output: [{ type: "message", id: "msg_harness", role: "assistant", content: [{ type: "output_text", text: "deterministic response", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }
      const chunks = [
        { type: "response.created", response: { id: responseId, created_at: createdAt, model: modelId } },
        { type: "response.output_item.added", item: { type: "message", id: "msg_harness", role: "assistant", content: [] }, output_index: 0 },
        { type: "response.content_part.added", item_id: "msg_harness", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", item_id: "msg_harness", output_index: 0, content_index: 0, delta: "deterministic response", logprobs: [], sequence_number: 1 },
        { type: "response.output_text.done", item_id: "msg_harness", output_index: 0, content_index: 0, text: "deterministic response", logprobs: [] },
        { type: "response.content_part.done", item_id: "msg_harness", output_index: 0, content_index: 0, part: { type: "output_text", text: "deterministic response", annotations: [] } },
        { type: "response.output_item.done", item: payload.output[0], output_index: 0 },
        { type: "response.completed", response: payload },
      ]
      for (const chunk of chunks) response.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`)
      response.end()
      return
    }
    if ((scenario === "permission" || scenario === "question") && !followUp) {
      const name = scenario === "question" ? "question" : "bash"
      const args = scenario === "question"
        ? JSON.stringify({ questions: [{ question: "Choose the deterministic option.", header: "Harness", options: [{ label: "Continue", description: "Continue the isolated harness" }] }] })
        : JSON.stringify({ command: "true" })
      const chunks = [
        { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${scenario}`, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] },
        { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] },
        { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      ]
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end("data: [DONE]\n\n")
      return
    }
    if (scenario === "abort") {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "deterministic" }, finish_reason: null }] })}\n\n`)
      return
    }
    const chunks = [
      { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "deterministic" }, finish_reason: null }] },
      { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: " response" }, finish_reason: null }] },
      { id: "chatcmpl-harness", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  const port = new Promise<number>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port))
  })
  return { server, port, requests }
}

function waitForExit(process: ChildProcess): Promise<boolean> {
  if (process.exitCode !== null) return Promise.resolve(true)
  return Promise.race([
    new Promise<boolean>(resolveExit => process.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ])
}

async function stopOwned(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return
  process.kill("SIGTERM")
  if (await waitForExit(process)) return
  process.kill("SIGKILL")
  await waitForExit(process)
}

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body) as T
}

async function readSse(response: Response, events: Event[]): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const records = buffer.split("\n\n")
    buffer = records.pop() ?? ""
    for (const record of records) {
      const data = record.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim()
      if (data && data !== "[DONE]") events.push(JSON.parse(data) as Event)
    }
  }
}

async function waitFor(events: Event[], predicate: (event: Event) => boolean, label: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (events.some(predicate)) return
    await delay(50)
  }
   throw new Error(`OpenCode SSE condition timed out: ${label}; events=${events.length}; observed=${JSON.stringify(events.map(event => ({ type: event.type, sessionID: event.properties?.sessionID, status: event.properties?.status })))}`)
}

async function waitForPending(base: string, path: string, sessionID: string, label: string): Promise<Event> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const pending = await request<Event[]>(base, `${path}?directory=${encodeURIComponent(workspace)}`)
    const match = pending.find(event => (event.properties?.sessionID ?? event.sessionID) === sessionID)
    if (match) return match
    await delay(50)
  }
  throw new Error(`OpenCode pending ${label} condition timed out`)
}

async function waitForProvider(requests: Array<unknown>, label: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (requests.length > 0) return
    await delay(25)
  }
  throw new Error(`Provider condition timed out: ${label}`)
}

async function main(scenario: Scenario): Promise<void> {
  const versionProbe = spawnSync(opencode, ["--version"], { encoding: "utf8" })
  const runtimeVersion = parseNumericVersion(versionProbe.stdout, "OpenCode executable version")
  const minimumVersion: NumericVersion = [1, 18, 26]
  const maximumExclusive: NumericVersion = [2, 0, 0]
  console.log(`OpenCode executable version: ${formatVersion(runtimeVersion)}`)
  assert.equal(versionProbe.status, 0, `OpenCode version probe failed: ${versionProbe.stderr.trim()}`)
  const expectedVersion = process.env.OPENCODE_EXPECTED_VERSION
  if (expectedVersion) {
    const expected = parseNumericVersion(expectedVersion, "OPENCODE_EXPECTED_VERSION")
    assert.equal(compareVersions(runtimeVersion, expected), 0, `expected OpenCode ${formatVersion(expected)}, found ${formatVersion(runtimeVersion)}`)
  } else {
    assert.ok(compareVersions(runtimeVersion, minimumVersion) >= 0, `OpenCode ${formatVersion(runtimeVersion)} is older than supported 1.18.26`)
    assert.ok(compareVersions(runtimeVersion, maximumExclusive) < 0, `OpenCode ${formatVersion(runtimeVersion)} is outside supported major version 1`)
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "opencode-tabby-server-"))
  const provider = mockProvider()
  let opencodeProcess: ChildProcess | undefined
  let receiver: IpcServer | undefined
  let sseAbort: AbortController | undefined
  try {
    const providerPort = await provider.port
    const endpoint = `http://127.0.0.1:${providerPort}`
    const deliveredEvents: Array<{ correlationId: string; eventId: string; state?: string }> = []
    receiver = new IpcServer(secret, event => {
      deliveredEvents.push({ correlationId: event.correlationId, eventId: event.eventId, state: "state" in event ? event.state : undefined })
      deliveries += 1
      return true
    })
    const receiverPort = await receiver.start()
    const configRoot = join(tempRoot, "config", "opencode")
    await writeFile(join(tempRoot, "config.json"), JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      share: "disabled",
       plugin: [`file://${join(tempRoot, "production-wrapper.ts")}`, `file://${join(tempRoot, "probe.ts")}`, `file://${join(tempRoot, "tool-plugin.ts")}`],
      model: `openai/${modelId}`,
       provider: { openai: {
        name: "Offline harness provider",
        options: { baseURL: `${endpoint}/v1`, apiKey: "offline" },
          models: { [modelId]: { name: "Deterministic offline model", npm: "@ai-sdk/openai@3.0.84", limit: { context: 8192, output: 256 } } },
       } },
    }, null, 2))
    await writeFile(join(tempRoot, "probe.ts"), 'import { appendFileSync } from "node:fs"; export default async ({ client }: { client: { session: { get: (input: unknown) => Promise<unknown> } } }) => ({ event: async ({ event }: { event: any }) => { if (event.type !== "session.idle") return; try { const result = await client.session.get({ path: { id: event.properties.sessionID } }); appendFileSync(process.env.HARNESS_EVENT_LOG!, JSON.stringify({ type: event.type, lookup: "ok", configured: Boolean(process.env.OPENCODE_NOTIFY_IPC_ENDPOINT && process.env.OPENCODE_NOTIFY_IPC_SECRET), result }) + "\\n") } catch { appendFileSync(process.env.HARNESS_EVENT_LOG!, JSON.stringify({ type: event.type, lookup: "failed", configured: Boolean(process.env.OPENCODE_NOTIFY_IPC_ENDPOINT && process.env.OPENCODE_NOTIFY_IPC_SECRET) }) + "\\n") } } })\n', "utf8")
    await writeFile(join(tempRoot, "tool-plugin.ts"), 'import { tool } from "@opencode-ai/plugin"; import { z } from "zod"; export default async () => ({ tool: { harness_permission: tool({ description: "Deterministic permission harness tool", args: { value: z.string() }, execute: async () => ({ output: "ok" }) }) } })\n', "utf8")
    await writeFile(join(tempRoot, "production-wrapper.ts"), `import production from "file://${join(workspace, "src/index.ts")}"; export default production\n`, "utf8")
    await writeFile(join(tempRoot, "event-log.jsonl"), "", "utf8")
    const binRoot = join(tempRoot, "bin")
    await mkdir(binRoot, { recursive: true })
     const notifyLogPath = join(tempRoot, "notify.log")
     await writeFile(notifyLogPath, "", "utf8")
     await writeFile(join(binRoot, "notify-send"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HARNESS_NOTIFY_LOG\"\nexit 0\n", "utf8")
    await chmod(join(binRoot, "notify-send"), 0o755)
    await writeFile(join(tempRoot, "isolation-marker"), "isolated")
    await mkdir(configRoot, { recursive: true })
    await mkdir(join(tempRoot, "data"), { recursive: true })
    await mkdir(join(tempRoot, "cache"), { recursive: true })
    await mkdir(join(tempRoot, "state"), { recursive: true })
    await import("node:fs/promises").then(fs => fs.copyFile(join(tempRoot, "config.json"), join(configRoot, "opencode.json")))
    const port = 43000 + Math.floor(Math.random() * 1000)
    opencodeProcess = spawn(opencode, ["serve", "--print-logs", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(tempRoot, "config"),
        XDG_DATA_HOME: join(tempRoot, "data"),
        XDG_CACHE_HOME: join(tempRoot, "cache"),
        XDG_STATE_HOME: join(tempRoot, "state"),
        OPENCODE_NOTIFY_CORRELATION: correlationId,
        OPENCODE_NOTIFY_IPC_SECRET: secret,
        OPENCODE_NOTIFY_IPC_ENDPOINT: `http://127.0.0.1:${receiverPort}`,
        OPENCODE_NOTIFY_PROJECT_LABEL: "isolated-server-harness",
        OPENCODE_NOTIFY_PERSISTED: "0",
         HARNESS_EVENT_LOG: join(tempRoot, "event-log.jsonl"),
         HARNESS_NOTIFY_LOG: notifyLogPath,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    opencodeProcess.stderr?.on("data", chunk => { stderr += String(chunk) })
    const base = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(`${base}/doc`, { signal: AbortSignal.timeout(500) }); break } catch { await delay(100) }
    }
    let loadedConfig: Record<string, unknown>
    try { loadedConfig = await request<Record<string, unknown>>(base, "/config") }
    catch (error) { throw new Error(`${String(error)}; runtime=${runtimeVersion}; stderr=${stderr.replaceAll(secret, "<secret>").replaceAll(/\S+[/\\]\S+/g, "<path>").slice(-1500)}`) }
    assert.ok(JSON.stringify(loadedConfig.plugin).includes("production-wrapper.ts"), "the production notifier plugin wrapper is loaded by isolated server config")
    const doc = await request<{ paths: Record<string, unknown> }>(base, "/doc")
    assert.ok(doc.paths["/session"] && doc.paths["/session/{sessionID}/message"] && doc.paths["/event"], "official /doc routes are present")
    assert.ok(doc.paths["/permission/{requestID}/reply"] && doc.paths["/question/{requestID}/reply"] && doc.paths["/question/{requestID}/reject"] && doc.paths["/session/{sessionID}/abort"], "official acknowledgement and abort routes are present")
    sseAbort = new AbortController()
    const events: Event[] = []
    const sseResponse = await fetch(`${base}/event?directory=${encodeURIComponent(workspace)}`, { signal: sseAbort.signal, headers: { accept: "text/event-stream" } })
    assert.equal(sseResponse.status, 200)
    const sseTask = readSse(sseResponse, events).catch(error => {
      if (!sseAbort?.signal.aborted) throw error
    })
    const eventLogPath = join(tempRoot, "event-log.jsonl")
    const makeSession = (title: string) => request<{ id: string }>(base, `/session?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, model: { providerID: "openai", id: modelId }, permission: [{ permission: "bash", action: "ask", pattern: "*" }] }) })
    const send = async (sessionID: string, text: string) => { await delay(250); return request(base, `/session/${sessionID}/message?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "openai", modelID: modelId }, parts: [{ type: "text", text }] }) }) }
    const sessionID = (event: Event) => event.properties?.sessionID ?? event.properties?.sessionId ?? event.sessionID
    const primary = await makeSession(`${scenario} harness session`)
    const marker = scenario === "success" ? "Return the deterministic offline response." : `${scenario.toUpperCase()}_MARKER`
    const before = events.length
    const message = send(primary.id, marker).catch(error => ({ error: String(error) }))
    let pendingRequest: Event | undefined
    if (scenario === "permission" || scenario === "question") {
      try { pendingRequest = await waitForPending(base, scenario === "permission" ? "/permission" : "/question", primary.id, scenario) }
      catch (error) { throw new Error(`${String(error)}; providerRequests=${JSON.stringify(provider.requests)}; stderr=${stderr.replaceAll(secret, "<secret>").replaceAll(/\S+[/\\]\S+/g, "<path>").slice(-1000)}`) }
    }
     const expectedType = scenario === "permission" ? "permission.asked" : scenario === "question" ? "question.asked" : "session.status"
    if (scenario === "abort") await waitForProvider(provider.requests, "abort request")
     await waitFor(events, event => events.length > before && (event.type === expectedType || (scenario === "error" && event.type === "session.error")) && sessionID(event) === primary.id && (scenario !== "retry" || event.properties?.status === "retry" || (event.properties?.status as { type?: string } | undefined)?.type === "retry") && (scenario !== "error" || event.type === "session.error" || ["error", "failed"].includes(String(event.properties?.status))), `${scenario} ${expectedType}; providerRequests=${provider.requests.map(item => item.scenario).join(",")}; stderr=${stderr.replaceAll(secret, "<secret>").replaceAll(/\S+[/\\]\S+/g, "<path>").slice(-500)}`)
     const observed = events.slice(before).find(event => (event.type === expectedType || (scenario === "error" && event.type === "session.error")) && sessionID(event) === primary.id)!
    if (scenario === "abort") await request(base, `/session/${primary.id}/abort?directory=${encodeURIComponent(workspace)}`, { method: "POST" })
    if (scenario === "permission") {
        const permission = pendingRequest
        assert.ok(permission)
        const permissionID = (permission.properties?.id ?? permission.id) as string
        assert.ok(permissionID)
        assert.equal(observed.properties?.id, permissionID)
        await request(base, `/permission/${permissionID}/reply?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply: "once" }) })
        await waitFor(events, event => event.type === "permission.replied" && (event.properties?.permissionID === permissionID || event.properties?.requestID === permissionID || event.properties?.id === permissionID), "permission.replied")
    } else if (scenario === "question") {
        const question = pendingRequest
        assert.ok(question)
        const questionID = (question.properties?.id ?? question.id) as string
        assert.ok(questionID)
        assert.equal(observed.properties?.id, questionID)
        await request(base, `/question/${questionID}/reply?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [["Continue"]] }) })
        await waitFor(events, event => event.type === "question.replied" && event.properties?.requestID === questionID, "question.replied")
    }
    if (scenario === "abort") {
      await request(base, `/session/${primary.id}/abort?directory=${encodeURIComponent(workspace)}`, { method: "POST" })
    }
    const result = await message
    if (scenario === "error") assert.ok(result)
    else if (scenario !== "abort") assert.ok(!(result as { error?: string }).error, `${scenario} message failed: ${JSON.stringify(result)}`)
    await waitFor(events, event => event.type === "session.idle" && sessionID(event) === primary.id, `${scenario} session.idle`)
     await delay(500)
     const externalAttention = (await readFile(notifyLogPath, "utf8")).trim().split("\n").filter(Boolean)
     const expectedAttention = scenario === "permission" || scenario === "question" ? 2 : 1
     assert.equal(externalAttention.length, expectedAttention, `${scenario} attention routing count: ${JSON.stringify({ externalAttention, deliveredEvents })}`)
     assert.equal(externalAttention.some(line => /working|retrying/i.test(line)), false, `${scenario} must not externally notify working/retrying`)
     if (scenario === "error" || scenario === "abort") assert.equal(externalAttention.some(line => /finished/i.test(line)), false, `${scenario} must not emit false success`)
    const primarySseEvents = events.filter(event => sessionID(event) === primary.id)
    const eventIndex = (type: string) => primarySseEvents.findIndex(event => event.type === type)
    const idleIndex = eventIndex("session.idle")
    if (scenario === "permission" || scenario === "question") {
      assert.ok(eventIndex(scenario === "permission" ? "permission.asked" : "question.asked") < eventIndex(scenario === "permission" ? "permission.replied" : "question.replied"))
      assert.ok(eventIndex(scenario === "permission" ? "permission.replied" : "question.replied") < idleIndex)
    }
    if (scenario === "retry") {
      const statuses = primarySseEvents.filter(event => event.type === "session.status").map(event => typeof event.properties?.status === "string" ? event.properties.status : (event.properties?.status as { type?: string } | undefined)?.type)
      assert.ok(statuses.indexOf("retry") >= 0 && statuses.indexOf("busy") < statuses.indexOf("retry") && statuses.lastIndexOf("busy") < statuses.indexOf("idle"))
    }
     if (scenario === "error" || scenario === "abort") assert.ok(eventIndex("session.error") >= 0 || primarySseEvents.some(event => event.type === "session.status" && ["error", "failed"].includes(String(event.properties?.status))))
    const expectedState = scenario === "success" ? "completed" : scenario === "permission" ? "working" : scenario === "question" ? "working" : scenario === "retry" ? "completed" : scenario === "error" ? "error" : undefined
    if (expectedState) assert.ok(deliveredEvents.some(event => event.state === expectedState), `${scenario} state delivery missing: ${JSON.stringify(deliveredEvents)}`)
    const expectedStates = scenario === "success" ? ["working", "completed"] : scenario === "permission" ? ["working", "waiting-permission", "completed"] : scenario === "question" ? ["working", "waiting-question", "completed"] : scenario === "retry" ? ["working", "retrying", "completed"] : ["working", "error"]
    assert.deepEqual(deliveredEvents.map(event => event.state), expectedStates)
    const pluginEvents = (await readFile(eventLogPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event)
    assert.ok(pluginEvents.some(event => event.type === "session.idle"), "the real plugin hook observed session.idle")
    if (scenario === "success") {
      assert.equal(deliveries, 2)
      assert.equal(deliveredEvents[0]?.correlationId, correlationId)
      assert.deepEqual(deliveredEvents.map(event => event.state), ["working", "completed"])
      const child = await request<Child>(base, `/session?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentID: primary.id, title: "child harness session", model: { providerID: "openai", id: modelId } }) })
      assert.equal(child.parentID ?? child.parentId, primary.id)
      await send(child.id, "Return the child deterministic response.")
      await waitFor(events, event => event.type === "session.idle" && (event.properties?.sessionID === child.id || event.properties?.sessionId === child.id), "child session.idle")
      await delay(750)
      assert.equal(deliveries, 2, "child session produces no delivery")
      assert.equal(provider.requests.length, 2)
    }
    const primaryIdleEvents = events.filter(event => event.type === "session.idle" && (event.properties?.sessionID === primary.id || event.properties?.sessionId === primary.id))
    const primaryStatusEvents = events.filter(event => event.type === "session.status" && (event.properties?.sessionID === primary.id || event.properties?.sessionId === primary.id))
    assert.ok(primaryIdleEvents.length >= 1)
    assert.ok(primaryStatusEvents.some(event => event.properties?.status === "idle" || (event.properties?.status as { type?: string } | undefined)?.type === "idle"))
    assert.equal(stderr.includes(secret), false)
    assert.equal(stderr.includes(`127.0.0.1:${receiverPort}`), false)
    assert.equal(await readFile(join(tempRoot, "isolation-marker"), "utf8"), "isolated")
    sseAbort.abort()
    await sseTask.catch(() => undefined)
     console.log(JSON.stringify({ architecture: "isolated-opencode-serve-offline-provider-sse-production-plugin-unified-attention", version: runtimeVersion, scenario, providerRequests: provider.requests.map(item => ({ path: item.path, status: item.status })), sseTypes: primarySseEvents.map(event => event.type).filter(Boolean), productStates: deliveredEvents.map(event => event.state), externalAttention: externalAttention.length, deliveries, sensitiveLogs: "none", cleanup: "owned process + receiver + provider + temp root" }))
  } finally {
    try { sseAbort?.abort() } catch { /* already closed */ }
    await receiver?.dispose()
    if (opencodeProcess) await stopOwned(opencodeProcess)
    await delay(50)
    await new Promise<void>(resolveClose => provider.server.close(() => resolveClose()))
    await rm(tempRoot, { recursive: true, force: true })
    await assert.rejects(access(tempRoot), /ENOENT/)
    assert.ok(opencodeProcess?.exitCode !== null || opencodeProcess?.signalCode !== null)
  }
}

let deliveries = 0
for (const scenario of ["success", "permission", "question", "retry", "error", "abort"] as const) {
  deliveries = 0
  let completed = false
  for (let attempt = 1; attempt <= 3 && !completed; attempt++) {
    try { await main(scenario); completed = true }
    catch (error) {
      const message = String(error)
      if (attempt === 3 || !message.includes("models.dev")) { console.error(error); process.exitCode = 1; break }
      await delay(100)
    }
  }
  if (!completed && process.exitCode) break
}
