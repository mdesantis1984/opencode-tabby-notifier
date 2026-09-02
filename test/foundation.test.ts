import assert from "node:assert/strict"
import test from "node:test"
import { redact, diagnostic } from "../src/diagnostics.ts"
import { loadConfig } from "../src/config.ts"

test("config rejects persisted secrets and diagnostics redact sensitive values", () => {
  assert.equal(loadConfig({ OPENCODE_NOTIFY_IPC_SECRET: "secret", OPENCODE_NOTIFY_CORRELATION: "tab" }).ipcSecret, "secret")
  assert.throws(() => loadConfig({ OPENCODE_NOTIFY_IPC_SECRET: "secret", OPENCODE_NOTIFY_PERSISTED: "1" }))
  assert.equal(redact("/home/a token=secret task content"), "[redacted]")
  assert.deepEqual(diagnostic("invalid", new Error("/tmp/secret")), { code: "invalid", status: "rejected" })
})
