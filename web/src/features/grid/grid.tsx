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
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { resolveKey } from "./core/keymap"
import { type CellRange, type Pos, rangeOf } from "./core/selection"
import { GridCell } from "./grid-cell"
import { ColumnHeaders, type HeaderCallbacks, RowHeaders } from "./grid-headers"
import {
  DEFAULT_COLUMN_WIDTH,
  HEADER_ROW_HEIGHT,
  ROW_HEIGHT,
  clampWidth,
  columnAt,
  columnKey,
  defaultRowHeaderWidth,
  lineItemIdAt,
  lineItemSource,
  prefixSums,
  revealOffset,
  without,
} from "./grid-layout"
import { sameSelection, useGridSelection } from "./use-grid-selection"
import { useViewData } from "./use-view-data"
import type { ConditionalFormat, GridQuery, LineItemInfo, MemberRef } from "./view-types"

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

type RowHeaderWidths = { count: number; widths: Readonly<Record<number, number>> }

/** The cell a pointer event is over, if it is over one. */
function cellOf(target: EventTarget | null): Pos | undefined {
  const cell =
    target instanceof Element ? target.closest<HTMLElement>("[data-row][data-col]") : null
  return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : undefined
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

  // Widths: the row header columns are the grid's own; the columns' come from the parent.
  const [dragged, setDragged] = useState<{ key: string; width: number } | null>(null)
  const [rowHeaderOverrides, setRowHeaderOverrides] = useState<RowHeaderWidths>({
    count: 0,
    widths: {},
  })
  const rowDimCount = rowDims.length
  const rowHeaderWidths = useMemo(() => {
    const fallback = defaultRowHeaderWidth(rowDimCount)
    const overrides = rowHeaderOverrides.count === rowDimCount ? rowHeaderOverrides.widths : {}
    return Array.from({ length: rowDimCount }, (_, level) => overrides[level] ?? fallback)
  }, [rowDimCount, rowHeaderOverrides])
  const rowHeaderWidth = rowHeaderWidths.reduce((sum, width) => sum + width, 0)
  const headerHeight = columnDims.length * HEADER_ROW_HEIGHT

  const colWidths = useMemo(
    () =>
      Array.from({ length: totalColumns }, (_, col) => {
        const header = colHeaders(col)
        if (!header) {
          return DEFAULT_COLUMN_WIDTH
        }
        const key = columnKey(header)
        return dragged?.key === key
          ? dragged.width
          : clampWidth(columnWidths[key] ?? DEFAULT_COLUMN_WIDTH)
      }),
    [totalColumns, colHeaders, columnWidths, dragged],
  )
  const colStarts = useMemo(() => prefixSums(colWidths), [colWidths])
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

  const lineItems = useMemo(
    () => new Map<string, LineItemInfo>(data.lineItems.map((lineItem) => [lineItem.id, lineItem])),
    [data.lineItems],
  )
  const lineItemSourceOfCells = useMemo(
    () => lineItemSource(rowDims, columnDims, data.pages),
    [rowDims, columnDims, data.pages],
  )

  const activeLineItemId = lineItemIdAt(
    lineItemSourceOfCells,
    rowHeaders(selection.anchor.row),
    colHeaders(selection.anchor.col),
  )
  const reportLineItem = useEffectEvent((id: string) => onSelectLineItem?.(id))
  useEffect(() => {
    if (activeLineItemId !== undefined) {
      reportLineItem(activeLineItemId)
    }
  }, [activeLineItemId])

  // Keep the end of the range that moves in view, clear of the sticky headers.
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
  useEffect(() => {
    reveal({ row: focusRow, col: focusCol })
  }, [focusRow, focusCol])

  const dragAbort = useRef<AbortController | null>(null)
  useEffect(() => () => dragAbort.current?.abort(), [])

  const toggleCollapse = useMemo(
    () =>
      onToggleCollapse &&
      ((member: MemberRef) => {
        onToggleCollapse(member)
        scrollRef.current?.focus({ preventScroll: true })
      }),
    [onToggleCollapse],
  )

  const headerCallbacks: HeaderCallbacks = {
    onToggleCollapse: toggleCollapse,
    columns: onColumnWidthsChange && {
      onResize: (key, width) => setDragged({ key, width }),
      onResizeEnd: (key, width) => {
        onColumnWidthsChange({ ...columnWidths, [key]: width })
        setDragged(null)
      },
      onReset: (key) => onColumnWidthsChange(without(columnWidths, key)),
    },
    onRowHeaderResize: (level, width) =>
      setRowHeaderOverrides((previous) => ({
        count: rowDimCount,
        widths: {
          ...(previous.count === rowDimCount ? previous.widths : {}),
          [level]: width,
        },
      })),
    onRowHeaderResizeReset: (level) =>
      setRowHeaderOverrides((previous) => ({
        count: rowDimCount,
        widths: without(previous.count === rowDimCount ? previous.widths : {}, level),
      })),
  }

  function pageRows(element: HTMLElement): number {
    return Math.floor((element.clientHeight - headerHeight) / ROW_HEIGHT)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Keys of something inside the grid, such as a chevron, are not the grid's.
    if (event.target !== event.currentTarget) {
      return
    }
    const next = run(resolveKey(event.nativeEvent, "navigate"), pageRows(event.currentTarget))
    if (!next) {
      return
    }
    // Tab on the last cell, or Shift+Tab on the first, goes on to the next control.
    if (event.key === "Tab" && sameSelection(next, selection)) {
      return
    }
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

    dragAbort.current?.abort()
    const abort = new AbortController()
    dragAbort.current = abort
    let last = cell
    window.addEventListener(
      "pointermove",
      (move) => {
        const over = cellNear(move, element)
        if (over && (over.row !== last.row || over.col !== last.col)) {
          last = over
          select(over, true)
        }
      },
      { signal: abort.signal },
    )
    const end = () => abort.abort()
    window.addEventListener("pointerup", end, { signal: abort.signal })
    window.addEventListener("pointercancel", end, { signal: abort.signal })
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
  const active = selection.anchor
  const activeId = `${gridId}-r${active.row}c${active.col}`
  const activeRendered =
    rowItems.some((item) => item.index === active.row) && cols.includes(active.col)

  const rect = (rowStart: number, rowEnd: number, colStart: number, colEnd: number) => ({
    top: headerHeight + rowStart * ROW_HEIGHT,
    height: (rowEnd - rowStart + 1) * ROW_HEIGHT,
    left: rowHeaderWidth + colStarts[colStart],
    width: colStarts[colEnd + 1] - colStarts[colStart],
  })
  const multiple = range.rowStart !== range.rowEnd || range.colStart !== range.colEnd

  return (
    <Frame className={className}>
      {data.error && <ErrorState error={data.error} onRetry={() => void data.refetch()} />}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-background has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50">
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
            onClick={handleClick}
          >
            <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
              <ColumnHeaders
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
                      header={rowHeader}
                      previous={rowHeaders(row - 1)}
                      rowDims={rowDims}
                      widths={rowHeaderWidths}
                      lineItems={lineItems}
                      onToggleCollapse={toggleCollapse}
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
                          id={`${gridId}-r${row}c${col}`}
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
                  className="pointer-events-none absolute z-5 bg-primary/10 ring-1 ring-primary ring-inset"
                  style={rect(range.rowStart, range.rowEnd, range.colStart, range.colEnd)}
                />
              )}
              <div
                aria-hidden
                className="pointer-events-none absolute z-5 ring-2 ring-primary/40 ring-inset group-focus/grid:ring-primary"
                style={rect(active.row, active.row, active.col, active.col)}
              />
            </div>
          </div>
        </TooltipProvider>
      </div>
    </Frame>
  )
}
