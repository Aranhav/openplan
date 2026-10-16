import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { serveModuleStore } from "@/test/module-edits"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import {
  headcountModule,
  makeStructure,
  pricingModule,
  productsId,
  regionsId,
  revenueModule,
  structure,
} from "@/test/structure"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const structureUrl = `/api/v1/models/${model.id}/structure`
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

type Typist = ReturnType<typeof userEvent.setup>

function openApp(
  modelStructure: StructureDto = structure,
  {
    role = "admin",
    mode = "dev",
  }: { role?: components["schemas"]["WorkspaceRole"]; mode?: "dev" | "prod" } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveModuleStore(modelStructure)
  const app = renderApp(`/m/${model.id}/modules`)
  return { store, ...app }
}

function namesIn(table: HTMLElement) {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent)
}

function itemTexts(list: HTMLElement) {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent)
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
      "No functional area2 modules",
      "Finance2 modules",
      "People1 module",
    ])
    expect(namesIn(screen.getByRole("table", { name: "No functional area" }))).toEqual([
      "Pricing",
      "Headcount",
    ])
    expect(namesIn(screen.getByRole("table", { name: "Finance" }))).toEqual(["Revenue", "Costs"])
    expect(namesIn(screen.getByRole("table", { name: "People" }))).toEqual(["Hiring plan"])
  })

  it("folds an area away under its name and brings it back", async () => {
    const typist = userEvent.setup()
    openApp()
    const page = within(await screen.findByRole("main"))
    const finance = await page.findByRole("button", { name: /^Finance/ })
    expect(finance).toHaveAttribute("aria-expanded", "true")

    await typist.click(finance)

    expect(finance).toHaveAttribute("aria-expanded", "false")
    expect(page.queryByRole("table", { name: "Finance" })).not.toBeInTheDocument()
    expect(page.getByRole("table", { name: "People" })).toBeVisible()
    await typist.click(finance)
    expect(await page.findByRole("table", { name: "Finance" })).toBeVisible()
  })

  it("needs no headings when no module has a functional area", async () => {
    openApp(makeStructure({ lists: structure.lists, modules: [pricingModule, headcountModule] }))

    const table = await screen.findByRole("table", { name: "Modules" })
    expect(namesIn(table)).toEqual(["Pricing", "Headcount"])
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument()
  })

  it("links each module to its page", async () => {
    openApp()

    const page = within(await screen.findByRole("main"))
    expect(await page.findByRole("link", { name: "Revenue" })).toHaveAttribute(
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
    await screen.findAllByRole("status", { name: "Loading modules" })
    release()

    expect(
      await within(screen.getByRole("main")).findByRole("link", { name: "Revenue" }),
    ).toBeVisible()
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
    serveModuleStore(structure)
    await typist.click(page.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("table", { name: "Finance" })).toBeVisible()
  })

  it("says there are none yet, and offers to create the first", async () => {
    openApp(makeStructure())

    expect(await screen.findByRole("heading", { level: 2, name: "No modules yet" })).toBeVisible()
    expect(screen.getByText("Modules hold the line items you plan with.")).toBeVisible()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "New module" })).toHaveLength(1)
  })
})

