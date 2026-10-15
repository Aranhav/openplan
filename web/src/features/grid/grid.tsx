import { type Virtualizer, useVirtualizer } from "@tanstack/react-virtual"
import { Table2 } from "lucide-react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SWITCHOVER_NOTE, cellId, errorNoteId, noteOf, switchoverNoteId } from "./cell-notes"
import { type CellReader, cellLabel, cellTarget } from "./cell-targets"
import { keyInput, resolveKey } from "./core/keymap"
import { type CellRange, type Pos, rangeOf } from "./core/selection"
import { type GridReference, NO_REFERENCE, displayText, listOptions } from "./edit-reference"
import { CellEditor } from "./editors/cell-editor"
import { GridCell } from "./grid-cell"
import { ColumnHeaders, type HeaderCallbacks, RowHeaders } from "./grid-headers"
import {
  DEFAULT_COLUMN_WIDTH,
  HEADER_ROW_HEIGHT,
  ROW_HEIGHT,
  columnAt,
  lineItemIdAt,
  lineItemSource,
} from "./grid-layout"
import { useCellMenu } from "./use-cell-menu"
import { useColumnWidths } from "./use-column-widths"
import { cellOf, useDragSelect } from "./use-drag-select"
import { useFollowMember } from "./use-follow-member"
import { sameSelection, useGridSelection } from "./use-grid-selection"
import { useGridEditing } from "./use-grid-editing"
import { useHoveredNote } from "./use-hovered-note"
import { useReveal } from "./use-reveal"
import { type Lookup, useViewData } from "./use-view-data"
import type {
  ConditionalFormat,
  GridQuery,
  LineItemInfo,
  Member,
  MemberRef,
  ViewDim,
} from "./view-types"

const NO_RULES: readonly ConditionalFormat[] = []
const NO_WIDTHS: Readonly<Record<string, number>> = {}
const INITIAL_VISIBLE: CellRange = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
const ROW_OVERSCAN = 6
const COLUMN_OVERSCAN = 3

export type GridProps = {
  modelId: string
  /** The pivot to show. Pass the same object while it does not change. */
  query: GridQuery
  /** Names the grid for assistive technology. */
  label?: string
  /** No cell can be changed (a viewer): copying still works. */
  readOnly?: boolean
  /** The items of the lists and the periods that list and period cells are edited with. */
  reference?: GridReference
  conditionalFormats?: readonly ConditionalFormat[]
  /** Column widths by the joined member keys of the column header. */
  columnWidths?: Readonly<Record<string, number>>
  /** Dragging a header edge or double clicking it asks for new widths; without it, no resizing. */
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  /** The line item of the active cell, when it changes. */
  onSelectLineItem?: (lineItemId: string) => void
  /** A chevron was clicked; without it, no chevrons. Keep the function the same between renders. */
  onToggleCollapse?: (member: MemberRef) => void
  /** Offered when the pivot shows nothing; without it, the message has no button. */
  onResetView?: () => void
  className?: string
}

