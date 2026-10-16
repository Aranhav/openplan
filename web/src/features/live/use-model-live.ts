import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import type { QueryResult } from "@/features/grid/view-types"
import { ApiError, api, isRecord, unwrap } from "@/lib/api/client"
import { LINE_ITEM_ERRORS, mutationKeys, pivotOfKey, queryKeys } from "@/lib/api/keys"

/**
 * Whether the model's screens hear of changes: `connecting` until the server has greeted the
 * first socket, `live` once it has, `reconnecting` when the socket is lost or could not be made,
 * and `off` when there is nothing to follow (the model is gone, or the user may not read it).
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "off"

const BACKOFF_FIRST_MS = 1_000
const BACKOFF_LAST_MS = 30_000
/**
 * How far a wait may stray from its length, so that sockets lost together do not return
 * together: either way for a backoff, and upwards for the wait a server asks for.
 */
const JITTER = 0.2
/** The longest wait that a server's Retry-After is taken for. */
const RETRY_AFTER_LAST_MS = 120_000
/** A socket that stayed this long after the greeting was a good connection: the waits start over. */
const STABLE_AFTER_MS = 10_000
/**
 * How long the messages that come together are gathered before the views are read again, so that
 * a stream of changes, such as an import, is read once and not once for each.
 */
const GATHER_MS = 100

/** The close codes that say the user may no longer read the model, or that it is gone. */
const CLOSE_REMOVED = 4403
const CLOSE_GONE = 4404

type Message =
  | { type: "hello"; seq: number }
  | { type: "cells_changed"; seq: number; line_item_ids: string[] }
  | { type: "structure_changed"; seq: number }
  | { type: "resync"; seq: number }

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

/** The line items a pivot filters on: they decide which rows a view shows, shown or not. */
function filteredOn(pivot: unknown): string[] {
  if (!isRecord(pivot) || !Array.isArray(pivot.filters)) {
    return []
  }
  return pivot.filters.flatMap((filter: unknown) =>
    isRecord(filter) && typeof filter.line_item === "string" ? [filter.line_item] : [],
  )
}

/**
 * Picks the views that show a line item of `changed`, or filter on one, or have nothing loaded to
 * tell by. The formula errors of a module are left out: they change with the structure only.
 */
function showsAny(changed: ReadonlySet<string>) {
  return (query: Query) => {
    const pivot = pivotOfKey(query.queryKey)
    if (pivot === LINE_ITEM_ERRORS) {
      return false
    }
    const { data } = query.state
    return (
      !isQueryResult(data) ||
      data.line_items.some((item) => changed.has(item.id)) ||
      filteredOn(pivot).some((id) => changed.has(id))
    )
  }
}

/** What the messages of the last moments say has to be read again. */
interface Pending {
  /** The highest sequence number among them. */
  seq: number
  everything: boolean
  structure: boolean
  /** The line items that cells changed in; none if no cells did. */
  lineItems: Set<string> | undefined
}

