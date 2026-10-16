import { useCallback, useState } from "react"

/**
 * For something that scrolls inside itself, such as the grid, and should take the room the page
 * leaves: the height from the top of the element to the bottom of the window less `bottom` (the
 * page's own padding), and at least `min`. It follows the window and whatever changes the page
 * above the element (a notice, a title that wraps), growing or shrinking: the page growing shows
 * in the size of the page, but when it shrinks the page may be held at the height of the window,
 * so what is above the element is watched too. Put `ref` on the element and `height` in its
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
      // The page growing is how a notice or a wrapped title that appears above the element shows.
      const observer = new ResizeObserver(measure)
      observer.observe(document.body)
      // Whatever is above the element in the page, which moves the element when it changes size
      // or goes (a notice that is gone leaves a page that is no shorter than the window).
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        for (let above = node.previousElementSibling; above; above = above.previousElementSibling) {
          observer.observe(above)
        }
      }
      return () => {
        window.removeEventListener("resize", measure)
        observer.disconnect()
      }
    },
    [min, bottom],
  )
  return { ref, height }
}
