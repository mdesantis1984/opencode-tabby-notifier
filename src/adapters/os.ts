import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import type { AttentionNotificationV1, CompletionNotificationV1 } from "../domain/completion.ts"

const Spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => spawn(command, args, options)
const safe = (value: string) => value.replace(/[\r\n]/g, " ").slice(0, 120)
type Options = { timeoutMs?: number; signal?: AbortSignal }

export function sendOsNotification(event: AttentionNotificationV1 | CompletionNotificationV1, spawnProcess = Spawn, options: Options = {}, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "linux") return Promise.resolve()
  const kind = "kind" in event ? event.kind : event.outcome
  const args = ["--app-name", "OpenCode", "OpenCode", `OpenCode ${kind === "completed" || kind === "success" ? "finished" : "requires attention"}: ${safe(event.projectLabel || "work")} (${kind})`]
  return new Promise((resolve, reject) => {
    const child = spawnProcess("notify-send", args, { shell: false, stdio: "ignore" })
    const timer = setTimeout(() => { child.kill(); reject(new Error("notification timeout")) }, options.timeoutMs ?? 2_000)
    const abort = () => { child.kill(); reject(new Error("notification aborted")) }
    options.signal?.addEventListener("abort", abort, { once: true })
    const finish = (error?: Error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); error ? reject(error) : resolve() }
    child.once("error", () => finish(new Error("notification failed")))
    child.once("close", (code) => code === 0 ? finish() : finish(new Error("notification failed")))
  })
}
