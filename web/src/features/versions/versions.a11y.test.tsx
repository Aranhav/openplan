import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { violations } from "@/test/axe"
import { actualId, forecastId, makeStructure } from "@/test/structure"
import { serveStructureStore } from "@/test/structure-edits"

const model = makeModel()
const structure = makeStructure({
  versions: [
    { id: actualId, name: "Actual", is_actual: true, is_current: false },
    { id: forecastId, name: "Forecast", is_actual: false, is_current: true, switchover: 3 },
  ],
})

function openVersions({
  role = "admin",
  mode = "dev",
}: { role?: "admin" | "viewer"; mode?: "dev" | "prod" } = {}) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  serveStructureStore(structure)
  renderApp(`/m/${model.id}/versions`)
}

describe("the versions page", () => {
  it.each([
    ["for a builder", { role: "admin" }],
    ["for a viewer", { role: "viewer" }],
    ["of a production model", { mode: "prod" }],
  ] as const)("has no accessibility violations %s", async (_, options) => {
    openVersions(options)
    await screen.findByRole("table", { name: "Versions" })

    expect(await violations()).toEqual([])
  })

  it("has none while a name is being edited", async () => {
    const typist = userEvent.setup()
    openVersions()
    await typist.click(await screen.findByRole("button", { name: "Rename Forecast" }))
    await screen.findByRole("textbox", { name: "Name of Forecast" })

    expect(await violations()).toEqual([])
  })

  it("has none with the dialog that adds a version open", async () => {
    const typist = userEvent.setup()
    openVersions()
    await typist.click(await screen.findByRole("button", { name: "Add version" }))
    await screen.findByRole("dialog", { name: "Add version" })

    expect(await violations()).toEqual([])
  })
})
