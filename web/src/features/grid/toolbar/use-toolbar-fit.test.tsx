import { act, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useToolbarFit } from "./use-toolbar-fit"

/** A ResizeObserver the test drives: `notify` says that the row changed size. */
class FakeResizeObserver {
  static callbacks: (() => void)[] = []

  constructor(callback: () => void) {
    FakeResizeObserver.callbacks.push(callback)
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

/** How wide the row and the page selectors are, and how much the selectors have in them. */
const sizes = { row: 1000, room: 300, content: 300 }

function Toolbar() {
  const row = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const compact = useToolbarFit(row, pages)
  return (
    <div ref={row} data-role="row">
      <div ref={pages} data-role="pages" />
      <p>{compact ? "compact" : "wide"}</p>
    </div>
  )
}

const realObserver = globalThis.ResizeObserver

beforeEach(() => {
  FakeResizeObserver.callbacks = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  Object.assign(sizes, { row: 1000, room: 300, content: 300 })
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    const role = this.getAttribute("data-role")
    return role === "row" ? sizes.row : role === "pages" ? sizes.room : 0
  })
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    return this.getAttribute("data-role") === "pages" ? sizes.content : 0
  })
})

afterEach(() => {
  globalThis.ResizeObserver = realObserver
  vi.restoreAllMocks()
})

/** The row changed size: the observer says so, and the toolbar looks again. */
function resize(row: number, room: number) {
  act(() => {
    sizes.row = row
    sizes.room = room
    for (const callback of FakeResizeObserver.callbacks) {
      callback()
    }
  })
}

describe("useToolbarFit", () => {
  it("is wide while the page selectors fit", () => {
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })

  it("is compact once the page selectors have more in them than room", () => {
    sizes.content = 400
    render(<Toolbar />)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("is wide again once the row is as wide as the wide layout needed, and not before", () => {
    sizes.content = 400
    render(<Toolbar />)
    expect(screen.getByText("compact")).toBeVisible()

    // The row grows, but not by as much as the selectors were short of.
    resize(1050, 350)
    expect(screen.getByText("compact")).toBeVisible()

    resize(1100, 400)
    expect(screen.getByText("wide")).toBeVisible()
  })

  it("goes compact when the row shrinks until they no longer fit", () => {
    render(<Toolbar />)
    expect(screen.getByText("wide")).toBeVisible()

    sizes.content = 300
    resize(800, 200)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("is wide in a row that has no layout", () => {
    sizes.row = 0
    sizes.room = 0
    sizes.content = 0
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })
})
