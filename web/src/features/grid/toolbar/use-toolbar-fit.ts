import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"

// How much wider than it needed to be the row has to get before the wide layout is tried again. A
// menu that opens takes the page's scrollbar away, which widens the row by a few pixels; without
// the margin that would be enough to bring the controls back and close the menu it was opened from.
const WIDE_MARGIN = 32

/** How wide an element is, to the fraction of a pixel: rounded widths could add up to a pixel short and let the row wrap. */
const widthOf = (element: Element) => element.getBoundingClientRect().width

/** The room an item takes in a row: its width and its margins. */
function outerWidth(element: Element): number {
  const { marginLeft, marginRight } = getComputedStyle(element)
  const margin = (value: string) => (Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : 0)
  return widthOf(element) + margin(marginLeft) + margin(marginRight)
}

/** The gap between the items of a flex row, in pixels. */
function gapOf(element: HTMLElement): number {
  const gap = Number.parseFloat(getComputedStyle(element).columnGap)
  return Number.isFinite(gap) ? gap : 0
}

/** The width of the items of a flex box laid end to end, with its gaps. An item that is not displayed takes no gap. */
function laidEnd(box: HTMLElement, widthOfItem: (item: Element) => number): number {
  const widths = Array.from(box.children)
    .filter((item) => getComputedStyle(item).display !== "none")
    .map(widthOfItem)
  return widths.reduce((sum, width) => sum + width, 0) + gapOf(box) * Math.max(widths.length - 1, 0)
}

/**
 * How wide the row has to be to have everything on one line: each item as wide as it is, with its
 * margins, and the page group, which takes the room that is left and wraps its selectors when it
 * has too little, as wide as its selectors laid end to end.
 */
function naturalWidth(row: HTMLElement, pages: HTMLElement | null): number {
  return laidEnd(row, (item) => (item === pages ? laidEnd(pages, outerWidth) : outerWidth(item)))
}

/**
 * Whether the toolbar has to put its secondary controls in the More menu: it does when the whole
 * row, the pivot, the page selectors, the controls and the saved views together, is wider than the
 * room it has, whether or not the view has page selectors. The first check is the wide layout;
 * once the menu is used, the wide layout is tried again when the row is clearly wider than the
 * layout needed to be. A row measured at zero (no layout) is wide.
 */
export function useToolbarFit(
  row: RefObject<HTMLElement | null>,
  pages: RefObject<HTMLElement | null>,
) {
  const [compact, setCompact] = useState(false)
  // How wide the row has to be for the wide layout to fit, as of the last time it did not.
  const needed = useRef(0)
  // Said by the row changing size, or what is in it changing (a selector that has its members, or
  // another member chosen), neither of which renders the toolbar that holds the row.
  const [, setLooked] = useState(0)

  useEffect(() => {
    const element = row.current
    if (!element) {
      return
    }
    const again = () => setLooked((times) => times + 1)
    const resized = new ResizeObserver(again)
    const changed = new MutationObserver(again)
    resized.observe(element)
    changed.observe(element, { childList: true, subtree: true, characterData: true })
    return () => {
      resized.disconnect()
      changed.disconnect()
    }
  }, [row])

  // After every render, and when it is said that the row changed, since what the page selectors
  // say (a member's name) changes what they need.
  useLayoutEffect(() => {
    const element = row.current
    if (!element) {
      return
    }
    const check = () => {
      const width = widthOf(element)
      if (width === 0) {
        return
      }
      if (!compact) {
        const natural = naturalWidth(element, pages.current)
        if (natural > width) {
          needed.current = natural
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
