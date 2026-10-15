import type { CellRange } from "./selection"
import type { Window } from "./types"

/** The grid fetches its data in blocks this size, so scrolling reuses what is already loaded. */
export const ROW_BLOCK = 100
export const COL_BLOCK = 40

export type Block = { rowBlock: number; colBlock: number }

/** The blocks that hold any cell of the visible range, a row of blocks at a time. */
export function blocksFor(visible: CellRange): Block[] {
  if (visible.rowEnd < visible.rowStart || visible.colEnd < visible.colStart) {
    return []
  }
  const firstRow = Math.floor(Math.max(visible.rowStart, 0) / ROW_BLOCK)
  const lastRow = Math.floor(visible.rowEnd / ROW_BLOCK)
  const firstCol = Math.floor(Math.max(visible.colStart, 0) / COL_BLOCK)
  const lastCol = Math.floor(visible.colEnd / COL_BLOCK)
  const blocks: Block[] = []
  for (let rowBlock = firstRow; rowBlock <= lastRow; rowBlock++) {
    for (let colBlock = firstCol; colBlock <= lastCol; colBlock++) {
      blocks.push({ rowBlock, colBlock })
    }
  }
  return blocks
}

/** The query window that fetches one block. */
export function windowOf({ rowBlock, colBlock }: Block): Window {
  return {
    row_offset: rowBlock * ROW_BLOCK,
    row_limit: ROW_BLOCK,
    col_offset: colBlock * COL_BLOCK,
    col_limit: COL_BLOCK,
  }
}
