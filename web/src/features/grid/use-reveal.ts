import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react"
import type { CellRange, Pos, Selection } from "./core/selection"
import { ROW_HEIGHT, revealOffset } from "./grid-layout"

// How long after the active cell moves that headers arriving late may still move the grid to it.
const LATE_HEADERS_MS = 1000

type Options = {
  /** The scroll container. */
  gridRef: RefObject<HTMLElement | null>
  selection: Selection
  selectRange: (range: CellRange) => void
  totalRows: number
  totalColumns: number
  headerHeight: number
  rowHeaderWidth: number
  colStarts: readonly number[]
  colWidths: readonly number[]
}

/**
 * Keeps the end of the range that moves in view, clear of the sticky headers. Columns whose
 * headers have not loaded count as the default width, so when headers arrive soon after the
 * active cell has moved, its place has moved too, and the grid goes to it again.
 *
 * Answers a function that selects a range the grid chose itself (after a paste or an undo) and
 * brings it into view at its top left, where the active cell is, rather than at its far end.
 */
export function useReveal({
  gridRef,
  selection,
  selectRange,
  totalRows,
  totalColumns,
  headerHeight,
  rowHeaderWidth,
  colStarts,
  colWidths,
}: Options) {
  const reveal = useEffectEvent((cell: Pos) => {
    const element = gridRef.current
    if (!element || cell.row >= totalRows || cell.col >= totalColumns) {
      return
    }
    const top = headerHeight + cell.row * ROW_HEIGHT
    const left = rowHeaderWidth + colStarts[cell.col]
    element.scrollTop = revealOffset(
      { start: top, end: top + ROW_HEIGHT },
      element.scrollTop,
      element.clientHeight,
      headerHeight,
    )
    element.scrollLeft = revealOffset(
      { start: left, end: left + colWidths[cell.col] },
      element.scrollLeft,
      element.clientWidth,
      rowHeaderWidth,
    )
  })
  const { row: focusRow, col: focusCol } = selection.focus
  const focusStart = colStarts[focusCol]
  const revealed = useRef<{ row: number; col: number; until: number } | null>(null)
  const requestedTarget = useRef<Pos | null>(null)
  const [requests, setRequests] = useState(0)
  useEffect(() => {
    const requested = requestedTarget.current
    requestedTarget.current = null
    const previous = revealed.current
    const moved = previous?.row !== focusRow || previous.col !== focusCol
    const until = moved ? Date.now() + LATE_HEADERS_MS : (previous?.until ?? 0)
    revealed.current = { row: focusRow, col: focusCol, until }
    if (requested) {
      reveal(requested)
    } else if (moved || Date.now() < until) {
      reveal({ row: focusRow, col: focusCol })
    }
  }, [focusRow, focusCol, focusStart, requests])

  return (range: CellRange) => {
    requestedTarget.current = { row: range.rowStart, col: range.colStart }
    setRequests((count) => count + 1)
    selectRange(range)
  }
}
