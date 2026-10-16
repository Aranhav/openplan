import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import type { QueryResult } from "@/features/grid/view-types"
import { ApiError, api, unwrap } from "@/lib/api/client"
import { queryKeys } from "@/lib/api/keys"

/**
 * Whether the model's screens hear of changes: `live` once the server has greeted the socket,
 * `reconnecting` until then and whenever the socket is lost, `off` when the server has said that
 * there is nothing to follow (the model is gone, or the user may not read it).
 */
export type LiveStatus = "live" | "reconnecting" | "off"

const BACKOFF_FIRST_MS = 1_000
const BACKOFF_LAST_MS = 30_000
/**
 * How far a wait may stray from its length, either way, so that sockets lost together do not
 * return together.
 */
const JITTER = 0.2
/** A socket that stayed this long after the greeting was a good connection: the waits start over. */
const STABLE_AFTER_MS = 10_000

/** The close codes that say the user may no longer read the model, or that it is gone. */
const CLOSE_REMOVED = 4403
const CLOSE_GONE = 4404

type Message =
  | { type: "hello"; seq: number }
  | { type: "cells_changed"; seq: number; line_item_ids: string[] }
  | { type: "structure_changed"; seq: number }
  | { type: "resync"; seq: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** What a frame says, or nothing if it is no message this client knows. */
function parseMessage(data: unknown): Message | undefined {
  if (typeof data !== "string") {
    return undefined
  }
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(json) || typeof json.seq !== "number") {
    return undefined
  }
  const { seq } = json
  switch (json.type) {
    case "hello":
    case "structure_changed":
    case "resync":
      return { type: json.type, seq }
    case "cells_changed":
      return Array.isArray(json.line_item_ids) &&
        json.line_item_ids.every((id) => typeof id === "string")
        ? { type: "cells_changed", seq, line_item_ids: json.line_item_ids }
        : undefined
    default:
      return undefined
  }
}

function isQueryResult(data: unknown): data is QueryResult {
  return isRecord(data) && typeof data.seq === "number" && Array.isArray(data.line_items)
}

/** The line items a view filters on: they decide which rows it shows, shown or not. */
function filteredOn(queryKey: readonly unknown[]): string[] {
  // The key of a view is the model's query key, the pivot and the block.
  const pivot = queryKey[3]
  if (!isRecord(pivot) || !Array.isArray(pivot.filters)) {
    return []
  }
  return pivot.filters.flatMap((filter: unknown) =>
    isRecord(filter) && typeof filter.line_item === "string" ? [filter.line_item] : [],
  )
}

/**
 * Follows one model over its live socket for as long as it is running, and keeps what the
 * screens loaded of the model current: a change that another user makes is read again, and only
 * where it shows.
 *
 * The sequence numbers are those of one log for all models, and every cell a batch changes takes
 * one too, so the next change of a model is rarely the number after the last: a jump says nothing.
 * Changes that were missed are told by `resync` (the server fell behind), or by a greeting that
 * is past every number heard of (the socket was away).
 */
class LiveConnection {
  private readonly modelId: string
  private readonly queryClient: QueryClient
  private readonly onStatus: (status: LiveStatus) => void
  private stopped = false
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private ticketRequest: AbortController | undefined
  /** How many connections in a row were lost soon after the server greeted them, or never were. */
  private failures = 0
  /** When the server greeted the open socket. */
  private greetedAt: number | undefined
  /** The highest sequence number heard of, in a greeting or a message. */
  private highest: number | undefined

  constructor(modelId: string, queryClient: QueryClient, onStatus: (status: LiveStatus) => void) {
    this.modelId = modelId
    this.queryClient = queryClient
    this.onStatus = onStatus
  }

  start() {
    void this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.ticketRequest?.abort()
    const socket = this.socket
    if (socket) {
      socket.onmessage = null
      socket.onclose = null
      socket.close(1000)
    }
  }

  private async connect() {
    const request = new AbortController()
    this.ticketRequest = request
    let ticket: { ticket: string; url: string }
    try {
      ticket = await unwrap(
        api.POST("/models/{id}/live/ticket", {
          params: { path: { id: this.modelId } },
          signal: request.signal,
        }),
      )
    } catch (error) {
      if (!this.stopped) {
        this.ticketRefused(error)
      }
      return
    }
    if (!this.stopped) {
      this.open(ticket)
    }
  }

