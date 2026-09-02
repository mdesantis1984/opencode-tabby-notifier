import { createHmac, timingSafeEqual } from "node:crypto"
import type { SessionStateEventV1, TabbyEventV1 } from "../domain/completion.ts"
export type { CompletionEventV1, SessionState, SessionStateEventV1, TabbyEventV1 } from "../domain/completion.ts"
type Frame = { payload: TabbyEventV1; mac: string }
export const MAX_FRAME_BYTES = 4096
export const FRESHNESS_WINDOW_MS = 300_000
export const MAX_EVENT_ID_LENGTH = 256
export const MAX_CORRELATION_ID_LENGTH = 128
export const MAX_PROJECT_LABEL_LENGTH = 128
export const MAX_REPLAY_ENTRIES = 1024
const bytes = (payload: TabbyEventV1) => JSON.stringify(payload)
const sign = (payload: TabbyEventV1, secret: string) => createHmac("sha256", secret).update(bytes(payload)).digest("hex")
export function createFrame(payload: TabbyEventV1, secret: string): string { return JSON.stringify({ payload, mac: sign(payload, secret) }) }
export class ReplayCache {
  private readonly entries = new Map<string, number>()
  constructor(private readonly maxEntries = MAX_REPLAY_ENTRIES, private readonly freshnessMs = FRESHNESS_WINDOW_MS) {}
  has(eventId: string, now: number): boolean { this.prune(now); return this.entries.has(eventId) }
  add(eventId: string, now: number): void {
    this.prune(now)
    this.entries.set(eventId, now)
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
  clear(): void { this.entries.clear() }
  get size(): number { return this.entries.size }
  private prune(now: number): void {
    for (const [eventId, seenAt] of this.entries) if (now - seenAt > this.freshnessMs) this.entries.delete(eventId)
  }
}
export function verifyFrame(input: string, secret: string, options: { seen?: Set<string> | ReplayCache; remoteAddress?: string; now?: number } = {}): TabbyEventV1 {
  if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES || (options.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(options.remoteAddress))) throw new Error("invalid frame")
  let frame: Frame; try { frame = JSON.parse(input) } catch { throw new Error("invalid frame") }
  const p = frame?.payload; if (!p || p.version !== 1 || typeof p.eventId !== "string" || !p.eventId || p.eventId.length > MAX_EVENT_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(p.eventId) || typeof p.correlationId !== "string" || !p.correlationId || p.correlationId.length > MAX_CORRELATION_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(p.correlationId) || typeof p.projectLabel !== "string" || p.projectLabel.length > MAX_PROJECT_LABEL_LENGTH || typeof frame.mac !== "string") throw new Error("invalid frame")
  const isCompletion = "outcome" in p
  const isState = "state" in p
  if ((!isCompletion && !isState) || (isCompletion && (isState || !["success", "failure", "cancelled"].includes(p.outcome))) || (isState && (!(["working", "waiting-permission", "waiting-question", "retrying", "error", "completed"] as string[]).includes(p.state) || typeof p.occurredAt !== "string" || typeof p.generation !== "number")) || (isCompletion && typeof p.completedAt !== "string")) throw new Error("invalid frame")
  const expected = sign(p, secret), actual = Buffer.from(frame.mac, "hex"), wanted = Buffer.from(expected, "hex")
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("unauthenticated")
  const timestamp = isCompletion ? (p as import("../domain/completion.ts").CompletionEventV1).completedAt : (p as SessionStateEventV1).occurredAt
  const now = options.now ?? Date.now(), time = Date.parse(timestamp); if (!Number.isFinite(time) || Math.abs(now - time) > FRESHNESS_WINDOW_MS) throw new Error("expired")
  if (options.seen instanceof ReplayCache) { if (options.seen.has(p.eventId, now)) throw new Error("replayed"); options.seen.add(p.eventId, now) }
  else if (options.seen?.has(p.eventId)) throw new Error("replayed"); else options.seen?.add(p.eventId)
  return p
}
