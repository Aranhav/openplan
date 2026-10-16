import type { StructureDto } from "@/features/structure/types"
import { countOf } from "./words"

export interface Blocker {
  /** The item that still has child items. */
  itemId: string
  /** The child list they are in. */
  list: string
  count: number
}

/**
 * The items among `ids` that others hang from. The engine refuses to delete an item while items of
 * a child list still have it as their parent, so these have to go first.
 */
export function blockedByChildren(
  structure: StructureDto,
  listId: string,
  ids: ReadonlySet<string>,
): Blocker[] {
  const blockers: Blocker[] = []
  for (const child of structure.lists.filter((list) => list.parent === listId)) {
    const counts = new Map<string, number>()
    for (const item of child.items) {
      if (item.parent && ids.has(item.parent)) {
        counts.set(item.parent, (counts.get(item.parent) ?? 0) + 1)
      }
    }
    for (const [itemId, count] of counts) {
      blockers.push({ itemId, list: child.name, count })
    }
  }
  const order = new Map([...ids].map((id, index) => [id, index]))
  return blockers.sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0))
}

/** Why the items cannot be deleted yet, naming the first and counting the rest. */
export function blockedMessage(blockers: Blocker[], names: ReadonlyMap<string, string>) {
  const [first, ...rest] = blockers
  const name = names.get(first.itemId) ?? "An item"
  const more =
    rest.length === 0
      ? ""
      : `, and ${rest.length} more selected ${rest.length === 1 ? "item has" : "items have"} child items`
  return `${name} still has ${countOf(first.count, "child item")} in ${first.list}${more}. Delete those first.`
}
