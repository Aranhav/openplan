import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterAll, afterEach, beforeAll } from "vitest"
import { server } from "./server"

// Node's Request rejects relative URLs; browsers resolve them against the page.
const NativeRequest = globalThis.Request
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, window.location.href) : input, init)
  }
}

// jsdom does not implement matchMedia; default to a light system preference.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom does not implement scrolling; the router restores scroll on navigation.
window.scrollTo = () => {}

// Radix menus and cmdk measure and scroll elements, which jsdom cannot do.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}

// Requests no test mocked fail loudly instead of reaching a real network.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))

afterEach(() => {
  cleanup()
  server.resetHandlers()
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.cookie = "sidebar_state=; max-age=0; path=/"
})

afterAll(() => server.close())
