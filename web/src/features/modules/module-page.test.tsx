import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { makeModel, mockSession, renderApp, serveModels, serveStructure } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import {
  makeStructure,
  revenueAmount,
  revenueModule,
  structure,
  unitPrice,
  unitsSold,
} from "@/test/structure"

const model = makeModel({ name: "Revenue plan" })
const structureUrl = `/api/v1/models/${model.id}/structure`

function openApp(path: string, modelStructure = structure) {
  mockSession()
  serveModels([model])
  serveStructure(modelStructure)
  return renderApp(path)
}

const revenuePath = `/m/${model.id}/modules/${revenueModule.id}`

describe("a module's page", () => {
  it("names the module, its functional area and its dimensions", async () => {
    openApp(revenuePath)

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
    const header = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement
    expect(within(header).getByText("Finance")).toBeVisible()
    expect(header).toHaveTextContent("Functional area: Finance")
    for (const dimension of ["Regions", "Products", "Time (Month)", "Versions"]) {
      expect(within(header).getByText(dimension)).toBeVisible()
    }
    expect(document.title).toBe("Revenue · OpenPlan")
  })

  it("lists the line items of the module, and only those, with their format and formula", async () => {
    openApp(revenuePath)

    const table = await screen.findByRole("table", { name: "Line items" })
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      )
    expect(rows).toEqual([
      [unitsSold.name, "Number", "Input"],
      [revenueAmount.name, "Currency (USD)", revenueAmount.formula],
    ])
    expect(within(table).queryByText(unitPrice.name)).not.toBeInTheDocument()
  })

  it("marks the line item named in the address", async () => {
    openApp(`${revenuePath}?tab=blueprint&li=${revenueAmount.id}`)

    const row = await screen.findByRole("row", { name: new RegExp(`^${revenueAmount.name}`) })
    expect(row).toHaveAttribute("data-state", "selected")
    expect(row).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("row", { name: new RegExp(`^${unitsSold.name}`) })).not.toHaveAttribute(
      "aria-current",
    )
  })

  it("ignores a line item that is not in the module", async () => {
    openApp(`${revenuePath}?li=${unitPrice.id}`)

    await screen.findByRole("table", { name: "Line items" })
    expect(document.querySelector("[aria-current=true]")).toBeNull()
  })

  it("says so when the module has no line items", async () => {
    openApp(revenuePath, makeStructure({ ...structure, line_items: [] }))

    expect(
      await screen.findByRole("heading", { level: 2, name: "No line items yet" }),
    ).toBeVisible()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("says so when the module is gone", async () => {
    openApp(`/m/${model.id}/modules/0192f3a0-0000-7000-8000-0000000000ff`)

    expect(await screen.findByRole("heading", { level: 1, name: "Module not found" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Back to modules" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules`,
    )
    expect(document.title).toBe("Module not found · OpenPlan")
  })

  it("shows a placeholder while the structure loads", async () => {
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
    renderApp(revenuePath)

    await screen.findAllByRole("status", { name: "Loading module" })
    release()

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
  })

  it("says so and offers a retry when the structure cannot be loaded", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    server.use(
      http.get(structureUrl, () => problem(500, "internal", "The database is starting up.")),
    )
    renderApp(revenuePath)
    const page = within(await screen.findByRole("main"))
    expect(await page.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveStructure(structure)
    await typist.click(page.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
  })
})
