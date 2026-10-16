// The query endpoint's request and answer, as the generated API schema words them.

import type { components } from "@/lib/api/schema"

type Schemas = components["schemas"]

/** One axis of a module's view, tagged by `kind` like the engine's `ViewDim`. */
export type ViewDim = Schemas["ViewDimDto"]

/** The member shown for a page dimension; a `null` key means the default member. */
export type PageSelection = Schemas["PageSelectionDto"]

/** One member of a dimension, named by its key (see the member keys in the global constraints). */
export type MemberRef = Schemas["MemberRefDto"]

export type FilterOp = Schemas["FilterOpDto"]

export type RowFilter = Schemas["RowFilterDto"]

/** The request body of `POST /models/{id}/query`; the fields the engine defaults may be left out. */
export type ViewQuery = Schemas["ViewQueryDto"]

/** A pivot without the slice of it to fetch, which the grid chooses as the user scrolls. */
export type GridQuery = Omit<ViewQuery, "window">

export type Member = Schemas["ViewMemberDto"]

/** The members of one row or column, one per dimension in dimension order. */
export type Header = Schemas["HeaderDto"]

export type PageMember = Schemas["PageMemberDto"]

export type CellFlag = Schemas["CellFlagDto"]

/** `text` is the item name or period label that goes with an item or period value. */
export type Cell = Schemas["CellDto"]

export type FormulaError = Schemas["FormulaProblem"]

export type LineItemInfo = Schemas["LineItemInfoDto"]

export type ViewResult = Omit<Schemas["ViewResultDto"], "seq">

/** The query endpoint's response: the view plus the model revision it was read at. */
export type QueryResult = Schemas["ViewResultDto"]

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
