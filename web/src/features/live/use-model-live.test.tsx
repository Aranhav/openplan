import { QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GridQuery, QueryResult } from "@/features/grid/view-types"
import { useDeleteModel } from "@/features/models/api"
import { queryKeys } from "@/lib/api/keys"
import { FakeWebSocket, hello } from "@/test/live"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { makeStructure } from "@/test/structure"
import { MODEL_ID, answer, lineItem, salesQuery, salesView } from "@/test/view-query"
import { type LiveStatus, useModelLive } from "./use-model-live"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const OTHER_MODEL = "0192f3a0-0000-7000-8000-000000000011"
const WORKSPACE = "0192f3a0-0000-7000-8000-000000000002"
const ORIGIN_BLOCK = { rowBlock: 0, colBlock: 0 }
/** A view of another module than the sales one. */
const costsQuery: GridQuery = { ...salesQuery, module: "0192f3a0-0000-7000-8000-000000000021" }
/** How long a connection must last for the server's greeting to count as a good one. */
const STABLE = 11_000
/** How long the messages that come together are gathered before the views are read again. */
const GATHER = 100

type Client = ReturnType<typeof createTestQueryClient>

/** Follows `modelId` (none if null) in a page whose queries are `queryClient`. */
function mount(modelId: string | null = MODEL_ID, queryClient = createTestQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook((id: string | undefined) => useModelLive(id), {
    wrapper,
    initialProps: modelId ?? undefined,
  })
  return { queryClient, ...hook }
}

/** What a view answers: it shows these line items, as of `seq`. */
function viewResult(
  lineItemIds: string[],
  seq: number,
  query: GridQuery = salesQuery,
): QueryResult {
  const fixture = salesView({
    totalRows: 1,
    totalColumns: 1,
    lineItems: lineItemIds.map((id) => lineItem(id, id)),
  })
  const window = { row_offset: 0, row_limit: 1, col_offset: 0, col_limit: 1 }
  return answer(fixture, { ...query, window }, seq)
}

/** Puts the answer of a view in the cache. */
function seedView(
  queryClient: Client,
  query: GridQuery,
  lineItemIds: string[],
  seq = 1,
  modelId = MODEL_ID,
) {
  queryClient.setQueryData(
    queryKeys.query(modelId, query, ORIGIN_BLOCK),
    viewResult(lineItemIds, seq, query),
  )
}

function isInvalidated(queryClient: Client, key: unknown[]) {
  const state = queryClient.getQueryState(key)
  expect(state, `nothing is cached at ${JSON.stringify(key)}`).toBeDefined()
  return state?.isInvalidated
}

const salesKey = (modelId = MODEL_ID) => queryKeys.query(modelId, salesQuery, ORIGIN_BLOCK)
const costsKey = (modelId = MODEL_ID) => queryKeys.query(modelId, costsQuery, ORIGIN_BLOCK)

/** Sends a message from the server on the newest socket. */
function tell(message: Record<string, unknown>) {
  act(() => FakeWebSocket.last.receive(message))
}

function cellsChanged(seq: number, ...lineItemIds: string[]) {
  return { type: "cells_changed", seq, line_item_ids: lineItemIds, user_id: "someone" }
}

function ticketFor(modelId: unknown, ticket = "ticket") {
  return HttpResponse.json({
    ticket,
    url: `wss://plan.test/api/v1/models/${String(modelId)}/live`,
  })
}

/** Answers the requests for a ticket, and notes whose they were. */
function serveTickets() {
  const asked: string[] = []
  server.use(
    http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
      asked.push(String(params.id))
      return ticketFor(params.id, `ticket-${asked.length}`)
    }),
  )
  return asked
}

/** Refuses the first `times` requests for a ticket as the server does when a user holds too many. */
function refuseTickets(seconds: number, times: number) {
  let asked = 0
  server.use(
    http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
      asked += 1
      return asked <= times
        ? problem(429, "auth.rate_limited", "Too many attempts.", {
            headers: { "retry-after": String(seconds) },
          })
        : ticketFor(params.id)
    }),
  )
  return () => asked
}

