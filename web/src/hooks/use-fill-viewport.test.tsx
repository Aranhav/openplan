import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useFillViewport } from "./use-fill-viewport"

/** A ResizeObserver the test drives: what it watches, and a way to say that something changed size. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  watched: Element[] = []
  disconnected = false

  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }

  observe(element: Element) {
    this.watched.push(element)
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true
  }

  notify() {
    this.callback()
  }
}

/** Where the element is on the page, as the test moves it. */
const place = { top: 200, scrollY: 0 }

function Filler({ min = 300, bottom = 24 }: { min?: number; bottom?: number }) {
  const { ref, height } = useFillViewport(min, bottom)
  return (
    <div ref={ref} data-testid="filler" style={{ height }}>
      {height === undefined ? "unknown" : height}
    </div>
  )
}

function setWindowHeight(height: number) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true })
}

const realObserver = globalThis.ResizeObserver

beforeEach(() => {
  FakeResizeObserver.instances = []
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  place.top = 200
  place.scrollY = 0
  setWindowHeight(800)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ top: place.top - place.scrollY }) as DOMRect,
  )
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => place.scrollY)
})

afterEach(() => {
  globalThis.ResizeObserver = realObserver
  vi.restoreAllMocks()
})

const shown = () => screen.getByTestId("filler").textContent

describe("useFillViewport", () => {
  it("takes the room from the top of the element to the bottom of the window, less the padding", () => {
    render(<Filler />)

    expect(shown()).toBe(String(800 - 200 - 24))
  })

  it("measures from the top of the page, not of what is scrolled into view", () => {
    place.scrollY = 120
    render(<Filler />)

    expect(shown()).toBe(String(800 - 200 - 24))
  })

  it("is at least the least it was asked for, when there is no room", () => {
    place.top = 700
    render(<Filler min={300} />)

    expect(shown()).toBe("300")
  })

  it("follows the window growing and shrinking", () => {
    render(<Filler />)

    act(() => {
      setWindowHeight(1000)
      window.dispatchEvent(new Event("resize"))
    })
    expect(shown()).toBe(String(1000 - 200 - 24))

    act(() => {
      setWindowHeight(600)
      window.dispatchEvent(new Event("resize"))
    })
    expect(shown()).toBe(String(600 - 200 - 24))
  })

  it("follows what is above it growing, such as a notice or a title that wraps, and shrinking again", () => {
    render(<Filler />)
    const [observer] = FakeResizeObserver.instances

    act(() => {
      place.top = 260
      observer.notify()
    })
    expect(shown()).toBe(String(800 - 260 - 24))

    act(() => {
      place.top = 200
      observer.notify()
    })
    expect(shown()).toBe(String(800 - 200 - 24))
  })

  it("watches the page, and everything above the element in it, at every level", () => {
    render(
      <main>
        <header data-testid="header">Title</header>
        <section>
          <p data-testid="notice">Notice</p>
          <Filler />
          <p data-testid="below">Below</p>
        </section>
      </main>,
    )

    const watched = FakeResizeObserver.instances[0].watched
    expect(watched).toContain(document.body)
    expect(watched).toContain(screen.getByTestId("header"))
    expect(watched).toContain(screen.getByTestId("notice"))
    expect(watched).not.toContain(screen.getByTestId("below"))
  })

  it("grows into the room a notice leaves when it goes, which the page may not show by being shorter", () => {
    function Page({ notice }: { notice: boolean }) {
      return (
        <main>
          {notice && <p data-testid="notice">Notice</p>}
          <Filler />
        </main>
      )
    }
    place.top = 260
    const { rerender } = render(<Page notice />)
    expect(shown()).toBe(String(800 - 260 - 24))
    const [observer] = FakeResizeObserver.instances

    // The notice is removed: what was watched is gone, and the observer says so.
    rerender(<Page notice={false} />)
    act(() => {
      place.top = 200
      observer.notify()
    })

    expect(shown()).toBe(String(800 - 200 - 24))
  })

  it("is unknown until the element is on the page", () => {
    function Late() {
      const { height } = useFillViewport(300, 24)
      return <p>{height === undefined ? "unknown" : height}</p>
    }
    render(<Late />)

    expect(screen.getByText("unknown")).toBeVisible()
  })

  it("stops listening when the element goes", () => {
    const remove = vi.spyOn(window, "removeEventListener")
    const { unmount } = render(<Filler />)

    unmount()

    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function))
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true)
  })
})