/**
 * Follows one model over its live socket for as long as it is running, and keeps what the
 * screens loaded of the model current: a change that another user makes is read again, and only
 * where it shows.
 *
 * The sequence numbers are those of one log for all models, and every cell a batch changes takes
 * one too, so the next change of a model is rarely the number after the last: a jump says nothing.
 * Changes that were missed are told by `resync` (the server fell behind), or by a greeting that
 * is past every number heard of (the socket was away). A view says what number it is as of, so a
 * read that was under way when a change was told of, and so may not hold it, is not cancelled but
 * checked once it is done, and read again if it is older than the change.
 *
 * Not done: a socket that goes quiet with no close is not noticed. The server pings every 25
 * seconds, but a browser answers a ping without telling the page, and the server sends no message
 * of its own to count on, so there is nothing for a timer to wait for (parked to M8).
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
  /** When the socket that is open, or being opened, was asked for. */
  private attemptedAt = 0
  /** When the server greeted the open socket. */
  private greetedAt: number | undefined
  /** The highest sequence number heard of, in a greeting or a message. */
  private highest: number | undefined
  private pending: Pending | undefined
  private gatherTimer: ReturnType<typeof setTimeout> | undefined

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
    clearTimeout(this.gatherTimer)
    this.ticketRequest?.abort()
    const socket = this.socket
    if (socket) {
      socket.onmessage = null
      socket.onclose = null
      socket.close(1000)
    }
  }

  private async connect() {
    this.attemptedAt = Date.now()
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
    if (this.stopped) {
      return
    }
    try {
      this.open(ticket)
    } catch (error) {
      this.openFailed(error)
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

  /** The browser would not make the socket. */
  private openFailed(error: unknown) {
    // A page may not open an address of this kind (a ws:// one from an https:// page), and would
    // be refused every time. Another address that does not fit may be mended by the server, so
    // that is tried again.
    if (isRecord(error) && error.name === "SecurityError") {
      this.onStatus("off")
      return
    }
    this.retryIn(this.nextBackoff())
  }

  private ticketRefused(error: unknown) {
    if (error instanceof ApiError) {
      // Nothing a second ticket would change: the session is over, or the model is not the
      // user's to read.
      if (error.status === 401 || error.status === 403 || error.status === 404) {
        this.giveUp()
        return
      }
      // A full box of tickets or sockets says how long to wait; that wait is not a failure.
      if (error.retryAfter !== undefined) {
        this.retryIn(this.waitAsked(error.retryAfter))
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

  /**
   * How long to wait when the server says how long: that long at least, and not for ever. The
   * tabs of a user are all told the same, so each adds a little of its own.
   */
  private waitAsked(seconds: number): number {
    const asked = Math.min(seconds * 1000, RETRY_AFTER_LAST_MS)
    return Math.max(asked, BACKOFF_FIRST_MS) * (1 + Math.random() * JITTER)
  }

  private retryIn(ms: number) {
    this.onStatus("reconnecting")
    this.timer = setTimeout(() => void this.connect(), ms)
  }

  /**
   * Stops following. The model's own query tells whether it is gone, and its screen takes over,
   * unless the user deleted the model just now: the screen is on its way elsewhere then, and a
   * model that is gone is not asked for.
   */
  private giveUp() {
    this.onStatus("off")
    if (!this.deletedHere()) {
      void this.queryClient.invalidateQueries({
        queryKey: queryKeys.model(this.modelId),
        exact: true,
      })
    }
  }

  private deletedHere(): boolean {
    return (
      this.queryClient.getMutationCache().findAll({
        mutationKey: mutationKeys.deleteModel,
        predicate: ({ state }) =>
          isRecord(state.variables) &&
          state.variables.id === this.modelId &&
          state.status !== "error",
      }).length > 0
    )
  }

  private hear(message: Message) {
    const { highest } = this
    const { seq } = message
    this.highest = Math.max(highest ?? seq, seq)
    switch (message.type) {
      case "hello":
        this.greeted(seq, highest)
        break
      case "cells_changed":
        this.gather(seq, (pending) => {
          pending.lineItems ??= new Set()
          for (const id of message.line_item_ids) {
            pending.lineItems.add(id)
          }
        })
        break
      case "structure_changed":
        this.gather(seq, (pending) => {
          pending.structure = true
        })
        break
      case "resync":
        this.gatherEverything(seq)
        break
    }
  }

  /**
   * The server's greeting says how far the model has got. What was loaded earlier is current if
   * it is as far. For the first socket the loaded views say what they are as of; what has no
   * number, the structure and the lists, is current if it was read after the socket was asked
   * for. For a later socket the highest number heard of before the last was lost says it.
   */
  private greeted(seq: number, heard: number | undefined) {
    this.greetedAt = Date.now()
    this.onStatus("live")
    if (heard !== undefined) {
      if (seq > heard) {
        this.gatherEverything(seq)
      }
      return
    }
    const cache = this.queryClient.getQueryCache()
    const views = cache.findAll({ queryKey: queryKeys.query(this.modelId) })
    if (views.some((view) => isQueryResult(view.state.data) && view.state.data.seq < seq)) {
      this.gatherEverything(seq)
      return
    }
    // A read that is under way may have been made before the server began to follow the model.
    void this.readAgainViews((view) => view.state.fetchStatus === "fetching", seq)
    // The model's own query, which holds no part of its structure, is left out.
    const olderThanSocket = (query: Query) =>
      query.queryKey.length > queryKeys.model(this.modelId).length &&
      !views.includes(query) &&
      (query.state.fetchStatus === "fetching" ||
        (query.state.data !== undefined && query.state.dataUpdatedAt < this.attemptedAt))
    void this.queryClient.invalidateQueries({
      queryKey: queryKeys.model(this.modelId),
      predicate: olderThanSocket,
    })
  }

  private gatherEverything(seq: number) {
    this.gather(seq, (pending) => {
      pending.everything = true
    })
  }

  /** Notes what a message says to read again, to be read once with what comes with it. */
  private gather(seq: number, add: (pending: Pending) => void) {
    const pending = (this.pending ??= {
      seq,
      everything: false,
      structure: false,
      lineItems: undefined,
    })
    pending.seq = Math.max(pending.seq, seq)
    add(pending)
    this.gatherTimer ??= setTimeout(() => this.readAgain(), GATHER_MS)
  }

  private readAgain() {
    this.gatherTimer = undefined
    const { pending } = this
    this.pending = undefined
    if (!pending || this.stopped) {
      return
    }
    if (pending.everything) {
      void this.queryClient.invalidateQueries({
        queryKey: queryKeys.model(this.modelId),
        exact: true,
      })
    }
    if (pending.everything || pending.structure) {
      void this.queryClient.invalidateQueries({ queryKey: queryKeys.structure(this.modelId) })
      void this.readAgainViews(() => true, pending.seq)
    } else if (pending.lineItems) {
      void this.readAgainViews(showsAny(pending.lineItems), pending.seq)
    }
  }

  /**
   * Reads again the views that `select` picks. A read that is already under way is let be, which
   * keeps a first load from starting over with each message, but it may have been made before
   * the change, so the views that are on screen are checked once they have loaded: one that is
   * as of an older number than the change is read again.
   */
  private async readAgainViews(select: (view: Query) => boolean, seq: number) {
    const queryKey = queryKeys.query(this.modelId)
    const selected = this.queryClient.getQueryCache().findAll({ queryKey, predicate: select })
    await this.queryClient.invalidateQueries(
      { queryKey, predicate: (view) => selected.includes(view) },
      { cancelRefetch: false },
    )
    if (this.stopped) {
      return
    }
    const older = selected.filter(
      (view) =>
        view.getObserversCount() > 0 && isQueryResult(view.state.data) && view.state.data.seq < seq,
    )
    if (older.length > 0) {
      await this.queryClient.invalidateQueries(
        { queryKey, predicate: (view) => older.includes(view) },
        { cancelRefetch: false },
      )
    }
  }
}

interface Reported {
  modelId: string | undefined
  status: LiveStatus
}

/**
 * Keeps the open model current: another user's edits to cells and structure are read again
 * where they show. Mount it once for the model, where all its screens sit. Without a model, such
 * as while it is still being asked for, nothing is followed.
 */
export function useModelLive(modelId: string | undefined): LiveStatus {
  const queryClient = useQueryClient()
  // The status belongs to the model it was reported for: another model starts over.
  const [reported, setReported] = useState<Reported>({ modelId, status: "connecting" })

  useEffect(() => {
    if (modelId === undefined) {
      return
    }
    const connection = new LiveConnection(modelId, queryClient, (status) =>
      setReported((previous) =>
        previous.modelId === modelId && previous.status === status ? previous : { modelId, status },
      ),
    )
    connection.start()
    return () => connection.stop()
  }, [modelId, queryClient])

  return reported.modelId === modelId ? reported.status : "connecting"
}