/** Answers the first request for a ticket as `refuse` says, and the next ones as it should. */
function failTicketOnce(refuse: () => Response) {
  let asked = 0
  server.use(
    http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
      asked += 1
      return asked === 1 ? refuse() : ticketFor(params.id)
    }),
  )
  return () => asked
}

/** The waits ask for no jitter, so that they are as long as they are told to be. */
function withoutJitter() {
  vi.spyOn(Math, "random").mockReturnValue(0)
}

/** A turn of the event loop, which timers faked by the test do not hold up. */
function nextTurn() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * Lets pending requests answer, a turn of the event loop at a time, until `check` holds. Unlike
 * `waitFor` it works with the timers faked, and it does not move them on.
 */
async function until(check: () => boolean) {
  const started = performance.now()
  while (!check() && performance.now() - started < 3000) {
    await act(async () => {
      // What the query library hands to its observers is delivered by a timer of no time at all.
      await vi.advanceTimersByTimeAsync(0)
      await nextTurn()
    })
  }
  expect(check()).toBe(true)
}

async function socketCount(count: number) {
  await until(() => FakeWebSocket.sockets.length === count)
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The time the messages gathered go by, and they are read. */
async function read() {
  await wait(GATHER)
}

/** Opens the first socket and has the server greet it. */
async function connected(seq = 5) {
  const view = mount()
  await socketCount(1)
  tell(hello(seq))
  return view
}

/** The connection is lost, and `after`, the time to the next try, goes by. */
async function lose(after: number, code?: number) {
  act(() => FakeWebSocket.last.drop(code))
  await wait(after)
}

/** A read that finishes when the test says. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The reads that a screen's query asks for, which each finish when the test says. */
function slowReads<T>() {
  const reads: ReturnType<typeof deferred<T>>[] = []
  const signals: AbortSignal[] = []
  const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
    const next = deferred<T>()
    reads.push(next)
    signals.push(signal)
    return next.promise
  })
  return { reads, signals, queryFn }
}

