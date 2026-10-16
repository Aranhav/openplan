import { describe, expect, it } from "vitest"
import { monthLabelsFor } from "@/test/structure-edits"
import { fiscalYearLabel, fiscalYears } from "./timeline"

describe("fiscalYearLabel", () => {
  it.each([
    [2027, "FY27"],
    [2000, "FY00"],
    [2005, "FY05"],
    [5, "FY05"],
    [9999, "FY99"],
  ])("words %i as %s", (year, label) => {
    expect(fiscalYearLabel(year)).toBe(label)
  })
})

describe("fiscalYears", () => {
  it("gives each fiscal year its label, first and last month and quarters", () => {
    const calendar = { first_year: 2027, fiscal_year_start_month: 4, years: 2 }

    expect(fiscalYears(calendar, monthLabelsFor(calendar))).toEqual([
      {
        label: "FY27",
        firstMonth: "Apr 26",
        lastMonth: "Mar 27",
        quarters: ["Q1 FY27", "Q2 FY27", "Q3 FY27", "Q4 FY27"],
      },
      {
        label: "FY28",
        firstMonth: "Apr 27",
        lastMonth: "Mar 28",
        quarters: ["Q1 FY28", "Q2 FY28", "Q3 FY28", "Q4 FY28"],
      },
    ])
  })

  it("starts the year in January when the fiscal year is the calendar year", () => {
    const calendar = { first_year: 2026, fiscal_year_start_month: 1, years: 1 }

    expect(fiscalYears(calendar, monthLabelsFor(calendar))).toEqual([
      {
        label: "FY26",
        firstMonth: "Jan 26",
        lastMonth: "Dec 26",
        quarters: ["Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26"],
      },
    ])
  })

  it("covers as many years as the calendar has", () => {
    const calendar = { first_year: 2026, fiscal_year_start_month: 10, years: 20 }

    const years = fiscalYears(calendar, monthLabelsFor(calendar))

    expect(years).toHaveLength(20)
    expect(years[0]).toMatchObject({ label: "FY26", firstMonth: "Oct 25", lastMonth: "Sep 26" })
    expect(years[19]).toMatchObject({ label: "FY45", firstMonth: "Oct 44", lastMonth: "Sep 45" })
  })
})
