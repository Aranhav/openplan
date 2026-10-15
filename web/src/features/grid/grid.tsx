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
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SWITCHOVER_NOTE, cellId, errorNoteId, noteOf, switchoverNoteId } from "./cell-notes"
import { type GridCommand, resolveKey } from "./core/keymap"
import { type CellRange, type Pos, rangeOf } from "./core/selection"
import { GridCell } from "./grid-cell"
import { ColumnHeaders, type HeaderCallbacks, RowHeaders } from "./grid-headers"
import {
  DEFAULT_COLUMN_WIDTH,
  HEADER_ROW_HEIGHT,
  ROW_HEIGHT,
  columnAt,
  lineItemIdAt,
  lineItemSource,
  revealOffset,
} from "./grid-layout"
import { useColumnWidths } from "./use-column-widths"
import { cellOf, useDragSelect } from "./use-drag-select"
import { sameSelection, useGridSelection } from "./use-grid-selection"
import { useHoveredNote } from "./use-hovered-note"
import { useViewData } from "./use-view-data"
import type {
  ConditionalFormat,
  GridQuery,
  Header,
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
  /** No cell can be changed (a viewer). */
  readOnly?: boolean
  conditionalFormats?: readonly ConditionalFormat[]
  /** Column widths by the joined member keys of the column header. */
  columnWidths?: Readonly<Record<string, number>>
  /** Dragging a header edge or double clicking it asks for new widths; without it, no resizing. */
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  /** The line item of the active cell, when it changes. */
  onSelectLineItem?: (lineItemId: string) => void
  /** A chevron was clicked; without it, no chevrons. Keep the function the same between renders. */
  onToggleCollapse?: (member: MemberRef) => void
  /** The check box of an editable boolean cell was clicked. */
  onToggleBoolean?: (cell: Pos) => void
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

// How long after the active cell moves that headers arriving late may still move the grid to it.
const LATE_HEADERS_MS = 1000

// How long the active cell waits for the view that a keyboard collapse asked for.
const FOLLOW_MS = 5000

/** The member a keyboard collapse or expand acted on, which the active cell goes to. */
type Following = {
  axis: "row" | "column"
  /** The keys of the member and of the members it is under, outermost first. */
  path: string[]
  /** Where the member was, to look for it nearest to that place. */
  from: number
  /** The row of the active cell for a column, the column for a row: it stays. */
  other: number
  until: number
}

const FOLLOW_RADIUS = 400

/** The position nearest to `from` whose header is under the path, if any such header is loaded. */
function nearestUnder(
  path: readonly string[],
  from: number,
  count: number,
  headerAt: (index: number) => Header | undefined,
): number | undefined {
  const matches = (index: number) => {
    const header = headerAt(index)
    return header !== undefined && path.every((key, level) => header.members[level]?.key === key)
  }
  for (let distance = 0; distance <= FOLLOW_RADIUS; distance++) {
    for (const index of [from - distance, from + distance]) {
      if (index >= 0 && index < count && matches(index)) {
        return index
      }
    }
  }
  return undefined
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
 * a time as it scrolls. It renders and navigates; editing is added around the callbacks.
 */
export function Grid({
  modelId,
  query,
  label = "Planning grid",
  readOnly = false,
  conditionalFormats = NO_RULES,
  columnWidths = NO_WIDTHS,
  onColumnWidthsChange,
  onSelectLineItem,
  onToggleCollapse,
  onToggleBoolean,
  onResetView,
  className,
}: GridProps) {
  const gridId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  const data = useViewData(modelId, query, visible)
  const { rowDims, columnDims, totalRows, totalColumns, rowHeaders, colHeaders } = data

  const { selection, select, run } = useGridSelection({ rows: totalRows, cols: totalColumns })
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

  // Keep the end of the range that moves in view, clear of the sticky headers. Columns whose
  // headers have not loaded count as the default width, so when headers arrive soon after the
  // active cell has moved, its place has moved too, and the grid goes to it again.
  const reveal = useEffectEvent((cell: Pos) => {
    const element = scrollRef.current
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
  useEffect(() => {
    const previous = revealed.current
    const moved = previous?.row !== focusRow || previous.col !== focusCol
    const until = moved ? Date.now() + LATE_HEADERS_MS : (previous?.until ?? 0)
    revealed.current = { row: focusRow, col: focusCol, until }
    if (moved || Date.now() < until) {
      reveal({ row: focusRow, col: focusCol })
    }
  }, [focusRow, focusCol, focusStart])

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

  // A member that comes after its children (a time summary) moves when it collapses or expands,
  // and the index the active cell had would then lie on its neighbour. So after a keyboard
  // collapse the active cell goes to the member, once the view with the member in its new place
  // has loaded.
  const follow = useRef<Following | null>(null)
  const goTo = useEffectEvent((pos: Pos) => select(pos))
  useEffect(() => {
    const pending = follow.current
    if (!pending) {
      return
    }
    if (Date.now() > pending.until) {
      follow.current = null
      return
    }
    const row = pending.axis === "row"
    const found = nearestUnder(
      pending.path,
      pending.from,
      row ? totalRows : totalColumns,
      row ? rowHeaders : colHeaders,
    )
    if (found !== undefined) {
      follow.current = null
      goTo(row ? { row: found, col: pending.other } : { row: pending.other, col: found })
    }
  }, [rowHeaders, colHeaders, totalRows, totalColumns])

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

  /**
   * Collapses or expands the member with children in the header of the active row or column, and
   * says so when there is none. The active cell then follows the member (see `follow`).
   */
  function collapseActive(command: Extract<GridCommand, { type: "collapse" }>) {
    const header = command.axis === "row" ? rowHeaders(active.row) : colHeaders(active.col)
    const dims = command.axis === "row" ? rowDims : columnDims
    if (!toggleMember || !header) {
      return
    }
    for (let level = header.members.length - 1; level >= 0; level--) {
      const member = header.members[level]
      if (member.has_children) {
        // Only a member that is not in the state asked for changes.
        if (member.collapsed === command.expand) {
          follow.current = {
            axis: command.axis,
            path: header.members.slice(0, level + 1).map((m) => m.key),
            from: command.axis === "row" ? active.row : active.col,
            other: command.axis === "row" ? active.col : active.row,
            until: Date.now() + FOLLOW_MS,
          }
          toggleMember(dims[level], member)
        }
        return
      }
    }
    announce("Nothing to collapse")
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Keys of something inside the grid, such as a chevron, are not the grid's.
    if (event.target !== event.currentTarget) {
      return
    }
    const command = resolveKey(event.nativeEvent, "navigate")
    if (command.type === "none") {
      return
    }
    // Copy and paste stay the browser's: their own events carry the clipboard to whatever
    // handles them (a handler gets the clipboard without asking for permission).
    if (command.type === "copy" || command.type === "paste") {
      return
    }
    if (command.type === "collapse") {
      collapseActive(command)
    } else {
      const next = run(command, pageRows(event.currentTarget))
      // Tab on the last cell, or Shift+Tab on the first, goes on to the next control.
      if (next && event.key === "Tab" && sameSelection(next, selection)) {
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
    select(cell, event.shiftKey)
    startDrag(cell, (move) => cellNear(move, element))
  }

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("[data-toggle]")) {
      const cell = cellOf(event.target)
      if (cell) {
        onToggleBoolean?.(cell)
      }
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

  return (
    <Frame className={className}>
      {data.error && <ErrorState error={data.error} onRetry={() => void data.refetch()} />}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-background has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 forced-colors:has-[:focus-visible]:outline-2">
        <TooltipProvider delayDuration={300}>
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
            className="group/grid h-full overflow-auto overscroll-contain bg-background outline-none"
            onKeyDown={handleKeyDown}
            onPointerDown={handlePointerDown}
            onPointerOver={onPointerOver}
            onPointerLeave={onPointerLeave}
            onClick={handleClick}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          >
            <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
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
                      return (
                        <GridCell
                          key={col}
                          gridId={gridId}
                          row={row}
                          col={col}
                          colIndex={rowDimCount + col + 1}
                          left={rowHeaderWidth + colStarts[col]}
                          width={colWidths[col]}
                          cell={data.cell(row, col)}
                          lineItem={
                            lineItemId === undefined ? undefined : lineItems.get(lineItemId)
                          }
                          rules={conditionalFormats}
                          selected={
                            row >= range.rowStart &&
                            row <= range.rowEnd &&
                            col >= range.colStart &&
                            col <= range.colEnd
                          }
                          gridReadOnly={readOnly}
                        />
                      )
                    })}
                  </div>
                )
              })}
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
