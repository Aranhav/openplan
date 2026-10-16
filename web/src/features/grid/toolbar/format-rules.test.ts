import { describe, expect, it } from "vitest"
import { makeLineItem } from "@/test/structure"
import type { ConditionalFormat } from "../view-types"
import {
  canBeBlank,
  mixesPercent,
  newRule,
  ruleProblems,
  ruleRows,
  scopeOf,
  toFormats,
  valueCount,
} from "./format-rules"

const plain = makeLineItem({ id: "li-plain", name: "Units" })
const percent = makeLineItem({
  id: "li-percent",
  name: "Margin",
  format: {
    type: "number",
    decimals: 1,
    thousands_sep: false,
    unit: { type: "percent" },
    negative: "minus",
  },
})
const otherPercent = makeLineItem({ ...percent, id: "li-percent-2", name: "Growth" })
const notes = makeLineItem({ id: "li-notes", name: "Notes", format: { type: "text" } })
const lineItems = [plain, percent, otherPercent, notes]

describe("valueCount", () => {
  it("says how many numbers a condition compares with", () => {
    expect(valueCount("negative")).toBe(0)
    expect(valueCount("positive")).toBe(0)
    expect(valueCount("blank")).toBe(0)
    expect(valueCount("between")).toBe(2)
    for (const op of ["lt", "le", "gt", "ge", "eq", "ne"] as const) {
      expect(valueCount(op)).toBe(1)
    }
  })
})

describe("scopeOf", () => {
  it("is the line items a rule names, or else every one with a number", () => {
    expect(scopeOf(["li-notes"], lineItems)).toEqual([notes])
    expect(scopeOf([], lineItems)).toEqual([plain, percent, otherPercent])
  })
})

describe("canBeBlank", () => {
  it("holds only for named line items of which one holds text, dates, items or periods", () => {
    expect(canBeBlank([], lineItems)).toBe(false)
    expect(canBeBlank(["li-plain"], lineItems)).toBe(false)
    expect(canBeBlank(["li-plain", "li-notes"], lineItems)).toBe(true)
  })
})

describe("mixesPercent", () => {
  it("holds when some of the line items are percentages and some are not", () => {
    expect(mixesPercent([plain, percent])).toBe(true)
    expect(mixesPercent([percent, otherPercent])).toBe(false)
    expect(mixesPercent([plain])).toBe(false)
    expect(mixesPercent([])).toBe(false)
  })
})

describe("ruleProblems", () => {
  it("wants a number where the condition compares with one", () => {
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "" }, lineItems)).toEqual({
      value: "Enter a number.",
    })
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "abc" }, lineItems)).toEqual({
      value: "'abc' isn't a number.",
    })
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "1,000.5" }, lineItems)).toEqual({})
  })

  it("wants two numbers for a range, in order", () => {
    const between = { ...newRule("x"), op: "between" as const }

    expect(ruleProblems({ ...between, value: "1", value2: "" }, lineItems)).toEqual({
      value2: "Enter a number.",
    })
    expect(ruleProblems({ ...between, value: "9", value2: "3" }, lineItems)).toEqual({
      value: "The first number must not be more than the second.",
    })
    expect(ruleProblems({ ...between, value: "3", value2: "3" }, lineItems)).toEqual({})
  })

  it("asks for no number where there is none to compare with", () => {
    expect(ruleProblems({ ...newRule("x"), op: "negative", value: "junk" }, lineItems)).toEqual({})
  })

  it("refuses is blank for line items that cannot be blank", () => {
    const blank = { ...newRule("x"), op: "blank" as const }

    expect(ruleProblems(blank, lineItems).op).toMatch(/never blank/)
    expect(ruleProblems({ ...blank, line_item_ids: ["li-plain"] }, lineItems).op).toMatch(/never blank/)
    expect(ruleProblems({ ...blank, line_item_ids: ["li-notes"] }, lineItems)).toEqual({})
  })

  it("orders percentages as typed in percent points when the rule is for percentages only", () => {
    const between = { ...newRule("x"), op: "between" as const, line_item_ids: ["li-percent"] }

    expect(ruleProblems({ ...between, value: "5%", value2: "10" }, lineItems)).toEqual({})
    expect(ruleProblems({ ...between, value: "10", value2: "5%" }, lineItems)).toEqual({
      value: "The first number must not be more than the second.",
    })
  })
})

describe("toFormats and ruleRows", () => {
  const formats: ConditionalFormat[] = [
    { name: "Losses", line_item_ids: [], op: "negative", style: { color: "red", bold: true } },
    {
      name: "Healthy",
      line_item_ids: ["li-plain"],
      op: "between",
      value: 10,
      value2: 20.5,
      style: { color: "green", bold: false },
    },
    {
      name: "Thin",
      line_item_ids: ["li-percent", "li-percent-2"],
      op: "lt",
      value: 0.05,
      style: { color: "amber", bold: false },
    },
  ]

  it("round trips", () => {
    expect(toFormats(ruleRows(formats, lineItems), lineItems)).toEqual(formats)
  })

  it("shows a percentage as the percent points a cell is typed in, and keeps the fraction", () => {
    const [, , thin] = ruleRows(formats, lineItems)

    expect(thin.value).toBe("5")
    expect(toFormats([{ ...thin, value: "5" }], lineItems)[0].value).toBe(0.05)
    expect(toFormats([{ ...thin, value: "5%" }], lineItems)[0].value).toBe(0.05)
  })

  it("keeps a number as stored for line items that are not all percentages", () => {
    const rule = { ...newRule("x"), op: "lt" as const, line_item_ids: ["li-plain", "li-percent"] }

    expect(toFormats([{ ...rule, value: "0.05" }], lineItems)[0].value).toBe(0.05)
    expect(ruleRows(toFormats([{ ...rule, value: "0.05" }], lineItems), lineItems)[0].value).toBe("0.05")
  })

  it("keeps only the numbers a condition uses, and trims the name", () => {
    expect(
      toFormats(
        [
          { ...newRule("  Big  "), op: "gt", value: "5", value2: "9" },
          { ...newRule("Neg"), op: "negative", value: "5" },
        ],
        lineItems,
      ),
    ).toEqual([
      { name: "Big", line_item_ids: [], op: "gt", value: 5, style: { color: "red", bold: false } },
      { name: "Neg", line_item_ids: [], op: "negative", style: { color: "red", bold: false } },
    ])
  })
})
