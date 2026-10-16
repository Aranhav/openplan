import { describe, expect, it } from "vitest"
import { makeStructure, regionsId } from "@/test/structure"
import { gridReference } from "./grid-reference"

const structure = makeStructure({
  calendar: { first_year: 2026, fiscal_year_start_month: 1, years: 2 },
  month_labels: Array.from({ length: 24 }, (_, index) => `M${index}`),
  lists: [
    {
      id: regionsId,
      name: "Regions",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [
        { id: "north", name: "North", code: "N" },
        { id: "south", name: "South" },
      ],
    },
  ],
})

describe("gridReference", () => {
  it("lists the items of each list with their names and codes", () => {
    expect(gridReference(structure).lists[regionsId]).toEqual([
      { id: "north", name: "North", code: "N" },
      { id: "south", name: "South", code: undefined },
    ])
  })

  it("has every month of the calendar by the model's own label", () => {
    const months = gridReference(structure).periods.filter((period) => period.level === "month")

    expect(months).toHaveLength(24)
    expect(months[0]).toEqual({ label: "M0", level: "month", index: 0 })
    expect(months[23]).toEqual({ label: "M23", level: "month", index: 23 })
  })

  it("words quarters, half years, years and the total the way the engine does", () => {
    const labels = (level: string) =>
      gridReference(structure)
        .periods.filter((period) => period.level === level)
        .map((period) => [period.label, period.index])

    expect(labels("quarter")).toEqual([
      ["Q1 FY26", 0],
      ["Q2 FY26", 1],
      ["Q3 FY26", 2],
      ["Q4 FY26", 3],
      ["Q1 FY27", 4],
      ["Q2 FY27", 5],
      ["Q3 FY27", 6],
      ["Q4 FY27", 7],
    ])
    expect(labels("half_year")).toEqual([
      ["H1 FY26", 0],
      ["H2 FY26", 1],
      ["H1 FY27", 2],
      ["H2 FY27", 3],
    ])
    expect(labels("year")).toEqual([
      ["FY26", 0],
      ["FY27", 1],
    ])
    expect(labels("all")).toEqual([["Total", 0]])
  })
})
