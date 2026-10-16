import type { Header, Member, PageMember, ViewDim } from "./view-types"

export const ROW_HEIGHT = 32
export const HEADER_ROW_HEIGHT = 32
export const DEFAULT_COLUMN_WIDTH = 120
export const MIN_COLUMN_WIDTH = 48
export const MAX_COLUMN_WIDTH = 640
/** How far a member is indented for each level of depth in the hierarchy. */
export const INDENT = 16

// The row headers share this width by default, up to this much for each dimension.
const ROW_HEADER_BUDGET = 320
const MAX_ROW_HEADER_DIMENSION_WIDTH = 240

export function defaultRowHeaderWidth(dimensionCount: number): number {
  return dimensionCount === 0
    ? 0
    : Math.min(MAX_ROW_HEADER_DIMENSION_WIDTH, Math.floor(ROW_HEADER_BUDGET / dimensionCount))
}

/** What is known of a row dimension before the first block of the view loads. */
export type RowDimInfo = {
  /** The greatest depth of a member. */
  maxDepth: number
  /** Some member has children, so its headers keep the room of a chevron. */
  collapsible: boolean
  /** How wide the widest label is, in pixels. */
  labelWidth: number
}

// A row header is padded by 8 px on each side, and a dimension with something to collapse keeps
// the room of a chevron (24 px) and the gap after it before every label.
const ROW_HEADER_PADDING = 16
const CHEVRON_ROOM = 26
const LABEL_SLACK = 4
const MIN_ROW_HEADER_WIDTH = 96
const MAX_ROW_HEADER_WIDTH = 320

/**
 * The width each row dimension needs to show its widest label under the deepest step of its
 * hierarchy, kept between the least and the most a row header is given. `corner` is how much
 * room the name written in the corner above the row headers asks for in all; what the widths do
 * not add up to is given to the last dimension.
 */
export function rowHeaderWidthsFor(dims: readonly RowDimInfo[], corner = 0): number[] {
  const widths = dims.map(({ maxDepth, collapsible, labelWidth }) =>
    Math.min(
      Math.max(
        Math.ceil(
          ROW_HEADER_PADDING +
            maxDepth * INDENT +
            (collapsible ? CHEVRON_ROOM : 0) +
            labelWidth +
            LABEL_SLACK,
        ),
        MIN_ROW_HEADER_WIDTH,
      ),
      MAX_ROW_HEADER_WIDTH,
    ),
  )
  const missing = corner - widths.reduce((sum, width) => sum + width, 0)
  if (missing > 0 && widths.length > 0) {
    widths[widths.length - 1] += missing
  }
  return widths
}

export function clampWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH)
}

/** Where a column's width is kept: the keys of its header's members, outermost dimension first. */
export function columnKey(header: Header): string {
  return header.members.map((member) => member.key).join("|")
}

/** A copy of `record` without `key`. */
export function without<T>(
  record: Readonly<Record<string | number, T>>,
  key: string | number,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== String(key)))
}

/** Where each size starts, and the total as the last entry. */
export function prefixSums(sizes: readonly number[]): number[] {
  const sums = [0]
  for (const size of sizes) {
    sums.push(sums[sums.length - 1] + size)
  }
  return sums
}

/** The column that holds position `x`, counted from where the first column starts. */
export function columnAt(starts: readonly number[], x: number): number {
  let low = 0
  let high = Math.max(starts.length - 2, 0)
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= x) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return low
}

/** A header cell over the columns `start` to `end`; `member` is unknown while the header loads. */
export type Span = { start: number; end: number; member?: Member }

/**
 * The header cells of one level over the given (ascending) columns. Neighbouring columns share a
 * cell when they have the same members from the outermost dimension down to `level`, so the same
 * member under two parents stays two cells.
 */
export function columnSpans(
  indexes: readonly number[],
  headerAt: (col: number) => Header | undefined,
  level: number,
): Span[] {
  const spans: Span[] = []
  let previous: Header | undefined
  for (const col of indexes) {
    const current = headerAt(col)
    const last = spans[spans.length - 1]
    if (last && previous && current && last.end === col - 1 && samePath(previous, current, level)) {
      last.end = col
    } else {
      spans.push({ start: col, end: col, member: current?.members[level] })
    }
    previous = current
  }
  return spans
}

/**
 * Whether `current` is the first row of its group at `level`: the row above does not have the
 * same members from the outermost dimension down to `level`. Rows whose neighbour is not loaded
 * count as first.
 */
