import { vi } from "vitest"

/**
 * Gives every element the size of a screen, because jsdom has no layout and a virtualized list
 * renders nothing in a viewport of zero. Restore with `vi.restoreAllMocks()`.
 */
export function mockViewport(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height)
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width)
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(height)
}
