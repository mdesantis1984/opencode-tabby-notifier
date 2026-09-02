import type { AttentionNotificationV1, CompletionEventV1, CompletionNotificationV1 } from "./domain/completion.ts"
import { diagnostic } from "./diagnostics.ts"

type Channel = (event: AttentionNotificationV1 | CompletionNotificationV1) => Promise<void>
export function fanOut(channels: { os: Channel; telegram: Channel; ipc: Channel }) {
  let disposed = false
  return {
  publish: async (event: AttentionNotificationV1 | CompletionNotificationV1) => {
      if (disposed) return [] as PromiseSettledResult<void>[]
      const results = await Promise.allSettled([channels.os, channels.telegram, channels.ipc].map((channel) => Promise.resolve().then(() => channel(event))))
      results.forEach((result) => { if (result.status === "rejected") diagnostic("channel_unavailable") })
      return results
    },
    dispose: () => { disposed = true },
  }
}