export function startsRowGroup(
  previous: Header | undefined,
  current: Header,
  level: number,
): boolean {
  return !previous || !samePath(previous, current, level)
}

function samePath(a: Header, b: Header, level: number): boolean {
  for (let i = 0; i <= level; i++) {
    if (a.members[i]?.key !== b.members[i]?.key) {
      return false
    }
  }
  return true
}

/** Where the line item of a cell is named: in a row header, a column header or on a page. */
export type LineItemSource =
  | { axis: "row"; level: number }
  | { axis: "column"; level: number }
  | { axis: "page"; key: string }
  | undefined

export function lineItemSource(
  rowDims: readonly ViewDim[],
  columnDims: readonly ViewDim[],
  pages: readonly PageMember[],
): LineItemSource {
  const isLineItems = (dim: ViewDim) => dim.kind === "line_items"
  const row = rowDims.findIndex(isLineItems)
  if (row >= 0) {
    return { axis: "row", level: row }
  }
  const column = columnDims.findIndex(isLineItems)
  if (column >= 0) {
    return { axis: "column", level: column }
  }
  const page = pages.find((p) => isLineItems(p.dim))
  return page && { axis: "page", key: page.member.key }
}

export function lineItemIdAt(
  source: LineItemSource,
  rowHeader: Header | undefined,
  columnHeader: Header | undefined,
): string | undefined {
  switch (source?.axis) {
    case "row":
      return rowHeader?.members[source.level]?.key
    case "column":
      return columnHeader?.members[source.level]?.key
    case "page":
      return source.key
    default:
      return undefined
  }
}

/**
 * The scroll position that brings `[start, end)` into view, moving as little as possible.
 * `inset` is the size of the sticky headers on the leading edge, which cover the first part of
 * the viewport. A range that does not fit lines up with its start.
 */
export function revealOffset(
  range: { start: number; end: number },
  scroll: number,
  viewport: number,
  inset: number,
): number {
  const fits = range.end - range.start <= viewport - inset
  if (range.start < scroll + inset || !fits) {
    return Math.max(range.start - inset, 0)
  }
  if (range.end > scroll + viewport) {
    return range.end - viewport
  }
  return scroll
}

/** A member with children that holds a row or column. `own` is the member of its own header. */
export type CollapsibleMember = { level: number; member: Member; own: boolean }

// A hierarchy is a handful of levels deep; a scan that long has left it.
const MAX_ANCESTORS = 8
const MAX_SCAN = 5000

/**
 * The members that hold the row or column at `index` and can be collapsed, for each dimension of
 * the header from the innermost out: its own member if it has children, then the members above
 * it, nearest first. A list or subset is listed parent first, so the members above come before;
 * time is listed with each summary after its periods, so they come after. Only headers that have
 * loaded are looked at, and only those of the same members of the outer dimensions.
 */
export function collapsibleMembers(
  dims: readonly ViewDim[],
  index: number,
  count: number,
  headerAt: (index: number) => Header | undefined,
): CollapsibleMember[] {
  const base = headerAt(index)
  if (!base) {
    return []
  }
  const found: CollapsibleMember[] = []
  for (let level = dims.length - 1; level >= 0; level--) {
    const own = base.members[level]
    if (!own) {
      continue
    }
    if (own.has_children) {
      found.push({ level, member: own, own: true })
    }
    for (const member of membersAbove(dims[level], level, index, count, headerAt, base)) {
      found.push({ level, member, own: false })
    }
  }
  return found
}

function membersAbove(
  dim: ViewDim,
  level: number,
  index: number,
  count: number,
  headerAt: (index: number) => Header | undefined,
  base: Header,
): Member[] {
  const parentFirst = dim.kind === "list" || dim.kind === "subset"
  if (!parentFirst && dim.kind !== "time") {
    return []
  }
  const step = parentFirst ? -1 : 1
  const found: Member[] = []
  let depth = base.members[level].depth
  for (
    let i = index + step;
    i >= 0 && i < count && Math.abs(i - index) <= MAX_SCAN && found.length < MAX_ANCESTORS;
    i += step
  ) {
    const header = headerAt(i)
    if (!header || !samePath(header, base, level - 1)) {
      break
    }
    const member = header.members[level]
    const above = parentFirst ? member.depth < depth : member.is_summary && member.depth > depth
    if (above && member.has_children) {
      found.push(member)
      depth = member.depth
      if (parentFirst && depth === 0) {
        break
      }
    }
  }
  return found
}
