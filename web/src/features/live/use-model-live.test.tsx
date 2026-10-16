import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { FakeWebSocket, hello } from "@/test/live"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { makeStructure } from "@/test/structure"
import { MODEL_ID, answer, lineItem, salesQuery, salesView } from "@/test/view-query"
import type { GridQuery } from "@/features/grid/view-types"
import { type LiveStatus, useModelLive } from "./use-model-live"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const OTHER_MODEL = "0192f3a0-0000-7000-8000-000000000011"
/** How long a connection must last for the server's greeting to count as a good one. */
const STABLE = 11_000
const ORIGIN_BLOCK = { rowBlock: 0, colBlock: 0 }
/** A view of another module than the sales one. */
const costsQuery: GridQuery = { ...salesQuery, module: "0192f3a0-0000-7000-8000-000000000021" }

function mount(modelId = MODEL_ID) {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook((id: string) => useModelLive(id), { wrapper, initialProps: modelId })
  return { queryClient, ...hook }
}

/** The answer a view has cached: it shows these line items, as of `seq`. */
function seedView(
  queryClient: ReturnType<typeof mount>["queryClient"],
  query: GridQuery,
  lineItemIds: string[],
  seq = 1,
  modelId = MODEL_ID,
) {
  const fixture = salesView({
    totalRows: 1,
    totalColumns: 1,
    lineItems: lineItemIds.map((id) => lineItem(id, id)),
  })
  const window = { row_offset: 0, row_limit: 1, col_offset: 0, col_limit: 1 }
  queryClient.setQueryData(
    queryKeys.query(modelId, query, ORIGIN_BLOCK),
    answer(fixture, { ...query, window }, seq),
  )
}

function isInvalidated(queryClient: ReturnType<typeof mount>["queryClient"], key: unknown[]) {
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

/** A request for a ticket, as the server's ticket endpoint will answer it. */
function serveTickets() {
  const asked: { at: number; modelId: string }[] = []
  let issued = 0
  server.use(
    http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
      issued += 1
      asked.push({ at: Date.now(), modelId: String(params.id) })
      return HttpResponse.json({
        ticket: `ticket-${issued}`,
        url: `wss://plan.test/api/v1/models/${String(params.id)}/live`,
      })
    }),
  )
  return asked
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
 * `waitFor` it works with the timers faked, and it does not move them.
 */
async function until(check: () => boolean) {
  const started = performance.now()
  while (!check() && performance.now() - started < 3000) {
    await act(nextTurn)
  }
  expect(check()).toBe(true)
}

async function socketCount(count: number) {
  await until(() => FakeWebSocket.sockets.length === count)
}

/** Opens the first socket and has the server greet it. */
async function connected(seq = 5) {
  const view = mount()
  await socketCount(1)
  tell(hello(seq))
  return view
}