  private open({ ticket, url }: { ticket: string; url: string }) {
    const socket = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`)
    this.socket = socket
    socket.onmessage = (event) => {
      const message = parseMessage(event.data)
      if (message && this.socket === socket) {
        this.hear(message)
      }
    }
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = undefined
        this.lost(event.code)
      }
    }
  }

  private ticketRefused(error: unknown) {
    if (error instanceof ApiError) {
      // Nothing a second ticket would change: the session is over, or the model is not the
      // user's to read.
      if (error.status === 401 || error.status === 403 || error.status === 404) {
        this.giveUp()
        return
      }
      // A full box of tickets or sockets says how long to wait; that wait is not a failure. A
      // server that says 0 is not asked again at once.
      if (error.retryAfter !== undefined) {
        this.retryIn(Math.max(error.retryAfter * 1000, BACKOFF_FIRST_MS))
        return
      }
    }
    this.retryIn(this.nextBackoff())
  }

  private lost(code: number) {
    if (code === CLOSE_REMOVED || code === CLOSE_GONE) {
      this.giveUp()
      return
    }
    if (this.greetedAt !== undefined && Date.now() - this.greetedAt >= STABLE_AFTER_MS) {
      this.failures = 0
    }
    this.greetedAt = undefined
    this.retryIn(this.nextBackoff())
  }

  private nextBackoff(): number {
    const wait = Math.min(BACKOFF_FIRST_MS * 2 ** this.failures, BACKOFF_LAST_MS)
    this.failures += 1
    return wait * (1 + (Math.random() * 2 - 1) * JITTER)
  }

  private retryIn(ms: number) {
    this.onStatus("reconnecting")
    this.timer = setTimeout(() => void this.connect(), ms)
  }

  /** Stops following. The model's own query tells whether it is gone, and its screen takes over. */
  private giveUp() {
    this.onStatus("off")
    void this.queryClient.invalidateQueries({
      queryKey: queryKeys.model(this.modelId),
      exact: true,
    })
  }

  private hear(message: Message) {
    const { highest } = this
    this.highest = Math.max(highest ?? message.seq, message.seq)
    switch (message.type) {
      case "hello":
        this.greeted(message.seq, highest)
        break
      case "cells_changed":
        this.readAgainWhereShown(new Set(message.line_item_ids))
        break
      case "structure_changed":
        this.readAgainStructure()
        break
      case "resync":
        this.readAgainAll()
        break
    }
  }

  /**
   * The server's greeting says how far the model has got. What was loaded earlier is current if
   * it is as far: for the first socket, that is told by the numbers the loaded views are as of,
   * and for the next, by the highest number heard of before the socket was lost.
   */
  private greeted(seq: number, heard: number | undefined) {
    this.greetedAt = Date.now()
    this.onStatus("live")
    const behind = heard === undefined ? this.loadedBefore(seq) : seq > heard
    if (behind) {
      this.readAgainAll()
    }
  }

  /** Whether a view that was loaded before the socket opened is older than the model is now. */
  private loadedBefore(seq: number): boolean {
    return this.queryClient
      .getQueryCache()
      .findAll({ queryKey: queryKeys.query(this.modelId) })
      .some((query) => isQueryResult(query.state.data) && query.state.data.seq < seq)
  }

  /**
   * Reads again the views that show a line item that changed, or filter on one, or that have
   * nothing loaded to tell by.
   */
  private readAgainWhereShown(changed: ReadonlySet<string>) {
    const shows = (query: Query) => {
      const { data } = query.state
      return (
        !isQueryResult(data) ||
        data.line_items.some((item) => changed.has(item.id)) ||
        filteredOn(query.queryKey).some((id) => changed.has(id))
      )
    }
    void this.queryClient.invalidateQueries({
      queryKey: queryKeys.query(this.modelId),
      predicate: shows,
    })
  }

  private readAgainStructure() {
    void this.queryClient.invalidateQueries({ queryKey: queryKeys.structure(this.modelId) })
    void this.queryClient.invalidateQueries({ queryKey: queryKeys.query(this.modelId) })
  }

  private readAgainAll() {
    void this.queryClient.invalidateQueries({ queryKey: queryKeys.model(this.modelId) })
  }
}

interface Reported {
  modelId: string
  status: LiveStatus
}

/**
 * Keeps the open model current: another user's edits to cells and structure are read again
 * where they show. Mount it once for the model, where all its screens sit.
 */
export function useModelLive(modelId: string): LiveStatus {
  const queryClient = useQueryClient()
  // The status belongs to the model it was reported for: another model starts over.
  const [reported, setReported] = useState<Reported>({ modelId, status: "reconnecting" })

  useEffect(() => {
    const connection = new LiveConnection(modelId, queryClient, (status) =>
      setReported((previous) =>
        previous.modelId === modelId && previous.status === status ? previous : { modelId, status },
      ),
    )
    connection.start()
    return () => connection.stop()
  }, [modelId, queryClient])

  return reported.modelId === modelId ? reported.status : "reconnecting"
}
