import type { components } from "@/lib/api/schema"

/** A cell value, adjacently tagged: `{ t, v }`. */
export type Value = components["schemas"]["ValueDto"]

/** How a line item's values are typed and displayed. */
export type Format = components["schemas"]["FormatDto"]

export type PeriodLevel = components["schemas"]["TimeLevelDto"]

/** The slice of a view the server returns for one query. */
export type Window = components["schemas"]["WindowDto"]
