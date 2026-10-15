import type { Format } from "@/features/grid/core/types"

export type NumberFormat = Extract<Format, { type: "number" }>

/** A number format for tests: two decimals, grouped thousands, no unit and a minus sign. */
export function numberFormat(options: Partial<Omit<NumberFormat, "type">> = {}): NumberFormat {
  return {
    type: "number",
    decimals: 2,
    thousands_sep: true,
    unit: { type: "none" },
    negative: "minus",
    ...options,
  }
}
