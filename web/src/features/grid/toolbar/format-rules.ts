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

export function ruleRows(formats: readonly ConditionalFormat[]): RuleRow[] {
  return formats.map((format) => ({
    name: format.name,
    line_item_ids: format.line_item_ids,
    op: format.op,
    value: format.value == null ? "" : String(format.value),
    value2: format.value2 == null ? "" : String(format.value2),
    color: format.style.color,
    bold: format.style.bold,
  }))
}

/** A number as typed, with or without the thousands separators. */
function numberOf(text: string): number | undefined {
  const plain = text.trim().replace(/,/g, "")
  return plain !== "" && Number.isFinite(Number(plain)) ? Number(plain) : undefined
}

/** What is wrong with the numbers of a rule, by the input they were typed in. */
export function ruleProblems(rule: RuleRow): { value?: string; value2?: string } {
  const count = valueCount(rule.op)
  const problems: { value?: string; value2?: string } = {}
  const first = numberOf(rule.value)
  const second = numberOf(rule.value2)
  if (count >= 1 && first === undefined) {
    problems.value = "Enter a number."
  }
  if (count === 2 && second === undefined) {
    problems.value2 = "Enter a number."
  }
  if (count === 2 && first !== undefined && second !== undefined && first > second) {
    problems.value = "The first number must not be more than the second."
  }
  return problems
}

/** The rules as a view keeps them. Call it for rules without problems. */
export function toFormats(rules: readonly RuleRow[]): ConditionalFormat[] {
  return rules.map((rule) => {
    const count = valueCount(rule.op)
    return {
      name: rule.name.trim(),
      line_item_ids: rule.line_item_ids,
      op: rule.op,
      ...(count >= 1 && { value: numberOf(rule.value) }),
      ...(count === 2 && { value2: numberOf(rule.value2) }),
      style: { color: rule.color, bold: rule.bold },
    }
  })
}
