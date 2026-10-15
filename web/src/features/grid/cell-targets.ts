import { lineItemIdAt, lineItemSource } from "./grid-layout"
import type { Cell, Header, LineItemInfo, PageMember, ViewDim } from "./view-types"

/** What the grid knows of the cells it has loaded. */
export type CellReader = {
  rowDims: readonly ViewDim[]
  columnDims: readonly ViewDim[]
  pages: readonly PageMember[]
  lineItems: ReadonlyMap<string, LineItemInfo>
  rowHeaders(row: number): Header | undefined
  colHeaders(col: number): Header | undefined
  cell(row: number, col: number): Cell | undefined
}

/** A loaded cell, with the line item it belongs to and where to write it. */
export type CellTarget = {
  cell: Cell
  lineItem: LineItemInfo
  /**
   * The member keys of the line item's own dimensions, in their order, which is what the server
   * writes by. Absent when the view has no dimension for one of them.
   */
  coords: string[] | undefined
  /** The cell can be written: it is not calculated, a summary, not applicable or in error. */
  editable: boolean
}

/** Whether two dimensions are the same list, subset, time, versions or line items. */
function sameDim(a: ViewDim, b: ViewDim): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  if (a.kind === "list") {
    return a.list === (b as typeof a).list
  }
  if (a.kind === "subset") {
    return a.subset === (b as typeof a).subset
  }
  return true
}

function memberKey(
  dim: ViewDim,
  rowDims: readonly ViewDim[],
  rowHeader: Header,
  columnDims: readonly ViewDim[],
  colHeader: Header,
  pages: readonly PageMember[],
): string | undefined {
  const row = rowDims.findIndex((candidate) => sameDim(candidate, dim))
  if (row >= 0) {
    return rowHeader.members[row]?.key
  }
  const column = columnDims.findIndex((candidate) => sameDim(candidate, dim))
  if (column >= 0) {
    return colHeader.members[column]?.key
  }
  return pages.find((page) => sameDim(page.dim, dim))?.member.key
}

/** The loaded cell at a position, or nothing while it, its headers or its line item have not loaded. */
export function cellTarget(reader: CellReader, row: number, col: number): CellTarget | undefined {
  const cell = reader.cell(row, col)
  const rowHeader = reader.rowHeaders(row)
  const colHeader = reader.colHeaders(col)
  if (!cell || !rowHeader || !colHeader) {
    return undefined
  }
  const source = lineItemSource(reader.rowDims, reader.columnDims, reader.pages)
  const lineItem = reader.lineItems.get(lineItemIdAt(source, rowHeader, colHeader) ?? "")
  if (!lineItem) {
    return undefined
  }
  const keys = lineItem.dims.map((dim) =>
    memberKey(dim, reader.rowDims, rowHeader, reader.columnDims, colHeader, reader.pages),
  )
  const coords = keys.every((key) => key !== undefined) ? (keys as string[]) : undefined
  const { flags } = cell
  const editable =
    coords !== undefined &&
    !flags.includes("readonly") &&
    !flags.includes("na") &&
    !flags.includes("error")
  return { cell, lineItem, coords, editable }
}

/** Names a cell for the edits that have not come back from the server yet. */
export function cellKey(lineItemId: string, coords: readonly string[]): string {
  return [lineItemId, ...coords].join("|")
}

/**
 * What names a cell to assistive technology: its line item, then the members of its row and of
 * its column that are not the line item itself. Absent while the cell has not loaded.
 */
export function cellLabel(reader: CellReader, row: number, col: number): string | undefined {
  const target = cellTarget(reader, row, col)
  const rowHeader = reader.rowHeaders(row)
  const colHeader = reader.colHeaders(col)
  if (!target || !rowHeader || !colHeader) {
    return undefined
  }
  const others = (dims: readonly ViewDim[], header: Header) =>
    header.members.filter((_, level) => dims[level]?.kind !== "line_items").map((m) => m.label)
  return [
    target.lineItem.name,
    ...others(reader.rowDims, rowHeader),
    ...others(reader.columnDims, colHeader),
  ].join(", ")
}
