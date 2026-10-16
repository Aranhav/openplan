import type { ItemDto } from "./types"

export type TreeRow =
  /** An item of the parent list, which the items under it belong to. */
  | { kind: "group"; key: string; parent: ItemDto; count: number; collapsed: boolean }
  | { kind: "item"; key: string; item: ItemDto }

interface TreeOptions {
  /** The items of the list, in order. */
  items: ItemDto[]
  /** The items of the parent list, in order; none for a list without a parent list. */
  parents?: ItemDto[]
  /** The ids of the parent items whose group is folded. */
  collapsed: ReadonlySet<string>
  /** Keeps the items whose name or code holds this text. */
  query?: string
}

/** Whether the name or the code of the item holds the text, whatever its case. */
export function matchesQuery(item: ItemDto, query: string) {
  const wanted = query.trim().toLowerCase()
  return (
    item.name.toLowerCase().includes(wanted) || (item.code?.toLowerCase().includes(wanted) ?? false)
  )
}

function itemRow(item: ItemDto): TreeRow {
  return { kind: "item", key: `item:${item.id}`, item }
}

/**
 * What the items table shows, top to bottom. With a parent list, each parent item is a row of its
 * own with the items that belong to it under it (unless it is folded); an item whose parent is not
 * in the parent list comes last, on its own. A filter keeps the matching items and the groups that
 * hold one, and a group counts just the items it shows or hides.
 */
export function buildRows({ items, parents, collapsed, query = "" }: TreeOptions): TreeRow[] {
  const filtered = query.trim() !== ""
  const shown = filtered ? items.filter((item) => matchesQuery(item, query)) : items
  if (!parents) {
    return shown.map(itemRow)
  }

  const childrenOf = new Map<string, ItemDto[]>()
  const known = new Set(parents.map((parent) => parent.id))
  const strays: ItemDto[] = []
  for (const item of shown) {
    if (item.parent_id && known.has(item.parent_id)) {
      childrenOf.set(item.parent_id, [...(childrenOf.get(item.parent_id) ?? []), item])
    } else {
      strays.push(item)
    }
  }

  const rows: TreeRow[] = []
  for (const parent of parents) {
    const children = childrenOf.get(parent.id) ?? []
    if (filtered && children.length === 0) {
      continue
    }
    const isCollapsed = collapsed.has(parent.id)
    rows.push({
      kind: "group",
      key: `group:${parent.id}`,
      parent,
      count: children.length,
      collapsed: isCollapsed,
    })
    if (!isCollapsed) {
      rows.push(...children.map(itemRow))
    }
  }
  rows.push(...strays.map(itemRow))
  return rows
}
