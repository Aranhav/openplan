import { act, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  makeModel,
  mockSession,
  renderApp,
  serveModels,
  serveStructure,
  workspace,
} from "@/test/app"
import { FakeWebSocket } from "@/test/live"
import { structure } from "@/test/structure"

const model = makeModel({ name: "Revenue plan" })

function openApp(path: string) {
  mockSession()
  serveModels([model])
  serveStructure(structure)
  return renderApp(path)
}

describe("a model's address", () => {
  it("opens the modules of the model", async () => {
    const { router } = openApp(`/m/${model.id}`)

    expect(await screen.findByRole("heading", { level: 1, name: "Modules" })).toBeVisible()
    expect(router.state.location.pathname).toBe(`/m/${model.id}/modules`)
  })

  it("replaces itself in the history, so Back does not return to a page that only redirects", async () => {
    const { router } = openApp(`/w/${workspace.id}`)
    await screen.findByRole("heading", { level: 1, name: "Models" })
    await act(() => router.navigate({ to: "/m/$modelId", params: { modelId: model.id } }))
    await screen.findByRole("heading", { level: 1, name: "Modules" })

    act(() => router.history.back())

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}`))
  })

  it("keeps the other pages of the model where they are", async () => {
    const { router } = openApp(`/m/${model.id}/settings`)
    await screen.findByRole("heading", { level: 1, name: "Revenue plan" })

    expect(router.state.location.pathname).toBe(`/m/${model.id}/settings`)
  })
})

describe("the model settings", () => {
  it("show the model page", async () => {
    openApp(`/m/${model.id}/settings`)

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue plan" })).toBeVisible()
    const settings = await screen.findByText("Model settings", {
      selector: "[data-slot=card-title]",
    })
    const card = within(settings.closest("[data-slot=card]") as HTMLElement)
    expect(card.getByLabelText("Name")).toHaveValue("Revenue plan")
  })
})

describe("a model that is gone", () => {
  it.each(["modules", "settings"])("is reported on its %s page", async (page) => {
    mockSession()
    serveModels([])
    renderApp(`/m/${model.id}/${page}`)

    expect(await screen.findByRole("heading", { level: 1, name: "Model not found" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Back to models" })).toBeVisible()
  })
})

describe("following the model live", () => {
  it("keeps one socket open for all the model's screens, and closes it when they are left", async () => {
    const { router } = openApp(`/m/${model.id}/modules`)
    await screen.findByRole("heading", { level: 1, name: "Modules" })
    await waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1))
    expect(FakeWebSocket.last.url).toContain(`/api/v1/models/${model.id}/live?ticket=`)

    await act(() => router.navigate({ to: "/m/$modelId/settings", params: { modelId: model.id } }))
    await screen.findByRole("heading", { level: 1, name: "Revenue plan" })
    expect(FakeWebSocket.sockets).toHaveLength(1)
    expect(FakeWebSocket.last.closedWith).toBeUndefined()

    await act(() =>
      router.navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } }),
    )
    await screen.findByRole("heading", { level: 1, name: "Models" })
    expect(FakeWebSocket.last.closedWith).toBe(1000)
  })

  it("follows no model that is gone", async () => {
    mockSession()
    serveModels([])
    renderApp(`/m/${model.id}/modules`)

    await screen.findByRole("heading", { level: 1, name: "Model not found" })

    expect(FakeWebSocket.sockets.every((socket) => socket.closedWith !== undefined)).toBe(true)
  })
})
