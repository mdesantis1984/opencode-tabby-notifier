import type { CompletionEventV1 } from "../domain/completion.ts"

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type TelegramOptions = { token: string; chatId: string; endpoint?: string; timeoutMs?: number; fetch?: Fetch; signal?: AbortSignal }
const safe = (value: string) => value.replace(/[\r\n]/g, " ").slice(0, 120)

export async function sendTelegramNotification(event: CompletionEventV1, options: TelegramOptions): Promise<void> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const response = await (options.fetch ?? fetch)(options.endpoint ?? `https://api.telegram.org/bot${options.token}/sendMessage`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: options.chatId, text: `OpenCode finished: ${safe(event.projectLabel || "work")} (${event.outcome}) at ${event.completedAt}` }),
    })
    if (!response.ok) throw new Error("telegram request failed")
  } finally { clearTimeout(timeout) }
}
