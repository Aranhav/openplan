import { HttpResponse, http } from "msw"
import type { StructureDto } from "@/features/structure/types"
import { server } from "./server"

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

type Calendar = Pick<StructureDto["calendar"], "first_year" | "fiscal_year_start_month" | "years">

/** The labels the server gives the months of a calendar (`Apr 26`), for a test to serve after a change. */
export function monthLabelsFor({ first_year, fiscal_year_start_month, years }: Calendar) {
  const firstMonth =
    (fiscal_year_start_month === 1 ? first_year : first_year - 1) * 12 + fiscal_year_start_month - 1
  return Array.from({ length: years * 12 }, (_, index) => {
    const month = firstMonth + index
    return `${MONTH_NAMES[month % 12]} ${String(Math.floor(month / 12) % 100).padStart(2, "0")}`
  })
}

export interface StructureStore {
  structure: StructureDto
}

/**
 * Serves the structure in `store.structure` for every model, read afresh on each request. A test
 * that mocks a structure change replaces it, so the page's next read of the structure shows it.
 */
export function serveStructureStore(structure: StructureDto): StructureStore {
  const store = { structure }
  server.use(http.get("/api/v1/models/:id/structure", () => HttpResponse.json(store.structure)))
  return store
}
