import { describe, expect, it } from "vitest"
import { COL_BLOCK, ROW_BLOCK, blocksFor, windowOf } from "./blocks"

describe("block sizes", () => {
  it("fetch 100 rows and 40 columns at a time", () => {
    expect(ROW_BLOCK).toBe(100)
    expect(COL_BLOCK).toBe(40)
  })
})

describe("blocksFor", () => {
  it("is the single block holding a small visible range", () => {
    expect(blocksFor({ rowStart: 0, rowEnd: 30, colStart: 0, colEnd: 12 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
    ])
  })

  it("treats the end of the range as inclusive", () => {
    expect(blocksFor({ rowStart: 90, rowEnd: 99, colStart: 0, colEnd: 39 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
    ])
    expect(blocksFor({ rowStart: 90, rowEnd: 100, colStart: 0, colEnd: 39 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
      { rowBlock: 1, colBlock: 0 },
    ])
    expect(blocksFor({ rowStart: 0, rowEnd: 99, colStart: 30, colEnd: 40 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
      { rowBlock: 0, colBlock: 1 },
    ])
  })

  it("starts at the block holding the first visible row and column", () => {
    expect(blocksFor({ rowStart: 250, rowEnd: 260, colStart: 85, colEnd: 90 })).toEqual([
      { rowBlock: 2, colBlock: 2 },
    ])
  })

  it("lists every block a range crosses, a row of blocks at a time", () => {
    expect(blocksFor({ rowStart: 80, rowEnd: 220, colStart: 30, colEnd: 85 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
      { rowBlock: 0, colBlock: 1 },
      { rowBlock: 0, colBlock: 2 },
      { rowBlock: 1, colBlock: 0 },
      { rowBlock: 1, colBlock: 1 },
      { rowBlock: 1, colBlock: 2 },
      { rowBlock: 2, colBlock: 0 },
      { rowBlock: 2, colBlock: 1 },
      { rowBlock: 2, colBlock: 2 },
    ])
  })

  it("starts at the first block when the range begins before the grid", () => {
    expect(blocksFor({ rowStart: -5, rowEnd: 10, colStart: -1, colEnd: 3 })).toEqual([
      { rowBlock: 0, colBlock: 0 },
    ])
  })

  it("is empty for a range that holds nothing", () => {
    expect(blocksFor({ rowStart: 10, rowEnd: 9, colStart: 0, colEnd: 5 })).toEqual([])
    expect(blocksFor({ rowStart: 0, rowEnd: 5, colStart: 7, colEnd: 6 })).toEqual([])
  })
})

describe("windowOf", () => {
  it("is the first block's rows and columns", () => {
    expect(windowOf({ rowBlock: 0, colBlock: 0 })).toEqual({
      row_offset: 0,
      row_limit: 100,
      col_offset: 0,
      col_limit: 40,
    })
  })

  it("moves by a whole block per index", () => {
    expect(windowOf({ rowBlock: 3, colBlock: 2 })).toEqual({
      row_offset: 300,
      row_limit: 100,
      col_offset: 80,
      col_limit: 40,
    })
  })

  it("matches the blocks blocksFor lists", () => {
    const [block] = blocksFor({ rowStart: 1234, rowEnd: 1240, colStart: 45, colEnd: 46 })
    const window = windowOf(block)
    expect(window.row_offset).toBeLessThanOrEqual(1234)
    expect(window.row_offset + window.row_limit).toBeGreaterThan(1240)
    expect(window.col_offset).toBeLessThanOrEqual(45)
    expect(window.col_offset + window.col_limit).toBeGreaterThan(46)
  })
})
