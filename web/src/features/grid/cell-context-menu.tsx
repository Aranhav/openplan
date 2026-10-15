import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu"
import { type CollapsibleMember, collapsibleMembers } from "./grid-layout"
import { collapseShortcut, shortcut } from "./shortcuts"
import type { Axis, AxisView, CellMenuProps, ColumnWidthItems } from "./cell-menu-model"
import type { Member } from "./view-types"

function collapseItems(
  axis: Axis,
  view: AxisView,
  onCollapse: (axis: Axis, level: number, member: Member) => void,
) {
  const found: CollapsibleMember[] = collapsibleMembers(
    view.dims,
    view.active,
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

function widthItems(items: ColumnWidthItems) {
  return (
    <>
      <ContextMenuItem onSelect={items.onChange}>Set column width…</ContextMenuItem>
      <ContextMenuItem disabled={!items.custom} onSelect={items.onReset}>
        Reset column width
      </ContextMenuItem>
    </>
  )
}

function CellItems({
  rows,
  columns,
  state,
  onCollapseAbove,
  width,
  onCopy,
  onPaste,
  onFillDown,
}: CellMenuProps) {
  const { canPaste, canFill } = state()
  const collapsing = onCollapseAbove
    ? [
        ...collapseItems("row", rows, onCollapseAbove),
        ...collapseItems("column", columns, onCollapseAbove),
      ]
    : []
  return (
    <>
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
          {widthItems(width(columns.active))}
        </>
      )}
    </>
  )
}

function HeaderItems({
  target,
  rows,
  columns,
  onToggleHeader,
  width,
}: CellMenuProps & { target: { kind: "header"; axis: Axis; level: number; index: number } }) {
  const { axis, level, index } = target
  const view = axis === "row" ? rows : columns
  const member = view.headerAt(index)?.members[level]
  const resizes = axis === "column" && level === view.dims.length - 1 && width
  return (
    <>
      {onToggleHeader && member?.has_children && (
        <ContextMenuItem onSelect={() => onToggleHeader(axis, level, member)}>
          {member.collapsed ? "Expand" : "Collapse"} {member.label}
        </ContextMenuItem>
      )}
      {resizes && onToggleHeader && member?.has_children && <ContextMenuSeparator />}
      {resizes && widthItems(width(index))}
    </>
  )
}

/**
 * What the menu of a cell or of a header offers. The menu's items are built by a child that only
 * exists while the menu is open, so what they look up (the members that hold a cell, what it
 * allows) is looked up when it is asked for and not on every render of the grid.
 */
export function CellMenuContent(props: CellMenuProps) {
  const { target, onCloseAutoFocus } = props
  return (
    <ContextMenuContent className="w-64" onCloseAutoFocus={onCloseAutoFocus}>
      {target.kind === "cell" ? (
        <CellItems {...props} />
      ) : (
        <HeaderItems {...props} target={target} />
      )}
    </ContextMenuContent>
  )
}
