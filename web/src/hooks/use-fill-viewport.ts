import { useCallback, useState } from "react"

/**
 * For something that scrolls inside itself, such as the grid, and should take the room the page
 * leaves: the height from the top of the element to the bottom of the window less `bottom` (the
 * page's own padding), and at least `min`. It follows the window and whatever changes the page
 * above the element (a notice, a title that wraps). Put `ref` on the element and `height` in its
 * style; `height` is unknown (`undefined`) until the element is on the page.
 */
export function useFillViewport(min: number, bottom: number) {
  const [height, setHeight] = useState<number>()
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) {
        return
      }
      const measure = () => {
        const top = element.getBoundingClientRect().top + window.scrollY
        setHeight(Math.max(min, Math.floor(window.innerHeight - top - bottom)))
      }
      measure()
      window.addEventListener("resize", measure)
      // The page changing size is how a notice or a wrapped title above the element shows.
      const observer = new ResizeObserver(measure)
      observer.observe(document.body)
      return () => {
        window.removeEventListener("resize", measure)
        observer.disconnect()
      }
    },
    [min, bottom],
  )
  return { ref, height }
}
