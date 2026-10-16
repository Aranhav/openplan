import type { GridQuery, ViewDim } from "@/features/grid/view-types"
import type { ModuleDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"

type Axis = components["schemas"]["AxisDto"]

function dimOf(axis: Axis): ViewDim {
  switch (axis.kind) {
    case "list":
      return { kind: "list", list: axis.list }
    case "subset":
      return { kind: "subset", subset: axis.subset }
    case "time":
      return { kind: "time" }
    case "versions":
      return { kind: "versions" }
  }
}

/**
 * The pivot a module opens with when it has no saved view: the line items down the rows, Time
 * across the columns (else the first list or subset), and every other dimension on a page at
 * its default member.
 */
export function defaultPivot(module: ModuleDto): GridQuery {
  const dims = module.axes.map(dimOf)
  const across = dims.find((dim) => dim.kind === "time") ?? dims[0]
  return {
    module: module.id,
    rows: [{ kind: "line_items" }],
    columns: across ? [across] : [],
    pages: dims.filter((dim) => dim !== across).map((dim) => ({ dim, key: null })),
  }
}
