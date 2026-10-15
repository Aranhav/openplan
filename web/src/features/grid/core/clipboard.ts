import { rangeOf, type Bounds, type Pos, type Selection } from "./selection"

export type PasteEdit = { pos: Pos; raw: string }

export type FillEdit = { from: Pos; to: Pos }

/** Rows of cells as tab-separated text. A cell with a tab, a line break or a quote is quoted. */
export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.map(quoteCell).join("\t")).join("\n")
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
 * Where each pasted value goes. A single value fills the whole selection. Anything bigger is
 * placed with its top left cell at the selection's top left, and is cut off at the grid's
 * last row and column.
 */
export function planPaste(grid: string[][], selection: Selection, bounds: Bounds): PasteEdit[] {
  const range = rangeOf(selection)
  const lastRow = Math.min(range.rowEnd, bounds.rows - 1)
  const lastCol = Math.min(range.colEnd, bounds.cols - 1)
  const edits: PasteEdit[] = []

  if (grid.length === 1 && grid[0].length === 1) {
    for (let row = range.rowStart; row <= lastRow; row++) {
      for (let col = range.colStart; col <= lastCol; col++) {
        edits.push({ pos: { row, col }, raw: grid[0][0] })
      }
    }
    return edits
  }

  for (let r = 0; r < grid.length && range.rowStart + r < bounds.rows; r++) {
    const row = range.rowStart + r
    for (let c = 0; c < grid[r].length && range.colStart + c < bounds.cols; c++) {
      edits.push({ pos: { row, col: range.colStart + c }, raw: grid[r][c] })
    }
  }
  return edits
}

/** Copies the top row of the selection into every row below it, column by column. */
export function planFillDown(selection: Selection): FillEdit[] {
  const range = rangeOf(selection)
  const edits: FillEdit[] = []
  for (let row = range.rowStart + 1; row <= range.rowEnd; row++) {
    for (let col = range.colStart; col <= range.colEnd; col++) {
      edits.push({ from: { row: range.rowStart, col }, to: { row, col } })
    }
  }
  return edits
}
