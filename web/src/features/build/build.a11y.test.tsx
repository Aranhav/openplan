import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
import { violations } from "@/test/axe"
import { revenueModule, structure } from "@/test/structure"

const model = makeModel()

describe("the model screens", () => {
  it.each([
    ["the modules", `/m/${model.id}/modules`, "Modules"],
    ["a module", `/m/${model.id}/modules/${revenueModule.id}`, "Revenue"],
    ["the settings", `/m/${model.id}/settings`, model.name],
  ])("have no accessibility violations: %s", async (_, path, title) => {
    mockSession()
    serveModels([model])
    serveStructure(structure)
    renderApp(path)
    await screen.findByRole("heading", { level: 1, name: title })
    await screen.findAllByRole("link", { name: "Pricing" })

    expect(await violations()).toEqual([])
  })
})
