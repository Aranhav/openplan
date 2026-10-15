import { useRef } from "react"

/**
 * Keeps the elements of a list by key, so focus can be put back on one of them after a dialog
 * closes. Put `refFor(key)` on each element; `get(key)` finds it while it is on the page.
 */
export function useElementMap<T extends HTMLElement>() {
  const elements = useRef(new Map<string, T>())
  return {
    get: (key: string | undefined) => (key === undefined ? undefined : elements.current.get(key)),
    refFor: (key: string) => (element: T | null) => {
      if (element) {
        elements.current.set(key, element)
      } else {
        elements.current.delete(key)
      }
    },
  }
}
