import type { StructureDto } from "@/features/structure/types"

/** "FY27" for the fiscal year that ends in 2027: the last two digits of its year. */
export function fiscalYearLabel(year: number) {
  return `FY${String(year % 100).padStart(2, "0")}`
}

export interface FiscalYear {
  label: string
  /** The first and last month of the fiscal year, as the model words them: "Apr 26". */
  firstMonth: string
  lastMonth: string
  quarters: string[]
}

/**
 * The fiscal years of a calendar. The months come from the model's own labels (`month_labels`),
 * twelve to a year; only the labels of years and quarters are worded here, the way the engine does.
 */
export function fiscalYears(
  { first_year, years }: Pick<StructureDto["calendar"], "first_year" | "years">,
  monthLabels: string[],
): FiscalYear[] {
  return Array.from({ length: years }, (_, index) => {
    const label = fiscalYearLabel(first_year + index)
    return {
      label,
      firstMonth: monthLabels[index * 12],
      lastMonth: monthLabels[index * 12 + 11],
      quarters: [1, 2, 3, 4].map((quarter) => `Q${quarter} ${label}`),
    }
  })
}
