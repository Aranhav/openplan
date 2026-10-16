import type { StructureDto } from "@/features/structure/types"
import { wholeNumberIn } from "./whole-number"

/** What decides the months of a calendar. */
export type Timeline = Pick<
  StructureDto["calendar"],
  "fiscal_year_start_month" | "first_year" | "years"
>

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/** "FY27" for the fiscal year that ends in 2027: the last two digits of its year. */
export function fiscalYearLabel(year: number) {
  return `FY${String(year % 100).padStart(2, "0")}`
}

/**
 * The label of each month of a calendar, in order: `Apr 26`. The server words them the same way
 * (`month_labels` of the structure, which is what a request names a month by); this is for a
 * calendar the server has not been told about yet. The first fiscal year ends in `first_year`, so
 * with any start month but January it begins the year before.
 */
export function monthLabelsFor({ fiscal_year_start_month, first_year, years }: Timeline) {
  const firstMonth =
    (fiscal_year_start_month === 1 ? first_year : first_year - 1) * 12 + fiscal_year_start_month - 1
  return Array.from({ length: years * 12 }, (_, index) => {
    const month = firstMonth + index
    return `${MONTH_NAMES[month % 12]} ${String(Math.floor(month / 12) % 100).padStart(2, "0")}`
  })
}

export interface FiscalYear {
  label: string
  /** The first and last month of the fiscal year: "Apr 26". */
  firstMonth: string
  lastMonth: string
  quarters: string[]
}

/** The fiscal years of a calendar, each with its months and quarters. */
export function fiscalYears(timeline: Timeline): FiscalYear[] {
  const months = monthLabelsFor(timeline)
  return Array.from({ length: timeline.years }, (_, index) => {
    const label = fiscalYearLabel(timeline.first_year + index)
    return {
      label,
      firstMonth: months[index * 12],
      lastMonth: months[index * 12 + 11],
      quarters: [1, 2, 3, 4].map((quarter) => `Q${quarter} ${label}`),
    }
  })
}

/**
 * The timeline a form describes while it is being edited, from its fields as typed. A field that
 * is not a valid number yet (empty, or on its way to the next digit) keeps its saved value, so
 * the preview never goes blank under someone's fingers.
 */
export function draftTimeline(
  fields: { fiscal_year_start_month: string; first_year: string; years: string },
  saved: Timeline,
): Timeline {
  return {
    fiscal_year_start_month:
      wholeNumberIn(fields.fiscal_year_start_month, 1, 12) ?? saved.fiscal_year_start_month,
    first_year: wholeNumberIn(fields.first_year, 1, 9999) ?? saved.first_year,
    years: wholeNumberIn(fields.years, 1, 20) ?? saved.years,
  }
}
