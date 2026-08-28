export type Config = { correlationId?: string; ipcSecret?: string; endpoint?: string; projectLabel?: string; telegramToken?: string; telegramChatId?: string }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.OPENCODE_NOTIFY_PERSISTED === "1") throw new Error("persistent secrets are not allowed")
  return { correlationId: env.OPENCODE_NOTIFY_CORRELATION, ipcSecret: env.OPENCODE_NOTIFY_IPC_SECRET, endpoint: env.OPENCODE_NOTIFY_IPC_ENDPOINT, projectLabel: env.OPENCODE_NOTIFY_PROJECT_LABEL, telegramToken: env.OPENCODE_NOTIFY_TELEGRAM_TOKEN, telegramChatId: env.OPENCODE_NOTIFY_TELEGRAM_CHAT_ID }
}
