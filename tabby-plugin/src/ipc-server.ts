import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { TabbyEventV1 } from "../../src/domain/completion.ts"
import { ReplayCache, verifyFrame } from "../../src/ipc/protocol.ts"

const LOOPBACK_HOST = "127.0.0.1"
const LOOPBACK_ADDRESSES = new Set([LOOPBACK_HOST, "::1", "::ffff:127.0.0.1"])
const MAX_BODY_BYTES = 4096
const REQUEST_TIMEOUT_MS = 5_000
const MAX_CONNECTIONS = 8

export type VerifiedEventHandler = (event: TabbyEventV1) => boolean | Promise<boolean>

/** A bounded, loopback-only HTTP listener which authenticates each frame exactly once. */
export class IpcServer {
  private server: Server | null = null
  private readonly seen = new ReplayCache()
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(
    private readonly secret: string,
    private readonly onEvent: VerifiedEventHandler,
    private readonly expectedCorrelationId?: string,
  ) {}

  start(port = 0): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("IPC server is disposed"))
    if (this.server) return Promise.reject(new Error("IPC server is already started"))

    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.handleRequest(request, response))
      this.server = server
      server.maxConnections = MAX_CONNECTIONS
      server.requestTimeout = REQUEST_TIMEOUT_MS
      server.headersTimeout = REQUEST_TIMEOUT_MS
      server.keepAliveTimeout = 1_000

      let started = false
      const onError = (error: Error): void => {
        if (this.server === server) this.server = null
        if (!started) reject(error)
        if (server.listening) {
          server.close()
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        }
      }
      server.on("error", onError)
      server.listen(port, LOOPBACK_HOST, () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          void this.dispose()
          reject(new Error("IPC server did not expose a TCP port"))
          return
        }
        started = true
        resolve(address.port)
      })
    })
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const respond = (status: number): void => {
      if (!response.writableEnded && !response.destroyed) response.writeHead(status).end()
    }
    const rejectRequest = (status: number): void => {
      respond(status)
      request.destroy()
    }
    const remoteAddress = request.socket.remoteAddress
    if (
      this.disposed
      || request.method !== "POST"
      || request.url !== "/"
      || !remoteAddress
      || !LOOPBACK_ADDRESSES.has(remoteAddress)
    ) {
      request.resume()
      respond(400)
      return
    }

    request.setTimeout(REQUEST_TIMEOUT_MS, () => rejectRequest(408))
    const chunks: Buffer[] = []
    let bodyBytes = 0
    let rejected = false
    request.on("data", (chunk: Buffer | string) => {
      if (rejected) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bodyBytes += bytes.length
      if (bodyBytes > MAX_BODY_BYTES) {
        rejected = true
        chunks.length = 0
        rejectRequest(413)
        return
      }
      chunks.push(bytes)
    })
    request.on("end", async () => {
      if (rejected || response.writableEnded || this.disposed) return
      try {
        const frame = Buffer.concat(chunks, bodyBytes).toString("utf8")
        const completion = verifyFrame(frame, this.secret, { seen: this.seen, remoteAddress })
        if (this.expectedCorrelationId && completion.correlationId !== this.expectedCorrelationId) {
          respond(400)
          return
        }
        respond(await this.onEvent(completion) ? 204 : 400)
      } catch {
        respond(400)
      }
    })
    request.on("error", () => respond(400))
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.seen.clear()
    const server = this.server
    this.server = null
    if (!server) {
      this.disposePromise = Promise.resolve()
      return this.disposePromise
    }

    this.disposePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    })
    return this.disposePromise
  }
}
