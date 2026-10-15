import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { HttpResponse, delay, http } from "msw"
import { describe, expect, it } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { problem } from "@/test/problem"
import {
  MODEL_ID,
  answer,
  failViewQuery,
  header,
  member,
  numberCell,
  salesQuery,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import { windowOf } from "./core/blocks"
import type { CellRange } from "./core/selection"
import { useViewData } from "./use-view-data"
import type { GridQuery, ViewQuery } from "./view-types"

function wrapper() {
  const queryClient = createTestQueryClient({ staleTime: QUERY_STALE_TIME })
  return {
    queryClient,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  }
}

const topLeft: CellRange = { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 5 }

function windows(requests: { window: { row_offset: number; col_offset: number } }[]) {
  return requests.map((r) => `${r.window.row_offset / 100},${r.window.col_offset / 40}`).sort()
}

describe("useViewData", () => {
  it("reads the size and dimensions of the view from the first block", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    expect(result.current.hasShape).toBe(false)
    await waitFor(() => expect(result.current.hasShape).toBe(true))
    expect(result.current).toMatchObject({
      totalRows: 1000,
      totalColumns: 50,
      isPlaceholder: false,
      error: null,
    })
    expect(result.current.rowDims).toEqual(served.fixture.rowDims)
    expect(result.current.columnDims).toEqual(served.fixture.columnDims)
    expect(served.requests[0]).toEqual({
      ...salesQuery,
      window: { row_offset: 0, row_limit: 100, col_offset: 0, col_limit: 40 },
    })
  })

  it("reports a query the server refuses, with no shape", async () => {
    failViewQuery("Unknown dimension.")
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.hasShape).toBe(false)
    expect(result.current.error).toMatchObject({ status: 422, detail: "Unknown dimension." })
  })

  it("fetches the blocks that hold the visible cells and one block around them", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(served.requests).toHaveLength(4))
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(windows(served.requests)).toEqual(["0,0", "0,1", "1,0", "1,1"])
  })

  it("asks for the first block alone until it knows how big the view is", async () => {
    const requests: ViewQuery[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        requests.push(query)
        await gate
        return HttpResponse.json(answer(salesView(), query))
      }),
    )
    const { Wrapper } = wrapper()

    renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), { wrapper: Wrapper })

    await waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(windows(requests)).toEqual(["0,0"])
    release()
    await waitFor(() => expect(requests).toHaveLength(4))
  })

  it("follows the visible range down the grid, keeping the first block for the totals", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const middle: CellRange = { rowStart: 250, rowEnd: 270, colStart: 5, colEnd: 9 }

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, middle), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(250, 5)).toBeDefined())
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(windows(served.requests)).toEqual(["0,0", "1,0", "1,1", "2,0", "2,1", "3,0", "3,1"])
  })

  it("does not ask for blocks past the end of the view", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const end: CellRange = { rowStart: 950, rowEnd: 999, colStart: 45, colEnd: 49 }

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, end), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(999, 49)).toBeDefined())
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(windows(served.requests)).toEqual(["0,0", "8,0", "8,1", "9,0", "9,1"])
  })

  it("looks cells and headers up by their position in the whole view", async () => {
    const { fixture } = serveViewQuery()
    const { Wrapper } = wrapper()
    const visible: CellRange = { rowStart: 120, rowEnd: 130, colStart: 41, colEnd: 45 }

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, visible), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(125, 43)).toBeDefined())
    expect(result.current.cell(125, 43)).toEqual(fixture.cell(125, 43))
    expect(result.current.rowHeaders(125)).toEqual(fixture.rowHeader(125))
    expect(result.current.colHeaders(43)).toEqual(fixture.columnHeader(43))
    expect(result.current.totalRows).toBe(1000)
    expect(result.current.totalColumns).toBe(50)
  })

  it("has nothing for a cell whose block has not loaded", async () => {
    serveViewQuery()
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())
    expect(result.current.cell(700, 3)).toBeUndefined()
    expect(result.current.rowHeaders(700)).toBeUndefined()
    expect(result.current.colHeaders(700)).toBeUndefined()
  })

  it("lists the line items of the view once", async () => {
    const { fixture } = serveViewQuery()
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(result.current.lineItems).toHaveLength(fixture.lineItems.length))
  })

  it("passes the pages of the view on", async () => {
    const pages = [
      {
        dim: { kind: "time" as const },
        member: {
          key: "Jan 26",
          label: "Jan 26",
          depth: 0,
          is_summary: false,
          has_children: false,
          collapsed: false,
        },
      },
    ]
    serveViewQuery(salesView({ pages }))
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.hasShape).toBe(true))
    expect(result.current.pages).toEqual(pages)
  })

  it("shows the cells and headers of the previous query, as a placeholder, while the next one loads", async () => {
    serveViewQuery()
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ query }: { query: GridQuery }) => useViewData(MODEL_ID, query, topLeft),
      { wrapper: Wrapper, initialProps: { query: salesQuery } },
    )
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())

    rerender({ query: { ...salesQuery, show_summaries: false } })

    expect(result.current.isPlaceholder).toBe(true)
    expect(result.current.totalRows).toBe(1000)
    expect(result.current.cell(0, 0)?.value).toEqual({ t: "number", v: 0 })
    expect(result.current.rowHeaders(0)?.members[0].label).toBe("Product 1")
    expect(result.current.colHeaders(0)?.members[1].label).toBe("Line item 0")
    expect(result.current.lineItems).toHaveLength(25)
    await waitFor(() => expect(result.current.isPlaceholder).toBe(false))
    expect(result.current.cell(0, 0)).toBeDefined()
  })

  it("gives the greatest depth of the rows that have loaded, for each row dimension", async () => {
    serveViewQuery(
      salesView({
        rowDims: [{ kind: "list", list: "a" }, { kind: "time" }],
        rowHeader: (row) =>
          header(
            member(`a${row}`, "A", { depth: row % 2 }),
            member(`t${row}`, "T", { depth: row % 4 }),
          ),
      }),
    )
    const { Wrapper } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.rowMaxDepth).toEqual([1, 3]))
  })

  it("keys each block under the model's query key", async () => {
    serveViewQuery()
    const { Wrapper, queryClient } = wrapper()

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())
    expect(
      queryClient.getQueryCache().findAll({ queryKey: queryKeys.query(MODEL_ID) }),
    ).toHaveLength(4)
    expect(
      queryClient.getQueryData(queryKeys.query(MODEL_ID, salesQuery, { rowBlock: 0, colBlock: 0 })),
    ).toBeDefined()
  })

  it("loads again when the model's queries are invalidated", async () => {
    const served = serveViewQuery()
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))
    served.fixture = salesView({ cell: () => ({ value: { t: "number", v: 7 }, flags: ["input"] }) })

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.query(MODEL_ID) }))

    await waitFor(() =>
      expect(result.current.cell(3, 3)).toEqual({ value: { t: "number", v: 7 }, flags: ["input"] }),
    )
    expect(served.requests).toHaveLength(8)
  })

  it("reports a block that failed and loads it again on refetch", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    failViewQuery("The model is busy.")

    await act(() => result.current.refetch())

    await waitFor(() =>
      expect(result.current.error).toMatchObject({ detail: "The model is busy." }),
    )
    expect(result.current.cell(0, 0)).toBeDefined()
    serveViewQuery(served.fixture)

    await act(() => result.current.refetch())

    await waitFor(() => expect(result.current.error).toBeNull())
  })
})