/** Keeps a query as a screen that shows it does: active, and with `data` already loaded. */
function show<T>(
  queryClient: Client,
  queryKey: unknown[],
  queryFn: (context: { signal: AbortSignal }) => Promise<T>,
  data?: T,
) {
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    initialData: data,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return { observer, stop: observer.subscribe(() => {}) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("useModelLive", () => {
  describe("connecting", () => {
    it("asks for a ticket and opens the socket at the address that comes with it", async () => {
      const asked = serveTickets()

      mount()

      await socketCount(1)
      expect(asked).toEqual([MODEL_ID])
      expect(FakeWebSocket.last.url).toBe(
        `wss://plan.test/api/v1/models/${MODEL_ID}/live?ticket=ticket-1`,
      )
    })

    it("says it is connecting until the server has greeted the socket, then that it is live", async () => {
      const { result } = mount()
      expect(result.current).toBe<LiveStatus>("connecting")
      await socketCount(1)
      expect(result.current).toBe<LiveStatus>("connecting")

      tell(hello(5))

      expect(result.current).toBe<LiveStatus>("live")
    })

    it("follows nothing without a model, and starts when there is one", async () => {
      const asked = serveTickets()
      const { result, rerender } = mount(null)

      await wait(5000)

      expect(result.current).toBe<LiveStatus>("connecting")
      expect(asked).toEqual([])
      rerender(MODEL_ID)
      await socketCount(1)
      expect(asked).toEqual([MODEL_ID])
    })

    it("ignores frames that are no message it knows", async () => {
      const { queryClient, result } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5)

      act(() => FakeWebSocket.last.receiveText("not json"))
      act(() => FakeWebSocket.last.receiveText("[1, 2]"))
      tell({ type: "something_new", seq: 9 })
      tell({ type: "cells_changed", seq: "9" })
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      expect(result.current).toBe<LiveStatus>("live")
    })

    it("closes the socket when the screen is left", async () => {
      const { unmount } = mount()
      await socketCount(1)
      tell(hello(5))

      unmount()

      expect(FakeWebSocket.last.closedWith).toBe(1000)
    })

    it("opens no socket for a ticket that arrives after the screen was left", async () => {
      const held = deferred<void>()
      let asked = 0
      server.use(
        http.post("/api/v1/models/:id/live/ticket", async ({ params }) => {
          asked += 1
          await held.promise
          return ticketFor(params.id, "late")
        }),
      )
      const { unmount } = mount()
      await until(() => asked === 1)

      unmount()
      held.resolve()
      await wait(100)

      expect(FakeWebSocket.sockets).toHaveLength(0)
    })

    it("follows another model when the model changes", async () => {
      const asked = serveTickets()
      const { rerender } = mount()
      await socketCount(1)
      tell(hello(5))

      rerender(OTHER_MODEL)

      await socketCount(2)
      expect(FakeWebSocket.sockets[0].closedWith).toBe(1000)
      expect(asked).toEqual([MODEL_ID, OTHER_MODEL])
      expect(FakeWebSocket.last.url).toContain(`/models/${OTHER_MODEL}/live`)
    })

    describe("when the browser will not make the socket", () => {
      function refuseSockets(error: Error) {
        vi.stubGlobal(
          "WebSocket",
          class {
            constructor() {
              throw error
            }
          },
        )
      }

      it("stops for good when the page may not open an address of that kind, with a word in the console and none to the user", async () => {
        const asked = serveTickets()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        refuseSockets(new DOMException("An insecure socket from a secure page.", "SecurityError"))
        const { queryClient, result } = mount()
        queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })

        await until(() => result.current === "off")
        await wait(120_000)

        expect(asked).toHaveLength(1)
        expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(false)
        expect(toast.error).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("An insecure socket from a secure page."))
      })

      it("tries again, as after a lost connection, when the address does not fit", async () => {
        const asked = serveTickets()
        refuseSockets(new DOMException("The address is not valid.", "SyntaxError"))
        const { result } = mount()
        await until(() => result.current === "reconnecting")
        expect(asked).toHaveLength(1)

        await wait(999)
        expect(asked).toHaveLength(1)
        await wait(1)
        await until(() => asked.length === 2)

        expect(result.current).toBe<LiveStatus>("reconnecting")
      })
    })
  })

  describe("a change to cells", () => {
    it("reads again only the views that show a line item that changed", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1", "li-2"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)

      tell(cellsChanged(6, "li-2"))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })

    it("reads again the views that filter on a line item that changed, though they do not show it", async () => {
      const { queryClient } = await connected()
      const filtered: GridQuery = {
        ...costsQuery,
        filters: [{ line_item: "li-9", op: "not_blank" }],
      }
      seedView(queryClient, filtered, ["li-3"], 5)
      seedView(queryClient, salesQuery, ["li-1"], 5)

      tell(cellsChanged(6, "li-9"))
      await read()

      expect(isInvalidated(queryClient, queryKeys.query(MODEL_ID, filtered, ORIGIN_BLOCK))).toBe(
        true,
      )
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
    })

    it("reads again a view that has nothing cached to tell by", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, costsQuery, ["li-3"], 5)
      void queryClient.prefetchQuery({
        queryKey: salesKey(),
        queryFn: () => new Promise<never>(() => {}),
      })

      tell(cellsChanged(6, "li-1"))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })

    it("leaves the views of other models alone", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell(cellsChanged(6, "li-1"))
      await read()

      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
    })

    it("leaves the structure alone", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())

      tell(cellsChanged(6, "li-1"))
      await read()

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
    })
  })

  describe("messages that come together", () => {
    it("are read once, after a moment, whatever they changed", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)
      const invalidate = vi.spyOn(queryClient, "invalidateQueries")

      tell(cellsChanged(6, "li-1"))
      await wait(GATHER / 2)
      tell(cellsChanged(8, "li-3"))
      await wait(GATHER / 2 - 1)

      expect(invalidate).not.toHaveBeenCalled()
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      await wait(1)
      expect(invalidate).toHaveBeenCalledTimes(1)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
    })

    it("are read once for each moment of a stream of changes", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5)
      const invalidate = vi.spyOn(queryClient, "invalidateQueries")

      // Twenty changes in two moments, ten milliseconds apart.
      for (let seq = 6; seq < 26; seq++) {
        tell(cellsChanged(seq, "li-1"))
        await wait(GATHER / 10)
      }

      expect(invalidate).toHaveBeenCalledTimes(2)
    })

    it("read everything if one of them says the structure changed", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)

      tell(cellsChanged(6, "li-1"))
      tell({ type: "structure_changed", seq: 7 })
      await read()

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
    })
  })

  describe("a read that is under way", () => {
    it("is let be, and read again once done if it was made before the change", async () => {
      const { queryClient } = await connected()
      const { reads, signals, queryFn } = slowReads<QueryResult>()
      const { observer } = show(queryClient, salesKey(), queryFn, viewResult(["li-1"], 5))
      void observer.refetch()
      await until(() => reads.length === 1)

      tell(cellsChanged(9, "li-1"))
      await read()

      expect(reads).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)
      reads[0].resolve(viewResult(["li-1"], 5))
      await until(() => reads.length === 2)
      reads[1].resolve(viewResult(["li-1"], 9))
      await wait(1000)
      expect(reads).toHaveLength(2)
      expect(queryClient.getQueryData<QueryResult>(salesKey())?.seq).toBe(9)
    })

    it("is marked stale once done when the last screen to show it left meanwhile", async () => {
      const { queryClient } = await connected()
      const { reads, queryFn } = slowReads<QueryResult>()
      const { observer, stop } = show(queryClient, salesKey(), queryFn, viewResult(["li-1"], 5))
      void observer.refetch()
      await until(() => reads.length === 1)
      tell(cellsChanged(9, "li-1"))
      await read()

      // The library puts a view back as it was before the read when nothing shows it any more,
      // and the change that made it stale is forgotten with the rest.
      stop()
      await wait(1000)

      expect(reads).toHaveLength(1)
      expect(queryClient.getQueryData<QueryResult>(salesKey())?.seq).toBe(5)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
    })

    it("is not read again once done if it holds the change", async () => {
      const { queryClient } = await connected()
      const { reads, queryFn } = slowReads<QueryResult>()
      const { observer } = show(queryClient, salesKey(), queryFn, viewResult(["li-1"], 5))
      void observer.refetch()
      await until(() => reads.length === 1)

      tell(cellsChanged(9, "li-1"))
      await read()
      reads[0].resolve(viewResult(["li-1"], 9))
      await wait(1000)

      expect(reads).toHaveLength(1)
    })

    it("is not started over by each of a stream of changes, a first load least of all", async () => {
      const { queryClient } = await connected()
      const { reads, signals, queryFn } = slowReads<QueryResult>()
      show(queryClient, salesKey(), queryFn)
      await until(() => reads.length === 1)

      for (let seq = 6; seq < 12; seq++) {
        tell(cellsChanged(seq, "li-1"))
        await read()
      }
      reads[0].resolve(viewResult(["li-1"], 11))
      await wait(1000)

      expect(reads).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)
    })
  })

  describe("sequence numbers", () => {
    // The numbers are those of one log for every model, and each changed cell takes one as well,
    // so the next change of a model is rarely the number after the last.
    it("does not take a jump in the numbers for changes it missed", async () => {
      const { queryClient } = await connected(5)
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)

      tell(cellsChanged(40, "li-1"))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })

    it("reads again what a change at or below the highest number it has seen touched", async () => {
      const { queryClient } = await connected(10)
      seedView(queryClient, salesQuery, ["li-1"], 10)
      seedView(queryClient, costsQuery, ["li-3"], 10)

      // Told of after the greeting, though it was made before it.
      tell(cellsChanged(9, "li-1"))
      await read()
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)

      // And a change that is told twice is read for twice.
      queryClient.setQueryData(salesKey(), queryClient.getQueryData(salesKey()))
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      tell(cellsChanged(9, "li-1"))
      await read()
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })
  })

  describe("a change to the structure", () => {
    it("reads again the structure, the items of its lists and every view of the model", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      queryClient.setQueryData(queryKeys.listItems(MODEL_ID, "list-1"), [])
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell({ type: "structure_changed", seq: 6 })
      await read()

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.listItems(MODEL_ID, "list-1"))).toBe(true)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(false)
    })

    it("reads again everything of the model, the model itself too, when told it fell behind", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell({ type: "resync", seq: 80 })
      await read()

      expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
    })
  })

  describe("the first greeting", () => {
    it("reads again everything loaded before a change that the greeting is already past", async () => {
      const { queryClient } = mount()
      seedView(queryClient, salesQuery, ["li-1"], 4)
      seedView(queryClient, costsQuery, ["li-3"], 7)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await socketCount(1)

      tell(hello(7))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
    })

    it("reads nothing again when all that was loaded is as new as the greeting and the socket", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      await wait(5)
      seedView(queryClient, salesQuery, ["li-1"], 7)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      queryClient.setQueryData(queryKeys.listItems(MODEL_ID, "list-1"), [])

      tell(hello(7))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.listItems(MODEL_ID, "list-1"))).toBe(false)
    })

    it("reads again the structure and the lists that were loaded before the socket was asked for", async () => {
      const queryClient = createTestQueryClient()
      queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      queryClient.setQueryData(queryKeys.listItems(MODEL_ID, "list-1"), [])
      seedView(queryClient, salesQuery, ["li-1"], 7)
      await wait(5)
      mount(MODEL_ID, queryClient)
      await socketCount(1)

      tell(hello(7))
      await read()

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.listItems(MODEL_ID, "list-1"))).toBe(true)
      // The views say what number they are as of, and are current. The model's own query holds
      // nothing of what the numbers tell.
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(false)
    })

    it("starts over a read of the structure that is under way, which may have been made before the server followed", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      const { reads, queryFn } = slowReads<ReturnType<typeof makeStructure>>()
      const { observer } = show(
        queryClient,
        queryKeys.structure(MODEL_ID),
        queryFn,
        makeStructure(),
      )
      void observer.refetch()
      await until(() => reads.length === 1)

      tell(hello(7))

      await until(() => reads.length === 2)
    })

    it("checks a view that is being read when the greeting comes, once it is done", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      const { reads, queryFn } = slowReads<QueryResult>()
      show(queryClient, salesKey(), queryFn)
      await until(() => reads.length === 1)

      tell(hello(9))
      await read()
      expect(reads).toHaveLength(1)
      reads[0].resolve(viewResult(["li-1"], 7))

      await until(() => reads.length === 2)
    })
  })

  describe("losing the connection", () => {
    /** The wait before the next try is `ms` and no less: nothing before, a socket at its end. */
    async function reconnectsAfter(ms: number, attempt: number) {
      await wait(ms - 1)
      expect(FakeWebSocket.sockets).toHaveLength(attempt - 1)
      await wait(1)
      await socketCount(attempt)
    }

    it("connects again with a new ticket after 1 s, and waits twice as long after each failure up to 30 s", async () => {
      const asked = serveTickets()
      mount()
      await socketCount(1)

      const waits = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]
      for (const [index, ms] of waits.entries()) {
        act(() => FakeWebSocket.last.drop())
        await reconnectsAfter(ms, index + 2)
      }

      expect(asked).toHaveLength(9)
      expect(FakeWebSocket.sockets.map((socket) => socket.url.split("ticket=")[1])).toEqual(
        Array.from({ length: 9 }, (_, index) => `ticket-${index + 1}`),
      )
    })

    it("strays from each wait by 20 % either way", async () => {
      const random = vi.spyOn(Math, "random")
      mount()
      await socketCount(1)

      random.mockReturnValue(0)
      act(() => FakeWebSocket.last.drop())
      await reconnectsAfter(800, 2)
      tell(hello(1))
      await wait(STABLE)
      random.mockReturnValue(1)
      act(() => FakeWebSocket.last.drop())
      await reconnectsAfter(1200, 3)
    })

    it("starts the waits again once a connection has lasted", async () => {
      mount()
      await socketCount(1)
      await lose(1000)
      await socketCount(2)
      await lose(2000)
      await socketCount(3)
      tell(hello(1))
      await wait(STABLE)

      act(() => FakeWebSocket.last.drop())

      await reconnectsAfter(1000, 4)
    })

    it("does not start the waits again for a connection that is lost soon after the server greeted it", async () => {
      mount()
      await socketCount(1)

      for (const [index, ms] of [1000, 2000, 4000].entries()) {
        tell(hello(1))
        act(() => FakeWebSocket.last.drop())
        await reconnectsAfter(ms, index + 2)
      }
    })

    it("says it is reconnecting from the loss, and that it is live once the new socket is greeted", async () => {
      const { result } = mount()
      await socketCount(1)
      tell(hello(1))
      expect(result.current).toBe<LiveStatus>("live")

      act(() => FakeWebSocket.last.drop())
      expect(result.current).toBe<LiveStatus>("reconnecting")
      await wait(1000)
      await socketCount(2)
      expect(result.current).toBe<LiveStatus>("reconnecting")
      tell(hello(1))
      expect(result.current).toBe<LiveStatus>("live")
    })

    it("says it is reconnecting when the first connection fails, and not before", async () => {
      server.use(http.post("/api/v1/models/:id/live/ticket", () => problem(500, "internal", "No.")))
      const { result } = mount()
      expect(result.current).toBe<LiveStatus>("connecting")

      await until(() => result.current === "reconnecting")
    })

    it.each([
      [1006, "the connection was lost"],
      [1008, "the server found it sent too much"],
      [1012, "the server restarted"],
      [1001, "the server is going away"],
    ])("connects again after code %i (%s)", async (code) => {
      mount()
      await socketCount(1)
      tell(hello(1))

      await lose(1000, code)

      await socketCount(2)
    })

    it("reads everything again when the model moved on while it was away", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      tell(hello(5))
      seedView(queryClient, salesQuery, ["li-1"], 5)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await lose(1000)
      await socketCount(2)

      tell(hello(31))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
    })

    it("reads nothing again when the model is as it was when the connection was lost", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      tell(hello(5))
      tell(cellsChanged(8, "li-1"))
      await read()
      seedView(queryClient, salesQuery, ["li-1"], 8)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await lose(1000)
      await socketCount(2)

      tell(hello(8))
      await read()

      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
    })

    it("stops trying when the screen is left", async () => {
      const asked = serveTickets()
      const { unmount } = mount()
      await socketCount(1)
      act(() => FakeWebSocket.last.drop())

      unmount()
      await wait(120_000)

      expect(asked).toHaveLength(1)
      expect(FakeWebSocket.sockets).toHaveLength(1)
    })

    describe("when the server says to wait", () => {
      it("waits as long as it is told, without a word to the user, and then asks again", async () => {
        withoutJitter()
        const asked = refuseTickets(60, 1)

        const { result } = mount()
        await until(() => asked() === 1)

        expect(result.current).toBe<LiveStatus>("reconnecting")
        await wait(59_999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
        tell(hello(1))
        expect(result.current).toBe<LiveStatus>("live")
        expect(toast.error).not.toHaveBeenCalled()
      })

      it("adds up to a fifth of its own, so that the tabs of a user do not all come at once", async () => {
        vi.spyOn(Math, "random").mockReturnValue(1)
        const asked = refuseTickets(60, 1)
        mount()
        await until(() => asked() === 1)

        await wait(71_999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
      })

      it("does not wait longer than two minutes, whatever it says", async () => {
        withoutJitter()
        const asked = refuseTickets(3600, 1)
        mount()
        await until(() => asked() === 1)

        await wait(119_999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
      })

      it("does not ask again at once of a server that says to wait no time at all", async () => {
        withoutJitter()
        const asked = refuseTickets(0, 1)
        mount()
        await until(() => asked() === 1)

        await wait(999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
      })

      it("does not make the next wait longer for it", async () => {
        withoutJitter()
        const asked = refuseTickets(30, 2)
        mount()
        await until(() => asked() === 1)

        await wait(30_000)
        await until(() => asked() === 2)
        await wait(30_000)
        await socketCount(1)
      })

      it("sends nobody to sign in", async () => {
        refuseTickets(60, 1)
        const { queryClient } = mount()
        queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })

        await wait(1000)

        expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(false)
        expect(queryClient.getQueryCache().findAll()).toHaveLength(1)
      })
    })

    describe("when the ticket cannot be had", () => {
      it.each([
        [500, "internal"],
        [503, "server.busy"],
      ])(
        "tries again after a status %i answer, as it does after a lost connection",
        async (status, code) => {
          const asked = failTicketOnce(() => problem(status, code, "Failed."))
          mount()
          await until(() => asked() === 1)

          await wait(999)
          expect(asked()).toBe(1)
          await wait(1)
          await socketCount(1)
        },
      )

      it("tries again when the server cannot be reached", async () => {
        const asked = failTicketOnce(() => HttpResponse.error())
        mount()
        await until(() => asked() === 1)

        await wait(1000)

        await socketCount(1)
      })
    })
  })

  describe("a model the user may no longer read", () => {
    it.each([
      [4403, "the user was removed from the workspace"],
      [4404, "the model was deleted"],
    ])(
      "stops for code %i (%s) and reads the model again, so that its screen can say it is gone",
      async (code) => {
        const asked = serveTickets()
        const { queryClient, result } = mount()
        await socketCount(1)
        tell(hello(1))
        queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
        queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())

        act(() => FakeWebSocket.last.drop(code))
        await wait(120_000)

        expect(result.current).toBe<LiveStatus>("off")
        expect(asked).toHaveLength(1)
        expect(FakeWebSocket.sockets).toHaveLength(1)
        expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(true)
        // The rest is left to the model's own screen, which is replaced.
        expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
      },
    )

    it.each([
      [401, "auth.unauthenticated"],
      [403, "auth.csrf"],
      [404, "not_found"],
    ])(
      "stops when the ticket is refused with status %i, and reads the model again",
      async (status, code) => {
        let asked = 0
        server.use(
          http.post("/api/v1/models/:id/live/ticket", () => {
            asked += 1
            return problem(status, code, "No.")
          }),
        )
        const { queryClient, result } = mount()
        queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
        await until(() => asked === 1)

        await wait(120_000)

        expect(result.current).toBe<LiveStatus>("off")
        expect(asked).toBe(1)
        expect(FakeWebSocket.sockets).toHaveLength(0)
        expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(true)
      },
    )

    describe("that the user deleted just now", () => {
      // The mutation library and the mock server answer in their own time here, so the clock runs.
      beforeEach(() => {
        vi.useRealTimers()
      })

      /** The model's own query, kept active as its screen keeps it, and a deletion of the model. */
      function deleting() {
        const queryClient = createTestQueryClient()
        const wrapper = ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        )
        const hook = renderHook(
          () => ({ live: useModelLive(MODEL_ID), remove: useDeleteModel() }),
          { wrapper },
        )
        const reads = vi.fn(() => Promise.reject(new Error("The model was asked for.")))
        show(queryClient, queryKeys.model(MODEL_ID), reads, { id: MODEL_ID })
        return { reads, ...hook }
      }

      async function greeted() {
        await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
        tell(hello(1))
      }

      const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

      it("is not asked for again when the server says it is gone before it answers the deletion", async () => {
        const answered = deferred<void>()
        server.use(
          http.delete("/api/v1/models/:id", async () => {
            await answered.promise
            return new HttpResponse(null, { status: 204 })
          }),
        )
        const { result, reads } = deleting()
        await greeted()

        act(() => result.current.remove.mutate({ id: MODEL_ID, workspace_id: WORKSPACE }))
        await waitFor(() => expect(result.current.remove.isPending).toBe(true))
        act(() => FakeWebSocket.last.drop(4404))
        answered.resolve()
        await waitFor(() => expect(result.current.remove.isSuccess).toBe(true))
        await later(100)

        expect(result.current.live).toBe<LiveStatus>("off")
        expect(reads).not.toHaveBeenCalled()
      })

      it("is not asked for again when the server says it is gone after it answered the deletion", async () => {
        server.use(http.delete("/api/v1/models/:id", () => new HttpResponse(null, { status: 204 })))
        const { result, reads } = deleting()
        await greeted()

        act(() => result.current.remove.mutate({ id: MODEL_ID, workspace_id: WORKSPACE }))
        await waitFor(() => expect(result.current.remove.isSuccess).toBe(true))
        act(() => FakeWebSocket.last.drop(4404))
        await later(100)

        expect(reads).not.toHaveBeenCalled()
      })

      it("is asked for again when it was not the user who deleted it", async () => {
        const { reads } = deleting()
        await greeted()

        act(() => FakeWebSocket.last.drop(4404))

        await waitFor(() => expect(reads).toHaveBeenCalledTimes(1))
      })
    })
  })
})
