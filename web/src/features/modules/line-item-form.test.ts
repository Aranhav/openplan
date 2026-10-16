import { describe, expect, it } from "vitest"
import type { LineItemDto } from "@/features/structure/types"
import {
  actualId,
  forecastId,
  makeLineItem,
  makeModule,
  productsId,
  regionsId,
  revenueModule,
} from "@/test/structure"
import {
  type LineItemValues,
  clearsInputValues,
  defaultSummaryFor,
  formatOf,
  lineItemPatch,
  lineItemSchema,
  lineItemValues,
  summaryMethodsFor,
  timeScaleLevels,
} from "./line-item-form"

const module = makeModule({ axes: [{ kind: "list", list: regionsId }] })
const input = makeLineItem()
const calculated = makeLineItem({ formula: "Units * Price" })

function valuesOf(lineItem: LineItemDto, overrides: Partial<LineItemValues> = {}) {
  return { ...lineItemValues(lineItem, module), ...overrides }
}

describe("lineItemValues", () => {
  it("reads the options of a currency format", () => {
    const values = valuesOf(
      makeLineItem({
        format: {
          type: "number",
          decimals: 1,
          thousands_sep: false,
          unit: { type: "currency", code: "EUR" },
          negative: "parens",
        },
      }),
    )

    expect(values).toMatchObject({
      format_type: "number",
      decimals: "1",
      thousands_sep: false,
      unit: "currency",
      currency_code: "EUR",
      negative: "parens",
    })
  })

  it("reads a list format and a time period format", () => {
    expect(valuesOf(makeLineItem({ format: { type: "list", list: productsId } }))).toMatchObject({
      format_type: "list",
      list: productsId,
    })
    expect(
      valuesOf(makeLineItem({ format: { type: "time_period", level: "quarter" } })),
    ).toMatchObject({ format_type: "time_period", period_level: "quarter" })
  })

  it("reads a ratio summary and a time summary", () => {
    const values = valuesOf(
      makeLineItem({
        summary: { method: "ratio", numerator: "a", denominator: "b" },
        time_summary: { method: "closing" },
      }),
    )

    expect(values).toMatchObject({
      summary_method: "ratio",
      summary_numerator: "a",
      summary_denominator: "b",
      time_summary_method: "closing",
    })
  })

  it("takes a time summary that is not set as the same as the summary", () => {
    expect(valuesOf(input).time_summary_method).toBe("same")
  })

  it("starts the lists a line item applies to from the module's, until it has chosen", () => {
    expect(valuesOf(input)).toMatchObject({
      applies_mode: "module",
      applies_to: [`list:${regionsId}`],
    })
    expect(
      valuesOf(makeLineItem({ applies_to: [{ kind: "list", list: productsId }] })),
    ).toMatchObject({ applies_mode: "chosen", applies_to: [`list:${productsId}`] })
  })

  it("reads the time scale and the versions", () => {
    expect(
      valuesOf(makeLineItem({ time_scale: { level: "year" }, versions: { only: [actualId] } })),
    ).toMatchObject({
      time_scale: "level:year",
      versions_mode: "only",
      versions_only: [actualId],
    })
    expect(valuesOf(makeLineItem({ time_scale: "none", versions: "none" }))).toMatchObject({
      time_scale: "none",
      versions_mode: "none",
    })
  })
})

