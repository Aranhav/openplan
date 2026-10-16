import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Bounds, Selection } from "./core/selection"
import type { GridCommand } from "./core/keymap"
import { sameSelection, useGridSelection } from "./use-grid-selection"

const bounds: Bounds = { rows: 100, cols: 10 }
const at = (row: number, col: number) => ({ row, col })
const cell = (row: number, col: number): Selection => ({
  anchor: at(row, col),
  focus: at(row, col),
})

function move(dir: "up" | "down" | "left" | "right", extend = false, jump = false): GridCommand {
  return { type: "move", dir, extend, jump }
}

describe("useGridSelection", () => {
  it("starts on the first cell", () => {
    const { result } = renderHook(() => useGridSelection(bounds))

    expect(result.current.selection).toEqual(cell(0, 0))
  })

  it("selects a cell, or grows the range from the active cell", () => {
    const { result } = renderHook(() => useGridSelection(bounds))

    act(() => result.current.select(at(4, 2)))
    expect(result.current.selection).toEqual(cell(4, 2))

    act(() => result.current.select(at(8, 5), true))
    expect(result.current.selection).toEqual({ anchor: at(4, 2), focus: at(8, 5) })

    act(() => result.current.select(at(1, 1)))
    expect(result.current.selection).toEqual(cell(1, 1))
  })

  it("selects a range with the active cell at its top left", () => {
    const { result } = renderHook(() => useGridSelection(bounds))

    act(() => result.current.selectRange({ rowStart: 3, rowEnd: 6, colStart: 1, colEnd: 4 }))

    expect(result.current.selection).toEqual({ anchor: at(3, 1), focus: at(6, 4) })
  })

  it("keeps a range that was selected within the bounds", () => {
    const { result } = renderHook(() => useGridSelection({ rows: 5, cols: 3 }))

    act(() => result.current.selectRange({ rowStart: 3, rowEnd: 60, colStart: 1, colEnd: 40 }))

    expect(result.current.selection).toEqual({ anchor: at(3, 1), focus: at(4, 2) })
  })

  it("moves with the navigation commands and answers with the new selection", () => {
    const { result } = renderHook(() => useGridSelection(bounds))
    let next: Selection | undefined

    act(() => {
      next = result.current.run(move("down"), 20)
    })
    expect(next).toEqual(cell(1, 0))
    expect(result.current.selection).toEqual(cell(1, 0))

    act(() => {
      next = result.current.run(move("right", true), 20)
    })
    expect(next).toEqual({ anchor: at(1, 0), focus: at(1, 1) })

    act(() => {
      next = result.current.run({ type: "move", dir: "down", extend: false, jump: true }, 20)
    })
    expect(next).toEqual(cell(99, 0))
  })

  it("handles home, end, page and select all", () => {
    const { result } = renderHook(() => useGridSelection(bounds))

    act(() => {
      result.current.run({ type: "edge", edge: "end", extend: false, jump: false }, 20)
    })
    expect(result.current.selection).toEqual(cell(0, 9))

    act(() => {
      result.current.run({ type: "page", dir: "down", extend: false }, 20)
    })
    expect(result.current.selection).toEqual(cell(20, 9))

    act(() => {
      result.current.run({ type: "selectAll" }, 20)
    })
    expect(result.current.selection).toEqual({ anchor: at(0, 0), focus: at(99, 9) })
  })

  it("selects the rows or columns of the selection", () => {
    const { result } = renderHook(() => useGridSelection(bounds))
    act(() => result.current.select(at(4, 2)))
    act(() => result.current.select(at(6, 3), true))

    act(() => {
      result.current.run({ type: "selectRow" }, 20)
    })
    expect(result.current.selection).toEqual({ anchor: at(4, 0), focus: at(6, 9) })

    act(() => {
      result.current.run({ type: "selectColumn" }, 20)
    })
    expect(result.current.selection).toEqual({ anchor: at(0, 0), focus: at(99, 9) })
  })

  it("leaves a move that goes nowhere as it is, but still answers it", () => {
    const { result } = renderHook(() => useGridSelection(bounds))
    const before = result.current.selection

    let next: Selection | undefined
    act(() => {
      next = result.current.run(move("up"), 20)
    })

    expect(next).toEqual(before)
    expect(result.current.selection).toBe(before)
  })

  it.each<GridCommand>([
    { type: "none" },
    { type: "edit" },
    { type: "replace", text: "a" },
    { type: "copy" },
    { type: "paste" },
    { type: "undo" },
    { type: "cancel" },
  ])("does not handle the %j command", (command) => {
    const { result } = renderHook(() => useGridSelection(bounds))

    let next: Selection | undefined
    act(() => {
      next = result.current.run(command, 20)
    })

    expect(next).toBeUndefined()
    expect(result.current.selection).toEqual(cell(0, 0))
  })

  it("keeps the selection inside a view that shrinks", () => {
    const { result, rerender } = renderHook(({ b }: { b: Bounds }) => useGridSelection(b), {
      initialProps: { b: bounds },
    })
    act(() => result.current.select(at(90, 8)))
    act(() => result.current.select(at(95, 9), true))

    rerender({ b: { rows: 50, cols: 4 } })

    expect(result.current.selection).toEqual({ anchor: at(49, 3), focus: at(49, 3) })
  })

  it("is on the first cell of a view that is empty", () => {
    const { result } = renderHook(() => useGridSelection({ rows: 0, cols: 0 }))

    expect(result.current.selection).toEqual(cell(0, 0))
  })
})

describe("sameSelection", () => {
  it("compares both ends", () => {
    expect(sameSelection(cell(1, 2), cell(1, 2))).toBe(true)
    expect(sameSelection(cell(1, 2), cell(1, 3))).toBe(false)
    expect(sameSelection(cell(1, 2), { anchor: at(1, 2), focus: at(2, 2) })).toBe(false)
  })
})
