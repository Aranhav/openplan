import {
  Braces,
  CalendarDays,
  GitBranch,
  Hash,
  List,
  SquareFunction,
  Tag,
  createElement,
} from "lucide"
import type { Completion } from "./api"

type Kind = Completion["kind"]

const ICONS: Record<Kind, Parameters<typeof createElement>[0]> = {
  line_item: Hash,
  list: List,
  function: SquareFunction,
  keyword: Braces,
  item: Tag,
  version: GitBranch,
  period: CalendarDays,
}

/** The icon of a kind of completion, as a decoration: the list says the kind in words too. */
export function kindIcon(kind: string) {
  const icon = ICONS[kind as Kind]
  if (!icon) {
    return null
  }
  const element = createElement(icon, { width: "14", height: "14", "aria-hidden": "true" })
  element.classList.add("cm-formulaKindIcon")
  return element
}
