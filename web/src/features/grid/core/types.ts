import type { components } from "@/lib/api/schema"

/** A cell value, adjacently tagged: `{ t, v }`. */
export type Value = components["schemas"]["ValueDto"]

/** How a line item's values are typed and displayed. */
export type Format = components["schemas"]["FormatDto"]

export type PeriodLevel = components["schemas"]["TimeLevelDto"]

/** The slice of a view the server returns for one query, as the engine's `Window`; the generated schema has no query endpoint yet. */
export type Window = {
  row_offset: number
  row_limit: number
  col_offset: number
  col_limit: number
}
