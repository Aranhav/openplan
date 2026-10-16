import type { LineItemDto, ModuleDto, StructureDto } from "./types"

export interface ModuleGroups {
  /** The modules that are in no functional area. */
  ungrouped: ModuleDto[]
  /** The functional areas by name, each with its modules. */
  areas: { name: string; modules: ModuleDto[] }[]
}

/** Sorts modules for navigation: the ungrouped ones, then a group for each functional area. */
export function groupModules(modules: readonly ModuleDto[]): ModuleGroups {
  const ungrouped: ModuleDto[] = []
  const byArea = new Map<string, ModuleDto[]>()
  for (const module of modules) {
    const area = module.functional_area.trim()
    if (area === "") {
      ungrouped.push(module)
    } else {
      byArea.set(area, [...(byArea.get(area) ?? []), module])
    }
  }
  const areas = [...byArea]
    .map(([name, grouped]) => ({ name, modules: grouped }))
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }))
  return { ungrouped, areas }
}

/** The line items of a module in the order the Blueprint and the grid list them. */
export function lineItemsOf(structure: StructureDto, moduleId: string): LineItemDto[] {
  return structure.line_items
    .filter((item) => item.module === moduleId)
    .sort((a, b) => a.ordinal - b.ordinal)
}

/** How many line items each module has, by the module's id. */
export function lineItemCounts(structure: StructureDto): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of structure.line_items) {
    counts.set(item.module, (counts.get(item.module) ?? 0) + 1)
  }
  return counts
}
