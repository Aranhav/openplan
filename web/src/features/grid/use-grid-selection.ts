import { useMemo, useState } from "react"
import type { GridCommand } from "./core/keymap"
import {
  type Bounds,
  type CellRange,
  type Pos,
  type Selection,
  move,
  movePage,
  moveToEdge,
  selectAll,
  selectColumns,
  selectRows,
} from "./core/selection"

const ORIGIN: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }

export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.anchor.row === b.anchor.row &&
    a.anchor.col === b.anchor.col &&
    a.focus.row === b.focus.row &&
    a.focus.col === b.focus.col
  )
}

function clampPos(pos: Pos, bounds: Bounds): Pos {
  const row = Math.min(pos.row, Math.max(bounds.rows - 1, 0))
  const col = Math.min(pos.col, Math.max(bounds.cols - 1, 0))
  return row === pos.row && col === pos.col ? pos : { row, col }
}

function clampSelection(selection: Selection, bounds: Bounds): Selection {
  const anchor = clampPos(selection.anchor, bounds)
  const focus = clampPos(selection.focus, bounds)
  return anchor === selection.anchor && focus === selection.focus ? selection : { anchor, focus }
}

function navigate(
  selection: Selection,
  command: GridCommand,
  pageRows: number,
  bounds: Bounds,
): Selection | undefined {
  switch (command.type) {
    case "move":
      return move(selection, command.dir, command, bounds)
    case "edge":
      return moveToEdge(selection, command.edge, command, bounds)
    case "page":
      return movePage(selection, command.dir, pageRows, command, bounds)
    case "selectAll":
      return selectAll(bounds)
    case "selectRow":
      return selectRows(selection, bounds)
    case "selectColumn":
      return selectColumns(selection, bounds)
    default:
      return undefined
  }
}

/**
 * The selected range of a grid with `bounds.rows` by `bounds.cols` cells, and the commands that
 * change it. The active cell is the anchor (Ruling M3-R7). Editing grows on this: it keeps the
 * selection and handles the commands `run` leaves alone.
 */
export function useGridSelection(bounds: Bounds) {
  const [stored, setStored] = useState(ORIGIN)
  const { rows, cols } = bounds
  const selection = useMemo(() => clampSelection(stored, { rows, cols }), [stored, rows, cols])

  /** Selects one cell, or with `extend` grows the range from the active cell to it. */
  function select(pos: Pos, extend = false) {
    setStored((previous) => ({ anchor: extend ? previous.anchor : pos, focus: pos }))
  }

  /** Selects a range, the active cell at its top left, as after a paste or an undo. */
  function selectRange(range: CellRange) {
    setStored({
      anchor: { row: range.rowStart, col: range.colStart },
      focus: { row: range.rowEnd, col: range.colEnd },
    })
  }

  /**
   * Applies a navigation command and answers the selection it leads to. Any other command is
   * not for the selection: it answers `undefined` and changes nothing.
   */
  function run(command: GridCommand, pageRows: number): Selection | undefined {
    const next = navigate(selection, command, pageRows, { rows, cols })
    if (next && !sameSelection(next, selection)) {
      setStored(next)
    }
    return next
  }

  return { selection, select, selectRange, run }
}
