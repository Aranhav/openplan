import type { ParseContext } from "./core/parse-value"
import type { Format, PeriodLevel, Value } from "./core/types"

/** An item of a list, as a list cell offers it. */
export type ListOption = { id: string; name: string; code?: string | null }

/** A period of the timeline, with the level and place the server stores it by. */
export type PeriodOption = { label: string; level: PeriodLevel; index: number }

/**
 * What a cell editor needs to know besides the view: the items of the lists that list cells
 * point to, by list id, and every period of the timeline. The model screen builds it from the
 * structure it has loaded.
 */
export type GridReference = {
  lists: Readonly<Record<string, readonly ListOption[]>>
  periods: readonly PeriodOption[]
}

export const NO_REFERENCE: GridReference = { lists: {}, periods: [] }

const NO_OPTIONS: readonly ListOption[] = []

type Index = {
  periodsByLabel: Map<string, [PeriodLevel, number]>
  periodLabels: Map<string, string>
  itemNames: Map<string, Map<string, string>>
  contexts: Map<string, ParseContext>
}

// A reference lives as long as the model screen's structure, so what is built from it is kept.
const indexes = new WeakMap<GridReference, Index>()

function indexOf(reference: GridReference): Index {
  let index = indexes.get(reference)
  if (!index) {
    index = {
      periodsByLabel: new Map(
        reference.periods.map((period) => [
          period.label.toLowerCase(),
          [period.level, period.index] as [PeriodLevel, number],
        ]),
      ),
      periodLabels: new Map(
        reference.periods.map((period) => [`${period.level}:${period.index}`, period.label]),
      ),
      itemNames: new Map(),
      contexts: new Map(),
    }
    indexes.set(reference, index)
  }
  return index
}

/** The items of the list a list cell is formatted as. */
export function listOptions(format: Format, reference: GridReference): readonly ListOption[] {
  return format.type === "list" ? (reference.lists[format.list] ?? NO_OPTIONS) : NO_OPTIONS
}

/** What `parseInput` needs to read an entry for a cell of this format. */
export function parseContextFor(format: Format, reference: GridReference): ParseContext {
  const index = indexOf(reference)
  const listId = format.type === "list" ? format.list : ""
  let context = index.contexts.get(listId)
  if (!context) {
    const options = listOptions(format, reference)
    context = {
      itemsByName: new Map(options.map((option) => [option.name.toLowerCase(), option.id])),
      itemsByCode: new Map(
        options.flatMap((option) =>
          option.code ? [[option.code.toLowerCase(), option.id] as [string, string]] : [],
        ),
      ),
      periodsByLabel: index.periodsByLabel,
    }
    index.contexts.set(listId, context)
  }
  return context
}

/**
 * The item name or period label that goes with an item or period value, which the server sends
 * beside the value for cells it has read and the grid works out for cells it has just edited.
 */
export function displayText(
  value: Value,
  format: Format,
  reference: GridReference,
): string | undefined {
  if (value.t === "item" && value.v !== null && format.type === "list") {
    const index = indexOf(reference)
    let names = index.itemNames.get(format.list)
    if (!names) {
      names = new Map(listOptions(format, reference).map((option) => [option.id, option.name]))
      index.itemNames.set(format.list, names)
    }
    return names.get(value.v)
  }
  if (value.t === "period" && value.v !== null) {
    return indexOf(reference).periodLabels.get(`${value.v[0]}:${value.v[1]}`)
  }
  return undefined
}

/** Whether two values are the same cell content. */
export function sameValue(a: Value, b: Value): boolean {
  if (a.t === "period" && b.t === "period") {
    return a.v === b.v || (a.v !== null && b.v !== null && a.v[0] === b.v[0] && a.v[1] === b.v[1])
  }
  return a.t === b.t && a.v === b.v
}
