import type { ModuleDto } from "@/features/structure/types"
import type {
  ConditionalFormat,
  GridQuery,
  MemberRef,
  PageSelection,
  RowFilter,
  ViewDefinition,
  ViewDim,
} from "../view-types"

/** Where a dimension sits in a pivot. */
export type Zone = "rows" | "columns" | "pages"

/** What a dimension is told apart by: its kind and, for a list or subset, its id. */
export function dimKey(dim: ViewDim): string {
  switch (dim.kind) {
    case "list":
      return `list:${dim.list}`
    case "subset":
      return `subset:${dim.subset}`
    default:
      return dim.kind
  }
}

/** The dimension an axis of a module is: the same kind, and the list or subset it names. */
export function dimOfAxis(axis: ModuleDto["axes"][number]): ViewDim {
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

const isDim = (dim: ViewDim) => (other: ViewDim) => dimKey(other) === dimKey(dim)
const isMember = (member: MemberRef) => (other: MemberRef) =>
  dimKey(other.dim) === dimKey(member.dim) && other.key === member.key

export type ViewAction =
  /** Takes a dimension out of its zone and puts it in `to`, at `index` there (the end by default). */
  | { type: "move"; dim: ViewDim; to: Zone; index?: number }
  | { type: "swap" }
  | { type: "set_page"; dim: ViewDim; key: string | null }
  | { type: "toggle_summaries" }
  | { type: "toggle_collapse"; member: MemberRef }
  | { type: "hide"; member: MemberRef }
  | { type: "show"; member: MemberRef }
  /** Shows the hidden members of one dimension, or of all. */
  | { type: "show_all"; dim?: ViewDim }
  | { type: "set_filters"; filters: RowFilter[] }
  | { type: "set_conditional_formats"; formats: ConditionalFormat[] }
  | { type: "set_column_widths"; widths: Record<string, number> }
  | { type: "replace"; definition: ViewDefinition }

function zoneOf(view: ViewDefinition, dim: ViewDim): Zone | undefined {
  if (view.rows.some(isDim(dim))) {
    return "rows"
  }
  if (view.columns.some(isDim(dim))) {
    return "columns"
  }
  return (view.pages ?? []).some((page) => isDim(dim)(page.dim)) ? "pages" : undefined
}

function move(view: ViewDefinition, dim: ViewDim, to: Zone, index: number | undefined) {
  const from = zoneOf(view, dim)
  if (from === undefined) {
    return view
  }
  // The rows are what the line items or the other dimensions are read down: they are never empty.
  if (from === "rows" && to !== "rows" && view.rows.length === 1) {
    return view
  }
  if (from === to && index === undefined) {
    return view
  }

  const rows = view.rows.filter((other) => !isDim(dim)(other))
  const columns = view.columns.filter((other) => !isDim(dim)(other))
  const pages = (view.pages ?? []).filter((page) => !isDim(dim)(page.dim))
  const kept = (view.pages ?? []).find((page) => isDim(dim)(page.dim))

  const insert = <T>(list: T[], item: T): T[] => {
    const at = Math.min(Math.max(index ?? list.length, 0), list.length)
    return [...list.slice(0, at), item, ...list.slice(at)]
  }
  const next: ViewDefinition = {
    ...view,
    rows: to === "rows" ? insert(rows, dim) : rows,
    columns: to === "columns" ? insert(columns, dim) : columns,
    pages: to === "pages" ? insert(pages, kept ?? { dim, key: null }) : pages,
  }
  return canonical(next) === canonical(view) ? view : next
}

function swap(view: ViewDefinition): ViewDefinition {
  return view.columns.length === 0 ? view : { ...view, rows: view.columns, columns: view.rows }
}

function setPage(view: ViewDefinition, dim: ViewDim, key: string | null): ViewDefinition {
  const pages = view.pages ?? []
  const at = pages.findIndex((page) => isDim(dim)(page.dim))
  if (at < 0 || (pages[at].key ?? null) === key) {
    return view
  }
  return {
    ...view,
    pages: pages.map((page, i): PageSelection => (i === at ? { ...page, key } : page)),
  }
}

function toggle(members: MemberRef[] | undefined, member: MemberRef): MemberRef[] {
  const list = members ?? []
  return list.some(isMember(member))
    ? list.filter((other) => !isMember(member)(other))
    : [...list, member]
}

/** The view after an action. It is the same object when the action changes nothing. */
export function reduceView(view: ViewDefinition, action: ViewAction): ViewDefinition {
  switch (action.type) {
    case "move":
      return move(view, action.dim, action.to, action.index)
    case "swap":
      return swap(view)
    case "set_page":
      return setPage(view, action.dim, action.key)
    case "toggle_summaries":
      return { ...view, show_summaries: !(view.show_summaries ?? true) }
    case "toggle_collapse":
      return { ...view, collapsed: toggle(view.collapsed, action.member) }
    case "hide":
      return (view.hidden ?? []).some(isMember(action.member))
        ? view
        : { ...view, hidden: [...(view.hidden ?? []), action.member] }
    case "show":
      return (view.hidden ?? []).some(isMember(action.member))
        ? { ...view, hidden: (view.hidden ?? []).filter((other) => !isMember(action.member)(other)) }
        : view
    case "show_all": {
      const { dim } = action
      const hidden = view.hidden ?? []
      const remaining = dim ? hidden.filter((member) => !isDim(dim)(member.dim)) : []
      return remaining.length === hidden.length ? view : { ...view, hidden: remaining }
    }
    case "set_filters":
      return { ...view, filters: action.filters }
    case "set_conditional_formats":
      return { ...view, conditional_formats: action.formats }
    case "set_column_widths":
      return { ...view, column_widths: action.widths }
    case "replace":
      return action.definition
  }
}

/** The part of a view that decides which cells there are: a query of the module, less the window. */
export function queryOf(moduleId: string, view: ViewDefinition): GridQuery {
  return {
    module: moduleId,
    rows: view.rows,
    columns: view.columns,
    pages: view.pages,
    line_items: view.line_items,
    filters: view.filters,
    hidden: view.hidden,
    collapsed: view.collapsed,
    show_summaries: view.show_summaries,
  }
}

/**
 * Whether the view puts every dimension of the module on the rows, columns or pages once, as the
 * server asks, so that a view kept from earlier (in a draft) is still a view of this module.
 */
export function fitsModule(view: ViewDefinition, module: Pick<ModuleDto, "axes">): boolean {
  const placed = [...view.rows, ...view.columns, ...(view.pages ?? []).map((page) => page.dim)]
  const wanted = ["line_items", ...module.axes.map((axis) => dimKey(dimOfAxis(axis)))]
  const keys = placed.map(dimKey)
  return keys.length === wanted.length && wanted.every((key) => keys.filter((k) => k === key).length === 1)
}

// What two views are compared by: the same view whether a field is absent, null or empty, and
// whether the members of a set (hidden, collapsed) or the widths come in one order or another.

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable)
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    )
  }
  return value
}

function sortedMembers(members: MemberRef[] | undefined) {
  return [...(members ?? [])]
    .map((member) => `${dimKey(member.dim)}\u0000${member.key}`)
    .sort()
}

function canonical(view: ViewDefinition): string {
  return JSON.stringify(
    stable({
      rows: view.rows.map(dimKey),
      columns: view.columns.map(dimKey),
      pages: (view.pages ?? []).map((page) => [dimKey(page.dim), page.key ?? null]),
      line_items: view.line_items ?? null,
      filters: view.filters ?? [],
      hidden: sortedMembers(view.hidden),
      collapsed: sortedMembers(view.collapsed),
      show_summaries: view.show_summaries ?? true,
      conditional_formats: view.conditional_formats ?? [],
      column_widths: view.column_widths ?? {},
    }),
  )
}

/** Whether the view in use differs from the one that was saved. */
export function isModified(current: ViewDefinition, saved: ViewDefinition): boolean {
  return canonical(current) !== canonical(saved)
}
