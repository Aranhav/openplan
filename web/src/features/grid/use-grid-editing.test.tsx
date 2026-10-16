import { QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { NOTES, editView, lineItems, reference, serveCells } from "@/test/edit-view"
import { createTestQueryClient } from "@/test/render"
import { MODEL_ID } from "@/test/view-query"
import type { CellReader } from "./cell-targets"
import { useGridEditing } from "./use-grid-editing"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function readerOf(): CellReader {
  const fixture = editView()
  return {
    rowDims: fixture.rowDims,
    columnDims: fixture.columnDims,
    pages: fixture.pages,
    lineItems: new Map(fixture.lineItems.map((item) => [item.id, item])),
    rowHeaders: (row) => (row < fixture.totalRows ? fixture.rowHeader(row) : undefined),
    colHeaders: (col) => (col < fixture.totalColumns ? fixture.columnHeader(col) : undefined),
    cell: (row, col) => fixture.cell(row, col),
  }
}

function setup(selection: { row: number; col: number }) {
  const reader = readerOf()
  const announce = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () =>
      useGridEditing({
        modelId: MODEL_ID,
        moduleId: "module-1",
        view: "view-1",
        readOnly: false,
        reference,
        selection: { anchor: selection, focus: selection },
        bounds: { rows: 6, cols: lineItems.length },
        reader,
        load: async () => reader,
        peek: () => reader,
        moveSelection: vi.fn(),
        selectRange: vi.fn(),
        announce,
        gridRef: { current: null },
        focusGrid: vi.fn(),
      }),
    { wrapper },
  )
  return { announce, ...hook }
}

describe("what the editing says to a screen reader", () => {
  it("says Filled, and never Saved, for a fill of one cell", async () => {
    const bodies = serveCells()
    const { result, announce } = setup({ row: 2, col: NOTES })

    await act(async () => {
      result.current.run({ type: "fillDown" })
    })
    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Filled 1 cell"))

    expect(announce.mock.calls).toEqual([["Filled 1 cell"]])
  })

  it("says Saved for the clearing of one cell, which has no message of its own", async () => {
    const bodies = serveCells()
    const { result, announce } = setup({ row: 1, col: NOTES })

    await act(async () => {
      result.current.run({ type: "clear" })
    })
    await waitFor(() => expect(bodies).toHaveLength(1))

    await waitFor(() => expect(announce.mock.calls).toEqual([["Saved"]]))
  })
})