describe("useViewData settling and caching", () => {
  const far: CellRange = { rowStart: 500, rowEnd: 520, colStart: 0, colEnd: 5 }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Answers every block after `ms`, and records whether the browser gave up on it. */
  function serveSlowly(ms: number) {
    const seen: { key: string; aborted: boolean }[] = []
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        const entry = { key: windows([query])[0], aborted: false }
        seen.push(entry)
        request.signal.addEventListener("abort", () => {
          entry.aborted = true
        })
        await delay(ms)
        return HttpResponse.json(answer(salesView(), query))
      }),
    )
    return seen
  }

  it("does not ask for the blocks next to the view when it moves on before they settle", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ visible }: { visible: CellRange }) => useViewData(MODEL_ID, salesQuery, visible),
      { wrapper: Wrapper, initialProps: { visible: topLeft } },
    )
    await waitFor(() => expect(result.current.hasShape).toBe(true), { interval: 2 })

    rerender({ visible: far })
    await waitFor(() => expect(result.current.cell(500, 0)).toBeDefined())
    await wait(250)

    // The blocks that were next to the top left never left the settling, so they cost nothing.
    expect(windows(served.requests)).toEqual(["0,0", "4,0", "4,1", "5,0", "5,1", "6,0", "6,1"])
  })

  it("asks at once for the blocks that hold what is visible", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const visible: CellRange = { rowStart: 250, rowEnd: 270, colStart: 5, colEnd: 9 }

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, visible), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(250, 5)).toBeDefined())
    expect(windows(served.requests)).toContain("2,0")
  })

  it("cancels the requests of blocks the view has left", async () => {
    const seen = serveSlowly(400)
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ visible }: { visible: CellRange }) => useViewData(MODEL_ID, salesQuery, visible),
      { wrapper: Wrapper, initialProps: { visible: topLeft } },
    )
    await waitFor(() => expect(result.current.hasShape).toBe(true), { timeout: 3000 })
    await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(4), { timeout: 3000 })

    rerender({ visible: far })

    await waitFor(
      () => {
        const left = seen.filter((entry) => ["0,1", "1,0", "1,1"].includes(entry.key))
        expect(left).toHaveLength(3)
        expect(left.every((entry) => entry.aborted)).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it("loads nothing again when the view goes away and comes back", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ visible }: { visible: CellRange }) => useViewData(MODEL_ID, salesQuery, visible),
      { wrapper: Wrapper, initialProps: { visible: topLeft } },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))
    rerender({ visible: far })
    await waitFor(() => expect(result.current.cell(500, 0)).toBeDefined())
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    const after = served.requests.length

    rerender({ visible: topLeft })
    await wait(250)

    expect(result.current.cell(0, 0)).toBeDefined()
    expect(result.current.cell(150, 0)).toBeDefined()
    expect(served.requests).toHaveLength(after)
  })

  it("never asks for the same block twice, however many views want it", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()

    const { result, rerender } = renderHook(
      ({ visible }: { visible: CellRange }) => [
        useViewData(MODEL_ID, salesQuery, visible),
        useViewData(MODEL_ID, salesQuery, topLeft),
      ],
      { wrapper: Wrapper, initialProps: { visible: topLeft } },
    )
    await waitFor(() => expect(result.current[0].isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))
    rerender({ visible: { ...topLeft, rowEnd: 30, colEnd: 8 } })
    await wait(250)

    const asked = windows(served.requests)
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked).toEqual(["0,0", "0,1", "1,0", "1,1"])
  })
})

