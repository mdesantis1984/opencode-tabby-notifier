import type { AttentionNotificationV1, CompletionNotificationV1, Outcome } from "../domain/completion.ts"

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type TelegramOptions = {
  token: string
  chatId: string
  endpoint?: string
  timeoutMs?: number
  fetch?: Fetch
  signal?: AbortSignal
}

export type TelegramPresentation = {
  title: string
  description: string
  action: string
  origin: string
  completedAt: string
}

const MAX_ORIGIN_CHARACTERS = 72

const copy: Record<Outcome, { description: string; action: string }> = {
  success: {
    description: "The OpenCode work run completed successfully.",
    action: "No action is required.",
  },
  failure: {
    description: "The OpenCode work run ended with an error.",
    action: "Review the result before continuing.",
  },
  cancelled: {
    description: "The OpenCode work run was cancelled.",
    action: "Start another run only if you still need it.",
  },
}

function boundLabel(value: string, maximum: number): string {
  const normalized = [...value.normalize("NFKC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      const isInvalidMarkup =
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
        || (codePoint & 0xffff) >= 0xfffe
      return isInvalidMarkup ? " " : character
    })
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  const characters = [...normalized]
  if (characters.length === 0) return "Project unavailable"
  if (characters.length <= maximum) return normalized
  return `${characters.slice(0, maximum - 1).join("")}…`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;")
}

function humanCompletionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Hora no disponible"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = months[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`
}

function outcomeTitle(event: AttentionNotificationV1 | CompletionNotificationV1): string {
  const kind = "kind" in event ? event.kind : event.outcome
  if (kind === "waiting-permission") return "⚠️ OPENCODE NEEDS PERMISSION"
  if (kind === "waiting-question") return "⚠️ OPENCODE NEEDS INPUT"
  if (kind === "failure") return "⚠️ OPENCODE REQUIRES ATTENTION"
  if (kind === "cancelled") return "⛔ OPENCODE WAS CANCELLED"
  if (kind === "error") return "⚠️ OPENCODE REQUIRES ATTENTION"
  return "✅ OPENCODE FINISHED"
}

export function telegramPresentation(event: AttentionNotificationV1 | CompletionNotificationV1): TelegramPresentation {
  const outcome: Outcome = "kind" in event ? event.outcome ?? (event.kind === "completed" ? "success" : "failure") : event.outcome
  const attentionCopy = "kind" in event && (event.kind === "waiting-permission" || event.kind === "waiting-question")
  const text = attentionCopy ? (event.kind === "waiting-permission" ? "OpenCode needs permission to continue." : "OpenCode needs your input to continue.") : copy[outcome].description
  const action = attentionCopy ? (event.kind === "waiting-permission" ? "Review and answer the permission request." : "Answer the OpenCode question.") : copy[outcome].action
  return {
    title: outcomeTitle(event),
    description: text,
    action,
    origin: boundLabel(event.projectLabel, MAX_ORIGIN_CHARACTERS),
    completedAt: humanCompletionTime("completedAt" in event ? event.completedAt : event.occurredAt),
  }
}

export function buildTelegramMessage(event: AttentionNotificationV1 | CompletionNotificationV1): string {
  const presentation = telegramPresentation(event)
  return [
    `<b>${escapeHtml(presentation.title)}</b>`,
    `<i>${escapeHtml(presentation.description)}</i>`,
    "",
    `<b>Origin:</b> <code>${escapeHtml(presentation.origin)}</code>`,
    `<b>Completed:</b> <code>${escapeHtml(presentation.completedAt)}</code>`,
    `<b>Action:</b> ${escapeHtml(presentation.action)}`,
  ].join("\n")
}

export async function sendTelegramNotification(event: AttentionNotificationV1 | CompletionNotificationV1, options: TelegramOptions): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const response = await (options.fetch ?? fetch)(
      options.endpoint ?? `https://api.telegram.org/bot${options.token}/sendMessage`,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: options.chatId,
          text: buildTelegramMessage(event),
          parse_mode: "HTML",
        }),
      },
    )
    if (!response.ok) throw new Error("telegram request failed")
  } finally {
    clearTimeout(timeout)
  }
}