describe("lineItemPatch", () => {
  it("is empty when nothing changed, whatever order the saved object's keys came in", () => {
    const saved = makeLineItem({
      format: {
        negative: "parens",
        unit: { code: "USD", type: "currency" },
        thousands_sep: true,
        decimals: 2,
        type: "number",
      },
    })

    expect(lineItemPatch(saved, valuesOf(saved))).toEqual({})
  })

  it("sends only what changed", () => {
    expect(
      lineItemPatch(input, valuesOf(input, { name: " Unit cost ", notes: "Per box" })),
    ).toEqual({ name: "Unit cost", notes: "Per box" })
  })

  it("clears the code and the formula with null", () => {
    const saved = makeLineItem({ code: "UP", formula: "1 + 1" })

    expect(lineItemPatch(saved, valuesOf(saved, { code: "  ", formula: "  " }))).toEqual({
      code: null,
      formula: null,
    })
  })

  it("builds a number format from its options", () => {
    const patch = lineItemPatch(
      input,
      valuesOf(input, {
        decimals: "3",
        unit: "currency",
        currency_code: "GBP",
        negative: "parens",
      }),
    )

    expect(patch.format).toEqual({
      type: "number",
      decimals: 3,
      thousands_sep: true,
      unit: { type: "currency", code: "GBP" },
      negative: "parens",
    })
  })

  it("sends a ratio with its two parts", () => {
    expect(
      lineItemPatch(
        input,
        valuesOf(input, {
          summary_method: "ratio",
          summary_numerator: "a",
          summary_denominator: "b",
        }),
      ).summary,
    ).toEqual({ method: "ratio", numerator: "a", denominator: "b" })
  })

  it("sets the time summary, and clears it with null when it is the same as the summary again", () => {
    const withTimeSummary = makeLineItem({ time_summary: { method: "closing" } })

    expect(
      lineItemPatch(input, valuesOf(input, { time_summary_method: "closing" })).time_summary,
    ).toEqual({ method: "closing" })
    expect(
      lineItemPatch(withTimeSummary, valuesOf(withTimeSummary, { time_summary_method: "same" })),
    ).toEqual({ time_summary: null })
  })

  it("sends the lists a line item applies to, and null to go back to the module's", () => {
    expect(
      lineItemPatch(
        input,
        valuesOf(input, { applies_mode: "chosen", applies_to: [`list:${productsId}`] }),
      ).applies_to,
    ).toEqual([{ kind: "list", list: productsId }])
    const own = makeLineItem({ applies_to: [{ kind: "list", list: productsId }] })

    expect(lineItemPatch(own, valuesOf(own, { applies_mode: "module" }))).toEqual({
      applies_to: null,
    })
  })

  it("sends the time scale and the versions", () => {
    const patch = lineItemPatch(
      input,
      valuesOf(input, {
        time_scale: "level:quarter",
        versions_mode: "only",
        versions_only: [actualId, forecastId],
      }),
    )

    expect(patch).toEqual({
      time_scale: { level: "quarter" },
      versions: { only: [actualId, forecastId] },
    })
  })
})

describe("clearsInputValues", () => {
  it("does not for a change of name, notes, decimals or summary", () => {
    expect(
      clearsInputValues(
        input,
        valuesOf(input, { name: "Other", decimals: "4", summary_method: "average" }),
      ),
    ).toBe(false)
  })

  it("does for another type of format", () => {
    expect(clearsInputValues(input, valuesOf(input, { format_type: "text" }))).toBe(true)
  })

  it("does for another list of a list format, not for the same", () => {
    const list = makeLineItem({ format: { type: "list", list: regionsId } })

    expect(clearsInputValues(list, valuesOf(list))).toBe(false)
    expect(clearsInputValues(list, valuesOf(list, { list: productsId }))).toBe(true)
  })

  it("does for another level of a time period format", () => {
    const period = makeLineItem({ format: { type: "time_period", level: "month" } })

    expect(clearsInputValues(period, valuesOf(period, { period_level: "year" }))).toBe(true)
  })

  it("does for other lists, another time scale or other versions", () => {
    expect(
      clearsInputValues(input, valuesOf(input, { applies_mode: "chosen", applies_to: [] })),
    ).toBe(true)
    expect(clearsInputValues(input, valuesOf(input, { time_scale: "none" }))).toBe(true)
    expect(clearsInputValues(input, valuesOf(input, { versions_mode: "none" }))).toBe(true)
  })

  it("does for an input line item that is given a formula", () => {
    expect(clearsInputValues(input, valuesOf(input, { formula: "1 + 1" }))).toBe(true)
  })

  it("does not for a calculated line item, which holds no input values", () => {
    expect(clearsInputValues(calculated, valuesOf(calculated, { format_type: "text" }))).toBe(false)
  })
})

