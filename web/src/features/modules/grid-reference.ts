import type { GridReference, PeriodOption } from "@/features/grid/edit-reference"
import { fiscalYearLabel } from "@/features/time/timeline"
import type { StructureDto } from "@/features/structure/types"

/** The parts of a structure the cell editors read. */
type ReferenceSource = Pick<StructureDto, "lists" | "calendar" | "month_labels">

/**
 * What the grid's cell editors need to know of the model: the items of each list, for list cells,
 * and every period of the timeline at every level, which period cells are typed by. The labels
 * are the engine's: `Jan 26` for a month (the structure holds them), `Q1 FY26`, `H1 FY26`,
 * `FY26` and `Total`.
 */
export function gridReference({ lists, calendar, month_labels }: ReferenceSource): GridReference {
  const years = Array.from({ length: calendar.years }, (_, year) =>
    fiscalYearLabel(calendar.first_year + year),
  )
  const periods: PeriodOption[] = [
    ...month_labels.map((label, index) => ({ label, level: "month" as const, index })),
    ...years.flatMap((year, index) =>
      [1, 2, 3, 4].map((quarter) => ({
        label: `Q${quarter} ${year}`,
        level: "quarter" as const,
        index: index * 4 + quarter - 1,
      })),
    ),
    ...years.flatMap((year, index) =>
      [1, 2].map((half) => ({
        label: `H${half} ${year}`,
        level: "half_year" as const,
        index: index * 2 + half - 1,
      })),
    ),
    ...years.map((label, index) => ({ label, level: "year" as const, index })),
    { label: "Total", level: "all" as const, index: 0 },
  ]
  return {
    lists: Object.fromEntries(
      lists.map((list) => [
        list.id,
        list.items.map((item) => ({ id: item.id, name: item.name, code: item.code })),
      ]),
    ),
    periods,
  }
}
