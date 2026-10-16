import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"

// How much wider than it needed to be the row has to get before the wide layout is tried again. A
// menu that opens takes the page's scrollbar away, which widens the row by a few pixels; without
// the margin that would be enough to bring the controls back and close the menu it was opened from.
const WIDE_MARGIN = 32

/**
 * Whether the toolbar has to put its secondary controls in the More menu: it does when the row
 * of page selectors, which is the part that gives way, has more in it than room. The first
 * check is the wide layout; once the menu is used, the wide layout is tried again when the row
 * is clearly wider than it was needed to be. A row measured at zero (no layout) is wide.
 */
export function useToolbarFit(
  row: RefObject<HTMLElement | null>,
  pages: RefObject<HTMLElement | null>,
) {
  const [compact, setCompact] = useState(false)
  // How wide the row has to be for the wide layout to fit, as of the last time it did not.
  const needed = useRef(0)
  // The width of the row, kept so that a window that changes size checks again.
  const [, setWidth] = useState(0)

  useEffect(() => {
    const element = row.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [row])

  // After every render, since what the page selectors say (a member's name) changes what they need.
  useLayoutEffect(() => {
    const element = row.current
    const group = pages.current
    if (!element || !group) {
      return
    }
    const check = () => {
      const width = element.clientWidth
      if (!compact) {
        const overflow = group.scrollWidth - group.clientWidth
        if (overflow > 1) {
          needed.current = width + overflow
          setCompact(true)
        }
      } else if (width >= needed.current + WIDE_MARGIN) {
        setCompact(false)
      }
    }
    check()
  })

  return compact
}
