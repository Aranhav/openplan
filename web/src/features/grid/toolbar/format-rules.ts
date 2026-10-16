import type { LineItemDto } from "@/features/structure/types"
import { editText } from "../core/format-value"
import { type ParseContext, parseInput } from "../core/parse-value"
import type { Format } from "../core/types"
import type { ConditionalFormat, FormatColor, FormatOp } from "../view-types"

export const FORMAT_COLORS: readonly FormatColor[] = ["red", "amber", "green", "blue", "muted"]

export const COLOR_NAMES: Record<FormatColor, string> = {
  red: "Red",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
  muted: "Grey",
}

export const FORMAT_OPS: readonly FormatOp[] = [
  "lt",
  "le",
  "gt",
  "ge",
  "eq",
  "ne",
  "between",
  "negative",
  "positive",
  "blank",
]

export const FORMAT_OP_LABELS: Record<FormatOp, string> = {
  lt: "is less than",
  le: "is at most",
  gt: "is greater than",
  ge: "is at least",
  eq: "equals",
  ne: "does not equal",
  between: "is between",
  negative: "is negative",
  positive: "is positive",
  blank: "is blank",
}

/** The most rules a view has, which the server allows. */
export const MAX_RULES = 50

/** How many numbers a condition compares with: none, one, or the two ends of a range. */
export function valueCount(op: FormatOp): 0 | 1 | 2 {
  switch (op) {
    case "negative":
    case "positive":
    case "blank":
      return 0
    case "between":
      return 2
    default:
      return 1
  }
}

/** One rule in the form: the numbers are as typed. */
export type RuleRow = {
  name: string
  line_item_ids: string[]
  op: FormatOp
  value: string
  value2: string
  color: FormatColor
  bold: boolean
}

export function newRule(name: string): RuleRow {
  return { name, line_item_ids: [], op: "lt", value: "", value2: "", color: "red", bold: false }
}

/** The line items a rule is for: the ones it names, or every one with a number format. */
export function scopeOf(ruleLineItems: readonly string[], lineItems: readonly LineItemDto[]) {
  return ruleLineItems.length === 0
    ? lineItems.filter((item) => item.format.type === "number")
    : lineItems.filter((item) => ruleLineItems.includes(item.id))
}

const isPercent = (item: LineItemDto) =>
  item.format.type === "number" && item.format.unit.type === "percent"

/** Some of the line items are percentages, and not all: the numbers cannot be typed as one of them is. */
export function mixesPercent(scope: readonly LineItemDto[]): boolean {
  return scope.some(isPercent) && !scope.every(isPercent)
}

const PLAIN_NUMBER: Format = {
  type: "number",
  decimals: 0,
  thousands_sep: false,
  unit: { type: "none" },
  negative: "minus",
}

const NO_NAMES: ParseContext = {
  itemsByName: new Map(),
  itemsByCode: new Map(),
  periodsByLabel: new Map(),
}

/**
 * How the numbers of a rule are typed, as the filter types them: in a rule for percentages only,
 * 5 and 5% are both 5%, which is the fraction 0.05 a view keeps. Otherwise a number is as stored.
 */
function formatOf(scope: readonly LineItemDto[]): Format {
  return scope.length > 0 && scope.every(isPercent) ? scope[0].format : PLAIN_NUMBER
}

/** Whether a cell of one of the line items can be blank: a number or a check box never is. */
export function canBeBlank(ruleLineItems: readonly string[], lineItems: readonly LineItemDto[]) {
  return (
    ruleLineItems.length > 0 &&
    scopeOf(ruleLineItems, lineItems).some((item) =>
      ["text", "date", "list", "time_period"].includes(item.format.type),
    )
  )
}

export function ruleRows(
  formats: readonly ConditionalFormat[],
  lineItems: readonly LineItemDto[],
): RuleRow[] {
  return formats.map((format) => {
    const typed = formatOf(scopeOf(format.line_item_ids, lineItems))
    const text = (value: number | null | undefined) =>
      value == null ? "" : editText({ t: "number", v: value }, typed)
    return {
      name: format.name,
      line_item_ids: format.line_item_ids,
      op: format.op,
      value: text(format.value),
      value2: text(format.value2),
      color: format.style.color,
      bold: format.style.bold,
    }
  })
}

/** A number as typed, as the line items of the rule take it, or what is wrong with it. */
function numberOf(text: string, format: Format): { number: number } | { message: string } {
  if (text.trim() === "") {
    return { message: "Enter a number." }
  }
  const parsed = parseInput(text, format, NO_NAMES)
  if (!parsed.ok) {
    return { message: parsed.message }
  }
  return parsed.value.t === "number" ? { number: parsed.value.v } : { message: "Enter a number." }
}

/** What is wrong with a rule, by the input it is about. */
export function ruleProblems(
  rule: RuleRow,
  lineItems: readonly LineItemDto[],
): { op?: string; value?: string; value2?: string } {
  const count = valueCount(rule.op)
  const format = formatOf(scopeOf(rule.line_item_ids, lineItems))
  const problems: { op?: string; value?: string; value2?: string } = {}
  if (rule.op === "blank" && !canBeBlank(rule.line_item_ids, lineItems)) {
    problems.op = "A number is never blank. Choose line items that hold text, dates, items or periods."
  }
  const first = count >= 1 ? numberOf(rule.value, format) : undefined
  const second = count === 2 ? numberOf(rule.value2, format) : undefined
  if (first && "message" in first) {
    problems.value = first.message
  }
  if (second && "message" in second) {
    problems.value2 = second.message
  }
  if (first && second && "number" in first && "number" in second && first.number > second.number) {
    problems.value = "The first number must not be more than the second."
  }
  return problems
}

/** The rules as a view keeps them. Call it for rules without problems. */
export function toFormats(
  rules: readonly RuleRow[],
  lineItems: readonly LineItemDto[],
): ConditionalFormat[] {
  return rules.map((rule) => {
    const count = valueCount(rule.op)
    const format = formatOf(scopeOf(rule.line_item_ids, lineItems))
    const number = (text: string) => {
      const parsed = numberOf(text, format)
      return "number" in parsed ? parsed.number : undefined
    }
    return {
      name: rule.name.trim(),
      line_item_ids: rule.line_item_ids,
      op: rule.op,
      ...(count >= 1 && { value: number(rule.value) }),
      ...(count === 2 && { value2: number(rule.value2) }),
      style: { color: rule.color, bold: rule.bold },
    }
  })
}
