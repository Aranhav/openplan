import { describe, expect, it } from "vitest"
import { draftTimeline, fiscalYearLabel, fiscalYears, monthLabelsFor } from "./timeline"

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

describe("monthLabelsFor", () => {
  // The labels the engine gives the months of these calendars (crates/engine/src/calendar.rs and
  // the `month_labels` of the structure document), which a request names a month by.
  it.each([
    [
      "January",
      { fiscal_year_start_month: 1, first_year: 2026, years: 2 },
      24,
      ["Jan 26", "Dec 27"],
    ],
    ["April", { fiscal_year_start_month: 4, first_year: 2027, years: 1 }, 12, ["Apr 26", "Mar 27"]],
    ["July", { fiscal_year_start_month: 7, first_year: 2027, years: 1 }, 12, ["Jul 26", "Jun 27"]],
    [
      "October",
      { fiscal_year_start_month: 10, first_year: 2026, years: 2 },
      24,
      ["Oct 25", "Sep 27"],
    ],
  ])("names the months of a calendar that starts in %s", (_, timeline, count, [first, last]) => {
    const labels = monthLabelsFor(timeline)

    expect(labels).toHaveLength(count)
    expect(labels[0]).toBe(first)
    expect(labels.at(-1)).toBe(last)
  })

  it("names every month of the engine's April-start model", () => {
    const labels = monthLabelsFor({ fiscal_year_start_month: 4, first_year: 2026, years: 3 })

    expect(labels).toHaveLength(36)
    expect(labels[0]).toBe("Apr 25")
    expect(labels[9]).toBe("Jan 26")
    expect(labels[35]).toBe("Mar 28")
  })

  it("lists the twelve months in order", () => {
    expect(monthLabelsFor({ fiscal_year_start_month: 7, first_year: 2027, years: 1 })).toEqual([
      "Jul 26",
      "Aug 26",
      "Sep 26",
      "Oct 26",
      "Nov 26",
      "Dec 26",
      "Jan 27",
      "Feb 27",
      "Mar 27",
      "Apr 27",
      "May 27",
      "Jun 27",
    ])
  })

  it("wraps the two digits of the year around a century", () => {
    const labels = monthLabelsFor({ fiscal_year_start_month: 1, first_year: 2099, years: 2 })

    expect(labels[0]).toBe("Jan 99")
    expect(labels[12]).toBe("Jan 00")
  })
})

describe("fiscalYears", () => {
  it("gives each fiscal year its label, first and last month and quarters", () => {
    expect(fiscalYears({ fiscal_year_start_month: 4, first_year: 2027, years: 2 })).toEqual([
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
    expect(fiscalYears({ fiscal_year_start_month: 1, first_year: 2026, years: 1 })).toEqual([
      {
        label: "FY26",
        firstMonth: "Jan 26",
        lastMonth: "Dec 26",
        quarters: ["Q1 FY26", "Q2 FY26", "Q3 FY26", "Q4 FY26"],
      },
    ])
  })

  it("covers as many years as the calendar has", () => {
    const years = fiscalYears({ fiscal_year_start_month: 10, first_year: 2026, years: 20 })

    expect(years).toHaveLength(20)
    expect(years[0]).toMatchObject({ label: "FY26", firstMonth: "Oct 25", lastMonth: "Sep 26" })
    expect(years[19]).toMatchObject({ label: "FY45", firstMonth: "Oct 44", lastMonth: "Sep 45" })
  })
})

describe("draftTimeline", () => {
  const saved = { fiscal_year_start_month: 1, first_year: 2026, years: 3 }

  it("takes the fields as they are typed", () => {
    expect(
      draftTimeline({ fiscal_year_start_month: "4", first_year: "2027", years: "5" }, saved),
    ).toEqual({ fiscal_year_start_month: 4, first_year: 2027, years: 5 })
  })

  it.each([
    ["empty", ""],
    ["out of range", "21"],
    ["zero", "0"],
    ["not a whole number", "1.5"],
  ])("keeps the saved years while they are %s", (_, years) => {
    expect(
      draftTimeline({ fiscal_year_start_month: "4", first_year: "2027", years }, saved),
    ).toEqual({ fiscal_year_start_month: 4, first_year: 2027, years: 3 })
  })

  it("keeps the saved first year while it is not a valid year", () => {
    expect(
      draftTimeline({ fiscal_year_start_month: "1", first_year: "10000", years: "2" }, saved),
    ).toEqual({ fiscal_year_start_month: 1, first_year: 2026, years: 2 })
  })
})
