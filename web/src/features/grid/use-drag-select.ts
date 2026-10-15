import { useEffect, useRef } from "react"
import type { Pos } from "./core/selection"

/** The cell a pointer event is over, if it is over one. */
export function cellOf(target: EventTarget | null): Pos | undefined {
  const cell =
    target instanceof Element ? target.closest<HTMLElement>("[data-row][data-col]") : null
  return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : undefined
}

/**
 * Selecting a range by dragging: once the button is down on a cell, every move of the pointer, in
 * the grid or out of it, grows the range to the cell it is over, until the button comes up.
 * `select(pos, true)` grows the range; `nearestCell` finds the cell for a pointer that is not over
 * one (over a header, or outside the grid).
 */
export function useDragSelect(select: (pos: Pos, extend?: boolean) => void) {
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  return function startDrag(origin: Pos, nearestCell: (event: PointerEvent) => Pos | undefined) {
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    let last = origin
    window.addEventListener(
      "pointermove",
      (event) => {
        const over = nearestCell(event)
        if (over && (over.row !== last.row || over.col !== last.col)) {
          last = over
          select(over, true)
        }
      },
      { signal: abort.signal },
    )
    const end = () => abort.abort()
    window.addEventListener("pointerup", end, { signal: abort.signal })
    window.addEventListener("pointercancel", end, { signal: abort.signal })
  }
}
