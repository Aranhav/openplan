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

describe("the live indicator", () => {
  it.each<[LiveStatus, string]>([
    ["live", "Live updates on"],
    ["reconnecting", "Reconnecting…"],
    ["off", "Live updates off"],
  ])("says %s as “%s”, to a screen reader and to a pointer", async (status, label) => {
    const typist = userEvent.setup()
    indicatorIn(status)

    const dot = screen.getByRole("img", { name: label })
    await typist.hover(dot)

    expect(await screen.findByRole("tooltip")).toHaveTextContent(label)
  })

  it("can be reached with the keyboard, which shows what it says", async () => {
    const typist = userEvent.setup()
    indicatorIn("reconnecting")

    await typist.tab()

    expect(screen.getByRole("img", { name: "Reconnecting…" })).toHaveFocus()
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Reconnecting…")
  })

  it("tells the three states apart by more than their colour", () => {
    const shapes = (["live", "reconnecting", "off"] as const).map((status) => {
      const { container, unmount } = indicatorIn(status)
      const dot = container.querySelector("[aria-hidden]")
      const shape = [dot?.className.includes("animate-pulse"), dot?.className.includes("border-2")]
      unmount()
      return shape.join()
    })

    expect(new Set(shapes).size).toBe(3)
  })

  it("shows nothing outside a model's layout", () => {
    const { container } = indicatorIn(undefined)

    expect(container).toBeEmptyDOMElement()
  })

  it("has no accessibility violations in any state", async () => {
    for (const status of ["live", "reconnecting", "off"] as const) {
      const { container, unmount } = indicatorIn(status)
      expect(await violations({ context: container, ignore: ["region"] })).toEqual([])
      unmount()
    }
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

  /** Waits until the grid has asked for all the blocks it wants, so that what follows is new. */
  async function loaded(served: { requests: unknown[] }) {
    let seen = -1
    while (served.requests.length !== seen) {
      seen = served.requests.length
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  it("follows the model live, and says so in its header", async () => {
    openModule()

    const page = within(await screen.findByRole("main"))
    expect(await page.findByRole("img", { name: "Reconnecting…" })).toBeVisible()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    expect(FakeWebSocket.last.url).toContain(`/api/v1/models/${model.id}/live?ticket=ticket-`)

    act(() => FakeWebSocket.last.receive(hello(1)))
    expect(await page.findByRole("img", { name: "Live updates on" })).toBeVisible()

    act(() => FakeWebSocket.last.drop())
    expect(await page.findByRole("img", { name: "Reconnecting…" })).toBeVisible()
  })

  it("shows what another user changed, without a reload", async () => {
    const { served } = openModule()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    act(() => FakeWebSocket.last.receive(hello(1)))
    expect((await shows("111")).length).toBeGreaterThan(0)
    await loaded(served)
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
    const { served } = openModule()
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    act(() => FakeWebSocket.last.receive(hello(1)))
    await shows("111")
    await loaded(served)
    const asked = served.requests.length

    act(() =>
      FakeWebSocket.last.receive({
        type: "cells_changed",
        seq: 2,
        line_item_ids: ["another-line-item"],
        user_id: "someone",
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

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
