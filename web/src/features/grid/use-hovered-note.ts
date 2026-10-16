import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import type { Pos } from "./core/selection"
import { cellOf } from "./use-drag-select"

const HOVER_DELAY_MS = 250

/**
 * The cell with a note (a `data-note` attribute) the pointer rests on. It is found from the
 * pointer events of the whole grid rather than one handler per cell, and it shows after a short
 * pause, so sweeping across a row of such cells does not flash a tooltip at each; once one is
 * showing, the next cell takes over at once.
 */
export function useHoveredNote() {
  const [hovered, setHovered] = useState<Pos | null>(null)
  const over = useRef("")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  function onPointerOver(event: ReactPointerEvent) {
    const noted =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-note]") : null
    const cell = noted ? cellOf(noted) : undefined
    const key = cell ? `${cell.row}:${cell.col}` : ""
    if (key === over.current) {
      return
    }
    over.current = key
    clearTimeout(timer.current)
    if (!cell) {
      setHovered(null)
    } else if (hovered) {
      setHovered(cell)
    } else {
      timer.current = setTimeout(() => setHovered(cell), HOVER_DELAY_MS)
    }
  }

  function onPointerLeave() {
    over.current = ""
    clearTimeout(timer.current)
    setHovered(null)
  }

  return { hovered, onPointerOver, onPointerLeave }
}
