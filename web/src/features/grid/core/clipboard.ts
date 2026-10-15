import { rangeOf, type Bounds, type Pos, type Selection } from "./selection"

export type PasteEdit = { pos: Pos; raw: string }

export type FillEdit = { from: Pos; to: Pos }

/**
 * Rows of cells as tab-separated text, every row ending in a line break as Excel writes it, so
 * a blank cell is "\n" and not an empty clipboard. A cell with a tab, a line break or a quote
 * is quoted.
 */
export function toTsv(rows: string[][]): string {
  return rows.map((row) => `${row.map(quoteCell).join("\t")}\n`).join("")
}

function quoteCell(cell: string): string {
  return /[\t\r\n"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

/**
 * Tab-separated text as rows of cells, the way Excel and Sheets write it. A quoted cell may
 * hold tabs, line breaks and doubled quotes. One trailing line break ends the last row
 * instead of starting another. Empty text has no rows.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let fieldStart = true
  let rowOpen = false

  const endField = () => {
    row.push(field)
    field = ""
    fieldStart = true
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
    rowOpen = false
  }

  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === "\n" || char === "\r") {
      endRow()
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1
      continue
    }
    rowOpen = true
    if (char === "\t") {
      endField()
      i++
    } else if (char === '"' && fieldStart) {
      fieldStart = false
      i++
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        field += text[i]
        i++
      }
    } else {
      field += char
      fieldStart = false
      i++
    }
  }
  if (rowOpen) {
    endRow()
  }
  return rows
}

/**
 * Where each pasted value goes. The block is placed with its top left cell at the selection's
 * top left. When the selection is a whole number of blocks tall and wide (a single value over
 * any selection is the common case) the block is repeated to fill it; otherwise it is pasted
 * once. Nothing is placed past the grid's last row or column.
 */
export function planPaste(grid: string[][], selection: Selection, bounds: Bounds): PasteEdit[] {
  const height = grid.length
  const width = grid.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (height === 0 || width === 0) {
    return []
  }
  const range = rangeOf(selection)
  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  const repeat = rows % height === 0 && cols % width === 0
  const lastRow = range.rowStart + (repeat ? rows : height) - 1
  const lastCol = range.colStart + (repeat ? cols : width) - 1

  const edits: PasteEdit[] = []
  for (let row = range.rowStart; row <= lastRow && row < bounds.rows; row++) {
    const cells = grid[(row - range.rowStart) % height]
    for (let col = range.colStart; col <= lastCol && col < bounds.cols; col++) {
      // A row shorter than the widest has no cell to put here.
      const raw = cells[(col - range.colStart) % width]
      if (raw !== undefined) {
        edits.push({ pos: { row, col }, raw })
      }
    }
  }
  return edits
}

/**
 * Fill down (Ctrl+D): the top row of the selection is copied into every row below it, column by
 * column. A single selected row copies the row above it instead, and has nothing to copy on the
 * first row.
 */
export function planFillDown(selection: Selection): FillEdit[] {
  const range = rangeOf(selection)
  const edits: FillEdit[] = []
  if (range.rowStart === range.rowEnd) {
    if (range.rowStart > 0) {
      for (let col = range.colStart; col <= range.colEnd; col++) {
        edits.push({ from: { row: range.rowStart - 1, col }, to: { row: range.rowStart, col } })
      }
    }
    return edits
  }
  for (let row = range.rowStart + 1; row <= range.rowEnd; row++) {
    for (let col = range.colStart; col <= range.colEnd; col++) {
      edits.push({ from: { row: range.rowStart, col }, to: { row, col } })
    }
  }
  return edits
}
