import { createHmac, timingSafeEqual } from "node:crypto"
import type { CompletionEventV1 } from "../domain/completion.ts"
export type { CompletionEventV1 }
type Frame = { payload: CompletionEventV1; mac: string }
const MAX = 4096, SKEW = 300_000
const bytes = (payload: CompletionEventV1) => JSON.stringify(payload)
const sign = (payload: CompletionEventV1, secret: string) => createHmac("sha256", secret).update(bytes(payload)).digest("hex")
export function createFrame(payload: CompletionEventV1, secret: string): string { return JSON.stringify({ payload, mac: sign(payload, secret) }) }
export function verifyFrame(input: string, secret: string, options: { seen?: Set<string>; remoteAddress?: string; now?: number } = {}): CompletionEventV1 {
  if (input.length > MAX || (options.remoteAddress && !["127.0.0.1", "::1"].includes(options.remoteAddress))) throw new Error("invalid frame")
  let frame: Frame; try { frame = JSON.parse(input) } catch { throw new Error("invalid frame") }
  const p = frame?.payload; if (!p || p.version !== 1 || typeof p.eventId !== "string" || typeof p.correlationId !== "string" || !p.correlationId || !/^[A-Za-z0-9._:-]+$/.test(p.correlationId) || !["success", "failure", "cancelled"].includes(p.outcome) || typeof frame.mac !== "string") throw new Error("invalid frame")
  const expected = sign(p, secret), actual = Buffer.from(frame.mac, "hex"), wanted = Buffer.from(expected, "hex")
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("unauthenticated")
  const time = Date.parse(p.completedAt); if (!Number.isFinite(time) || Math.abs((options.now ?? Date.now()) - time) > SKEW) throw new Error("expired")
  if (options.seen?.has(p.eventId)) throw new Error("replayed"); options.seen?.add(p.eventId)
  return p
}
