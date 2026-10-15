import { describe, expect, it } from "vitest"
import {
  contains,
  move,
  moveToEdge,
  movePage,
  rangeOf,
  selectAll,
  type Selection,
} from "./selection"

const bounds = { rows: 10, cols: 5 }
const plain = { extend: false, jump: false }

function cell(row: number, col: number): Selection {
  return { anchor: { row, col }, focus: { row, col } }
}

describe("rangeOf", () => {
  it("is the cell itself for a single-cell selection", () => {
    expect(rangeOf(cell(3, 2))).toEqual({ rowStart: 3, rowEnd: 3, colStart: 2, colEnd: 2 })
  })

  it("is inclusive and ordered when the focus is below and right of the anchor", () => {
    const sel = { anchor: { row: 1, col: 1 }, focus: { row: 4, col: 3 } }
    expect(rangeOf(sel)).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
  })

  it("is ordered when the focus is above and left of the anchor", () => {
    const sel = { anchor: { row: 4, col: 3 }, focus: { row: 1, col: 1 } }
    expect(rangeOf(sel)).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
  })

  it("orders rows and columns independently", () => {
    const sel = { anchor: { row: 5, col: 0 }, focus: { row: 2, col: 4 } }
    expect(rangeOf(sel)).toEqual({ rowStart: 2, rowEnd: 5, colStart: 0, colEnd: 4 })
  })
})

describe("contains", () => {
  const sel = { anchor: { row: 4, col: 3 }, focus: { row: 1, col: 1 } }

  it("includes every edge of the range", () => {
    expect(contains(sel, { row: 1, col: 1 })).toBe(true)
    expect(contains(sel, { row: 4, col: 3 })).toBe(true)
    expect(contains(sel, { row: 1, col: 3 })).toBe(true)
    expect(contains(sel, { row: 4, col: 1 })).toBe(true)
    expect(contains(sel, { row: 2, col: 2 })).toBe(true)
  })

  it("excludes cells just outside the range", () => {
    expect(contains(sel, { row: 0, col: 2 })).toBe(false)
    expect(contains(sel, { row: 5, col: 2 })).toBe(false)
    expect(contains(sel, { row: 2, col: 0 })).toBe(false)
    expect(contains(sel, { row: 2, col: 4 })).toBe(false)
  })
})

describe("selectAll", () => {
  it("spans the whole grid from the top left to the bottom right", () => {
    expect(selectAll(bounds)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 9, col: 4 },
    })
  })

  it("falls back to the origin for a grid with nothing in it", () => {
    expect(selectAll({ rows: 0, cols: 0 })).toEqual(cell(0, 0))
  })
})

