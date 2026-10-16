import { dimOfAxis } from "@/features/grid/toolbar/view-state"
import type { ViewDefinition } from "@/features/grid/view-types"
import type { ModuleDto } from "@/features/structure/types"

/**
 * The view a module opens with when it has no saved default: the line items down the rows, Time
 * across the columns (else the first list or subset), and every other dimension on a page at
 * its default member.
 */
export function defaultView(module: ModuleDto): ViewDefinition {
  const dims = module.axes.map(dimOfAxis)
  const across = dims.find((dim) => dim.kind === "time") ?? dims[0]
  return {
    rows: [{ kind: "line_items" }],
    columns: across ? [across] : [],
    pages: dims.filter((dim) => dim !== across).map((dim) => ({ dim, key: null })),
  }
}