describe("creating a module", () => {
  async function openDialog(typist: Typist, modelStructure: StructureDto = structure) {
    const app = openApp(modelStructure)
    await typist.click(await screen.findByRole("button", { name: "New module" }))
    return { ...app, dialog: within(await screen.findByRole("dialog", { name: "New module" })) }
  }

  it("creates a module with its dimensions in the order chosen, and opens its Blueprint", async () => {
    const typist = userEvent.setup()
    const { store, router, dialog } = await openDialog(typist)

    await typist.type(dialog.getByLabelText("Name"), "Forecast")
    await typist.type(dialog.getByLabelText("Functional area"), "Planning")
    await typist.click(dialog.getByRole("checkbox", { name: /Products/ }))
    await typist.click(dialog.getByRole("checkbox", { name: /Regions/ }))
    const order = dialog.getByRole("list", { name: "Order of dimensions" })
    expect(itemTexts(order)).toEqual(["1Products", "2Regions"])
    await typist.click(dialog.getByRole("button", { name: "Move Regions up" }))
    expect(itemTexts(order)).toEqual(["1Regions", "2Products"])
    await typist.click(dialog.getByRole("switch", { name: "Time" }))
    await typist.click(dialog.getByRole("combobox", { name: "Time level" }))
    await typist.click(await screen.findByRole("option", { name: "Quarter" }))
    await typist.click(dialog.getByRole("switch", { name: "Versions" }))
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/modules\/[0-9a-f-]{36}$/))
    expect(router.state.location.search).toEqual({ tab: "blueprint" })
    expect(store.requests).toEqual([
      {
        action: "create module",
        body: {
          name: "Forecast",
          functional_area: "Planning",
          axes: [
            { kind: "list", list: regionsId },
            { kind: "list", list: productsId },
            { kind: "time", level: "quarter", range: null },
            { kind: "versions" },
          ],
        },
      },
    ])
    expect(await screen.findByRole("heading", { level: 1, name: "Forecast" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Blueprint" })).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByRole("heading", { name: "Add your first line item" })).toBeVisible()
  })

  it("creates a module with no dimensions and no functional area", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist)

    await typist.type(dialog.getByLabelText("Name"), "Notes")
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    await waitFor(() =>
      expect(store.requests[0]).toEqual({
        action: "create module",
        body: { name: "Notes", functional_area: null, axes: [] },
      }),
    )
  })

  it("offers the functional areas that exist, to fill the field with one", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)
    const areas = within(dialog.getByRole("group", { name: "Existing functional areas" }))

    expect(areas.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Finance",
      "People",
    ])
    await typist.click(areas.getByRole("button", { name: "People" }))

    expect(dialog.getByLabelText("Functional area")).toHaveValue("People")
    expect(areas.getByRole("button", { name: "People" })).toHaveAttribute("aria-pressed", "true")
    expect(areas.getByRole("button", { name: "Finance" })).toHaveAttribute("aria-pressed", "false")
  })

  it("takes a dimension back out and drops it from the order", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)

    await typist.click(dialog.getByRole("checkbox", { name: /Regions/ }))
    expect(dialog.getByRole("list", { name: "Order of dimensions" })).toBeVisible()
    await typist.click(dialog.getByRole("checkbox", { name: /Regions/ }))

    expect(dialog.queryByRole("list", { name: "Order of dimensions" })).toBeNull()
  })

  it("keeps focus on the button that moved a dimension, or on its twin at the end of the order", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)
    await typist.click(dialog.getByRole("checkbox", { name: /Regions/ }))
    await typist.click(dialog.getByRole("checkbox", { name: /Products/ }))

    await typist.click(dialog.getByRole("button", { name: "Move Regions down" }))
    expect(dialog.getByRole("button", { name: "Move Regions up" })).toHaveFocus()
    await typist.click(dialog.getByRole("button", { name: "Move Regions up" }))

    expect(dialog.getByRole("button", { name: "Move Regions down" })).toHaveFocus()
  })

  it("lets the time range be chosen once the model has some", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(
      typist,
      makeStructure({
        time_ranges: [{ id: "tr1", name: "Forecast years", first_year: 2027, years: 2 }],
      }),
    )

    await typist.type(dialog.getByLabelText("Name"), "Plan")
    await typist.click(dialog.getByRole("switch", { name: "Time" }))
    await typist.click(dialog.getByRole("combobox", { name: "Time range" }))
    await typist.click(await screen.findByRole("option", { name: "Forecast years" }))
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    await waitFor(() =>
      expect(store.requests[0].body).toMatchObject({
        axes: [{ kind: "time", level: "month", range: "tr1" }],
      }),
    )
  })

  it("explains that the model has no lists yet", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist, makeStructure())

    expect(dialog.getByText(/no lists yet/)).toBeVisible()
    expect(dialog.queryByRole("checkbox")).toBeNull()
  })

  it("asks for a name before it asks the server", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist)

    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    expect(await dialog.findByText("Name is required.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("shows a name that is taken under the name", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)

    await typist.type(dialog.getByLabelText("Name"), "Pricing")
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    expect(await dialog.findByText("That name is already in use.")).toBeVisible()
    expect(screen.getByRole("dialog", { name: "New module" })).toBeVisible()
  })

  it("shows a refusal of the dimensions under them", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)
    server.use(
      http.post("/api/v1/models/:id/modules", () =>
        problem(422, "structure.invalid", "A module can have only one Time dimension."),
      ),
    )

    await typist.type(dialog.getByLabelText("Name"), "Plan")
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "A module can have only one Time dimension.",
    )
  })

  it("holds the dialog open and the button busy while the module is created", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/models/:id/modules", async () => {
        await gate
        return problem(500, "internal", "Try again later.")
      }),
    )

    await typist.type(dialog.getByLabelText("Name"), "Plan")
    await typist.click(dialog.getByRole("button", { name: "Create module" }))

    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Create module" })).toBeDisabled(),
    )
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "New module" })).toBeVisible()
    release()
  })

  it("starts empty each time it opens", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)
    await typist.type(dialog.getByLabelText("Name"), "Draft")
    await typist.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await typist.click(screen.getByRole("button", { name: "New module" }))

    expect(await screen.findByLabelText("Name")).toHaveValue("")
  })

  it("brings focus back to the button that opened it", async () => {
    const typist = userEvent.setup()
    await openDialog(typist)

    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.getByRole("button", { name: "New module" })).toHaveFocus())
  })
})

describe("who may create modules", () => {
  it("shows planners and viewers the modules and no button", async () => {
    openApp(structure, { role: "planner" })

    expect(await screen.findByRole("table", { name: "Finance" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "New module" })).toBeNull()
  })

  it("shows a viewer of an empty model no button either", async () => {
    openApp(makeStructure(), { role: "viewer" })

    expect(await screen.findByRole("heading", { name: "No modules yet" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "New module" })).toBeNull()
  })

  it("keeps the button on screen but off in production mode, and says why", async () => {
    const typist = userEvent.setup()
    openApp(structure, { mode: "prod" })

    const button = await screen.findByRole("button", { name: "New module" })
    expect(button).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent(PRODUCTION_MESSAGE)
    await typist.hover(button.parentElement as HTMLElement)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
  })
})
