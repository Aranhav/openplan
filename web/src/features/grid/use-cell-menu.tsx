import { type MouseEvent as ReactMouseEvent, type RefObject, useRef, useState } from "react"
import { CellMenuContent } from "./cell-context-menu"
import { type Axis, type MenuTarget, headerHasItems } from "./cell-menu-model"
import { ColumnWidthPopover } from "./column-width-popover"
import type { GridCommand } from "./core/keymap"
import { type Pos, type Selection, contains } from "./core/selection"
import { HEADER_ROW_HEIGHT, ROW_HEIGHT, columnKey, without } from "./grid-layout"
import { headerOf } from "./header-target"
import type { Following } from "./use-follow-member"
import { cellOf } from "./use-drag-select"
import type { Header, Member, ViewDim } from "./view-types"

type Options = {
  /** The scroll container, which has the focus. */
  gridRef: RefObject<HTMLDivElement | null>
  /** The element the menu opens from. */
  triggerRef: RefObject<HTMLDivElement | null>
  selection: Selection
  select: (pos: Pos) => void
  rowDims: readonly ViewDim[]
  columnDims: readonly ViewDim[]
  totalRows: number
  totalColumns: number
  rowHeaders: (row: number) => Header | undefined
  colHeaders: (col: number) => Header | undefined
  /** Collapses or expands a member; absent when the grid cannot. */
  toggleMember?: (dim: ViewDim, member: Member) => void
  follow: { start: (following: Following) => void; cancel: () => void }
  announce: (text: string) => void
  geometry: {
    rowHeaderWidth: number
    headerHeight: number
    colStarts: readonly number[]
    colWidths: readonly number[]
  }
  columnWidths: Readonly<Record<string, number>>
  /** Absent when the columns cannot be resized. */
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  editing: {
    menuState: () => { canPaste: boolean; canFill: boolean }
    copyToClipboard: () => Promise<void>
    pasteFromClipboard: () => Promise<void>
    fillDown: () => Promise<void>
  }
  focusGrid: () => void
}

/** The column the width form is for, and where it points: the cell or the header it came from. */
type WidthForm = { key: string; col: number; width: number; top: number; height: number }

/**
 * The menu of a cell or of a header, how it opens (a right click, Shift+F10, the Menu key) and
 * what its items do, with the collapse of a member from the keyboard, which works the same way:
 * the active cell goes with the member it collapsed to its own row or column.
 */
