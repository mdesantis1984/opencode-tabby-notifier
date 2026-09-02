import { sendIpcNotification } from "./adapters/ipc.ts"
import { sendOsNotification } from "./adapters/os.ts"
import { sendTelegramNotification } from "./adapters/telegram.ts"
import type { Config } from "./config.ts"
import type { AttentionNotificationV1, CompletionEventV1, CompletionNotificationV1 } from "./domain/completion.ts"
import { fanOut } from "./fanout.ts"

type TelegramDeliveryOptions = { token: string; chatId: string }
type IpcDeliveryOptions = { endpoint: string; secret: string }

export type DeliveryAdapters = {
  os: (event: AttentionNotificationV1 | CompletionNotificationV1) => Promise<void>
  telegram: (event: AttentionNotificationV1 | CompletionNotificationV1, options: TelegramDeliveryOptions) => Promise<void>
  ipc: (event: CompletionEventV1, options: IpcDeliveryOptions) => Promise<void>
}

export type CompletionDelivery = {
  publish: (event: AttentionNotificationV1 | CompletionNotificationV1) => Promise<PromiseSettledResult<void>[]>
  dispose: () => void
}

const defaultAdapters: DeliveryAdapters = {
  os: (event) => sendOsNotification(event),
  telegram: (event, options) => sendTelegramNotification(event, options),
  ipc: (event, options) => sendIpcNotification(event, options),
}
const deliveredAttention = new Set<string>()

/** Compose every host through the same failure-isolating transport fan-out. */
export function createDelivery(
  config: Config,
  overrides: Partial<DeliveryAdapters> = {},
): CompletionDelivery {
  const adapters = { ...defaultAdapters, ...overrides }
  const queue = fanOut({
    os: (event) => adapters.os(event),
    telegram: (event) => config.telegramToken && config.telegramChatId
      ? adapters.telegram(event, { token: config.telegramToken, chatId: config.telegramChatId })
      : Promise.resolve(),
    ipc: (event) => config.endpoint && config.ipcSecret && event.correlationId && "outcome" in event
      ? adapters.ipc(event as CompletionEventV1, { endpoint: config.endpoint, secret: config.ipcSecret })
      : Promise.resolve(),
  })

  return {
    publish: (event) => {
      if ("kind" in event) {
        const key = `${event.correlationId ?? ""}:${event.generation}:${event.kind}`
        if (deliveredAttention.has(key)) return Promise.resolve([])
        deliveredAttention.add(key)
        while (deliveredAttention.size > 256) deliveredAttention.delete(deliveredAttention.values().next().value!)
      }
      return queue.publish(event as CompletionEventV1)
    },
    dispose: queue.dispose,
  }
}
