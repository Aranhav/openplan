import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu"
import { type CollapsibleMember, collapsibleMembers } from "./grid-layout"
import { collapseShortcut, shortcut } from "./shortcuts"
import type { Header, Member, ViewDim } from "./view-types"

type Axis = "row" | "column"

type AxisView = {
  dims: readonly ViewDim[]
  count: number
  index: number
  headerAt: (index: number) => Header | undefined
}

export type CellMenuProps = {
  rows: AxisView
  columns: AxisView
  canPaste: boolean
  canFill: boolean
  /** Without it, the menu has no Collapse or Expand. */
  onCollapse?: (axis: Axis, level: number, member: Member) => void
  /** Without it, the menu has no column width. */
  width?: {
    /** The column has a width of its own to go back from. */
    custom: boolean
    onChange: () => void
    onReset: () => void
  }
  onCopy: () => void
  onPaste: () => void
  onFillDown: () => void
  /** The menu closes and the keyboard does not return to the grid, as something else takes it. */
  onCloseAutoFocus: (event: Event) => void
}

function collapseItems(
  axis: Axis,
  view: AxisView,
  onCollapse: (axis: Axis, level: number, member: Member) => void,
) {
  const found: CollapsibleMember[] = collapsibleMembers(
    view.dims,
    view.index,
    view.count,
    view.headerAt,
  )
  // The keys act on the innermost member of the header itself, which comes first.
  const withKeys = found.findIndex((entry) => entry.own)
  return found.map((entry, position) => (
    <ContextMenuItem
      key={`${axis}-${entry.level}-${entry.member.key}`}
      onSelect={() => onCollapse(axis, entry.level, entry.member)}
    >
      {entry.member.collapsed ? "Expand" : "Collapse"} {entry.member.label}
      {position === withKeys && (
        <ContextMenuShortcut>{collapseShortcut(axis, entry.member.collapsed)}</ContextMenuShortcut>
      )}
    </ContextMenuItem>
  ))
}

/**
 * What the menu of a cell offers: copy, paste and fill down with their keys, collapse or expand
 * for every member that holds the cell's row or column, and the width of the column. It is
 * mounted only while the menu is open, so what it looks up is looked up when it is needed.
 */
export function CellMenuContent({
  rows,
  columns,
  canPaste,
  canFill,
  onCollapse,
  width,
  onCopy,
  onPaste,
  onFillDown,
  onCloseAutoFocus,
}: CellMenuProps) {
  const collapsing = onCollapse
    ? [...collapseItems("row", rows, onCollapse), ...collapseItems("column", columns, onCollapse)]
    : []
  return (
    <ContextMenuContent className="w-64" onCloseAutoFocus={onCloseAutoFocus}>
      <ContextMenuItem onSelect={onCopy}>
        Copy
        <ContextMenuShortcut>{shortcut("C")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!canPaste} onSelect={onPaste}>
        Paste
        <ContextMenuShortcut>{shortcut("V")}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!canFill} onSelect={onFillDown}>
        Fill down
        <ContextMenuShortcut>{shortcut("D")}</ContextMenuShortcut>
      </ContextMenuItem>
      {collapsing.length > 0 && (
        <>
          <ContextMenuSeparator />
          {collapsing}
        </>
      )}
      {width && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={width.onChange}>Column width…</ContextMenuItem>
          <ContextMenuItem disabled={!width.custom} onSelect={width.onReset}>
            Reset column width
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}
