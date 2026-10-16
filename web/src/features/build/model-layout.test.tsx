import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
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
    const { router } = openApp(`/m/${model.id}`)
    await screen.findByRole("heading", { level: 1, name: "Modules" })

    expect(router.history.length).toBe(1)
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