describe("useViewData consistency", () => {
  const originKey = { rowBlock: 0, colBlock: 0 }
  const isOrigin = (query: ViewQuery) =>
    query.window.row_offset === 0 && query.window.col_offset === 0

  it("never blanks a block when the first block arrives after it", async () => {
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        if (isOrigin(query)) {
          await delay(300)
        }
        return HttpResponse.json(answer(salesView(), query, isOrigin(query) ? 2 : 1))
      }),
    )
    const { Wrapper } = wrapper()
    const visible: CellRange = { rowStart: 150, rowEnd: 170, colStart: 0, colEnd: 5 }
    const showed: boolean[] = []

    const { result } = renderHook(
      () => {
        const data = useViewData(MODEL_ID, salesQuery, visible)
        showed.push(data.cell(150, 0) !== undefined)
        return data
      },
      { wrapper: Wrapper },
    )
    await waitFor(() => expect(result.current.cell(150, 0)).toBeDefined())
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined(), { timeout: 3000 })

    expect(showed.slice(showed.indexOf(true)).every(Boolean)).toBe(true)
  })

  it("shows a block again after only that block was loaded again", async () => {
    const served = serveViewQuery()
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))
    served.seq = 2

    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.query(MODEL_ID, salesQuery, { rowBlock: 1, colBlock: 0 }),
        exact: true,
      }),
    )

    await waitFor(() => expect(served.requests).toHaveLength(5))
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    for (const [row, col] of [
      [0, 0],
      [0, 41],
      [150, 0],
      [150, 41],
    ]) {
      expect(result.current.cell(row, col), `cell ${row}, ${col}`).toBeDefined()
    }
  })

  it("shows a first block from the cache and a block that was just loaded together", async () => {
    const served = serveViewQuery()
    served.seq = 5
    const { Wrapper, queryClient } = wrapper()
    queryClient.setQueryData(
      queryKeys.query(MODEL_ID, salesQuery, originKey),
      answer(salesView(), { ...salesQuery, window: windowOf(originKey) }, 1),
    )
    const visible: CellRange = { rowStart: 150, rowEnd: 170, colStart: 0, colEnd: 5 }

    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, visible), {
      wrapper: Wrapper,
    })

    await waitFor(() => expect(result.current.cell(150, 0)).toBeDefined())
    expect(result.current.cell(0, 0)).toBeDefined()
    expect(windows(served.requests)).not.toContain("0,0")
  })

  it("loads the blocks of an older shape again when rows were added", async () => {
    const served = serveViewQuery()
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))
    served.fixture = salesView({ totalRows: 1100 })

    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.query(MODEL_ID, salesQuery, originKey),
        exact: true,
      }),
    )

    await waitFor(() => expect(result.current.totalRows).toBe(1100))
    // The first block again, then the three blocks that still describe 1,000 rows.
    await waitFor(() => expect(served.requests).toHaveLength(8))
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(windows(served.requests).sort()).toEqual([
      "0,0",
      "0,0",
      "0,1",
      "0,1",
      "1,0",
      "1,0",
      "1,1",
      "1,1",
    ])
    for (const [row, col] of [
      [0, 41],
      [150, 0],
      [150, 41],
    ]) {
      expect(result.current.cell(row, col), `cell ${row}, ${col}`).toBeDefined()
    }
  })

  it("hands out one object for a line item however many blocks list it", async () => {
    serveViewQuery()
    const { Wrapper } = wrapper()
    const identities = new Set<unknown>()

    const { result } = renderHook(
      () => {
        const data = useViewData(MODEL_ID, salesQuery, topLeft)
        if (data.lineItems[0]) {
          identities.add(data.lineItems[0])
        }
        return data
      },
      { wrapper: Wrapper },
    )

    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(result.current.cell(0, 41)).toBeDefined())
    expect(identities.size).toBe(1)
  })
})

