// Mirrors the JSON of the engine's view queries (task V1) and the query endpoint (V2) until the
// generated API schema carries them (Ruling M3-R8); a later task replaces each type below with
// its generated one. Field names are the engine's snake_case.

import type { Format, Value, Window } from "./core/types"

/** One axis of a module's view, tagged by `kind` like the engine's `ViewDim`. */
export type ViewDim =
  | { kind: "line_items" }
  | { kind: "list"; list: string }
  | { kind: "subset"; subset: string }
  | { kind: "time" }
  | { kind: "versions" }

/** The member shown for a page dimension; a `null` key means the default member. */
export type PageSelection = { dim: ViewDim; key: string | null }

/** One member of a dimension, named by its key (see the member keys in the global constraints). */
export type MemberRef = { dim: ViewDim; key: string }

export type FilterOp =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "contains"
  | "is_blank"
  | "not_blank"
  | "is_true"
  | "is_false"

export type RowFilter = { line_item: string; op: FilterOp; value?: Value | null }

/** The request body of `POST /models/{id}/query`; the fields the engine defaults may be left out. */
export type ViewQuery = {
  module: string
  line_items?: string[] | null
  rows: ViewDim[]
  columns: ViewDim[]
  pages?: PageSelection[]
  show_summaries?: boolean
  collapsed?: MemberRef[]
  hidden?: MemberRef[]
  filters?: RowFilter[]
  window: Window
}

/** A pivot without the slice of it to fetch, which the grid chooses as the user scrolls. */
export type GridQuery = Omit<ViewQuery, "window">

export type Member = {
  key: string
  label: string
  depth: number
  is_summary: boolean
  has_children: boolean
  collapsed: boolean
}

/** The members of one row or column, one per dimension in dimension order. */
export type Header = { members: Member[] }

export type PageMember = { dim: ViewDim; member: Member }

export type CellFlag =
  | "input"
  | "calculated"
  | "summary"
  | "readonly"
  | "na"
  | "error"
  | "switchover"

/** `text` is the item name or period label that goes with an item or period value. */
export type Cell = { value: Value; text?: string; flags: CellFlag[] }

export type FormulaError = {
  code: string
  message: string
  start: number
  end: number
  suggestion: string | null
}

export type LineItemInfo = {
  id: string
  name: string
  format: Format
  is_input: boolean
  /** The line item's own axes, in axis order. */
  dims: ViewDim[]
  errors: FormulaError[]
}

export type ViewResult = {
  row_dims: ViewDim[]
  column_dims: ViewDim[]
  pages: PageMember[]
  rows: Header[]
  columns: Header[]
  total_rows: number
  total_columns: number
  cells: Cell[][]
  line_items: LineItemInfo[]
}

/** The query endpoint's response: the view plus the model revision it was read at. */
export type QueryResult = ViewResult & { seq: number }

export type FormatColor = "red" | "amber" | "green" | "blue" | "muted"

export type FormatOp =
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "eq"
  | "ne"
  | "between"
  | "negative"
  | "positive"
  | "blank"

export type FormatStyle = { color: FormatColor; bold: boolean }

/**
 * A conditional formatting rule of a saved view (task V3). Without line items it applies to every
 * line item with a number format. Numbers are compared as stored, so a percentage is a fraction.
 */
export type ConditionalFormat = {
  name: string
  line_item_ids: string[]
  op: FormatOp
  value?: number | null
  value2?: number | null
  style: FormatStyle
}
