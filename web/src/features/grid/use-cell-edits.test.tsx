import { QueryClientProvider, useQuery } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryKeys } from "@/lib/api/keys"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { MODEL_ID } from "@/test/view-query"
import { cellKey } from "./cell-targets"
import type { CellWrite } from "./cells-api"
import type { CellEdit } from "./core/undo"
import { useCellEdits } from "./use-cell-edits"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const MODULE = "module-1"

const edit = (value: number, before = 1, coords = ["p-1", "Jan 26"]): CellEdit => ({
  lineItemId: "li-1",
  coords,
  before: { t: "number", v: before },
  after: { t: "number", v: value },
})

const written = (value: number, coords = ["p-1", "Jan 26"]): CellWrite => ({
  line_item_id: "li-1",
  coords,
  value: { t: "number", v: value },
})

/** A request the test lets through when it wants to. */
function gate() {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, release }
}

type Served = { bodies: { edits: CellWrite[] }[] }

function serveCells(options: { hold?: Promise<void>[] } = {}): Served {
  const served: Served = { bodies: [] }
  let call = 0
  server.use(
    http.post("/api/v1/models/:id/cells", async ({ request }) => {
      served.bodies.push((await request.json()) as { edits: CellWrite[] })
      await options.hold?.[call++]
      return HttpResponse.json({ seq: call, changed_line_item_ids: ["li-1"] })
    }),
  )
  return served
}

function setup(moduleId = MODULE) {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(({ module }) => useCellEdits(MODEL_ID, module), {
    wrapper,
    initialProps: { module: moduleId },
  })
  return { queryClient, wrapper, ...hook }
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
})

describe("useCellEdits commit", () => {
  it("writes the batch in one request with the values after", async () => {
    const served = serveCells()
    const { result } = setup()

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.commit([edit(5), edit(6, 1, ["p-2", "Jan 26"])])
    })

    expect(saved).toBe(true)
    expect(served.bodies).toEqual([{ edits: [written(5), written(6, ["p-2", "Jan 26"])] }])
  })

  it("sends nothing for an empty batch", async () => {
    const served = serveCells()
    const { result } = setup()

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.commit([])
    })

    expect(saved).toBe(true)
    expect(served.bodies).toEqual([])
  })

  it("holds the new value as pending until the server has been read again", async () => {
    const response = gate()
    const reread = gate()
    serveCells({ hold: [response.opened] })
    const { result, wrapper } = setup()
    const key = cellKey("li-1", ["p-1", "Jan 26"])
    let reads = 0
    renderHook(
      () =>
        useQuery({
          queryKey: queryKeys.query(MODEL_ID, "view"),
          queryFn: async () => {
            reads += 1
            if (reads > 1) {
              await reread.opened
            }
            return reads
          },
        }),
      { wrapper },
    )
    await waitFor(() => expect(reads).toBe(1))

    let committing!: Promise<boolean>
    act(() => {
      committing = result.current.commit([edit(5)])
    })

    expect(result.current.pending.get(key)).toEqual({ t: "number", v: 5 })
    await act(async () => response.release())
    await waitFor(() => expect(reads).toBe(2))
    expect(result.current.pending.get(key)).toEqual({ t: "number", v: 5 })

    await act(async () => {
      reread.release()
      await committing
    })
    expect(result.current.pending.size).toBe(0)
  })

  it("asks for every query of the model to be read again", async () => {
    serveCells()
    const { result, queryClient } = setup()
    queryClient.setQueryData(queryKeys.query(MODEL_ID, "view", { rowBlock: 0 }), 1)
    queryClient.setQueryData(queryKeys.query("other-model", "view"), 1)

    await act(async () => {
      await result.current.commit([edit(5)])
    })

    expect(
      queryClient.getQueryState(queryKeys.query(MODEL_ID, "view", { rowBlock: 0 }))?.isInvalidated,
    ).toBe(true)
    expect(queryClient.getQueryState(queryKeys.query("other-model", "view"))?.isInvalidated).toBe(
      false,
    )
  })

  it("takes the value back and says why when the server refuses it", async () => {
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(422, "cells.invalid_value", "Some fields are invalid.", {
          errors: [
            { field: "edits[0]", message: "Enter a number" },
            { field: "edits[1]", message: "Enter a date" },
          ],
        }),
      ),
    )
    const { result } = setup()

    let saved: boolean | undefined
    await act(async () => {
      saved = await result.current.commit([edit(5)])
    })

    expect(saved).toBe(false)
    expect(result.current.pending.size).toBe(0)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Enter a number")
  })

  it("says what the server said for any other refusal", async () => {
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(403, "auth.forbidden", "You need the Planner role to change cells."),
      ),
    )
    const { result } = setup()

    await act(async () => {
      await result.current.commit([edit(5)])
    })

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "You need the Planner role to change cells.",
    )
    expect(result.current.pending.size).toBe(0)
  })

  it("does not remember a refused batch for undo", async () => {
    server.use(http.post("/api/v1/models/:id/cells", () => problem(422, "cells.not_input", "No.")))
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
    })
    const served = serveCells()

    await act(async () => {
      await result.current.undo()
    })

    expect(served.bodies).toEqual([])
  })

  it("writes batches in the order they were made", async () => {
    const first = gate()
    const served = serveCells({ hold: [first.opened] })
    const { result } = setup()

    let both!: Promise<boolean[]>
    act(() => {
      both = Promise.all([result.current.commit([edit(5)]), result.current.commit([edit(6, 5)])])
    })
    await waitFor(() => expect(served.bodies).toHaveLength(1))
    expect(served.bodies[0].edits[0].value).toEqual({ t: "number", v: 5 })

    await act(async () => {
      first.release()
      await both
    })
    expect(served.bodies.map((body) => body.edits[0].value)).toEqual([
      { t: "number", v: 5 },
      { t: "number", v: 6 },
    ])
  })

  it("keeps the later value pending when an earlier edit of the same cell comes back", async () => {
    const first = gate()
    const second = gate()
    serveCells({ hold: [first.opened, second.opened] })
    const { result } = setup()
    const key = cellKey("li-1", ["p-1", "Jan 26"])

    let both!: Promise<boolean[]>
    act(() => {
      both = Promise.all([result.current.commit([edit(5)]), result.current.commit([edit(6, 5)])])
    })
    await act(async () => first.release())
    await waitFor(() => expect(result.current.pending.get(key)).toEqual({ t: "number", v: 6 }))

    await act(async () => {
      second.release()
      await both
    })
    expect(result.current.pending.size).toBe(0)
  })
})

