import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import {
  MODEL_ID,
  answer,
  failViewQuery,
  salesQuery,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import type { CellRange } from "./core/selection"
import { useViewData } from "./use-view-data"
import type { GridQuery, ViewQuery } from "./view-types"

function wrapper() {
  const queryClient = createTestQueryClient()
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

  it("shows no cells of the previous query while the next one loads", async () => {
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
    expect(result.current.cell(0, 0)).toBeUndefined()
    expect(result.current.rowHeaders(0)).toBeUndefined()
    await waitFor(() => expect(result.current.cell(0, 0)).toBeDefined())
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