describe("useViewData while the view changes", () => {
  const far: CellRange = { rowStart: 500, rowEnd: 520, colStart: 0, colEnd: 5 }
  const changed: GridQuery = { ...salesQuery, show_summaries: false }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** The changed query answers with negative numbers, and its row block 5 after `lateMs`. */
  function serveChange({ lateMs = 0, fail = false } = {}) {
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        if (query.show_summaries !== false) {
          return HttpResponse.json(answer(salesView(), query))
        }
        if (fail) {
          return problem(422, "structure.invalid", "The change is not valid.")
        }
        if (query.window.row_offset === 500) {
          await delay(lateMs)
        }
        const fixture = salesView({ cell: (row, col) => numberCell(-(row * 1000 + col)) })
        return HttpResponse.json(answer(fixture, query))
      }),
    )
  }

  it("keeps the previous view until the blocks that hold the visible cells have loaded too", async () => {
    serveChange({ lateMs: 400 })
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ query }: { query: GridQuery }) => useViewData(MODEL_ID, query, far),
      { wrapper: Wrapper, initialProps: { query: salesQuery } },
    )
    await waitFor(() => expect(result.current.cell(505, 0)).toBeDefined())
    expect(result.current.cell(505, 0)?.value).toEqual({ t: "number", v: 505000 })

    rerender({ query: changed })
    await wait(150)

    // The first block of the changed query is in; the block with the visible cells is not.
    expect(result.current.isPlaceholder).toBe(true)
    expect(result.current.cell(505, 0)?.value).toEqual({ t: "number", v: 505000 })
    await waitFor(() => expect(result.current.isPlaceholder).toBe(false), { timeout: 3000 })
    expect(result.current.cell(505, 0)?.value).toEqual({ t: "number", v: -505000 })
  })

  it("shows skeletons, not the previous view, for a block of the same query that has not loaded", async () => {
    serveViewQuery()
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ visible }: { visible: CellRange }) => useViewData(MODEL_ID, salesQuery, visible),
      { wrapper: Wrapper, initialProps: { visible: topLeft } },
    )
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())

    rerender({ visible: far })

    expect(result.current.isPlaceholder).toBe(false)
    expect(result.current.cell(505, 0)).toBeUndefined()
    await waitFor(() => expect(result.current.cell(505, 0)).toBeDefined())
  })

  it("keeps the previous view, not dimmed, beside the error when the changed query fails", async () => {
    serveChange({ fail: true })
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ query }: { query: GridQuery }) => useViewData(MODEL_ID, query, topLeft),
      { wrapper: Wrapper, initialProps: { query: salesQuery } },
    )
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())

    rerender({ query: changed })

    await waitFor(() => expect(result.current.error?.message).toBe("The change is not valid."))
    expect(result.current.hasShape).toBe(true)
    expect(result.current.isPlaceholder).toBe(false)
    expect(result.current.cell(0, 0)?.value).toEqual({ t: "number", v: 0 })
  })

  it("shows the changed view once a retry succeeds", async () => {
    serveChange({ fail: true })
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ query }: { query: GridQuery }) => useViewData(MODEL_ID, query, topLeft),
      { wrapper: Wrapper, initialProps: { query: salesQuery } },
    )
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())
    rerender({ query: changed })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    serveChange()

    await act(() => result.current.refetch())

    await waitFor(() => expect(result.current.error).toBeNull())
    await waitFor(() => expect(result.current.cell(1, 1)?.value).toEqual({ t: "number", v: -1001 }))
    expect(result.current.isPlaceholder).toBe(false)
  })
})

