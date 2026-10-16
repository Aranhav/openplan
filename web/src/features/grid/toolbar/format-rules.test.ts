import { describe, expect, it } from "vitest"
import type { ConditionalFormat } from "../view-types"
import { newRule, ruleProblems, ruleRows, toFormats, valueCount } from "./format-rules"

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

describe("ruleProblems", () => {
  it("wants a number where the condition compares with one", () => {
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "" })).toEqual({ value: "Enter a number." })
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "abc" })).toEqual({
      value: "Enter a number.",
    })
    expect(ruleProblems({ ...newRule("x"), op: "gt", value: "1,000.5" })).toEqual({})
  })

  it("wants two numbers for a range, in order", () => {
    const between = { ...newRule("x"), op: "between" as const }

    expect(ruleProblems({ ...between, value: "1", value2: "" })).toEqual({ value2: "Enter a number." })
    expect(ruleProblems({ ...between, value: "9", value2: "3" })).toEqual({
      value: "The first number must not be more than the second.",
    })
    expect(ruleProblems({ ...between, value: "3", value2: "3" })).toEqual({})
  })

  it("asks for no number where there is none to compare with", () => {
    expect(ruleProblems({ ...newRule("x"), op: "negative", value: "junk" })).toEqual({})
  })
})

describe("toFormats and ruleRows", () => {
  const formats: ConditionalFormat[] = [
    { name: "Losses", line_item_ids: [], op: "negative", style: { color: "red", bold: true } },
    {
      name: "Healthy",
      line_item_ids: ["li-1"],
      op: "between",
      value: 10,
      value2: 20.5,
      style: { color: "green", bold: false },
    },
  ]

  it("round trips", () => {
    expect(toFormats(ruleRows(formats))).toEqual(formats)
  })

  it("keeps only the numbers a condition uses, and trims the name", () => {
    expect(
      toFormats([
        { ...newRule("  Big  "), op: "gt", value: "5", value2: "9" },
        { ...newRule("Neg"), op: "negative", value: "5" },
      ]),
    ).toEqual([
      { name: "Big", line_item_ids: [], op: "gt", value: 5, style: { color: "red", bold: false } },
      { name: "Neg", line_item_ids: [], op: "negative", style: { color: "red", bold: false } },
    ])
  })
})
