export type Pos = { row: number; col: number }

/**
 * One rectangular range, as in Excel. The anchor is the active cell: Enter, F2 and typing act
 * on it, and a plain arrow key moves from it and collapses the range to the new cell. The
 * focus is the opposite corner, the end that Shift+arrow keys grow and shrink the range from.
 */
export type Selection = { anchor: Pos; focus: Pos }

/** The number of body rows and columns that can be selected. */
export type Bounds = { rows: number; cols: number }

/** A rectangle of cells with both ends included. */
export type CellRange = { rowStart: number; rowEnd: number; colStart: number; colEnd: number }

export type Direction = "up" | "down" | "left" | "right"
export type Edge = "home" | "end"

export type MoveOptions = {
  /** Keep the anchor and move the focus end of the range (Shift). */
  extend: boolean
  /** Go to the edge of the grid instead of one step (Ctrl or Command). */
  jump: boolean
}

export function rangeOf(sel: Selection): CellRange {
  return {
    rowStart: Math.min(sel.anchor.row, sel.focus.row),
    rowEnd: Math.max(sel.anchor.row, sel.focus.row),
    colStart: Math.min(sel.anchor.col, sel.focus.col),
    colEnd: Math.max(sel.anchor.col, sel.focus.col),
  }
}

export function contains(sel: Selection, pos: Pos): boolean {
  const range = rangeOf(sel)
  return (
    pos.row >= range.rowStart &&
    pos.row <= range.rowEnd &&
    pos.col >= range.colStart &&
    pos.col <= range.colEnd
  )
}

/** Every cell. A grid with no rows or columns has nothing to select, so this is the origin. */
export function selectAll(bounds: Bounds): Selection {
  return {
    anchor: { row: 0, col: 0 },
    focus: { row: Math.max(bounds.rows - 1, 0), col: Math.max(bounds.cols - 1, 0) },
  }
}

export function move(
  sel: Selection,
  dir: Direction,
  { extend, jump }: MoveOptions,
  bounds: Bounds,
): Selection {
  if (isEmpty(bounds)) {
    return sel
  }
  return land(sel, stepTarget(startOf(sel, extend), dir, jump, bounds), extend, bounds)
}

/**
 * Home and End go to the first and last column of the row; with `jump`, to the grid's corners.
 */
export function moveToEdge(
  sel: Selection,
  edge: Edge,
  { extend, jump }: MoveOptions,
  bounds: Bounds,
): Selection {
  if (isEmpty(bounds)) {
    return sel
  }
  const first = edge === "home"
  const row = jump ? (first ? 0 : bounds.rows - 1) : startOf(sel, extend).row
  return land(sel, { row, col: first ? 0 : bounds.cols - 1 }, extend, bounds)
}

/** PageUp and PageDown move `pageRows` rows (at least one) and keep the column. */
export function movePage(
  sel: Selection,
  dir: "up" | "down",
  pageRows: number,
  { extend }: Pick<MoveOptions, "extend">,
  bounds: Bounds,
): Selection {
  if (isEmpty(bounds)) {
    return sel
  }
  const rows = Math.max(pageRows, 1)
  const start = startOf(sel, extend)
  const row = start.row + (dir === "down" ? rows : -rows)
  return land(sel, { row, col: start.col }, extend, bounds)
}

/** Where a move starts: the focus end when extending, else the active cell, the anchor. */
function startOf(sel: Selection, extend: boolean): Pos {
  return extend ? sel.focus : sel.anchor
}

function isEmpty(bounds: Bounds): boolean {
  return bounds.rows <= 0 || bounds.cols <= 0
}

function stepTarget(focus: Pos, dir: Direction, jump: boolean, bounds: Bounds): Pos {
  switch (dir) {
    case "up":
      return { row: jump ? 0 : focus.row - 1, col: focus.col }
    case "down":
      return { row: jump ? bounds.rows - 1 : focus.row + 1, col: focus.col }
    case "left":
      return { row: focus.row, col: jump ? 0 : focus.col - 1 }
    case "right":
      return { row: focus.row, col: jump ? bounds.cols - 1 : focus.col + 1 }
  }
}

function clamp(value: number, last: number): number {
  return Math.min(Math.max(value, 0), last)
}

/** Put the focus at `target`, inside the grid, and collapse to it unless extending. */
function land(sel: Selection, target: Pos, extend: boolean, bounds: Bounds): Selection {
  const focus = {
    row: clamp(target.row, bounds.rows - 1),
    col: clamp(target.col, bounds.cols - 1),
  }
  return { anchor: extend ? sel.anchor : focus, focus }
}
