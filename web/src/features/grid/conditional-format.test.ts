import { describe, expect, it } from "vitest"
import { numberFormat } from "@/test/number-format"
import { lineItem } from "@/test/view-query"
import { conditionalStyle, styleClassName } from "./conditional-format"
import type { Cell, ConditionalFormat, FormatOp } from "./view-types"

const revenue = lineItem("li-revenue", "Revenue")
const notes = lineItem("li-notes", "Notes", { format: { type: "text" } })

function rule(overrides: Partial<ConditionalFormat> = {}): ConditionalFormat {
  return {
    name: "Rule",
    line_item_ids: [],
    op: "lt",
    value: 0,
    style: { color: "red", bold: false },
    ...overrides,
  }
}

function numberCell(value: number, flags: Cell["flags"] = ["input"]): Cell {
  return { value: { t: "number", v: value }, flags }
}

describe("conditionalStyle", () => {
  it("returns nothing without rules", () => {
    expect(conditionalStyle([], revenue, numberCell(5))).toBeUndefined()
  })

  it("lets the first matching rule win", () => {
    const rules = [
      rule({ name: "Big", op: "gt", value: 100, style: { color: "green", bold: true } }),
      rule({ name: "Positive", op: "positive", style: { color: "blue", bold: false } }),
      rule({ name: "Any positive", op: "gt", value: 0, style: { color: "amber", bold: false } }),
    ]

    expect(conditionalStyle(rules, revenue, numberCell(500))).toEqual({
      color: "green",
      bold: true,
    })
    expect(conditionalStyle(rules, revenue, numberCell(50))).toEqual({
      color: "blue",
      bold: false,
    })
    expect(conditionalStyle(rules, revenue, numberCell(-5))).toBeUndefined()
  })

  it.each<[FormatOp, number | null, number | null, number, boolean]>([
    ["lt", 10, null, 9, true],
    ["lt", 10, null, 10, false],
    ["le", 10, null, 10, true],
    ["le", 10, null, 11, false],
    ["gt", 10, null, 11, true],
    ["gt", 10, null, 10, false],
    ["ge", 10, null, 10, true],
    ["ge", 10, null, 9, false],
    ["eq", 10, null, 10, true],
    ["eq", 10, null, 11, false],
    ["ne", 10, null, 11, true],
    ["ne", 10, null, 10, false],
    ["between", 10, 20, 10, true],
    ["between", 10, 20, 20, true],
    ["between", 10, 20, 21, false],
    ["between", 20, 10, 15, true],
    ["negative", null, null, -0.5, true],
    ["negative", null, null, 0, false],
    ["positive", null, null, 0.5, true],
    ["positive", null, null, 0, false],
  ])("%s %s %s matches %s: %s", (op, value, value2, cellValue, matches) => {
    const rules = [rule({ op, value, value2 })]

    const style = conditionalStyle(rules, revenue, numberCell(cellValue))

    expect(style !== undefined).toBe(matches)
  })

  it("never matches a comparison that has no threshold", () => {
    expect(conditionalStyle([rule({ op: "gt", value: null })], revenue, numberCell(5))).toBe(
      undefined,
    )
    expect(
      conditionalStyle([rule({ op: "between", value: 1, value2: null })], revenue, numberCell(5)),
    ).toBeUndefined()
  })

  it("compares only numbers", () => {
    const text: Cell = { value: { t: "text", v: "5" }, flags: ["input"] }

    expect(conditionalStyle([rule({ op: "gt", value: 0 })], notes, text)).toBeUndefined()
    expect(
      conditionalStyle([rule({ op: "positive", line_item_ids: ["li-notes"] })], notes, text),
    ).toBeUndefined()
  })

  it("matches blank text, dates, items and periods with the blank op, never a number", () => {
    const blank = [rule({ op: "blank", line_item_ids: ["li-notes", "li-revenue"] })]
    const cell = (value: Cell["value"]): Cell => ({ value, flags: ["input"] })

    expect(conditionalStyle(blank, notes, cell({ t: "text", v: "" }))).toBeDefined()
    expect(conditionalStyle(blank, notes, cell({ t: "date", v: null }))).toBeDefined()
    expect(conditionalStyle(blank, notes, cell({ t: "item", v: null }))).toBeDefined()
    expect(conditionalStyle(blank, notes, cell({ t: "period", v: null }))).toBeDefined()
    expect(conditionalStyle(blank, notes, cell({ t: "text", v: "x" }))).toBeUndefined()
    expect(conditionalStyle(blank, revenue, numberCell(0))).toBeUndefined()
  })

  it("applies a rule without line items to number line items only", () => {
    const rules = [rule({ op: "blank" })]
    const text: Cell = { value: { t: "text", v: "" }, flags: ["input"] }

    expect(conditionalStyle(rules, notes, text)).toBeUndefined()
    expect(conditionalStyle([rule()], revenue, numberCell(-1))).toBeDefined()
  })

  it("applies a rule with line items to those line items only", () => {
    const rules = [rule({ line_item_ids: ["li-costs"] })]

    expect(conditionalStyle(rules, revenue, numberCell(-1))).toBeUndefined()
    expect(
      conditionalStyle(
        rules,
        lineItem("li-costs", "Costs", { format: numberFormat() }),
        numberCell(-1),
      ),
    ).toBeDefined()
  })

  it.each<{ flags: Cell["flags"] }>([{ flags: ["na"] }, { flags: ["error", "readonly"] }])(
    "does not style a cell flagged $flags",
    ({ flags }) => {
      expect(
        conditionalStyle([rule({ op: "negative" })], revenue, numberCell(-5, flags)),
      ).toBeUndefined()
    },
  )
})

describe("styleClassName", () => {
  it.each([
    ["red", "bg-red-500/15 text-red-700 dark:text-red-300"],
    ["amber", "bg-amber-500/15 text-amber-800 dark:text-amber-300"],
    ["green", "bg-green-500/15 text-green-800 dark:text-green-300"],
    ["blue", "bg-blue-500/15 text-blue-700 dark:text-blue-300"],
    ["muted", "bg-neutral-500/15 text-neutral-700 dark:text-neutral-300"],
  ] as const)("maps %s to its tints", (color, classes) => {
    expect(styleClassName({ color, bold: false })).toBe(classes)
  })

  it("adds bold", () => {
    expect(styleClassName({ color: "red", bold: true })).toBe(
      "bg-red-500/15 text-red-700 dark:text-red-300 font-bold",
    )
  })
})
