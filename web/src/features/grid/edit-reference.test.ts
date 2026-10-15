import { describe, expect, it } from "vitest"
import { numberFormat } from "@/test/number-format"
import { parseInput } from "./core/parse-value"
import type { Format, Value } from "./core/types"
import {
  type GridReference,
  NO_REFERENCE,
  displayText,
  listOptions,
  parseContextFor,
  sameValue,
} from "./edit-reference"

const listFormat: Format = { type: "list", list: "regions" }

const reference: GridReference = {
  lists: {
    regions: [
      { id: "r-emea", name: "EMEA", code: "EU" },
      { id: "r-apac", name: "Asia Pacific", code: null },
      { id: "r-na", name: "North America" },
    ],
    other: [{ id: "o-1", name: "Other" }],
  },
  periods: [
    { label: "Jan 26", level: "month", index: 0 },
    { label: "Q1 FY26", level: "quarter", index: 0 },
  ],
}

describe("parseContextFor", () => {
  it("lets a list cell take the items of its list by name or by code, ignoring case", () => {
    const ctx = parseContextFor(listFormat, reference)

    expect(parseInput("emea", listFormat, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: "r-emea" },
    })
    expect(parseInput("eu", listFormat, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: "r-emea" },
    })
    expect(parseInput("Asia Pacific", listFormat, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: "r-apac" },
    })
    expect(parseInput("Other", listFormat, ctx).ok).toBe(false)
  })

  it("lets a time period cell take the labels of the timeline", () => {
    const format: Format = { type: "time_period", level: "month" }
    const ctx = parseContextFor(format, reference)

    expect(parseInput("jan 26", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["month", 0] },
    })
    expect(parseInput("Q1 FY26", format, ctx).ok).toBe(false)
  })

  it("knows no items without a reference", () => {
    const ctx = parseContextFor(listFormat, NO_REFERENCE)

    expect(parseInput("EMEA", listFormat, ctx)).toEqual({
      ok: false,
      message: "'EMEA' isn't in this list.",
    })
  })

  it("builds a context once for a format of the same list", () => {
    expect(parseContextFor(listFormat, reference)).toBe(parseContextFor(listFormat, reference))
    expect(parseContextFor({ type: "text" }, reference)).toBe(
      parseContextFor(numberFormat(), reference),
    )
    expect(parseContextFor(listFormat, reference)).not.toBe(
      parseContextFor({ type: "list", list: "other" }, reference),
    )
  })
})

describe("listOptions", () => {
  it("lists the items of a list cell's list, and none for any other format", () => {
    expect(listOptions(listFormat, reference).map((option) => option.id)).toEqual([
      "r-emea",
      "r-apac",
      "r-na",
    ])
    expect(listOptions({ type: "list", list: "unknown" }, reference)).toEqual([])
    expect(listOptions({ type: "text" }, reference)).toEqual([])
  })
})

describe("displayText", () => {
  it("names an item by its list and a period by its level and place", () => {
    expect(displayText({ t: "item", v: "r-apac" }, listFormat, reference)).toBe("Asia Pacific")
    expect(
      displayText(
        { t: "period", v: ["quarter", 0] },
        { type: "time_period", level: "quarter" },
        reference,
      ),
    ).toBe("Q1 FY26")
  })

  it("has no text for a blank value, an unknown one or a value that needs none", () => {
    expect(displayText({ t: "item", v: null }, listFormat, reference)).toBeUndefined()
    expect(displayText({ t: "item", v: "gone" }, listFormat, reference)).toBeUndefined()
    expect(
      displayText({ t: "period", v: null }, { type: "time_period", level: "month" }, reference),
    ).toBeUndefined()
    expect(displayText({ t: "number", v: 5 }, numberFormat(), reference)).toBeUndefined()
  })
})

describe("sameValue", () => {
  it.each<[Value, Value]>([
    [
      { t: "number", v: 5 },
      { t: "number", v: 5 },
    ],
    [
      { t: "text", v: "a" },
      { t: "text", v: "a" },
    ],
    [
      { t: "boolean", v: false },
      { t: "boolean", v: false },
    ],
    [
      { t: "date", v: null },
      { t: "date", v: null },
    ],
    [
      { t: "date", v: "2026-01-02" },
      { t: "date", v: "2026-01-02" },
    ],
    [
      { t: "item", v: "a" },
      { t: "item", v: "a" },
    ],
    [
      { t: "period", v: ["month", 3] },
      { t: "period", v: ["month", 3] },
    ],
    [
      { t: "period", v: null },
      { t: "period", v: null },
    ],
  ])("finds %j and %j the same", (a, b) => {
    expect(sameValue(a, b)).toBe(true)
  })

  it.each<[Value, Value]>([
    [
      { t: "number", v: 5 },
      { t: "number", v: 6 },
    ],
    [
      { t: "number", v: 0 },
      { t: "boolean", v: false },
    ],
    [
      { t: "text", v: "" },
      { t: "date", v: null },
    ],
    [
      { t: "date", v: null },
      { t: "date", v: "2026-01-02" },
    ],
    [
      { t: "period", v: ["month", 3] },
      { t: "period", v: ["quarter", 3] },
    ],
    [
      { t: "period", v: ["month", 3] },
      { t: "period", v: ["month", 4] },
    ],
    [
      { t: "item", v: null },
      { t: "item", v: "a" },
    ],
  ])("finds %j and %j different", (a, b) => {
    expect(sameValue(a, b)).toBe(false)
  })

  it("finds 0 and -0 the same", () => {
    expect(sameValue({ t: "number", v: 0 }, { t: "number", v: -0 })).toBe(true)
  })
})