function Frame({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex h-full min-h-60 flex-col gap-3", className)}>{children}</div>
}

function GridSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading grid"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border"
    >
      {Array.from({ length: 9 }, (_, row) => (
        <div key={row} className={cn("flex h-8 shrink-0 border-b", row === 0 && "bg-muted")}>
          <div className="flex w-40 shrink-0 items-center border-r bg-muted px-2">
            <Skeleton className="h-3 w-24" />
          </div>
          {Array.from({ length: 6 }, (_, col) => (
            <div key={col} className="flex flex-1 items-center justify-end border-r px-2">
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** How many cells a range holds, in words, or nothing for a single cell. */
function selectionMessage(range: CellRange): string {
  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  if (rows === 1 && cols === 1) {
    return ""
  }
  return `${rows} ${rows === 1 ? "row" : "rows"} by ${cols} ${cols === 1 ? "column" : "columns"} selected`
}

/**
 * The pivot grid: virtualized rows and columns with sticky, multi-level headers, loaded a block at
 * a time as it scrolls, and edited the way a spreadsheet is: type over a cell, Enter or F2 or a
 * double click to edit it, Escape to give up, paste, fill down, clear, undo and redo.
 */
export function Grid({
  modelId,
  query,
  label = "Planning grid",
  readOnly = false,
  reference = NO_REFERENCE,
  conditionalFormats = NO_RULES,
  columnWidths = NO_WIDTHS,
  onColumnWidthsChange,
  onSelectLineItem,
  onToggleCollapse,
  onResetView,
  className,
}: GridProps) {
  const gridId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  const data = useViewData(modelId, query, visible)
  const { rowDims, columnDims, totalRows, totalColumns, rowHeaders, colHeaders } = data

  const { selection, select, selectRange, run } = useGridSelection({
    rows: totalRows,
    cols: totalColumns,
  })
  const startDrag = useDragSelect(select)

  const { rowHeaderWidths, rowHeaderWidth, colWidths, colStarts, callbacks } = useColumnWidths({
    rowDimCount: rowDims.length,
    totalColumns,
    colHeaders,
    columnWidths,
    onColumnWidthsChange,
  })
  const rowDimCount = rowDims.length
  const headerHeight = columnDims.length * HEADER_ROW_HEIGHT
  const contentWidth = rowHeaderWidth + colStarts[colStarts.length - 1]
  const contentHeight = headerHeight + totalRows * ROW_HEIGHT

  // The virtualizers say what is on screen; `visible` carries that to the data.
  const trackRows = (instance: Virtualizer<HTMLDivElement, Element>) => {
    const range = instance.range
    if (range) {
      setVisible((previous) =>
        previous.rowStart === range.startIndex && previous.rowEnd === range.endIndex
          ? previous
          : { ...previous, rowStart: range.startIndex, rowEnd: range.endIndex },
      )
    }
  }
  const trackColumns = (instance: Virtualizer<HTMLDivElement, Element>) => {
    const range = instance.range
    if (range) {
      setVisible((previous) =>
        previous.colStart === range.startIndex && previous.colEnd === range.endIndex
          ? previous
          : { ...previous, colStart: range.startIndex, colEnd: range.endIndex },
      )
    }
  }
  const getColumnKey = useCallback((col: number) => `${col}:${colWidths[col]}`, [colWidths])
  // eslint-disable-next-line react-hooks/incompatible-library -- the grid only reads from it
  const rowVirtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    scrollMargin: headerHeight,
    onChange: trackRows,
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: totalColumns,
    getScrollElement: () => scrollRef.current,
    estimateSize: (col) => colWidths[col] ?? DEFAULT_COLUMN_WIDTH,
    getItemKey: getColumnKey,
    overscan: COLUMN_OVERSCAN,
    scrollMargin: rowHeaderWidth,
    onChange: trackColumns,
  })

  // One object for each line item, and where a cell finds its line item.
  const lineItems = useMemo(
    () => new Map<string, LineItemInfo>(data.lineItems.map((lineItem) => [lineItem.id, lineItem])),
    [data.lineItems],
  )
  const lineItemSourceOfCells = useMemo(
    () => lineItemSource(rowDims, columnDims, data.pages),
    [rowDims, columnDims, data.pages],
  )
  const lineItemIdOf = (row: number, col: number) =>
    lineItemIdAt(lineItemSourceOfCells, rowHeaders(row), colHeaders(col))

  const activeLineItemId = lineItemIdOf(selection.anchor.row, selection.anchor.col)
  const reportLineItem = useEffectEvent((id: string) => onSelectLineItem?.(id))
  useEffect(() => {
    if (activeLineItemId !== undefined) {
      reportLineItem(activeLineItemId)
    }
  }, [activeLineItemId])

  const selectAndReveal = useReveal({
    gridRef: scrollRef,
    selection,
    selectRange,
    totalRows,
    totalColumns,
    headerHeight,
    rowHeaderWidth,
    colStarts,
    colWidths,
  })

  // What the status region says. A new message replaces the node, so the same words said twice
  // are read twice.
  const [announcement, setAnnouncement] = useState({ text: "", id: 0 })
  const announce = (text: string) => setAnnouncement((now) => ({ text, id: now.id + 1 }))
  const toggleMember = useMemo(
    () =>
      onToggleCollapse &&
      ((dim: ViewDim, member: Member) => {
        onToggleCollapse({ dim, key: member.key })
        scrollRef.current?.focus({ preventScroll: true })
        setAnnouncement((now) => ({
          text: `${member.collapsed ? "Expanded" : "Collapsed"} ${member.label}`,
          id: now.id + 1,
        }))
      }),
    [onToggleCollapse],
  )
  const headerCallbacks: HeaderCallbacks = { ...callbacks, onToggleCollapse: toggleMember }

  const follow = useFollowMember({
    rowHeaders,
    colHeaders,
    totalRows,
    totalColumns,
    waiting: data.isPlaceholder,
    onFound: select,
  })

  // Editing. What the cells hold and where to find them is the same for the editors and the
  // clipboard as for the rendering; a view that is only the previous one is not edited.
  const reader = useMemo<CellReader>(
    () => ({
      rowDims,
      columnDims,
      pages: data.pages,
      lineItems,
      rowHeaders,
      colHeaders,
      cell: data.cell,
    }),
    [rowDims, columnDims, data.pages, lineItems, rowHeaders, colHeaders, data.cell],
  )
  // Cells that were loaded for an action are read through a reader of their own.
  const readerOf = (lookup: Lookup): CellReader => ({
    ...reader,
    lineItems: new Map(lookup.lineItems.map((lineItem) => [lineItem.id, lineItem])),
    rowHeaders: lookup.rowHeaders,
    colHeaders: lookup.colHeaders,
    cell: lookup.cell,
  })
  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true })
  const editing = useGridEditing({
    modelId,
    moduleId: query.module,
    readOnly: readOnly || data.isPlaceholder,
    reference,
    selection,
    bounds: { rows: totalRows, cols: totalColumns },
    reader,
    load: async (range) => readerOf(await data.load(range)),
    peek: (range) => {
      const lookup = data.peek(range)
      return lookup && readerOf(lookup)
    },
    moveSelection: (direction) =>
      run({ type: "move", dir: direction, extend: false, jump: false }, 0),
    selectRange: selectAndReveal,
    gridRef: scrollRef,
    focusGrid,
  })

  const triggerRef = useRef<HTMLDivElement>(null)
  const menu = useCellMenu({
    gridRef: scrollRef,
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
    geometry: { rowHeaderWidth, headerHeight, colStarts, colWidths },
    columnWidths,
    onColumnWidthsChange,
    editing,
    focusGrid,
  })

  // The notes: what a switchover or error cell cannot say by its value, in one tooltip that
  // follows the pointer, or the active cell while the grid has focus.
  const [focused, setFocused] = useState(false)
  const { hovered, onPointerOver, onPointerLeave } = useHoveredNote()
  const active = selection.anchor
  // The view can shrink under a pointer that has not moved, so the hovered cell may be gone.
  const hoveredHere =
    hovered && hovered.row < totalRows && hovered.col < totalColumns ? hovered : null
  const tipCell = hoveredHere ?? (focused ? active : null)
  const tipKey = tipCell ? `${tipCell.row}:${tipCell.col}` : ""
  const tipNote = tipCell
    ? noteOf(
        data.cell(tipCell.row, tipCell.col),
        lineItems.get(lineItemIdOf(tipCell.row, tipCell.col) ?? ""),
      )
    : undefined
  const [dismissed, setDismissed] = useState("")
  if (dismissed !== "" && dismissed !== tipKey) {
    setDismissed("")
  }

  function pageRows(element: HTMLElement): number {
    return Math.floor((element.clientHeight - headerHeight) / ROW_HEIGHT)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Keys of something inside the grid, such as a chevron, are not the grid's.
    if (event.target !== event.currentTarget) {
      return
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault()
      menu.openAtActive()
      return
    }
    const command = resolveKey(keyInput(event.nativeEvent), "navigate")
    if (command.type === "none") {
      return
    }
    // Copy and paste stay the browser's: their own events carry the clipboard to whatever
    // handles them (a handler gets the clipboard without asking for permission).
    if (command.type === "copy" || command.type === "paste") {
      return
    }
    if (command.type === "collapse") {
      menu.collapseActive(command)
    } else {
      // Going on with something else ends a collapse that is still waiting for its view.
      follow.cancel()
      const next = run(command, pageRows(event.currentTarget))
      if (next === undefined) {
        editing.run(command)
      } else if (event.key === "Tab" && sameSelection(next, selection)) {
        // Tab on the last cell, or Shift+Tab on the first, goes on to the next control.
        return
      }
    }
    // What the grid takes, the browser does not do as well: no scrolling by Space, for one.
    event.preventDefault()
  }

  /** The cell at a pointer position, outside the cells too: the nearest one, for dragging. */
  function cellNear(event: PointerEvent, element: HTMLElement): Pos | undefined {
    const over = cellOf(event.target)
    if (over || totalRows === 0 || totalColumns === 0) {
      return over
    }
    const box = element.getBoundingClientRect()
    const x = event.clientX - box.left + element.scrollLeft - rowHeaderWidth
    const y = event.clientY - box.top + element.scrollTop - headerHeight
    return {
      row: Math.min(Math.max(Math.floor(y / ROW_HEIGHT), 0), totalRows - 1),
      col: columnAt(colStarts, x),
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const cell = cellOf(event.target)
    if (!cell || event.button !== 0) {
      return
    }
    const element = event.currentTarget
    element.focus({ preventScroll: true })
    follow.cancel()
    select(cell, event.shiftKey)
    startDrag(cell, (move) => cellNear(move, element))
  }

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("[data-toggle]")) {
      const cell = cellOf(event.target)
      if (cell) {
        editing.toggleAt(cell)
      }
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const cell = cellOf(event.target)
    if (cell) {
      editing.openAt(cell)
    }
  }

  if (!data.hasShape) {
    return (
      <Frame className={className}>
        {data.error ? (
          <ErrorState error={data.error} onRetry={() => void data.refetch()} />
        ) : (
          <GridSkeleton />
        )}
      </Frame>
    )
  }
  if (totalRows === 0 || totalColumns === 0) {
    return (
      <Frame className={className}>
        {data.isPlaceholder ? (
          <GridSkeleton />
        ) : (
          <EmptyState
            icon={Table2}
            title="Nothing to show with this pivot."
            description="Change the rows, columns or filters, or start again from the default view."
            action={onResetView && <Button onClick={onResetView}>Reset view</Button>}
          />
        )}
      </Frame>
    )
  }

  const rowItems = rowVirtualizer.getVirtualItems()
  const columnItems = columnVirtualizer.getVirtualItems()
  const cols = columnItems.map((item) => item.index)
  const range = rangeOf(selection)
  const activeId = cellId(gridId, active.row, active.col)
  const activeRendered =
    rowItems.some((item) => item.index === active.row) && cols.includes(active.col)

  const rect = (rowStart: number, rowEnd: number, colStart: number, colEnd: number) => ({
    top: headerHeight + rowStart * ROW_HEIGHT,
    height: (rowEnd - rowStart + 1) * ROW_HEIGHT,
    left: rowHeaderWidth + colStarts[colStart],
    width: colStarts[colEnd + 1] - colStarts[colStart],
  })
  const multiple = range.rowStart !== range.rowEnd || range.colStart !== range.colEnd
  const anchor = tipCell ?? active

  // The editor on the cell being edited, if the cell is still there to edit.
  const editorCell = editing.editor
  const editorTarget = editorCell && cellTarget(reader, editorCell.pos.row, editorCell.pos.col)
  const editorValue = editorTarget && editing.valueOf(editorTarget)
  const canWrite = !readOnly && !data.isPlaceholder

  return (
    <Frame className={className}>
      {data.error && <ErrorState error={data.error} onRetry={() => void data.refetch()} />}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-background has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 forced-colors:has-[:focus-visible]:outline-2">
        <TooltipProvider delayDuration={300}>
          <ContextMenu>
            <div
              ref={scrollRef}
              role="grid"
              tabIndex={0}
              aria-label={label}
              aria-rowcount={totalRows + columnDims.length}
              aria-colcount={totalColumns + rowDims.length}
              aria-multiselectable
              aria-readonly={readOnly || undefined}
              aria-busy={data.isPlaceholder || undefined}
              aria-activedescendant={activeRendered ? activeId : undefined}
              className={cn(
                "group/grid h-full overflow-auto overscroll-contain bg-background outline-none",
                data.isPlaceholder && "opacity-60",
              )}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerOver={onPointerOver}
              onPointerLeave={onPointerLeave}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            >
              <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
                {/* Only the headers and cells have the menu: the editor, its popovers and the
                    form for a width are beside it, and keep the browser's own menu. */}
                <ContextMenuTrigger asChild>
                  <div
                    ref={triggerRef}
                    className="absolute top-0 left-0"
                    style={{ width: contentWidth, height: contentHeight }}
                  >
                    {/* What the menu is for is decided here, below the trigger, so that a right
                        click that is left to the browser can stop before it reaches the trigger. */}
                    <div className="contents" onContextMenu={menu.onContextMenu}>
                      <ColumnHeaders
                        gridId={gridId}
                        columnDims={columnDims}
                        cols={cols}
                        colStarts={colStarts}
                        rowHeaderWidths={rowHeaderWidths}
                        headerAt={colHeaders}
                        lineItems={lineItems}
                        callbacks={headerCallbacks}
                        contentWidth={contentWidth}
                      />
                      {rowItems.map((rowItem) => {
                        const row = rowItem.index
                        const rowHeader = rowHeaders(row)
                        return (
                          <div
                            key={row}
                            role="row"
                            data-row-index={row}
                            aria-rowindex={columnDims.length + row + 1}
                            className="absolute left-0"
                            style={{ top: rowItem.start, height: ROW_HEIGHT, width: contentWidth }}
                          >
                            <RowHeaders
                              gridId={gridId}
                              header={rowHeader}
                              previous={rowHeaders(row - 1)}
                              rowDims={rowDims}
                              widths={rowHeaderWidths}
                              lineItems={lineItems}
                              onToggleCollapse={toggleMember}
                            />
                            {cols.map((col) => {
                              const lineItemId = lineItemIdAt(
                                lineItemSourceOfCells,
                                rowHeader,
                                colHeaders(col),
                              )
                              const lineItem =
                                lineItemId === undefined ? undefined : lineItems.get(lineItemId)
                              // A value that is being written shows in place of the one it replaces.
                              const pendingValue = editing.pendingAt(row, col)
                              const loaded = data.cell(row, col)
                              const cell =
                                pendingValue && loaded
                                  ? {
                                      ...loaded,
                                      value: pendingValue,
                                      text:
                                        lineItem &&
                                        displayText(pendingValue, lineItem.format, reference),
                                    }
                                  : loaded
                              return (
                                <GridCell
                                  key={col}
                                  gridId={gridId}
                                  row={row}
                                  col={col}
                                  colIndex={rowDimCount + col + 1}
                                  left={rowHeaderWidth + colStarts[col]}
                                  width={colWidths[col]}
                                  cell={cell}
                                  lineItem={lineItem}
                                  rules={conditionalFormats}
                                  selected={
                                    row >= range.rowStart &&
                                    row <= range.rowEnd &&
                                    col >= range.colStart &&
                                    col <= range.colEnd
                                  }
                                  pending={pendingValue !== undefined}
                                  gridReadOnly={!canWrite}
                                />
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </ContextMenuTrigger>
                {multiple && (
                  <div
                    aria-hidden
                    data-selection="range"
                    className="pointer-events-none absolute z-5 bg-primary/10 ring-1 ring-primary ring-inset forced-colors:outline-1 forced-colors:-outline-offset-1"
                    style={rect(range.rowStart, range.rowEnd, range.colStart, range.colEnd)}
                  />
                )}
                <div
                  aria-hidden
                  data-selection="active"
                  className="pointer-events-none absolute z-5 ring-2 ring-primary/40 ring-inset group-focus/grid:ring-primary forced-colors:outline-2 forced-colors:-outline-offset-2"
                  style={rect(active.row, active.row, active.col, active.col)}
                />
                {editorCell && editorTarget && editorValue && (
                  // In a row and a cell of its own, so that the grid's rows hold only cells.
                  <div
                    role="row"
                    aria-rowindex={columnDims.length + editorCell.pos.row + 1}
                    className="pointer-events-none absolute left-0 z-10"
                    style={{
                      top: headerHeight + editorCell.pos.row * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      width: contentWidth,
                    }}
                  >
                    <div
                      role="gridcell"
                      aria-colindex={rowDimCount + editorCell.pos.col + 1}
                      className="pointer-events-auto absolute top-0 h-full"
                      style={{
                        left: rowHeaderWidth + colStarts[editorCell.pos.col],
                        width: colWidths[editorCell.pos.col],
                      }}
                    >
                      <CellEditor
                        kind={editorCell.kind}
                        label={cellLabel(reader, editorCell.pos.row, editorCell.pos.col) ?? label}
                        initial={editorCell.initial}
                        align={editorTarget.lineItem.format.type === "number" ? "right" : "left"}
                        entered={editorCell.entered}
                        options={listOptions(editorTarget.lineItem.format, reference)}
                        currentItem={editorValue.value.t === "item" ? editorValue.value.v : null}
                        currentDate={editorValue.value.t === "date" ? editorValue.value.v : null}
                        onText={editing.commitText}
                        onValue={editing.pick}
                        onLeave={editing.leave}
                        onCancel={editing.cancel}
                      />
                    </div>
                  </div>
                )}
                {menu.widthForm}
                {/* Radix closes a tooltip when anything that holds its trigger scrolls, and the grid
                    scrolls to the active cell as the keys move it; only Escape dismisses this one. */}
                <Tooltip open={tipNote !== undefined && dismissed !== tipKey}>
                  <TooltipTrigger asChild>
                    <div
                      aria-hidden
                      data-tooltip-anchor
                      className="pointer-events-none absolute"
                      style={rect(anchor.row, anchor.row, anchor.col, anchor.col)}
                    />
                  </TooltipTrigger>
                  <TooltipContent hideWhenDetached onEscapeKeyDown={() => setDismissed(tipKey)}>
                    {tipNote}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            {menu.menu}
          </ContextMenu>
        </TooltipProvider>
      </div>
      <div hidden>
        <span id={switchoverNoteId(gridId)}>{SWITCHOVER_NOTE}</span>
        {data.lineItems
          .filter((lineItem) => lineItem.errors.length > 0)
          .map((lineItem) => (
            <span key={lineItem.id} id={errorNoteId(gridId, lineItem.id)}>
              {lineItem.errors[0].message}
            </span>
          ))}
      </div>
      <div role="status" className="sr-only">
        <span key={announcement.id}>{announcement.text}</span>
      </div>
      <div role="status" className="sr-only">
        {selectionMessage(range)}
      </div>
    </Frame>
  )
}
