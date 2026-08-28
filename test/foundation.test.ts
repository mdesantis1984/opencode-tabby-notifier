import assert from "node:assert/strict"
import test from "node:test"
import { aggregateEvent, normalizeStatus, type SessionEvent } from "../src/domain/aggregator.ts"
import { redact, diagnostic } from "../src/diagnostics.ts"
import { loadConfig } from "../src/config.ts"

const event = (x: Partial<SessionEvent>): SessionEvent => ({ type: "session.status", sessionId: "root", correlationId: "tab-1", status: "idle", ...x })

test("aggregates generations and waits for children", () => {
  const state = aggregateEvent(event({ status: "busy", generation: 1 }))
  assert.equal(aggregateEvent(event({ status: "idle", generation: 1, childBusy: true }), state), undefined)
  assert.deepEqual(aggregateEvent(event({ status: "idle", generation: 1, childBusy: false }), state)?.outcome, "success")
})

test("normalizes failure and cancellation and deduplicates canonical idle", () => {
  assert.equal(normalizeStatus(event({ status: "error" }))?.outcome, "failure")
  assert.equal(normalizeStatus(event({ type: "session.idle", status: "aborted" }))?.outcome, "cancelled")
  const state = aggregateEvent(event({}))
  assert.equal(aggregateEvent(event({ type: "session.idle" }), state), undefined)
})

test("rejects missing or ambiguous correlation", () => {
  assert.equal(normalizeStatus(event({ correlationId: "" })), undefined)
  assert.equal(normalizeStatus(event({ correlationId: "ambiguous" })), undefined)
})

test("config rejects persisted secrets and diagnostics redact sensitive values", () => {
  assert.equal(loadConfig({ OPENCODE_NOTIFY_IPC_SECRET: "secret", OPENCODE_NOTIFY_CORRELATION: "tab" }).ipcSecret, "secret")
  assert.throws(() => loadConfig({ OPENCODE_NOTIFY_IPC_SECRET: "secret", OPENCODE_NOTIFY_PERSISTED: "1" }))
  assert.equal(redact("/home/a token=secret task content"), "[redacted]")
  assert.deepEqual(diagnostic("invalid", new Error("/tmp/secret")), { code: "invalid", status: "rejected" })
})
