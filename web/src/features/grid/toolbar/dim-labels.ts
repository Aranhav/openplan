import { axisLabel, timeLevelLabel } from "@/features/structure/labels"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import type { ViewDefinition, ViewDim } from "../view-types"
import { dimKey } from "./view-state"

type Axis = ModuleDto["axes"][number]

function axisDim(axis: Axis): ViewDim {
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

function axisOf(dim: ViewDim, module: Pick<ModuleDto, "axes">): Axis | undefined {
  return module.axes.find((axis) => dimKey(axisDim(axis)) === dimKey(dim))
}

/** What a dimension is called on the toolbar: "Line items", a list's name, "Time (Month)". */
export function dimLabel(
  dim: ViewDim,
  module: Pick<ModuleDto, "axes">,
  structure: StructureDto,
): string {
  if (dim.kind === "line_items") {
    return "Line items"
  }
  const axis = axisOf(dim, module)
  return axis ? axisLabel(axis, structure) : "Dimension"
}

const PERIODS = {
  month: "Months",
  quarter: "Quarters",
  half_year: "Half years",
  year: "Years",
  all: "Total",
} as const

function cornerName(dim: ViewDim, module: Pick<ModuleDto, "axes">, structure: StructureDto) {
  if (dim.kind === "time") {
    const axis = axisOf(dim, module)
    if (axis?.kind === "time") {
      return PERIODS[axis.level] ?? timeLevelLabel(axis.level)
    }
  }
  return dim.kind === "versions" ? "Versions" : dimLabel(dim, module, structure)
}

/** What the corner of the grid says: the dimensions down the rows, a slash, then those across: "Regions / Months". */
export function cornerLabel(
  view: Pick<ViewDefinition, "rows" | "columns">,
  module: Pick<ModuleDto, "axes">,
  structure: StructureDto,
): string {
  const name = (dim: ViewDim) => cornerName(dim, module, structure)
  const rows = view.rows.map(name).join(", ")
  return view.columns.length === 0 ? rows : `${rows} / ${view.columns.map(name).join(", ")}`
}