describe("useViewData blocks of an older shape that cannot be loaded again", () => {
  const originKey = { rowBlock: 0, colBlock: 0 }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it("does not ask for a block again when asking for it failed", async () => {
    let grown = false
    const asked: string[] = []
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        const key = windows([query])[0]
        asked.push(key)
        if (grown && key === "1,0") {
          return problem(500, "internal", "The block could not be read.")
        }
        return HttpResponse.json(answer(salesView({ totalRows: grown ? 1100 : 1000 }), query))
      }),
    )
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(asked).toHaveLength(4))
    grown = true

    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.query(MODEL_ID, salesQuery, originKey),
        exact: true,
      }),
    )
    await waitFor(() => expect(result.current.totalRows).toBe(1100))
    await wait(600)

    expect(asked.filter((key) => key === "1,0")).toHaveLength(2)
    expect(result.current.error?.message).toBe("The block could not be read.")
  })

  it("loads it again when the grid retries", async () => {
    let grown = false
    let broken = true
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        if (grown && broken && windows([query])[0] === "1,0") {
          return problem(500, "internal", "The block could not be read.")
        }
        return HttpResponse.json(answer(salesView({ totalRows: grown ? 1100 : 1000 }), query))
      }),
    )
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(result.current.cell(150, 0)).toBeDefined())
    grown = true
    await act(() =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.query(MODEL_ID, salesQuery, originKey),
        exact: true,
      }),
    )
    await waitFor(() => expect(result.current.error).not.toBeNull())
    broken = false

    await act(() => result.current.refetch())

    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.cell(150, 0)).toBeDefined()
  })
})

