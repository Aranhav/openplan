import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { violations } from "@/test/axe"
import { makeStructure } from "@/test/structure"
import { serveStructureStore } from "@/test/structure-edits"

const model = makeModel()
const structure = makeStructure({
  time_ranges: [
    {
      id: "0192f3a0-0000-7000-8000-000000000501",
      name: "Forecast years",
      first_year: 2027,
      years: 2,
    },
  ],
})

function openTime({
  role = "admin",
  mode = "dev",
}: { role?: "admin" | "viewer"; mode?: "dev" | "prod" } = {}) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  serveStructureStore(structure)
  renderApp(`/m/${model.id}/time`)
}

describe("the time page", () => {
  it.each([
    ["for a builder", { role: "admin" }],
    ["for a viewer", { role: "viewer" }],
    ["of a production model", { mode: "prod" }],
  ] as const)("has no accessibility violations %s", async (_, options) => {
    openTime(options)
    await screen.findByRole("table", { name: "Timeline preview" })

    expect(await violations()).toEqual([])
  })

  it("has none with the dialog that confirms a change of timeline open", async () => {
    const typist = userEvent.setup()
    openTime()
    const heading = await screen.findByRole("heading", { level: 2, name: "Calendar" })
    const calendar = within(heading.closest("[data-slot=card]") as HTMLElement)
    const years = calendar.getByRole("spinbutton", { name: "Years" })
    await typist.clear(years)
    await typist.type(years, "5")
    await typist.click(calendar.getByRole("button", { name: "Save changes" }))
    await screen.findByRole("alertdialog", { name: "Change the timeline?" })

    expect(await violations()).toEqual([])
  })

  it("has none with the dialog that adds a time range open", async () => {
    const typist = userEvent.setup()
    openTime()
    await typist.click(await screen.findByRole("button", { name: "Add time range" }))
    await screen.findByRole("dialog", { name: "Add time range" })

    expect(await violations()).toEqual([])
  })
})
