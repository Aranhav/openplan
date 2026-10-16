import { screen } from "@testing-library/react"
import axe from "axe-core"
import { describe, expect, it } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
import { revenueModule, structure } from "@/test/structure"

const model = makeModel()

async function violations() {
  const results = await axe.run(document.body, {
    // jsdom has no layout, so contrast and anything that needs a size cannot be judged here.
    rules: { "color-contrast": { enabled: false } },
  })
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  )
}

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
