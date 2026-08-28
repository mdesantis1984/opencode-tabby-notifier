import assert from "node:assert/strict"
import test from "node:test"
import { createFrame, verifyFrame, type CompletionEventV1 } from "../src/ipc/protocol.ts"

const payload: CompletionEventV1 = { version: 1, eventId: "e1", correlationId: "tab-1", outcome: "success", projectLabel: "demo", completedAt: new Date().toISOString() }

test("signs and verifies a bounded v1 frame", () => {
  const frame = createFrame(payload, "a".repeat(64))
  assert.deepEqual(verifyFrame(frame, "a".repeat(64)), payload)
  assert.throws(() => verifyFrame(JSON.stringify({}), "a".repeat(64)))
})

test("rejects oversized, unauthenticated, delayed, replayed and non-loopback frames", () => {
  const secret = "b".repeat(64), frame = createFrame(payload, secret)
  assert.throws(() => verifyFrame(frame, "c".repeat(64)))
  assert.throws(() => verifyFrame(frame + "x".repeat(4096), secret))
  assert.throws(() => verifyFrame(createFrame({ ...payload, completedAt: "2000-01-01T00:00:00.000Z" }, secret), secret))
  const seen = new Set<string>(); assert.deepEqual(verifyFrame(frame, secret, { seen }), payload)
  assert.throws(() => verifyFrame(frame, secret, { seen }))
  assert.throws(() => verifyFrame(frame, secret, { remoteAddress: "10.0.0.1" }))
})
