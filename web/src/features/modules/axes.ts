import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"

type Schemas = components["schemas"]

export type Axis = Schemas["AxisDto"]
export type TimeLevel = Schemas["TimeLevelDto"]

/** The levels a module's Time dimension can have, finest first. */
export const MODULE_TIME_LEVELS = ["month", "quarter", "half_year", "year"] as const

/** What a list of dimensions holds for the whole calendar, which is no time range at all. */
export const WHOLE_CALENDAR = ""

/** A list or subset a module or a line item can have as a dimension. */
export interface DimensionOption {
  /** `list:<id>` or `subset:<id>`, which a form holds the choice by. */
  key: string
  name: string
  /** "List" or "Subset of Regions". */
  kind: string
}

type OwnAxis = Extract<Axis, { kind: "list" | "subset" }>

/** The lists and then the subsets of a model, which a module can take as dimensions. */
export function dimensionOptions(structure: StructureDto): DimensionOption[] {
  const listNames = new Map(structure.lists.map((list) => [list.id, list.name]))
  return [
    ...structure.lists.map((list) => ({ key: `list:${list.id}`, name: list.name, kind: "List" })),
    ...structure.subsets.map((subset) => ({
      key: `subset:${subset.id}`,
      name: subset.name,
      kind: `Subset of ${listNames.get(subset.list) ?? "a list"}`,
    })),
  ]
}

function keyOf(axis: OwnAxis): string {
  return axis.kind === "list" ? `list:${axis.list}` : `subset:${axis.subset}`
}

function axisOfKey(key: string): OwnAxis {
  const separator = key.indexOf(":")
  const id = key.slice(separator + 1)
  return key.startsWith("list:") ? { kind: "list", list: id } : { kind: "subset", subset: id }
}

/** The keys of the lists and subsets among `axes`, in order. */
export function ownKeys(axes: readonly Axis[]): string[] {
  return axes.flatMap((axis) =>
    axis.kind === "list" || axis.kind === "subset" ? [keyOf(axis)] : [],
  )
}

/** The lists and subsets named by `keys`, in order, as the axes a request takes. */
export function ownAxes(keys: readonly string[]): Axis[] {
  return keys.map(axisOfKey)
}

/** What a form holds of the dimensions of a module. */
interface AxesValues {
  /** The keys of its lists and subsets, in the order the module lists them. */
  dimensions: string[]
  time: boolean
  time_level: (typeof MODULE_TIME_LEVELS)[number]
  /** The id of the time range, or `WHOLE_CALENDAR`. */
  time_range: string
  versions: boolean
}

function moduleTimeLevel(level: TimeLevel): AxesValues["time_level"] {
  return MODULE_TIME_LEVELS.find((candidate) => candidate === level) ?? "month"
}

export function axesValues(axes: readonly Axis[]): AxesValues {
  const time = axes.find((axis) => axis.kind === "time")
  return {
    dimensions: ownKeys(axes),
    time: time !== undefined,
    time_level: time ? moduleTimeLevel(time.level) : "month",
    time_range: time?.range ?? WHOLE_CALENDAR,
    versions: axes.some((axis) => axis.kind === "versions"),
  }
}

/**
 * The axes a form's values stand for. Whatever the order, a module lays its cells out with the
 * lists and subsets first, then Time, then Versions, so that is the order they are given in.
 */
export function axesOf(values: AxesValues): Axis[] {
  return [
    ...ownAxes(values.dimensions),
    ...(values.time
      ? [
          {
            kind: "time",
            level: values.time_level,
            range: values.time_range === WHOLE_CALENDAR ? null : values.time_range,
          } satisfies Axis,
        ]
      : []),
    ...(values.versions ? [{ kind: "versions" } satisfies Axis] : []),
  ]
}

/** Whether two lists of axes are the same dimensions in the same order. */
export function sameAxes(a: readonly Axis[], b: readonly Axis[]): boolean {
  return JSON.stringify(axesOf(axesValues(a))) === JSON.stringify(axesOf(axesValues(b)))
}