describe("formatOf", () => {
  it("builds every kind of format", () => {
    const values = valuesOf(input)

    expect(formatOf({ ...values, format_type: "boolean" })).toEqual({ type: "boolean" })
    expect(formatOf({ ...values, format_type: "date" })).toEqual({ type: "date" })
    expect(formatOf({ ...values, format_type: "list", list: "l1" })).toEqual({
      type: "list",
      list: "l1",
    })
    expect(formatOf({ ...values, format_type: "time_period", period_level: "year" })).toEqual({
      type: "time_period",
      level: "year",
    })
    expect(formatOf({ ...values, unit: "percent" })).toMatchObject({ unit: { type: "percent" } })
  })
})

describe("summaries", () => {
  it("offers numbers every method but Any and All, and booleans Any, All and the periodic ones", () => {
    expect(summaryMethodsFor("number")).toContain("ratio")
    expect(summaryMethodsFor("number")).not.toContain("any")
    expect(summaryMethodsFor("boolean")).toEqual(
      expect.arrayContaining(["any", "all", "none", "first"]),
    )
    expect(summaryMethodsFor("boolean")).not.toContain("sum")
  })

  it("offers text, dates, lists and periods only None", () => {
    for (const format of ["text", "date", "list", "time_period"] as const) {
      expect(summaryMethodsFor(format)).toEqual(["none"])
    }
  })

  it("sums numbers and summarizes nothing else", () => {
    expect(defaultSummaryFor("number")).toBe("sum")
    expect(defaultSummaryFor("boolean")).toBe("none")
  })
})

describe("timeScaleLevels", () => {
  it("offers the module's level and the coarser ones, up to the total", () => {
    expect(timeScaleLevels("quarter")).toEqual(["quarter", "half_year", "year", "all"])
    expect(timeScaleLevels("year")).toEqual(["year", "all"])
  })

  it("offers none without a Time dimension", () => {
    expect(timeScaleLevels(undefined)).toEqual([])
  })
})

describe("lineItemSchema", () => {
  const valid = valuesOf(input)

  function problems(overrides: Partial<LineItemValues>) {
    const result = lineItemSchema.safeParse({ ...valid, ...overrides })
    return result.success ? [] : result.error.issues.map((issue) => [issue.path[0], issue.message])
  }

  it("accepts the values of a line item as it is", () => {
    expect(lineItemSchema.safeParse(valid).success).toBe(true)
    expect(lineItemSchema.safeParse(valuesOf(revenueModuleLineItem())).success).toBe(true)
  })

  it("refuses decimals outside 0 to 10", () => {
    expect(problems({ decimals: "11" })).toEqual([
      ["decimals", "Decimals must be between 0 and 10."],
    ])
  })

  it("wants three capital letters for a currency", () => {
    expect(problems({ unit: "currency", currency_code: "us" })).toEqual([
      ["currency_code", "Currency code must be three uppercase letters, such as USD."],
    ])
    expect(problems({ unit: "currency", currency_code: "USD" })).toEqual([])
  })

  it("wants a list for a list format", () => {
    expect(problems({ format_type: "list", list: "" })).toEqual([["list", "Choose a list."]])
  })

  it("wants both parts of a ratio", () => {
    expect(problems({ summary_method: "ratio" })).toEqual([
      ["summary_numerator", "Choose the numerator."],
      ["summary_denominator", "Choose the denominator."],
    ])
    expect(problems({ time_summary_method: "ratio", time_summary_numerator: "a" })).toEqual([
      ["time_summary_denominator", "Choose the denominator."],
    ])
  })

  it("wants a version when the line item is limited to some", () => {
    expect(problems({ versions_mode: "only", versions_only: [] })).toEqual([
      ["versions_only", "Choose at least one version."],
    ])
  })

  it("holds the name to 80 characters", () => {
    expect(problems({ name: "x".repeat(81) })).toEqual([
      ["name", "Name must be at most 80 characters."],
    ])
    expect(problems({ name: "  " })).toEqual([["name", "Name is required."]])
  })
})

function revenueModuleLineItem() {
  return makeLineItem({ module: revenueModule.id, formula: "Units sold * 2" })
}