describe("useModelLive", () => {
  describe("connecting", () => {
    it("asks for a ticket and opens the socket at the address that comes with it", async () => {
      const asked = serveTickets()

      mount()

      await socketCount(1)
      expect(asked.map((ask) => ask.modelId)).toEqual([MODEL_ID])
      expect(FakeWebSocket.last.url).toBe(
        `wss://plan.test/api/v1/models/${MODEL_ID}/live?ticket=ticket-1`,
      )
    })

    it("says it is reconnecting until the server has greeted it, then that it is live", async () => {
      const { result } = mount()
      expect(result.current).toBe<LiveStatus>("reconnecting")
      await socketCount(1)
      expect(result.current).toBe<LiveStatus>("reconnecting")

      tell(hello(5))

      expect(result.current).toBe<LiveStatus>("live")
    })

    it("ignores frames that are no message it knows", async () => {
      const { queryClient, result } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5)

      act(() => FakeWebSocket.last.receiveText("not json"))
      act(() => FakeWebSocket.last.receiveText("[1, 2]"))
      tell({ type: "something_new", seq: 9 })
      tell({ type: "cells_changed", seq: "9" })

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
      let asked = 0
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.post("/api/v1/models/:id/live/ticket", async () => {
          asked += 1
          await held
          return HttpResponse.json({ ticket: "late", url: "wss://plan.test/live" })
        }),
      )
      const { unmount } = mount()
      await waitFor(() => expect(asked).toBe(1))

      unmount()
      release()
      await new Promise((resolve) => setTimeout(resolve, 30))

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
      expect(asked.map((ask) => ask.modelId)).toEqual([MODEL_ID, OTHER_MODEL])
      expect(FakeWebSocket.last.url).toContain(`/models/${OTHER_MODEL}/live`)
    })
  })

  describe("a change to cells", () => {
    it("reads again only the views that show a line item that changed", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1", "li-2"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)

      tell(cellsChanged(6, "li-2"))

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

      expect(isInvalidated(queryClient, queryKeys.query(MODEL_ID, filtered, ORIGIN_BLOCK))).toBe(
        true,
      )
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
    })

    it("reads again a view that has nothing cached to tell by", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(salesKey(), undefined)
      seedView(queryClient, costsQuery, ["li-3"], 5)
      const fetching = vi.fn(() => new Promise<never>(() => {}))
      void queryClient.prefetchQuery({ queryKey: salesKey(), queryFn: fetching })
      await waitFor(() => expect(fetching).toHaveBeenCalled())

      tell(cellsChanged(6, "li-1"))

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })

    it("reads the line items of the module's formula errors too", async () => {
      const { queryClient } = await connected()
      const errorsKey = queryKeys.query(MODEL_ID, "line-item-errors", "module-1")
      const fixture = salesView({
        totalRows: 1,
        totalColumns: 1,
        lineItems: [lineItem("li-1", "Units")],
      })
      queryClient.setQueryData(
        errorsKey,
        answer(
          fixture,
          { ...salesQuery, window: { row_offset: 0, row_limit: 1, col_offset: 0, col_limit: 1 } },
          5,
        ),
      )

      tell(cellsChanged(6, "li-1"))

      expect(isInvalidated(queryClient, errorsKey)).toBe(true)
    })

    it("leaves the views of other models alone", async () => {
      const { queryClient } = await connected()
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell(cellsChanged(6, "li-1"))

      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
    })

    it("leaves the structure alone", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())

      tell(cellsChanged(6, "li-1"))

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
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

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })

    it("reads again what a change at or below the highest number it has seen touched", async () => {
      const { queryClient } = await connected(10)
      seedView(queryClient, salesQuery, ["li-1"], 10)
      seedView(queryClient, costsQuery, ["li-3"], 10)

      // Told of after the greeting, though it was made before it.
      tell(cellsChanged(9, "li-1"))
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)

      // And a change that is told twice is read for twice.
      queryClient.setQueryData(salesKey(), queryClient.getQueryData(salesKey()))
      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      tell(cellsChanged(9, "li-1"))
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(false)
    })
  })

  describe("a change to the structure", () => {
    it("reads again the structure, the items of its lists and every view of the model", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      queryClient.setQueryData(queryKeys.listItems(MODEL_ID, "list-1"), [])
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, costsQuery, ["li-3"], 5)
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell({ type: "structure_changed", seq: 6 })

      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.listItems(MODEL_ID, "list-1"))).toBe(true)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
    })

    it("reads again everything of the model, the model itself too, when told it fell behind", async () => {
      const { queryClient } = await connected()
      queryClient.setQueryData(queryKeys.model(MODEL_ID), { id: MODEL_ID })
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      seedView(queryClient, salesQuery, ["li-1"], 5)
      seedView(queryClient, salesQuery, ["li-1"], 5, OTHER_MODEL)

      tell({ type: "resync", seq: 80 })

      expect(isInvalidated(queryClient, queryKeys.model(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, salesKey(OTHER_MODEL))).toBe(false)
    })
  })

  describe("the first greeting", () => {
    it("reads again what was loaded before a change that the greeting is already past", async () => {
      const { queryClient } = mount()
      seedView(queryClient, salesQuery, ["li-1"], 4)
      seedView(queryClient, costsQuery, ["li-3"], 7)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await socketCount(1)

      tell(hello(7))

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, costsKey())).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
    })

    it("reads nothing again when everything loaded is as new as the greeting", async () => {
      const { queryClient } = mount()
      seedView(queryClient, salesQuery, ["li-1"], 7)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await socketCount(1)

      tell(hello(7))

      expect(isInvalidated(queryClient, salesKey())).toBe(false)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(false)
    })
  })

  describe("losing the connection", () => {
    /** How long the hook asks each of its timers to wait. */
    let delays: number[]

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      vi.spyOn(Math, "random").mockReturnValue(0.5)
      delays = []
      const setTimer = globalThis.setTimeout
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler, ms, ...args) => {
        // The libraries set timers too; the hook's are those set from its own file.
        if (typeof ms === "number" && /use-model-live\.ts:/.test(new Error().stack ?? "")) {
          delays.push(ms)
        }
        return setTimer(handler, ms, ...args)
      }) as typeof setTimeout)
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
    })

    async function wait(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

    /** The connection is lost, and the time the hook waits before the next try goes by. */
    async function lose(code?: number) {
      act(() => FakeWebSocket.last.drop(code))
      await wait(delays.at(-1) ?? 0)
    }

    it("connects again with a new ticket after 1 s, and waits twice as long after each failure up to 30 s", async () => {
      const asked = serveTickets()
      mount()
      await socketCount(1)

      for (let attempt = 2; attempt <= 9; attempt++) {
        await lose()
        await socketCount(attempt)
      }

      expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
      expect(asked).toHaveLength(9)
      expect(FakeWebSocket.sockets.map((socket) => socket.url.split("ticket=")[1])).toEqual(
        Array.from({ length: 9 }, (_, index) => `ticket-${index + 1}`),
      )
    })

    it("does not connect before the wait is over", async () => {
      const asked = serveTickets()
      mount()
      await socketCount(1)

      act(() => FakeWebSocket.last.drop())
      await wait(999)

      expect(asked).toHaveLength(1)
      await wait(1)
      await socketCount(2)
    })

    it("strays from each wait by 20 % either way", async () => {
      const random = vi.spyOn(Math, "random")
      mount()
      await socketCount(1)

      random.mockReturnValue(0)
      await lose()
      await socketCount(2)
      tell(hello(1))
      await wait(STABLE)
      random.mockReturnValue(1)
      await lose()

      expect(delays).toEqual([800, 1200])
    })

    it("starts the waits again once a connection has lasted", async () => {
      mount()
      await socketCount(1)
      await lose()
      await socketCount(2)
      await lose()
      await socketCount(3)
      tell(hello(1))
      await wait(STABLE)

      await lose()

      expect(delays).toEqual([1000, 2000, 1000])
    })

    it("does not start the waits again for a connection that is lost soon after the server greeted it", async () => {
      mount()
      await socketCount(1)

      for (let attempt = 2; attempt <= 4; attempt++) {
        tell(hello(1))
        await lose()
        await socketCount(attempt)
      }

      expect(delays).toEqual([1000, 2000, 4000])
    })

    it("says it is reconnecting until the server has greeted the new socket", async () => {
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

    it.each([
      [1006, "the connection was lost"],
      [1008, "the server found it sent too much"],
      [1012, "the server restarted"],
      [1001, "the server is going away"],
    ])("connects again after code %i (%s)", async (code) => {
      mount()
      await socketCount(1)
      tell(hello(1))

      await lose(code)

      await socketCount(2)
    })

    it("reads everything again when the model moved on while it was away", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      tell(hello(5))
      seedView(queryClient, salesQuery, ["li-1"], 5)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await lose()
      await socketCount(2)

      tell(hello(31))

      expect(isInvalidated(queryClient, salesKey())).toBe(true)
      expect(isInvalidated(queryClient, queryKeys.structure(MODEL_ID))).toBe(true)
    })

    it("reads nothing again when the model is as it was when the connection was lost", async () => {
      const { queryClient } = mount()
      await socketCount(1)
      tell(hello(5))
      tell(cellsChanged(8, "li-1"))
      seedView(queryClient, salesQuery, ["li-1"], 8)
      queryClient.setQueryData(queryKeys.structure(MODEL_ID), makeStructure())
      await lose()
      await socketCount(2)

      tell(hello(8))

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
      function refuseTicketsFor(seconds: number, times: number) {
        let asked = 0
        server.use(
          http.post("/api/v1/models/:id/live/ticket", ({ params }) => {
            asked += 1
            if (asked <= times) {
              return problem(429, "auth.rate_limited", "Too many attempts.", {
                headers: { "retry-after": String(seconds) },
              })
            }
            return HttpResponse.json({
              ticket: "ticket",
              url: `wss://plan.test/api/v1/models/${String(params.id)}/live`,
            })
          }),
        )
        return () => asked
      }

      it("waits as long as it is told, without a word to the user, and then asks again", async () => {
        const asked = refuseTicketsFor(60, 1)

        const { result } = mount()
        await until(() => asked() === 1)

        expect(result.current).toBe<LiveStatus>("reconnecting")
        await wait(59_999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
        expect(delays).toEqual([60_000])
        tell(hello(1))
        expect(result.current).toBe<LiveStatus>("live")
        expect(toast.error).not.toHaveBeenCalled()
      })

      it("does not make the next wait longer for it", async () => {
        const asked = refuseTicketsFor(30, 2)
        mount()
        await until(() => asked() === 1)

        await wait(30_000)
        await until(() => asked() === 2)
        await wait(30_000)
        await socketCount(1)

        expect(delays).toEqual([30_000, 30_000])
      })

      it("does not ask again at once of a server that says to wait no time at all", async () => {
        const asked = refuseTicketsFor(0, 1)
        mount()
        await until(() => asked() === 1)

        await wait(999)
        expect(asked()).toBe(1)
        await wait(1)
        await socketCount(1)
      })

      it("sends nobody to sign in", async () => {
        refuseTicketsFor(60, 1)
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
          let asked = 0
          server.use(
            http.post("/api/v1/models/:id/live/ticket", () => {
              asked += 1
              return asked === 1
                ? problem(status, code, "Failed.")
                : HttpResponse.json({ ticket: "t", url: "wss://plan.test/live" })
            }),
          )
          mount()
          await until(() => asked === 1)

          await wait(999)
          expect(asked).toBe(1)
          await wait(1)
          await socketCount(1)
        },
      )

      it("tries again when the server cannot be reached", async () => {
        let asked = 0
        server.use(
          http.post("/api/v1/models/:id/live/ticket", () => {
            asked += 1
            return asked === 1
              ? HttpResponse.error()
              : HttpResponse.json({ ticket: "t", url: "wss://plan.test/live" })
          }),
        )
        mount()
        await until(() => asked === 1)

        await wait(1000)

        await socketCount(1)
      })
    })
  })

  describe("a model the user may no longer read", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function wait(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    }

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
  })
})
