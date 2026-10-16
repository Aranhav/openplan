/** The words the screens use for the parts of a structure: formats, dimensions, summaries and months. */
import type { components } from "@/lib/api/schema"
import type { StructureDto } from "./types"

type Schemas = components["schemas"]

const TIME_LEVEL_LABELS: Record<Schemas["TimeLevelDto"], string> = {
  month: "Month",
  quarter: "Quarter",
  half_year: "Half year",
  year: "Year",
  all: "Total",
}

const SUMMARY_LABELS: Record<Schemas["SummaryMethodDto"]["method"], string> = {
  sum: "Sum",
  average: "Average",
  min: "Min",
  max: "Max",
  none: "None",
  formula: "Formula",
  ratio: "Ratio",
  first: "First",
  last: "Last",
  opening: "Opening balance",
  closing: "Closing balance",
  any: "Any",
  all: "All",
}

const MODULE_DEFAULT = "Module default"

export function timeLevelLabel(level: Schemas["TimeLevelDto"]) {
  return TIME_LEVEL_LABELS[level]
}

function numberLabel(unit: Schemas["NumberUnitDto"]) {
  switch (unit.type) {
    case "none":
      return "Number"
    case "currency":
      return `Currency (${unit.code})`
    case "percent":
      return "Percent"
  }
}

/** "Number", "Currency (USD)", "Percent", "Boolean", "Text", "Date", "List: Regions" or "Time period: Month". */
export function formatLabel(format: Schemas["FormatDto"], structure: StructureDto) {
  switch (format.type) {
    case "number":
      return numberLabel(format.unit)
    case "boolean":
      return "Boolean"
    case "text":
      return "Text"
    case "date":
      return "Date"
    case "list": {
      const name = structure.lists.find((list) => list.id === format.list)?.name
      return name ? `List: ${name}` : "List"
    }
    case "time_period":
      return `Time period: ${timeLevelLabel(format.level)}`
  }
}

/** A dimension of a module: the name of its list or subset, "Time (Month)" or "Versions". */
export function axisLabel(axis: Schemas["AxisDto"], structure: StructureDto) {
  switch (axis.kind) {
    case "list":
      return structure.lists.find((list) => list.id === axis.list)?.name ?? "List"
    case "subset":
      return structure.subsets.find((subset) => subset.id === axis.subset)?.name ?? "Subset"
    case "time": {
      const range = structure.time_ranges.find((candidate) => candidate.id === axis.range)
      const parts = [timeLevelLabel(axis.level), range?.name].filter(Boolean)
      return `Time (${parts.join(", ")})`
    }
    case "versions":
      return "Versions"
  }
}

export function dimsLabel(axes: Schemas["AxisDto"][], structure: StructureDto) {
  return axes.length === 0 ? "None" : axes.map((axis) => axisLabel(axis, structure)).join(", ")
}

export function summaryLabel(method: Schemas["SummaryMethodDto"]) {
  return SUMMARY_LABELS[method.method]
}

export function timeScaleLabel(scale: Schemas["TimeScaleDto"]) {
  if (scale === "module") {
    return MODULE_DEFAULT
  }
  return scale === "none" ? "None" : timeLevelLabel(scale.level)
}

export function versionsLabel(scope: Schemas["VersionsScopeDto"], structure: StructureDto) {
  if (scope === "module") {
    return MODULE_DEFAULT
  }
  if (scope === "none") {
    return "None"
  }
  const names = scope.only.flatMap((id) => {
    const version = structure.versions.find((candidate) => candidate.id === id)
    return version ? [version.name] : []
  })
  return names.length === 0 ? "None" : names.join(", ")
}
