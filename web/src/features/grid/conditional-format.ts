import type { Value } from "./core/types"
import type { Cell, ConditionalFormat, FormatColor, FormatStyle, LineItemInfo } from "./view-types"

// Whole class names, because Tailwind only generates the ones it finds written out in full. The
// light text is one step darker for green and amber, whose -700 is under 4.5:1 on their tint.
const COLOR_CLASSES: Record<FormatColor, string> = {
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  amber: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  green: "bg-green-500/15 text-green-800 dark:text-green-300",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  // A grey that differs from the surfaces of summary and calculated cells, which are bg-muted.
  muted: "bg-neutral-500/15 text-neutral-700 dark:text-neutral-300",
}

/**
 * The style of the first rule that matches the cell, if any. Cells with no value to judge (not
 * applicable, or in error) are never styled.
 */
export function conditionalStyle(
  rules: readonly ConditionalFormat[],
  lineItem: LineItemInfo,
  cell: Cell,
): FormatStyle | undefined {
  if (cell.flags.includes("na") || cell.flags.includes("error")) {
    return undefined
  }
  return rules.find((rule) => appliesTo(rule, lineItem) && matches(rule, cell.value))?.style
}

/** The classes that colour a cell; they replace the cell's own background and text colour. */
export function styleClassName(style: FormatStyle): string {
  const classes = COLOR_CLASSES[style.color]
  return style.bold ? `${classes} font-bold` : classes
}

function appliesTo(rule: ConditionalFormat, lineItem: LineItemInfo): boolean {
  return rule.line_item_ids.length === 0
    ? lineItem.format.type === "number"
    : rule.line_item_ids.includes(lineItem.id)
}

function matches(rule: ConditionalFormat, value: Value): boolean {
  if (rule.op === "blank") {
    return isBlank(value)
  }
  if (value.t !== "number") {
    return false
  }
  const v = value.v
  const { value: a, value2: b } = rule
  switch (rule.op) {
    case "lt":
      return a != null && v < a
    case "le":
      return a != null && v <= a
    case "gt":
      return a != null && v > a
    case "ge":
      return a != null && v >= a
    case "eq":
      return a != null && v === a
    case "ne":
      return a != null && v !== a
    case "between":
      return a != null && b != null && v >= Math.min(a, b) && v <= Math.max(a, b)
    case "negative":
      return v < 0
    case "positive":
      return v > 0
  }
}

/** A number is never blank: the engine shows an empty number cell as zero. */
function isBlank(value: Value): boolean {
  switch (value.t) {
    case "text":
      return value.v === ""
    case "date":
    case "item":
    case "period":
      return value.v === null
    case "number":
    case "boolean":
      return false
  }
}
