import type { Header, Member, ViewDim } from "./view-types"

export type Axis = "row" | "column"

/** What the menu is for: the active cell, or a header that was right clicked. */
export type MenuTarget =
  | { kind: "cell" }
  | { kind: "header"; axis: Axis; level: number; index: number }

export type AxisView = {
  dims: readonly ViewDim[]
  count: number
  /** The row or column of the active cell. */
  active: number
  headerAt: (index: number) => Header | undefined
}

/** The width items of a column: whether it has a width of its own, and what the items do. */
export type ColumnWidthItems = {
  custom: boolean
  onChange: () => void
  onReset: () => void
}

export type CellMenuProps = {
  target: MenuTarget
  rows: AxisView
  columns: AxisView
  /** What the active cell and the selection allow; asked when the menu opens. */
  state: () => { canPaste: boolean; canFill: boolean }
  /** Collapses or expands a member that holds the active cell, which the cell follows. Without it, none are offered. */
  onCollapseAbove?: (axis: Axis, level: number, member: Member) => void
  /** Collapses or expands the member of a header. Without it, none are offered. */
  onToggleHeader?: (axis: Axis, level: number, member: Member) => void
  /** The width of a column. Without it, the menu has no column width. */
  width?: (column: number) => ColumnWidthItems
  onCopy: () => void
  onPaste: () => void
  onFillDown: () => void
  /** The menu closes and the keyboard does not return to the grid, as something else takes it. */
  onCloseAutoFocus: (event: Event) => void
}

/** Whether a header has anything to offer, which decides if the menu opens or the browser's does. */
export function headerHasItems(
  props: Pick<CellMenuProps, "rows" | "columns" | "onToggleHeader" | "width">,
  axis: Axis,
  level: number,
  index: number,
): boolean {
  const view = axis === "row" ? props.rows : props.columns
  const member = view.headerAt(index)?.members[level]
  const collapses = !!props.onToggleHeader && !!member?.has_children
  const resizes = axis === "column" && level === view.dims.length - 1 && !!props.width
  return collapses || resizes
}