describe("useCellEdits undo and redo", () => {
  it("writes the values from before to undo and the values after to redo", async () => {
    const served = serveCells()
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5), edit(6, 2, ["p-2", "Jan 26"])])
    })

    await act(async () => {
      await result.current.undo()
    })
    await act(async () => {
      await result.current.redo()
    })

    expect(served.bodies.slice(1)).toEqual([
      { edits: [written(1), written(2, ["p-2", "Jan 26"])] },
      { edits: [written(5), written(6, ["p-2", "Jan 26"])] },
    ])
  })

  it("undoes an edit that has not been written yet once it has", async () => {
    const first = gate()
    const served = serveCells({ hold: [first.opened] })
    const { result } = setup()

    let undoing!: Promise<void>
    act(() => {
      void result.current.commit([edit(5)])
      undoing = result.current.undo()
    })
    await waitFor(() => expect(served.bodies).toHaveLength(1))
    await act(async () => {
      first.release()
      await undoing
    })

    expect(served.bodies.map((body) => body.edits[0].value)).toEqual([
      { t: "number", v: 5 },
      { t: "number", v: 1 },
    ])
  })

  it("undoes the newest batch first", async () => {
    const served = serveCells()
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
      await result.current.commit([edit(7, 5)])
    })

    await act(async () => {
      await result.current.undo()
      await result.current.undo()
    })

    expect(served.bodies.slice(2).map((body) => body.edits[0].value)).toEqual([
      { t: "number", v: 5 },
      { t: "number", v: 1 },
    ])
  })

  it("does nothing when there is nothing to undo or redo", async () => {
    const served = serveCells()
    const { result } = setup()

    await act(async () => {
      await result.current.undo()
      await result.current.redo()
    })

    expect(served.bodies).toEqual([])
  })

  it("shows the restored value as pending and does not remember the undo as a new edit", async () => {
    const response = gate()
    serveCells({ hold: [Promise.resolve(), response.opened] })
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
    })

    let undoing!: Promise<void>
    act(() => {
      undoing = result.current.undo()
    })
    await waitFor(() =>
      expect(result.current.pending.get(cellKey("li-1", ["p-1", "Jan 26"]))).toEqual({
        t: "number",
        v: 1,
      }),
    )
    await act(async () => {
      response.release()
      await undoing
    })
    expect(result.current.pending.size).toBe(0)
  })

  it("drops what could be redone when a new edit is made", async () => {
    const served = serveCells()
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
      await result.current.undo()
      await result.current.commit([edit(9)])
      await result.current.redo()
    })

    expect(served.bodies).toHaveLength(3)
  })

  it("keeps a batch to undo again when undoing it fails", async () => {
    serveCells()
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
    })
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(403, "auth.forbidden", "You need the Planner role to change cells."),
      ),
    )
    await act(async () => {
      await result.current.undo()
    })
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "You need the Planner role to change cells.",
    )
    expect(result.current.pending.size).toBe(0)

    const served = serveCells()
    await act(async () => {
      await result.current.undo()
    })

    expect(served.bodies).toEqual([{ edits: [written(1)] }])
  })

  it("keeps a batch to redo again when redoing it fails", async () => {
    serveCells()
    const { result } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
      await result.current.undo()
    })
    server.use(http.post("/api/v1/models/:id/cells", () => problem(422, "cells.not_input", "No.")))
    await act(async () => {
      await result.current.redo()
    })

    const served = serveCells()
    await act(async () => {
      await result.current.redo()
    })

    expect(served.bodies).toEqual([{ edits: [written(5)] }])
  })

  it("forgets the history when the grid moves to another module", async () => {
    const served = serveCells()
    const { result, rerender } = setup()
    await act(async () => {
      await result.current.commit([edit(5)])
    })

    rerender({ module: "module-2" })
    await act(async () => {
      await result.current.undo()
    })

    expect(served.bodies).toHaveLength(1)
  })
})
