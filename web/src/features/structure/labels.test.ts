import { describe, expect, it } from "vitest"
import type { components } from "@/lib/api/schema"
import {
  actualId,
  forecastId,
  makeStructure,
  productsId,
  regionsId,
  structure,
} from "@/test/structure"
import {
  axisLabel,
  dimsLabel,
  formatLabel,
  summaryLabel,
  timeLevelLabel,
  timeScaleLabel,
  versionsLabel,
} from "./labels"

type Format = components["schemas"]["FormatDto"]
type SummaryMethod = components["schemas"]["SummaryMethodDto"]

const number = (unit: components["schemas"]["NumberUnitDto"]): Format => ({
  type: "number",
  decimals: 2,
  thousands_sep: true,
  unit,
  negative: "minus",
})

describe("formatLabel", () => {
  it("names a plain number, a currency and a percentage", () => {
    expect(formatLabel(number({ type: "none" }), structure)).toBe("Number")
    expect(formatLabel(number({ type: "currency", code: "USD" }), structure)).toBe("Currency (USD)")
    expect(formatLabel(number({ type: "percent" }), structure)).toBe("Percent")
  })

  it("names the simple types", () => {
    expect(formatLabel({ type: "boolean" }, structure)).toBe("Boolean")
    expect(formatLabel({ type: "text" }, structure)).toBe("Text")
    expect(formatLabel({ type: "date" }, structure)).toBe("Date")
  })

  it("names the list of a list format", () => {
    expect(formatLabel({ type: "list", list: regionsId }, structure)).toBe("List: Regions")
  })

  it("leaves the name out for a list the structure no longer has", () => {
    expect(formatLabel({ type: "list", list: "gone" }, structure)).toBe("List")
  })

  it("names the level of a time period format", () => {
    expect(formatLabel({ type: "time_period", level: "month" }, structure)).toBe(
      "Time period: Month",
    )
    expect(formatLabel({ type: "time_period", level: "half_year" }, structure)).toBe(
      "Time period: Half year",
    )
  })
})

describe("timeLevelLabel", () => {
  it("words every level", () => {
    expect((["month", "quarter", "half_year", "year", "all"] as const).map(timeLevelLabel)).toEqual(
      ["Month", "Quarter", "Half year", "Year", "Total"],
    )
  })
})

describe("axisLabel and dimsLabel", () => {
  const withSubsetAndRange = makeStructure({
    lists: structure.lists,
    subsets: [{ id: "s1", list: regionsId, name: "Europe", items: [] }],
    time_ranges: [{ id: "r1", name: "Long range", first_year: 2026, years: 10 }],
  })

  it("names a list, a subset, the versions and a time axis", () => {
    expect(axisLabel({ kind: "list", list: regionsId }, withSubsetAndRange)).toBe("Regions")
    expect(axisLabel({ kind: "subset", subset: "s1" }, withSubsetAndRange)).toBe("Europe")
    expect(axisLabel({ kind: "versions" }, withSubsetAndRange)).toBe("Versions")
    expect(axisLabel({ kind: "time", level: "quarter" }, withSubsetAndRange)).toBe("Time (Quarter)")
  })

  it("names the time range a time axis uses", () => {
    expect(axisLabel({ kind: "time", level: "month", range: "r1" }, withSubsetAndRange)).toBe(
      "Time (Month, Long range)",
    )
  })

  it("falls back to the kind when the structure no longer has the list or subset", () => {
    expect(axisLabel({ kind: "list", list: "gone" }, withSubsetAndRange)).toBe("List")
    expect(axisLabel({ kind: "subset", subset: "gone" }, withSubsetAndRange)).toBe("Subset")
  })

  it("lists the axes in order", () => {
    expect(
      dimsLabel(
        [
          { kind: "list", list: regionsId },
          { kind: "list", list: productsId },
          { kind: "time", level: "month" },
          { kind: "versions" },
        ],
        structure,
      ),
    ).toBe("Regions, Products, Time (Month), Versions")
  })

  it("says so when there are none", () => {
    expect(dimsLabel([], structure)).toBe("None")
  })
})

describe("summaryLabel", () => {
  it("words every summary method", () => {
    const methods: SummaryMethod[] = [
      { method: "sum" },
      { method: "average" },
      { method: "min" },
      { method: "max" },
      { method: "none" },
      { method: "formula" },
      { method: "ratio", numerator: "a", denominator: "b" },
      { method: "first" },
      { method: "last" },
      { method: "opening" },
      { method: "closing" },
      { method: "any" },
      { method: "all" },
    ]

    expect(methods.map(summaryLabel)).toEqual([
      "Sum",
      "Average",
      "Min",
      "Max",
      "None",
      "Formula",
      "Ratio",
      "First",
      "Last",
      "Opening balance",
      "Closing balance",
      "Any",
      "All",
    ])
  })
})

describe("timeScaleLabel", () => {
  it("words the module's, none and a coarser level", () => {
    expect(timeScaleLabel("module")).toBe("Module default")
    expect(timeScaleLabel("none")).toBe("None")
    expect(timeScaleLabel({ level: "year" })).toBe("Year")
  })
})

describe("versionsLabel", () => {
  it("words the module's and none", () => {
    expect(versionsLabel("module", structure)).toBe("Module default")
    expect(versionsLabel("none", structure)).toBe("None")
  })

  it("names the versions a line item is limited to, in their order", () => {
    expect(versionsLabel({ only: [forecastId, actualId] }, structure)).toBe("Forecast, Actual")
  })

  it("skips a version the structure no longer has", () => {
    expect(versionsLabel({ only: ["gone", actualId] }, structure)).toBe("Actual")
    expect(versionsLabel({ only: ["gone"] }, structure)).toBe("None")
  })
})
