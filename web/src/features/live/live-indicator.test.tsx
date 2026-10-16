import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
import { violations } from "@/test/axe"
import { FakeWebSocket, hello } from "@/test/live"
import { revenueModule, structure } from "@/test/structure"
import { numberCell, salesLineItemId, salesView, serveViewQuery } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import { LiveIndicator } from "./live-indicator"
import { LiveStatusContext } from "./live-status"
import type { LiveStatus } from "./use-model-live"

vi.mock("@/features/grid/measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const modulePath = `/m/${model.id}/modules/${revenueModule.id}`

function indicatorIn(status: LiveStatus | undefined) {
  return render(
    <LiveStatusContext value={status}>
      <LiveIndicator />
    </LiveStatusContext>,
  )
}

const STATUSES: [LiveStatus, string][] = [
  ["connecting", "Connecting…"],
  ["live", "Live updates on"],
  ["reconnecting", "Reconnecting…"],
  ["off", "Live updates off"],
]

describe("the live indicator", () => {
  it.each(STATUSES)(
    "says %s as “%s”, to a screen reader and to a pointer",
    async (status, label) => {
      const typist = userEvent.setup()
      indicatorIn(status)

      const mark = screen.getByRole("img", { name: label })
      await typist.hover(mark)

      expect(await screen.findByRole("tooltip")).toHaveTextContent(label)
    },
  )

  it("can be reached with the keyboard, which shows what it says", async () => {
    const typist = userEvent.setup()
    indicatorIn("reconnecting")

    await typist.tab()

    expect(screen.getByRole("img", { name: "Reconnecting…" })).toHaveFocus()
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Reconnecting…")
  })

  it("tells the four states apart by their shape, with no colour and no motion", () => {
    const shapes = STATUSES.map(([status]) => {
      const { container, unmount } = indicatorIn(status)
      const glyph = container.querySelector("svg")
      const shape = glyph ? [...glyph.classList].find((name) => name.startsWith("lucide-")) : "dot"
      unmount()
      return shape
    })

    expect(shapes.every(Boolean)).toBe(true)
    expect(new Set(shapes).size).toBe(4)
  })

  it("stops moving when motion is reduced", () => {
    for (const [status] of STATUSES) {
      const { container, unmount } = indicatorIn(status)
      for (const moving of container.querySelectorAll("[class*='animate-']")) {
        expect(moving).toHaveClass("motion-reduce:animate-none")
      }
      unmount()
    }
  })

  it("shows nothing outside a model's layout", () => {
    const { container } = indicatorIn(undefined)

    expect(container).toBeEmptyDOMElement()
  })

  it("has no accessibility violations in any state", async () => {
    for (const [status] of STATUSES) {
      const { container, unmount } = indicatorIn(status)
      expect(await violations({ context: container, ignore: ["region"] })).toEqual([])
      unmount()
    }
  })
})

describe("what the indicator tells a screen reader", () => {
  function followed(first: LiveStatus) {
    const view = indicatorIn(first)
    return {
      become: (status: LiveStatus) =>
        view.rerender(
          <LiveStatusContext value={status}>
            <LiveIndicator />
          </LiveStatusContext>,
        ),
    }
  }
  const said = () => screen.getByRole("status")

  it("says nothing of the first connection, nor of the screen opening when it is live", () => {
    const { become } = followed("connecting")
    expect(said()).toBeEmptyDOMElement()

    become("live")
    expect(said()).toBeEmptyDOMElement()
    indicatorIn("live")
    expect(screen.getAllByRole("status").at(-1)).toBeEmptyDOMElement()
  })

  it("says when the connection is lost, when it is back, and when it is given up", () => {
    const { become } = followed("live")

    become("reconnecting")
    expect(said()).toHaveTextContent("Reconnecting…")
    become("live")
    expect(said()).toHaveTextContent("Live updates on")
    become("off")
    expect(said()).toHaveTextContent("Live updates off")
  })

  it("says when the first connection fails, and when it comes after that", () => {
    const { become } = followed("connecting")

    become("reconnecting")
    expect(said()).toHaveTextContent("Reconnecting…")
    become("live")
    expect(said()).toHaveTextContent("Live updates on")
  })

  it("is a polite announcement", () => {
    indicatorIn("live")

    expect(said()).toHaveAttribute("role", "status")
  })
})

describe("a module's screen", () => {
  beforeEach(() => {
    mockViewport(900, 500)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function openModule() {
    mockSession()
    serveModels([model])
    serveStructure(structure)
    const served = serveViewQuery(salesView({ cell: () => numberCell(111) }))
    return { served, ...renderApp(modulePath) }
  }

  const shows = (value: string) => within(screen.getByRole("main")).findAllByText(value)

  /** The grid has asked for the blocks it wants (the first, and those next to it) and has them. */
  async function loaded(served: { requests: unknown[] }, queryClient: { isFetching(): number }) {
    await waitFor(() => expect(served.requests).toHaveLength(4))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  }

  it("follows the model live, and says so in its header", async () => {
    openModule()

    const page = within(await screen.findByRole("main"))
    expect(await page.findByRole("img", { name: "Connecting…" })).toBeVisible()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    expect(FakeWebSocket.last.url).toContain(`/api/v1/models/${model.id}/live?ticket=ticket-`)

    act(() => FakeWebSocket.last.receive(hello(1)))
    expect(await page.findByRole("img", { name: "Live updates on" })).toBeVisible()

    act(() => FakeWebSocket.last.drop())
    expect(await page.findByRole("img", { name: "Reconnecting…" })).toBeVisible()
    expect(page.getByText("Reconnecting…", { selector: "[role=status]" })).toBeInTheDocument()
  })

  it("shows what another user changed, without a reload", async () => {
    const { served, queryClient } = openModule()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    act(() => FakeWebSocket.last.receive(hello(1)))
    expect((await shows("111")).length).toBeGreaterThan(0)
    await loaded(served, queryClient)
    const asked = served.requests.length

    served.fixture = salesView({ cell: () => numberCell(222) })
    act(() =>
      FakeWebSocket.last.receive({
        type: "cells_changed",
        seq: 2,
        line_item_ids: [salesLineItemId(3)],
        user_id: "someone",
      }),
    )

    expect((await shows("222")).length).toBeGreaterThan(0)
    expect(served.requests.length).toBeGreaterThan(asked)
  })

  it("leaves the grid alone when the change is to a line item it does not show", async () => {
    const { served, queryClient } = openModule()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    act(() => FakeWebSocket.last.receive(hello(1)))
    await shows("111")
    await loaded(served, queryClient)
    const asked = served.requests.length
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    act(() =>
      FakeWebSocket.last.receive({
        type: "cells_changed",
        seq: 2,
        line_item_ids: ["another-line-item"],
        user_id: "someone",
      }),
    )
    // The messages are read after a moment; a view that was to be read again is being read then.
    await waitFor(() => expect(invalidate).toHaveBeenCalled())

    expect(queryClient.isFetching()).toBe(0)
    expect(served.requests).toHaveLength(asked)
  })

  it("says the live updates are off when the model is no longer there to follow", async () => {
    openModule()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    act(() => FakeWebSocket.last.receive(hello(1)))
    expect(await screen.findByRole("img", { name: "Live updates on" })).toBeVisible()

    act(() => FakeWebSocket.last.drop(4404))

    expect(await screen.findByRole("img", { name: "Live updates off" })).toBeVisible()
    expect(FakeWebSocket.sockets).toHaveLength(1)
  })
})
