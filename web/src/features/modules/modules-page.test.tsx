import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import {
  headcountModule,
  makeStructure,
  pricingModule,
  revenueModule,
  structure,
} from "@/test/structure"

const model = makeModel({ name: "Revenue plan" })
const structureUrl = `/api/v1/models/${model.id}/structure`

function openApp(modelStructure = structure) {
  mockSession()
  serveModels([model])
  serveStructure(modelStructure)
  return renderApp(`/m/${model.id}/modules`)
}

function namesIn(table: HTMLElement) {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent)
}

describe("the modules page", () => {
  it("titles the page", async () => {
    openApp()

    expect(await screen.findByRole("heading", { level: 1, name: "Modules" })).toBeVisible()
    expect(document.title).toBe("Modules · OpenPlan")
  })

  it("lists the modules in a table for each functional area, the ones outside any first", async () => {
    openApp()

    const headings = await screen.findAllByRole("heading", { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "No functional area",
      "Finance",
      "People",
    ])
    expect(namesIn(screen.getByRole("table", { name: "No functional area" }))).toEqual([
      "Pricing",
      "Headcount",
    ])
    expect(namesIn(screen.getByRole("table", { name: "Finance" }))).toEqual(["Revenue", "Costs"])
    expect(namesIn(screen.getByRole("table", { name: "People" }))).toEqual(["Hiring plan"])
  })

  it("needs no headings when no module has a functional area", async () => {
    openApp(makeStructure({ lists: structure.lists, modules: [pricingModule, headcountModule] }))

    const table = await screen.findByRole("table", { name: "Modules" })
    expect(namesIn(table)).toEqual(["Pricing", "Headcount"])
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument()
  })

  it("links each module to its page", async () => {
    openApp()

    expect(await screen.findByRole("link", { name: "Revenue" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules/${revenueModule.id}`,
    )
  })

  it("shows the dimensions of a module and how many line items it has", async () => {
    openApp()

    const row = within(await screen.findByRole("row", { name: /^Revenue/ }))
    for (const dimension of ["Regions", "Products", "Time (Month)", "Versions"]) {
      expect(row.getByText(dimension)).toBeVisible()
    }
    expect(row.getAllByRole("cell")[2]).toHaveTextContent("2")
    expect(
      within(screen.getByRole("row", { name: /^Headcount/ })).getAllByRole("cell")[2],
    ).toHaveTextContent("0")
  })

  it("shows placeholders while the modules load", async () => {
    mockSession()
    serveModels([model])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get(structureUrl, async () => {
        await gate
        return HttpResponse.json(structure)
      }),
    )
    renderApp(`/m/${model.id}/modules`)

    const page = await screen.findByRole("heading", { level: 1, name: "Modules" })
    expect(page).toBeVisible()
    const loading = await screen.findAllByRole("status", { name: "Loading modules" })
    expect(loading.length).toBeGreaterThan(0)
    release()

    expect(await screen.findByRole("link", { name: "Revenue" })).toBeVisible()
  })

  it("says so and offers a retry when the modules cannot be loaded", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    server.use(
      http.get(structureUrl, () => problem(500, "internal", "The database is starting up.")),
    )
    renderApp(`/m/${model.id}/modules`)
    const page = within(await screen.findByRole("main"))
    expect(await page.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveStructure(structure)
    await typist.click(page.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("table", { name: "Finance" })).toBeVisible()
  })

  it("says there are none yet", async () => {
    openApp(makeStructure())

    expect(await screen.findByRole("heading", { level: 2, name: "No modules yet" })).toBeVisible()
    expect(screen.getByText("Modules hold the line items you plan with.")).toBeVisible()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})
