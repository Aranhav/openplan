import { useMemo, useState } from "react"
import type { HeaderCallbacks } from "./grid-headers"
import {
  DEFAULT_COLUMN_WIDTH,
  clampWidth,
  columnKey,
  defaultRowHeaderWidth,
  prefixSums,
  rowHeaderWidthsFor,
  type RowDimInfo,
  without,
} from "./grid-layout"
import type { Header } from "./view-types"

type RowHeaderWidths = { count: number; widths: Readonly<Record<number, number>> }

type Options = {
  rowDimCount: number
  /** What is known of each row dimension up front; their widths follow it until one is resized. */
  rowDimInfo?: readonly RowDimInfo[]
  /** How wide the row headers have to be together for the name in the corner to fit. */
  cornerWidth?: number
  totalColumns: number
  colHeaders: (col: number) => Header | undefined
  /** The widths the parent keeps, by the joined member keys of a column's header. */
  columnWidths: Readonly<Record<string, number>>
  onColumnWidthsChange?: (widths: Record<string, number>) => void
}

/**
 * The sizes of the grid's columns. The row header columns are the grid's own to resize, and start
 * at what their labels need if that is known, else at a share of a fixed width; the data
 * columns' widths belong to the parent, and the grid only shows a column being dragged. A column
 * whose header has not loaded has no key to look its width up by, so it counts as the default.
 */
export function useColumnWidths({
  rowDimCount,
  rowDimInfo,
  cornerWidth,
  totalColumns,
  colHeaders,
  columnWidths,
  onColumnWidthsChange,
}: Options) {
  const [dragged, setDragged] = useState<{ key: string; width: number } | null>(null)
  const [rowHeaderOverrides, setRowHeaderOverrides] = useState<RowHeaderWidths>({
    count: 0,
    widths: {},
  })

  const rowHeaderWidths = useMemo(() => {
    const fallback = defaultRowHeaderWidth(rowDimCount)
    const sized = rowDimInfo?.length === rowDimCount ? rowHeaderWidthsFor(rowDimInfo, cornerWidth) : undefined
    const overrides = rowHeaderOverrides.count === rowDimCount ? rowHeaderOverrides.widths : {}
    return Array.from(
      { length: rowDimCount },
      (_, level) => overrides[level] ?? sized?.[level] ?? fallback,
    )
  }, [rowDimCount, rowDimInfo, cornerWidth, rowHeaderOverrides])
  const rowHeaderWidth = rowHeaderWidths.reduce((sum, width) => sum + width, 0)

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

  const callbacks: Omit<HeaderCallbacks, "onToggleCollapse"> = {
    columns: onColumnWidthsChange && {
      onResize: (key, width) => setDragged({ key, width }),
      onResizeEnd: (key, width) => {
        onColumnWidthsChange({ ...columnWidths, [key]: width })
        setDragged(null)
      },
      onResizeCancel: () => setDragged(null),
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

  return { rowHeaderWidths, rowHeaderWidth, colWidths, colStarts, callbacks }
}