describe("move", () => {
  it("steps one cell in each direction and collapses to the new cell", () => {
    expect(move(cell(3, 2), "up", plain, bounds)).toEqual(cell(2, 2))
    expect(move(cell(3, 2), "down", plain, bounds)).toEqual(cell(4, 2))
    expect(move(cell(3, 2), "left", plain, bounds)).toEqual(cell(3, 1))
    expect(move(cell(3, 2), "right", plain, bounds)).toEqual(cell(3, 3))
  })

  it("stays put at every edge of the grid", () => {
    expect(move(cell(0, 2), "up", plain, bounds)).toEqual(cell(0, 2))
    expect(move(cell(9, 2), "down", plain, bounds)).toEqual(cell(9, 2))
    expect(move(cell(3, 0), "left", plain, bounds)).toEqual(cell(3, 0))
    expect(move(cell(3, 4), "right", plain, bounds)).toEqual(cell(3, 4))
  })

  it("moves from the focus and collapses a range when not extending", () => {
    const range = { anchor: { row: 1, col: 1 }, focus: { row: 4, col: 3 } }
    expect(move(range, "down", plain, bounds)).toEqual(cell(5, 3))
    expect(move(range, "left", plain, bounds)).toEqual(cell(4, 2))
  })

  it("extends by moving only the focus", () => {
    const next = move(cell(3, 2), "down", { extend: true, jump: false }, bounds)
    expect(next).toEqual({ anchor: { row: 3, col: 2 }, focus: { row: 4, col: 2 } })
    const wider = move(next, "right", { extend: true, jump: false }, bounds)
    expect(wider).toEqual({ anchor: { row: 3, col: 2 }, focus: { row: 4, col: 3 } })
  })

  it("shrinks an extended range back toward its anchor", () => {
    const range = { anchor: { row: 3, col: 2 }, focus: { row: 5, col: 2 } }
    expect(move(range, "up", { extend: true, jump: false }, bounds)).toEqual({
      anchor: { row: 3, col: 2 },
      focus: { row: 4, col: 2 },
    })
  })

  it("clamps an extension at the edge", () => {
    const sel = { anchor: { row: 3, col: 2 }, focus: { row: 9, col: 2 } }
    expect(move(sel, "down", { extend: true, jump: false }, bounds).focus).toEqual({
      row: 9,
      col: 2,
    })
  })

  it("jumps to the edge in the direction of travel", () => {
    const jump = { extend: false, jump: true }
    expect(move(cell(3, 2), "up", jump, bounds)).toEqual(cell(0, 2))
    expect(move(cell(3, 2), "down", jump, bounds)).toEqual(cell(9, 2))
    expect(move(cell(3, 2), "left", jump, bounds)).toEqual(cell(3, 0))
    expect(move(cell(3, 2), "right", jump, bounds)).toEqual(cell(3, 4))
  })

  it("extends all the way to the edge when jumping and extending", () => {
    expect(move(cell(3, 2), "down", { extend: true, jump: true }, bounds)).toEqual({
      anchor: { row: 3, col: 2 },
      focus: { row: 9, col: 2 },
    })
  })

  it("leaves the selection alone when the grid has no rows or no columns", () => {
    const sel = cell(0, 0)
    expect(move(sel, "down", plain, { rows: 0, cols: 5 })).toBe(sel)
    expect(move(sel, "right", plain, { rows: 5, cols: 0 })).toBe(sel)
  })
})

describe("moveToEdge", () => {
  it("goes to the first and last column of the current row", () => {
    expect(moveToEdge(cell(3, 2), "home", plain, bounds)).toEqual(cell(3, 0))
    expect(moveToEdge(cell(3, 2), "end", plain, bounds)).toEqual(cell(3, 4))
  })

  it("goes to the first and last cell of the grid when jumping", () => {
    const jump = { extend: false, jump: true }
    expect(moveToEdge(cell(3, 2), "home", jump, bounds)).toEqual(cell(0, 0))
    expect(moveToEdge(cell(3, 2), "end", jump, bounds)).toEqual(cell(9, 4))
  })

  it("extends from the anchor", () => {
    expect(moveToEdge(cell(3, 2), "end", { extend: true, jump: false }, bounds)).toEqual({
      anchor: { row: 3, col: 2 },
      focus: { row: 3, col: 4 },
    })
    expect(moveToEdge(cell(3, 2), "home", { extend: true, jump: true }, bounds)).toEqual({
      anchor: { row: 3, col: 2 },
      focus: { row: 0, col: 0 },
    })
  })

  it("leaves the selection alone when the grid is empty", () => {
    const sel = cell(0, 0)
    expect(moveToEdge(sel, "end", plain, { rows: 0, cols: 0 })).toBe(sel)
  })
})

describe("movePage", () => {
  it("moves a page of rows down and up, keeping the column", () => {
    expect(movePage(cell(2, 3), "down", 4, { extend: false }, bounds)).toEqual(cell(6, 3))
    expect(movePage(cell(6, 3), "up", 4, { extend: false }, bounds)).toEqual(cell(2, 3))
  })

  it("stops at the first and last row", () => {
    expect(movePage(cell(8, 1), "down", 4, { extend: false }, bounds)).toEqual(cell(9, 1))
    expect(movePage(cell(1, 1), "up", 4, { extend: false }, bounds)).toEqual(cell(0, 1))
  })

  it("extends from the anchor", () => {
    expect(movePage(cell(2, 3), "down", 4, { extend: true }, bounds)).toEqual({
      anchor: { row: 2, col: 3 },
      focus: { row: 6, col: 3 },
    })
  })

  it("moves at least one row when the page is smaller than a row", () => {
    expect(movePage(cell(2, 3), "down", 0, { extend: false }, bounds)).toEqual(cell(3, 3))
  })

  it("leaves the selection alone when the grid is empty", () => {
    const sel = cell(0, 0)
    expect(movePage(sel, "down", 4, { extend: false }, { rows: 0, cols: 0 })).toBe(sel)
  })
})