describe("useViewData load", () => {
  const far: CellRange = { rowStart: 500, rowEnd: 520, colStart: 0, colEnd: 5 }

  it("loads the blocks that hold a range, and answers with their cells and headers", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))

    let lookup!: Awaited<ReturnType<typeof result.current.load>>
    await act(async () => {
      lookup = await result.current.load(far)
    })

    expect(lookup.cell(505, 2)?.value).toEqual({ t: "number", v: 505002 })
    expect(lookup.rowHeaders(505)?.members[0].label).toBe("Product 506")
    expect(lookup.colHeaders(3)?.members[1].label).toBe("Line item 3")
    expect(lookup.lineItems.length).toBeGreaterThan(0)
    expect(windows(served.requests).filter((key) => key === "5,0")).toHaveLength(1)
  })

  it("asks for nothing when everything the range needs is loaded", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))

    await act(async () => {
      await result.current.load(topLeft)
      await result.current.load({ rowStart: 0, rowEnd: 150, colStart: 0, colEnd: 45 })
    })

    expect(served.requests).toHaveLength(4)
  })

  it("loads the first block along with the blocks of the range", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })

    let lookup!: Awaited<ReturnType<typeof result.current.load>>
    await act(async () => {
      lookup = await result.current.load(far)
    })

    expect(lookup.cell(505, 2)).toBeDefined()
    expect(windows(served.requests)).toContain("0,0")
  })

  it("peeks at what is cached, without asking for anything", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))

    const lookup = result.current.peek({ rowStart: 90, rowEnd: 110, colStart: 38, colEnd: 42 })

    expect(lookup?.cell(105, 40)?.value).toEqual({ t: "number", v: 105040 })
    expect(lookup?.rowHeaders(105)?.members[0].label).toBe("Product 106")
    expect(served.requests).toHaveLength(4)
  })

  it("peeks at nothing while a block of the range is not cached", async () => {
    const served = serveViewQuery()
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await waitFor(() => expect(served.requests).toHaveLength(4))

    expect(result.current.peek(far)).toBeUndefined()
    await act(async () => {
      await result.current.load(far)
    })

    expect(result.current.peek(far)?.cell(505, 2)?.value).toEqual({ t: "number", v: 505002 })
  })

  it("loads a block again when the model's queries were invalidated, and shows what it now holds", async () => {
    const served = serveViewQuery()
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await act(async () => {
      await result.current.load(far)
    })
    expect(result.current.peek(far)?.cell(505, 2)?.value).toEqual({ t: "number", v: 505002 })
    served.fixture = salesView({ cell: () => numberCell(7) })
    const before = served.requests.length

    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.query(MODEL_ID) }))
    let lookup!: Awaited<ReturnType<typeof result.current.load>>
    await act(async () => {
      lookup = await result.current.load(far)
    })

    expect(lookup.cell(505, 2)?.value).toEqual({ t: "number", v: 7 })
    expect(served.requests.length).toBeGreaterThan(before)
  })

  it("peeks at nothing for a block that was invalidated, until it has loaded again", async () => {
    const served = serveViewQuery()
    const { Wrapper, queryClient } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    await act(async () => {
      await result.current.load(far)
    })
    expect(result.current.peek(far)).toBeDefined()

    // Only the blocks on show are read again; the far one stays invalid and cached.
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.query(MODEL_ID) }))

    expect(result.current.peek(far)).toBeUndefined()
    expect(result.current.peek(topLeft)).toBeDefined()
    served.fixture = salesView()
    await act(async () => {
      await result.current.load(far)
    })
    expect(result.current.peek(far)).toBeDefined()
  })

  it("rejects when a block cannot be loaded", async () => {
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        return query.window.row_offset === 500
          ? problem(500, "internal", "The block could not be read.")
          : HttpResponse.json(answer(salesView(), query))
      }),
    )
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useViewData(MODEL_ID, salesQuery, topLeft), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(result.current.hasShape).toBe(true))

    await expect(result.current.load(far)).rejects.toThrow("The block could not be read.")
  })
})
