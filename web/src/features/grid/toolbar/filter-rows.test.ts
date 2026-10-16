import { describe, expect, it } from "vitest"
import { NO_REFERENCE } from "../edit-reference"
import type { Format } from "../core/types"
import { numberFormat } from "@/test/number-format"
import { defaultRow, needsValue, operatorsFor, rowOf, toFilter } from "./filter-rows"

const number = numberFormat({ decimals: 0 })
const percent = numberFormat({ decimals: 1, unit: { type: "percent" } })
const text: Format = { type: "text" }
const list: Format = { type: "list", list: "regions" }
const reference = {
  lists: { regions: [{ id: "emea", name: "EMEA", code: "E" }] },
  periods: [{ label: "Jan 26", level: "month" as const, index: 0 }],
}

describe("operatorsFor", () => {
  it("offers what fits the format", () => {
    expect(operatorsFor(number)).toEqual(["eq", "ne", "lt", "le", "gt", "ge"])
    expect(operatorsFor({ type: "boolean" })).toEqual(["is_true", "is_false"])
    expect(operatorsFor(text)).toEqual(["eq", "ne", "contains", "is_blank", "not_blank"])
    expect(operatorsFor(list)).toContain("contains")
    expect(operatorsFor({ type: "date" })).toEqual([
      "eq",
      "ne",
      "lt",
      "le",
      "gt",
      "ge",
      "is_blank",
      "not_blank",
    ])
  })

  it("never offers 'contains' for a number, which the server refuses", () => {
    expect(operatorsFor(number)).not.toContain("contains")
    expect(operatorsFor(percent)).not.toContain("contains")
  })
})

describe("needsValue", () => {
  it("is false for blank, true and false", () => {
    for (const op of ["is_blank", "not_blank", "is_true", "is_false"] as const) {
      expect(needsValue(op)).toBe(false)
    }
    for (const op of ["eq", "ne", "lt", "le", "gt", "ge", "contains"] as const) {
      expect(needsValue(op)).toBe(true)
    }
  })
})

describe("toFilter", () => {
  it("reads a number the way a cell takes it, so a percentage is a fraction", () => {
    expect(toFilter({ line_item: "li", op: "gt", text: "25" }, percent, reference)).toEqual({
      filter: { line_item: "li", op: "gt", value: { t: "number", v: 0.25 } },
    })
    expect(toFilter({ line_item: "li", op: "ge", text: "1,200" }, number, reference)).toEqual({
      filter: { line_item: "li", op: "ge", value: { t: "number", v: 1200 } },
    })
  })

  it("reads an item by name or code and a text as it is", () => {
    expect(toFilter({ line_item: "li", op: "eq", text: "emea" }, list, reference)).toEqual({
      filter: { line_item: "li", op: "eq", value: { t: "item", v: "emea" } },
    })
    expect(toFilter({ line_item: "li", op: "eq", text: "E" }, list, reference)).toEqual({
      filter: { line_item: "li", op: "eq", value: { t: "item", v: "emea" } },
    })
    expect(toFilter({ line_item: "li", op: "contains", text: " Gold " }, list, reference)).toEqual({
      filter: { line_item: "li", op: "contains", value: { t: "text", v: "Gold" } },
    })
    expect(toFilter({ line_item: "li", op: "ne", text: "Paid" }, text, reference)).toEqual({
      filter: { line_item: "li", op: "ne", value: { t: "text", v: "Paid" } },
    })
  })

  it("leaves out the value of a comparison that has none", () => {
    expect(toFilter({ line_item: "li", op: "is_blank", text: "ignored" }, text, reference)).toEqual({
      filter: { line_item: "li", op: "is_blank" },
    })
  })

  it("says what is wrong with a row", () => {
    expect(toFilter({ line_item: "gone", op: "eq", text: "1" }, undefined, reference)).toEqual({
      field: "line_item",
      message: "Choose a line item.",
    })
    expect(toFilter({ line_item: "li", op: "contains", text: "1" }, number, reference)).toEqual({
      field: "op",
      message: "Choose a condition that fits the line item.",
    })
    expect(toFilter({ line_item: "li", op: "eq", text: "  " }, number, reference)).toEqual({
      field: "text",
      message: "Enter a value to compare with.",
    })
    expect(toFilter({ line_item: "li", op: "eq", text: "abc" }, number, NO_REFERENCE)).toEqual({
      field: "text",
      message: expect.stringMatching(/number/i),
    })
  })
})

describe("rowOf", () => {
  it("writes the value of a filter as it is typed", () => {
    expect(
      rowOf({ line_item: "li", op: "gt", value: { t: "number", v: 0.25 } }, percent, reference),
    ).toEqual({ line_item: "li", op: "gt", text: "25" })
    expect(
      rowOf({ line_item: "li", op: "eq", value: { t: "item", v: "emea" } }, list, reference),
    ).toEqual({ line_item: "li", op: "eq", text: "EMEA" })
    expect(
      rowOf({ line_item: "li", op: "contains", value: { t: "text", v: "Gold" } }, list, reference),
    ).toEqual({ line_item: "li", op: "contains", text: "Gold" })
    expect(rowOf({ line_item: "li", op: "is_blank" }, text, reference)).toEqual({
      line_item: "li",
      op: "is_blank",
      text: "",
    })
  })

  it("round trips through toFilter", () => {
    const filter = { line_item: "li", op: "lt", value: { t: "number", v: 1234.5 } } as const
    const row = rowOf(filter, number, reference)

    expect(toFilter(row, number, reference)).toEqual({ filter })
  })
})

describe("defaultRow", () => {
  it("starts at the first comparison of the format", () => {
    expect(defaultRow("li", number)).toEqual({ line_item: "li", op: "eq", text: "" })
    expect(defaultRow("li", { type: "boolean" })).toEqual({
      line_item: "li",
      op: "is_true",
      text: "",
    })
  })
})
