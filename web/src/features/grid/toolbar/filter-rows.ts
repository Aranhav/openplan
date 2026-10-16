import { editText } from "../core/format-value"
import { parseInput } from "../core/parse-value"
import type { Format } from "../core/types"
import { type GridReference, displayText, parseContextFor } from "../edit-reference"
import type { FilterOp, RowFilter } from "../view-types"

/** One row of the filter form: the line item, how its value is compared, and what it is compared with, as typed. */
export type FilterRow = { line_item: string; op: FilterOp; text: string }

export const OPERATOR_LABELS: Record<FilterOp, string> = {
  eq: "equals",
  ne: "does not equal",
  lt: "is less than",
  le: "is at most",
  gt: "is greater than",
  ge: "is at least",
  contains: "contains",
  is_blank: "is blank",
  not_blank: "is not blank",
  is_true: "is true",
  is_false: "is false",
}

const ORDERED: FilterOp[] = ["eq", "ne", "lt", "le", "gt", "ge"]
const BLANK: FilterOp[] = ["is_blank", "not_blank"]

/** The ways to compare the values of a line item of this format, as the engine accepts them. */
export function operatorsFor(format: Format): FilterOp[] {
  switch (format.type) {
    case "number":
      return ORDERED
    case "boolean":
      return ["is_true", "is_false"]
    case "text":
      return ["eq", "ne", "contains", ...BLANK]
    case "list":
      return ["eq", "ne", "contains", ...BLANK]
    case "date":
    case "time_period":
      return [...ORDERED, ...BLANK]
  }
}

/** Whether a comparison has a value to compare with; blank, true and false have none. */
export function needsValue(op: FilterOp): boolean {
  return !["is_blank", "not_blank", "is_true", "is_false"].includes(op)
}

/** What an empty value input suggests to type, as a cell of the format would take it. */
export function placeholderFor(format: Format, op: FilterOp): string {
  if (op === "contains") {
    return "Text to look for"
  }
  switch (format.type) {
    case "number":
      return "A number"
    case "text":
      return "Text"
    case "date":
      return "YYYY-MM-DD"
    case "list":
      return "Item name or code"
    case "time_period":
      return "A period, such as Jan 26"
    case "boolean":
      return ""
  }
}

/** The first comparison to offer for a line item of this format. */
export function defaultRow(lineItem: string, format: Format): FilterRow {
  return { line_item: lineItem, op: operatorsFor(format)[0], text: "" }
}

/** The form row of a filter that is in force. */
export function rowOf(filter: RowFilter, format: Format, reference: GridReference): FilterRow {
  const { value } = filter
  const text =
    value == null
      ? ""
      : filter.op === "contains"
        ? value.t === "text"
          ? value.v
          : ""
        : editText(value, format, displayText(value, format, reference))
  return { line_item: filter.line_item, op: filter.op, text }
}

/** The filter a form row stands for, or what is wrong with the row and which of its inputs it is about. */
export function toFilter(
  row: FilterRow,
  format: Format | undefined,
  reference: GridReference,
): { filter: RowFilter } | { field: keyof FilterRow; message: string } {
  if (!format) {
    return { field: "line_item", message: "Choose a line item." }
  }
  if (!operatorsFor(format).includes(row.op)) {
    return { field: "op", message: "Choose a condition that fits the line item." }
  }
  if (!needsValue(row.op)) {
    return { filter: { line_item: row.line_item, op: row.op } }
  }
  const text = row.text.trim()
  if (text === "") {
    return { field: "text", message: "Enter a value to compare with." }
  }
  if (row.op === "contains") {
    return { filter: { line_item: row.line_item, op: row.op, value: { t: "text", v: text } } }
  }
  const parsed = parseInput(text, format, parseContextFor(format, reference))
  return parsed.ok
    ? { filter: { line_item: row.line_item, op: row.op, value: parsed.value } }
    : { field: "text", message: parsed.message }
}
