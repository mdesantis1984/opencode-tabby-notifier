import type { TabbyEventV1 } from "../domain/completion.ts"
import { createFrame } from "../ipc/protocol.ts"

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type IpcOptions = { endpoint: string; secret: string; timeoutMs?: number; fetch?: Fetch; signal?: AbortSignal }

export async function sendIpcNotification(event: TabbyEventV1, options: IpcOptions): Promise<void> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const response = await (options.fetch ?? fetch)(options.endpoint, {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: createFrame(event, options.secret),
    })
    if (!response.ok) throw new Error("ipc request failed")
  } finally { clearTimeout(timeout) }
}
