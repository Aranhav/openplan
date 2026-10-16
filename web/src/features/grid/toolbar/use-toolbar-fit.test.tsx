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

/**
 * How wide the row is, how wide each of its two fixed parts is, and how wide each selector in the
 * page group is (there are as many as `selectors`). jsdom has no layout, so the test says.
 */
const sizes = { row: 1000, fixed: 250, selector: 150, selectors: 2 }

function Toolbar() {
  const row = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const compact = useToolbarFit(row, pages)
  return (
    <div ref={row} data-role="row">
      <div data-role="fixed" />
      <div ref={pages} data-role="pages">
        {Array.from({ length: sizes.selectors }, (_, index) => (
          <div key={index} data-role="selector" />
        ))}
      </div>
      <div data-role="fixed" />
      <p>{compact ? "compact" : "wide"}</p>
    </div>
  )
}

const realObserver = globalThis.ResizeObserver

beforeEach(() => {
  FakeResizeObserver.callbacks = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  Object.assign(sizes, { row: 1000, fixed: 250, selector: 150, selectors: 2 })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = (() => {
      switch (this.getAttribute("data-role")) {
        case "row":
          return sizes.row
        case "fixed":
          return sizes.fixed
        case "selector":
          return sizes.selector
        default:
          return 0
      }
    })()
    return { width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) }
  })
})

afterEach(() => {
  globalThis.ResizeObserver = realObserver
  vi.restoreAllMocks()
})

/** The row changed size: the observer says so, and the toolbar looks again. */
function resize(row: number) {
  act(() => {
    sizes.row = row
    for (const callback of FakeResizeObserver.callbacks) {
      callback()
    }
  })
}

describe("useToolbarFit", () => {
  it("is wide while everything fits on the row", () => {
    // 250 + 250 + 2 * 150 = 800 of 1000.
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })

  it("is wide when everything fits exactly", () => {
    sizes.row = 800
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })

  it("is compact once the row has more in it than room, and the selectors are what is long", () => {
    sizes.selector = 300
    render(<Toolbar />)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("is compact when the fixed controls alone are too wide, for a view with no page selectors", () => {
    Object.assign(sizes, { selectors: 0, fixed: 400, row: 700 })
    render(<Toolbar />)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("is wide for a view with no page selectors when the row has room for the rest", () => {
    Object.assign(sizes, { selectors: 0, fixed: 400, row: 800 })
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })

  // The width of the content column beside a 256 px sidebar and 48 px of padding, and of the
  // whole screen where the sidebar is off-canvas.
  describe.each([
    ["with page selectors", { selectors: 2, selector: 160, fixed: 290 }],
    ["with no page selectors", { selectors: 0, selector: 0, fixed: 290 }],
  ] as const)("on a screen, %s", (_, setup) => {
    const room = (screen: number) => (screen >= 768 ? screen - 304 : screen - 48)
    // With selectors the row needs 2 * 290 + 2 * 160 = 900; without, 580.
    const need = setup.selectors === 0 ? 580 : 900

    it.each([1280, 1100, 900, 768, 375])("is wide or compact by whether the row has the room, at %i px", (width) => {
      Object.assign(sizes, setup, { row: room(width) })
      render(<Toolbar />)

      expect(screen.getByText(room(width) >= need ? "wide" : "compact")).toBeVisible()
    })
  })

  it("is wide again once the row is clearly wider than the wide layout needed, and not before", () => {
    sizes.selector = 300
    render(<Toolbar />)
    expect(screen.getByText("compact")).toBeVisible()

    // The wide layout needed 1100. The row grows, but not by enough.
    resize(1130)
    expect(screen.getByText("compact")).toBeVisible()

    resize(1132)
    expect(screen.getByText("wide")).toBeVisible()
  })

  it("stays compact when the row grows by the width of a scrollbar, which an open menu takes away", () => {
    sizes.selector = 310
    render(<Toolbar />)
    expect(screen.getByText("compact")).toBeVisible()

    // The wide layout needed 1120; the row was 1000, and a scrollbar is 15 px.
    resize(1015)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("counts the margins of the items, such as the separators have", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          display: "block",
          columnGap: "",
          marginLeft: element.getAttribute("data-role") === "fixed" ? "4px" : "0px",
          marginRight: element.getAttribute("data-role") === "fixed" ? "4px" : "0px",
        }) as CSSStyleDeclaration,
    )
    // 2 * (250 + 8) + 2 * 150 = 816.
    sizes.row = 810
    const { unmount } = render(<Toolbar />)
    expect(screen.getByText("compact")).toBeVisible()
    unmount()

    sizes.row = 816
    render(<Toolbar />)
    expect(screen.getByText("wide")).toBeVisible()
  })

  it("counts the gaps between the items, and none for an item that is not displayed", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          display: element.getAttribute("data-role") === "selector" && sizes.selectors > 1 ? "none" : "block",
          columnGap: "10px",
          marginLeft: "0px",
          marginRight: "0px",
        }) as CSSStyleDeclaration,
    )
    // The selectors are not displayed. The row has four items, which are the two fixed ones of 250,
    // the group of no width and the label, so 500 and three gaps of 10.
    sizes.row = 529
    const { unmount } = render(<Toolbar />)
    expect(screen.getByText("compact")).toBeVisible()
    unmount()

    sizes.row = 530
    render(<Toolbar />)
    expect(screen.getByText("wide")).toBeVisible()
  })

  it("looks again when something in the row changes, though the row is no different", async () => {
    render(<Toolbar />)
    expect(screen.getByText("wide")).toBeVisible()

    // The selectors have their members: they are wider than the skeletons they replace were.
    sizes.selector = 300
    await act(async () => {
      document.querySelector("[data-role=pages]")?.appendChild(document.createElement("div"))
      await Promise.resolve()
    })

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("goes compact when the row shrinks until everything no longer fits", () => {
    render(<Toolbar />)
    expect(screen.getByText("wide")).toBeVisible()

    resize(790)

    expect(screen.getByText("compact")).toBeVisible()
  })

  it("is wide in a row that has no layout", () => {
    Object.assign(sizes, { row: 0 })
    render(<Toolbar />)

    expect(screen.getByText("wide")).toBeVisible()
  })
})
