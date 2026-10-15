// Mirrors the engine's serde JSON until the generated API schema carries these types
// (Ruling M3-R6); a later task replaces each alias below with its generated one.

export type PeriodLevel = "month" | "quarter" | "half_year" | "year" | "all"

/** A cell value, adjacently tagged like the engine's `Value`. */
export type Value =
  | { t: "number"; v: number }
  | { t: "boolean"; v: boolean }
  | { t: "text"; v: string }
  | { t: "date"; v: string | null }
  | { t: "item"; v: string | null }
  | { t: "period"; v: [PeriodLevel, number] | null }

export type NumberUnit =
  | { type: "none" }
  | { type: "currency"; code: string }
  | { type: "percent" }

export type Format =
  | {
      type: "number"
      decimals: number
      thousands_sep: boolean
      unit: NumberUnit
      negative: "minus" | "parens"
    }
  | { type: "boolean" }
  | { type: "text" }
  | { type: "date" }
  | { type: "list"; list: string }
  | { type: "time_period"; level: PeriodLevel }

/** The slice of a view the server returns for one query, as the engine's `Window`. */
export type Window = {
  row_offset: number
  row_limit: number
  col_offset: number
  col_limit: number
}