export function useCellMenu({
  gridRef,
  triggerRef,
  selection,
  select,
  rowDims,
  columnDims,
  totalRows,
  totalColumns,
  rowHeaders,
  colHeaders,
  toggleMember,
  follow,
  announce,
  geometry,
  columnWidths,
  onColumnWidthsChange,
  editing,
  focusGrid,
}: Options) {
  const active = selection.anchor
  const [target, setTarget] = useState<MenuTarget>({ kind: "cell" })
  const [widthForm, setWidthForm] = useState<WidthForm | null>(null)
  const widthRequested = useRef(false)

  /**
   * Collapses or expands a member that holds the active row or column, the member of its own
   * header or one above it, and goes with the active cell to the member's row or column.
   */
  function collapseMember(axis: Axis, level: number, member: Member) {
    const header = axis === "row" ? rowHeaders(active.row) : colHeaders(active.col)
    const dims = axis === "row" ? rowDims : columnDims
    if (!toggleMember || !header) {
      return
    }
    const row = axis === "row"
    follow.start({
      axis,
      path: [...header.members.slice(0, level).map((m) => m.key), member.key],
      inner: header.members.slice(level + 1).map((m) => m.key),
      from: row ? active.row : active.col,
      other: row ? active.col : active.row,
    })
    toggleMember(dims[level], member)
  }

  /**
   * The keys: collapses or expands the member with children in the header of the active row or
   * column, and says so when there is none.
   */
  function collapseActive(command: Extract<GridCommand, { type: "collapse" }>) {
    const header = command.axis === "row" ? rowHeaders(active.row) : colHeaders(active.col)
    if (!toggleMember || !header) {
      return
    }
    for (let level = header.members.length - 1; level >= 0; level--) {
      const member = header.members[level]
      if (member.has_children) {
        // Only a member that is not in the state asked for changes.
        if (member.collapsed === command.expand) {
          collapseMember(command.axis, level, member)
        }
        return
      }
    }
    announce(command.expand ? "Nothing to expand" : "Nothing to collapse")
  }

  const menuProps = {
    target,
    rows: { dims: rowDims, count: totalRows, active: active.row, headerAt: rowHeaders },
    columns: { dims: columnDims, count: totalColumns, active: active.col, headerAt: colHeaders },
    state: editing.menuState,
    onCollapseAbove: toggleMember && collapseMember,
    onToggleHeader:
      toggleMember &&
      ((axis: Axis, level: number, member: Member) =>
        toggleMember((axis === "row" ? rowDims : columnDims)[level], member)),
    width:
      onColumnWidthsChange &&
      ((col: number) => {
        const header = colHeaders(col)
        const key = header && columnKey(header)
        return {
          custom: key !== undefined && key in columnWidths,
          onChange: () => {
            if (key === undefined) {
              return
            }
            widthRequested.current = true
            // A cell points at itself; a header at where it is, the top of the view.
            const fromCell = target.kind === "cell"
            const scrolled = gridRef.current?.scrollTop ?? 0
            setWidthForm({
              key,
              col,
              width: geometry.colWidths[col],
              top: fromCell
                ? geometry.headerHeight + active.row * ROW_HEIGHT
                : scrolled + (columnDims.length - 1) * HEADER_ROW_HEIGHT,
              height: fromCell ? ROW_HEIGHT : HEADER_ROW_HEIGHT,
            })
          },
          onReset: () => {
            if (key !== undefined) {
              onColumnWidthsChange(without(columnWidths, key))
            }
          },
        }
      }),
    onCopy: () => void editing.copyToClipboard(),
    onPaste: () => void editing.pasteFromClipboard(),
    onFillDown: () => void editing.fillDown(),
    onCloseAutoFocus: (event: Event) => {
      // The keyboard goes back to the grid, unless a form for the width takes it from here.
      event.preventDefault()
      if (widthRequested.current) {
        widthRequested.current = false
      } else {
        focusGrid()
      }
    },
  }

  return {
    collapseActive,

    /**
     * A right click: on a header it is the menu of the header, on a cell the menu of the cell.
     * Anywhere else, or on a header with nothing to offer, it is the browser's menu: stopping the
     * event here keeps it from the trigger, which would open ours.
     */
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      const header = headerOf(event.target)
      if (header) {
        if (!headerHasItems(menuProps, header.axis, header.level, header.index)) {
          event.stopPropagation()
          return
        }
        gridRef.current?.focus({ preventScroll: true })
        setTarget({ kind: "header", ...header })
        return
      }
      const cell = cellOf(event.target)
      if (!cell) {
        event.stopPropagation()
        return
      }
      gridRef.current?.focus({ preventScroll: true })
      if (!contains(selection, cell)) {
        follow.cancel()
        select(cell)
      }
      setTarget({ kind: "cell" })
    },

    /** Opens the menu of the active cell, as the Menu key and Shift+F10 do. */
    openAtActive() {
      const grid = gridRef.current
      if (!grid || !triggerRef.current) {
        return
      }
      const box = grid.getBoundingClientRect()
      const left = geometry.rowHeaderWidth + geometry.colStarts[active.col] - grid.scrollLeft
      const top = geometry.headerHeight + active.row * ROW_HEIGHT - grid.scrollTop
      // A cell partly under the sticky headers is pointed at where it shows.
      const x = box.left + Math.max(left, geometry.rowHeaderWidth) + 8
      const y = box.top + Math.max(top, geometry.headerHeight) + ROW_HEIGHT - 4
      setTarget({ kind: "cell" })
      triggerRef.current.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: x,
          clientY: y,
        }),
      )
    },

    menu: <CellMenuContent {...menuProps} />,

    widthForm: widthForm && (
      <ColumnWidthPopover
        anchor={{
          top: widthForm.top,
          height: widthForm.height,
          left: geometry.rowHeaderWidth + geometry.colStarts[widthForm.col],
          width: geometry.colWidths[widthForm.col],
        }}
        width={widthForm.width}
        onSubmit={(width) => {
          onColumnWidthsChange?.({ ...columnWidths, [widthForm.key]: width })
          setWidthForm(null)
          focusGrid()
        }}
        onClose={() => {
          setWidthForm(null)
          focusGrid()
        }}
      />
    ),
  }
}
