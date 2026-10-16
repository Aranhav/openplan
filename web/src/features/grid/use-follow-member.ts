import { useEffect, useEffectEvent, useRef } from "react"
import type { Pos } from "./core/selection"
import type { Header } from "./view-types"

// How long the active cell waits for the view that a keyboard collapse asked for.
const FOLLOW_MS = 5000

// How far from where the member was its new place is looked for, in rows or columns.
const FOLLOW_RADIUS = 400

/** The member a keyboard collapse or expand acted on, which the active cell goes to. */
export type Following = {
  axis: "row" | "column"
  /** The keys of the member and of the members it is under, outermost first. */
  path: string[]
  /** The keys of the members inside it that the active cell was in, to stay in them. */
  inner: string[]
  /** Where the member was, to look for it nearest to that place. */
  from: number
  /** The row of the active cell for a column, the column for a row: it stays. */
  other: number
}

type Pending = Following & { until: number }

function nearestUnder(
  keys: readonly string[],
  from: number,
  count: number,
  headerAt: (index: number) => Header | undefined,
): number | undefined {
  const matches = (index: number) => {
    const header = headerAt(index)
    return header !== undefined && keys.every((key, level) => header.members[level]?.key === key)
  }
  for (let distance = 0; distance <= FOLLOW_RADIUS; distance++) {
    for (const index of [from - distance, from + distance]) {
      if (index >= 0 && index < count && matches(index)) {
        return index
      }
    }
  }
  return undefined
}

type Options = {
  rowHeaders: (row: number) => Header | undefined
  colHeaders: (col: number) => Header | undefined
  totalRows: number
  totalColumns: number
  /** The view on show is the previous one, which the member has not moved in yet. */
  waiting: boolean
  onFound: (pos: Pos) => void
}

/**
 * A member that comes after its children (a time summary) moves when it collapses or expands,
 * and the index the active cell had would then lie on its neighbour. So after a keyboard collapse
 * the active cell goes to the member, once the view with the member in its new place has loaded:
 * to the same members inside it as before (the same version, say), if they are still there.
 * Whatever the user does in the meantime is the end of it.
 */
export function useFollowMember({
  rowHeaders,
  colHeaders,
  totalRows,
  totalColumns,
  waiting,
  onFound,
}: Options) {
  const pending = useRef<Pending | null>(null)
  const goTo = useEffectEvent(onFound)

  useEffect(() => {
    const following = pending.current
    if (!following || waiting) {
      return
    }
    if (Date.now() > following.until) {
      pending.current = null
      return
    }
    const row = following.axis === "row"
    const count = row ? totalRows : totalColumns
    const headerAt = row ? rowHeaders : colHeaders
    const found =
      nearestUnder([...following.path, ...following.inner], following.from, count, headerAt) ??
      nearestUnder(following.path, following.from, count, headerAt)
    if (found !== undefined) {
      pending.current = null
      goTo(row ? { row: found, col: following.other } : { row: following.other, col: found })
    }
  }, [rowHeaders, colHeaders, totalRows, totalColumns, waiting])

  return {
    start(following: Following) {
      pending.current = { ...following, until: Date.now() + FOLLOW_MS }
    },
    cancel() {
      pending.current = null
    },
  }
}
