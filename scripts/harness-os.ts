import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sendOsNotification } from "../src/adapters/os.ts"
import type { CompletionEventV1 } from "../src/domain/completion.ts"

const event = (outcome: CompletionEventV1["outcome"], projectLabel: string): CompletionEventV1 => ({
  version: 1,
  eventId: `harness-${outcome}`,
  correlationId: "tab-harness-os",
  outcome,
  projectLabel,
  completedAt: "2026-01-01T00:00:00.000Z",
})

const fakeExecutable = `
import { appendFileSync } from "node:fs"

const [, , logPath, mode, ...args] = process.argv
appendFileSync(logPath, JSON.stringify({ mode, args }) + "\\n")
if (mode === "failure") process.exit(7)
if (mode === "timeout") setTimeout(() => {}, 5_000)
`

const readRecords = async (logPath: string): Promise<Array<{ mode: string; args: string[] }>> => {
  const content = await readFile(logPath, "utf8")
  return content.trim().split("\n").map((line) => JSON.parse(line) as { mode: string; args: string[] })
}

async function main(): Promise<void> {
  assert.equal(process.platform, "linux", "OS harness requires Linux")
  const runtimeDir = await mkdtemp(join(tmpdir(), "tabby-os-harness-"))
  const executablePath = join(runtimeDir, "fake-notify-send.mjs")
  const logPath = join(runtimeDir, "argv.jsonl")
  await writeFile(executablePath, fakeExecutable, "utf8")
  await writeFile(logPath, "", "utf8")

  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  const closed: Promise<void>[] = []
  const activeChildren = new Set<ChildProcess>()
  const spawnProcess = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args], options })
    const mode = ["success", "failure", "timeout"][calls.length - 1]
    const child = spawn(process.execPath, [executablePath, logPath, mode, ...args], {
      shell: false,
      stdio: "ignore",
    })
    activeChildren.add(child)
    closed.push(new Promise<void>((resolve) => child.once("close", () => {
      activeChildren.delete(child)
      resolve()
    })))
    return child
  }

  try {
    await sendOsNotification(event("success", "demo; $(touch should-not-exist)"), spawnProcess)
    await assert.rejects(
      sendOsNotification(event("failure", "failure"), spawnProcess),
      /notification failed/,
    )
    await assert.rejects(
      sendOsNotification(event("cancelled", "timeout"), spawnProcess, { timeoutMs: 250 }),
      /notification timeout/,
    )

    await Promise.all(closed)
    assert.equal(activeChildren.size, 0)
    const records = await readRecords(logPath)
    assert.deepEqual(calls.map(({ command }) => command), ["notify-send", "notify-send", "notify-send"])
    assert.deepEqual(calls.map(({ options }) => options.shell), [false, false, false])
    assert.deepEqual(records[0], {
      mode: "success",
      args: ["--app-name", "OpenCode", "OpenCode", "OpenCode finished: demo; $(touch should-not-exist) (success)"],
    })
    assert.equal(records[1]?.mode, "failure")
    assert.equal(records[2]?.mode, "timeout")
    assert.equal(calls.length, 3)
    console.log("OS harness passed: real fake child process verified fixed argv/message, nonzero exit, timeout, and cleanup")
  } finally {
    for (const child of activeChildren) child.kill()
    await Promise.all(closed)
    await rm(runtimeDir, { recursive: true, force: true })
    await assert.rejects(access(runtimeDir), /ENOENT/)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
