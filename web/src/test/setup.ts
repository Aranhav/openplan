import "@testing-library/jest-dom/vitest"
import { cleanup, configure } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest"
import { FakeWebSocket, ticketHandler } from "./live"
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

// The first render of the whole app in a test file can take over a second on a busy machine, and
// the default timeout of findBy and waitFor (1 s) is not enough then.
configure({ asyncUtilTimeout: 3000 })

// Requests no test mocked fail loudly instead of reaching a real network.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }))

// A model's screens follow it over a WebSocket, which is opened with a ticket. No test may reach a
// network, so each gets a fake socket and an answer to the ticket (new each time, so that the
// numbers of the tickets do not depend on the tests before it). The socket goes in after msw has
// listened, which puts a wrapper of its own in its place; only the socket is put back afterwards.
let nativeWebSocket = globalThis.WebSocket

function useWebSocket(socket: typeof WebSocket) {
  Object.defineProperty(globalThis, "WebSocket", {
    value: socket,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  nativeWebSocket = globalThis.WebSocket
  useWebSocket(FakeWebSocket as unknown as typeof WebSocket)
  server.use(ticketHandler())
})

afterEach(() => {
  cleanup()
  useWebSocket(nativeWebSocket)
  server.resetHandlers()
  FakeWebSocket.sockets = []
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
  document.cookie = "sidebar_state=; max-age=0; path=/"
})

afterAll(() => server.close())
