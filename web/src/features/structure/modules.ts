import type { ModuleDto } from "./types"

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
