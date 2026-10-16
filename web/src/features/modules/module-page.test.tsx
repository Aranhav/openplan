import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { serveModuleStore } from "@/test/module-edits"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import {
  makeStructure,
  productsId,
  regionsId,
  revenueAmount,
  revenueModule,
  structure,
  unitsSold,
} from "@/test/structure"
import { formulaText } from "@/test/formula"
import {
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import type { ViewQuery } from "@/features/grid/view-types"
import { mockViewport } from "@/test/viewport"
import { spinning } from "@/test/spinning"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// jsdom has no canvas: every character is 8 px wide.
vi.mock("@/features/grid/measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const structureUrl = `/api/v1/models/${model.id}/structure`
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."
const revenuePath = `/m/${model.id}/modules/${revenueModule.id}`

type Typist = ReturnType<typeof userEvent.setup>

function openApp(
  path: string,
  modelStructure: StructureDto = structure,
  {
    role = "admin",
    mode = "dev",
  }: {
    role?: components["schemas"]["WorkspaceRole"]
    mode?: "dev" | "prod"
  } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveModuleStore(modelStructure)
  // After the store, which answers queries with no rows, so that the grid has some to show.
  const served = serveViewQuery()
  const app = renderApp(path)
  return { store, served, ...app }
}

/** The page's own content, without the sidebar and the header, which list the module too. */
async function page() {
  return within(await screen.findByRole("main"))
}

beforeEach(() => {
  mockViewport(900, 500)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a module's page", () => {
  it("names the module, its functional area and its dimensions", async () => {
    openApp(revenuePath)

    const content = await page()
    expect(await content.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
    const header = content.getByRole("heading", { level: 1 }).closest("div")
      ?.parentElement as HTMLElement
    expect(within(header).getByText("Finance")).toBeVisible()
    expect(header).toHaveTextContent("Functional area: Finance")
    for (const dimension of ["Regions", "Products", "Time (Month)", "Versions"]) {
      expect(within(header).getByText(dimension)).toBeVisible()
    }
    expect(document.title).toBe("Revenue · OpenPlan")
  })

  it("says so when the module is gone", async () => {
    openApp(`/m/${model.id}/modules/0192f3a0-0000-7000-8000-0000000000ff`)

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Module not found",
      }),
    ).toBeVisible()
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

    expect(
      await within(await screen.findByRole("main")).findByRole("heading", {
        level: 1,
        name: "Revenue",
      }),
    ).toBeVisible()
  })

  it("says so and offers a retry when the structure cannot be loaded", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    server.use(
      http.get(structureUrl, () => problem(500, "internal", "The database is starting up.")),
    )
    renderApp(revenuePath)
    const content = await page()
    expect(await content.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveModuleStore(structure)
    serveViewQuery()
    await typist.click(content.getByRole("button", { name: "Retry" }))

    expect(await content.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
  })
})

describe("the tabs", () => {
  it("opens on the grid", async () => {
    openApp(revenuePath)
    const content = await page()

    expect(await content.findByRole("tab", { name: "Grid" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(await content.findByRole("grid", { name: "Revenue grid" })).toBeVisible()
    expect(content.queryByRole("grid", { name: "Line items" })).toBeNull()
  })

  it("shows the Blueprint when the address says so", async () => {
    openApp(`${revenuePath}?tab=blueprint`)
    const content = await page()

    expect(await content.findByRole("tab", { name: "Blueprint" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(await content.findByRole("grid", { name: "Line items" })).toBeVisible()
    expect(content.queryByRole("grid", { name: "Revenue grid" })).toBeNull()
  })

  it("keeps the tab in the address", async () => {
    const typist = userEvent.setup()
    const { router } = openApp(`${revenuePath}?li=${unitsSold.id}`)
    const content = await page()

    await typist.click(await content.findByRole("tab", { name: "Blueprint" }))

    expect(router.state.location.search).toEqual({
      tab: "blueprint",
      li: unitsSold.id,
    })
    expect(await content.findByRole("grid", { name: "Line items" })).toBeVisible()
    await typist.click(content.getByRole("tab", { name: "Grid" }))
    expect(router.state.location.search).toEqual({
      tab: "grid",
      li: unitsSold.id,
    })
  })

  it("moves between the tabs with the arrow keys", async () => {
    const typist = userEvent.setup()
    openApp(revenuePath)
    const content = await page()

    ;(await content.findByRole("tab", { name: "Grid" })).focus()
    await typist.keyboard("{ArrowRight}")

    expect(content.getByRole("tab", { name: "Blueprint" })).toHaveAttribute("aria-selected", "true")
  })
})

describe("the grid tab", () => {
  it("shows the module in the grid, laid out as the default pivot", async () => {
    const { served } = openApp(revenuePath)

    expect(await (await page()).findByRole("grid", { name: "Revenue grid" })).toBeVisible()
    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    const query: ViewQuery = served.requests[0]
    expect(query).toMatchObject({
      module: revenueModule.id,
      rows: [{ kind: "line_items" }],
      columns: [{ kind: "time" }],
      pages: [
        { dim: { kind: "list", list: regionsId }, key: null },
        { dim: { kind: "list", list: productsId }, key: null },
        { dim: { kind: "versions" }, key: null },
      ],
    })
  })

  it("lets a viewer look but not enter values", async () => {
    openApp(revenuePath, structure, { role: "viewer" })

    expect(await (await page()).findByRole("grid", { name: "Revenue grid" })).toHaveAttribute(
      "aria-readonly",
      "true",
    )
  })

  it("lets a planner enter values", async () => {
    openApp(revenuePath, structure, { role: "planner" })

    const grid = await (await page()).findByRole("grid", { name: "Revenue grid" })
    expect(grid).not.toHaveAttribute("aria-readonly")
  })

  it("sends a module without line items to the Blueprint to add some", async () => {
    const typist = userEvent.setup()
    const { router } = openApp(revenuePath, makeStructure({ ...structure, line_items: [] }))
    const content = await page()

    expect(await content.findByRole("heading", { name: "No line items yet" })).toBeVisible()
    await typist.click(content.getByRole("button", { name: "Open Blueprint" }))

    expect(router.state.location.search).toEqual({ tab: "blueprint" })
    expect(await content.findByRole("heading", { name: "Add your first line item" })).toBeVisible()
  })
})

describe("the formula bar in the grid tab", () => {
  /** The line items of Revenue down the rows, and three months across. */
  const revenueView = salesView({
    rowDims: [lineItemsDim],
    columnDims: [{ kind: "time" }],
    totalRows: 2,
    totalColumns: 3,
    lineItems: [unitsSold, revenueAmount].map((item) => lineItem(item.id, item.name)),
    rowHeader: (row) => {
      const item = [unitsSold, revenueAmount][row]
      return header(member(item.id, item.name))
    },
    columnHeader: (col) => header(member(`m${col}`, `Month ${col + 1}`)),
    cell: () => numberCell(1),
  })

  it("shows the formula of the line item of the active cell, and follows the active cell", async () => {
    const typist = userEvent.setup()
    const { served } = openApp(revenuePath)
    served.fixture = revenueView
    const content = await page()

    const grid = await content.findByRole("grid", { name: "Revenue grid" })
    const first = await content.findByRole("textbox", { name: "Formula of Units sold" })
    expect(formulaText(first)).toBe("")

    const secondRow = grid.querySelector<HTMLElement>("[data-row='1'][data-col='0']")
    expect(secondRow).not.toBeNull()
    await typist.click(secondRow as HTMLElement)

    const second = await content.findByRole("textbox", { name: "Formula of Revenue amount" })
    expect(formulaText(second)).toBe("Units sold * Pricing.Unit price")
  })

  it("lets a planner read the formula but not change it", async () => {
    const { served } = openApp(revenuePath, structure, { role: "planner" })
    served.fixture = revenueView
    const content = await page()

    const formula = await content.findByRole("textbox", { name: "Formula of Units sold" })
    expect(formula).toHaveAttribute("aria-readonly", "true")
  })
})

describe("renaming a module in its title", () => {
  /**
   * The title once the rename is over. While the input is open a hidden heading says the name too,
   * and it shows the new one before the title does: a heading found by `findByRole` can be that one,
   * which the title then replaces, so the test waits for the input to be gone.
   */
  async function renamedTo(content: ReturnType<typeof within>, name: string) {
    await waitFor(() => {
      expect(content.queryByRole("textbox", { name: "Module name" })).toBeNull()
      expect(content.getByRole("heading", { level: 1, name })).toBeVisible()
    })
  }

  async function startRename(typist: Typist, path = revenuePath) {
    const app = openApp(path)
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Rename module" }))
    return {
      ...app,
      content,
      input: await content.findByRole("textbox", { name: "Module name" }),
    }
  }

  it("turns the title into an input that Enter saves", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)
    expect(input).toHaveValue("Revenue")
    expect(input).toHaveFocus()

    await typist.clear(input)
    await typist.type(input, "Sales{Enter}")

    await renamedTo(content, "Sales")
    expect(store.requests).toEqual([
      {
        action: "update module",
        id: revenueModule.id,
        body: { name: "Sales" },
      },
    ])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Module renamed"))
    expect(content.getByRole("button", { name: "Rename module" })).toHaveFocus()
    expect(document.title).toBe("Sales · OpenPlan")
  })

  it("shows that it is saving, and leaves the input as it is until the server answers", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)
    const release = store.hold()

    await typist.clear(input)
    await typist.type(input, "Sales{Enter}")

    expect(await content.findByText("Saving the name")).toHaveAttribute("role", "status")
    expect(input).toHaveAttribute("aria-busy", "true")
    expect(input).toHaveAttribute("readonly")
    expect(spinning(input.parentElement as HTMLElement)).toBe(true)
    release()
    await renamedTo(content, "Sales")
    await waitFor(() => expect(content.queryByText("Saving the name")).toBeNull())
  })

  it("gives up on Escape and changes nothing", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)

    await typist.type(input, " plan{Escape}")

    expect(content.getByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
    expect(store.requests).toEqual([])
    expect(content.getByRole("button", { name: "Rename module" })).toHaveFocus()
  })

  it("saves when the user moves on", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)

    await typist.clear(input)
    await typist.type(input, "Turnover")
    await typist.tab()

    await renamedTo(content, "Turnover")
    expect(store.requests).toHaveLength(1)
  })

  it("does not ask the server when the name is unchanged", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)

    await typist.type(input, "{Enter}")

    expect(content.getByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("keeps the input and says so when the name is taken", async () => {
    const typist = userEvent.setup()
    const { content, input } = await startRename(typist)

    await typist.clear(input)
    await typist.type(input, "Pricing{Enter}")

    expect(await content.findByText("That name is already in use.")).toBeVisible()
    expect(input).toBeVisible()
  })

  it("asks for a name", async () => {
    const typist = userEvent.setup()
    const { store, content, input } = await startRename(typist)

    await typist.clear(input)
    await typist.type(input, "{Enter}")

    expect(await content.findByText("Name is required.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("is not offered to a planner", async () => {
    openApp(revenuePath, structure, { role: "planner" })
    const content = await page()

    expect(await content.findByRole("heading", { level: 1, name: "Revenue" })).toBeVisible()
    expect(content.queryByRole("button", { name: "Rename module" })).toBeNull()
    expect(content.queryByRole("button", { name: "Module settings" })).toBeNull()
  })

  it("is off in production mode, and says why", async () => {
    const typist = userEvent.setup()
    openApp(revenuePath, structure, { mode: "prod" })
    const content = await page()

    const rename = await content.findByRole("button", {
      name: "Rename module",
    })
    expect(rename).toBeDisabled()
    expect(content.getByRole("button", { name: "Module settings" })).toBeDisabled()
    expect(content.getByText(PRODUCTION_MESSAGE)).toBeVisible()
    await typist.hover(rename.parentElement as HTMLElement)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
  })
})

describe("the module settings", () => {
  async function openSettings(typist: Typist, modelStructure: StructureDto = structure) {
    const app = openApp(revenuePath, modelStructure)
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Module settings" }))
    return {
      ...app,
      sheet: within(await screen.findByRole("dialog", { name: "Module settings" })),
    }
  }

  it("shows the module as it is", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)

    expect(sheet.getByLabelText("Name")).toHaveValue("Revenue")
    expect(sheet.getByLabelText("Functional area")).toHaveValue("Finance")
    const order = sheet.getByRole("list", { name: "Order of dimensions" })
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["1Regions", "2Products"])
    expect(sheet.getByRole("switch", { name: "Time" })).toBeChecked()
    expect(sheet.getByRole("combobox", { name: "Time level" })).toHaveTextContent("Month")
    expect(sheet.getByRole("switch", { name: "Versions" })).toBeChecked()
    expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("saves a new name and functional area without asking, sending only what changed", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSettings(typist)

    await typist.clear(sheet.getByLabelText("Name"))
    await typist.type(sheet.getByLabelText("Name"), "Turnover")
    await typist.clear(sheet.getByLabelText("Functional area"))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([
      {
        action: "update module",
        id: revenueModule.id,
        body: { name: "Turnover", functional_area: "" },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Module saved")
    expect(await (await page()).findByRole("heading", { level: 1, name: "Turnover" })).toBeVisible()
  })

  it("confirms before it changes the dimensions, which clears the input values", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSettings(typist)

    await typist.click(sheet.getByRole("switch", { name: "Versions" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    const confirm = within(await screen.findByRole("alertdialog", { name: "Clear input values?" }))
    expect(
      confirm.getByText("Changing dimensions clears this module's input values."),
    ).toBeVisible()
    expect(store.requests).toEqual([])
    await typist.click(confirm.getByRole("button", { name: "Save and clear values" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([
      {
        action: "update module",
        id: revenueModule.id,
        body: {
          axes: [
            { kind: "list", list: regionsId },
            { kind: "list", list: productsId },
            { kind: "time", level: "month", range: null },
          ],
        },
      },
    ])
  })

  it("keeps the sheet open and changes nothing when the confirmation is refused", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSettings(typist)

    await typist.click(sheet.getByRole("checkbox", { name: /Regions/ }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    )

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByRole("dialog", { name: "Module settings" })).toBeVisible()
    expect(store.requests).toEqual([])
    expect(sheet.getByRole("button", { name: "Save changes" })).toHaveFocus()
  })

  it("does not confirm a reorder of the dimensions that leaves them where they were", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)

    await typist.click(sheet.getByRole("button", { name: "Move Regions down" }))
    await typist.click(sheet.getByRole("button", { name: "Move Regions up" }))

    expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("shows what the server refuses under the field it is about", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)
    server.use(
      http.patch("/api/v1/models/:id/modules/:moduleId", () =>
        problem(
          422,
          "structure.invalid",
          "A line item's time scale can't be finer than its module's.",
        ),
      ),
    )

    await typist.click(sheet.getByRole("switch", { name: "Time" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )

    expect(await sheet.findByRole("alert")).toHaveTextContent(
      "A line item's time scale can't be finer than its module's.",
    )
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("deletes the module after asking, and leaves its page", async () => {
    const typist = userEvent.setup()
    const { store, router, sheet } = await openSettings(typist)

    await typist.click(sheet.getByRole("button", { name: "Delete module" }))
    const confirm = within(await screen.findByRole("alertdialog", { name: "Delete Revenue?" }))
    await typist.click(confirm.getByRole("button", { name: "Delete module" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${model.id}/modules`))
    expect(store.requests).toEqual([{ action: "delete module", id: revenueModule.id }])
    expect(toast.success).toHaveBeenCalledWith("Module deleted")
    expect(
      await within(await screen.findByRole("main")).findByRole("heading", {
        level: 1,
        name: "Modules",
      }),
    ).toBeVisible()
  })

  it("keeps the module when the deletion is refused", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)
    server.use(
      http.delete("/api/v1/models/:id/modules/:moduleId", () =>
        problem(409, "structure.in_use", "Another module uses it."),
      ),
    )

    await typist.click(sheet.getByRole("button", { name: "Delete module" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete module",
      }),
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Another module uses it."))
    expect(screen.getByRole("alertdialog")).toBeVisible()
  })

  it("puts the focus in the name without selecting it, so that typing adds to it", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)
    const name = sheet.getByLabelText<HTMLInputElement>("Name")

    expect(name).toHaveFocus()
    expect(name.selectionStart).toBe(name.selectionEnd)
    await typist.keyboard("s")

    expect(name).toHaveValue("Revenues")
  })

  it("leaves the sheet open and the button busy while it saves, and cannot be dismissed", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSettings(typist)
    const release = store.hold()

    await typist.type(sheet.getByLabelText("Functional area"), "s")
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled())
    expect(spinning(sheet.getByRole("button", { name: "Save changes" }))).toBe(true)
    expect(sheet.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(sheet.queryByRole("button", { name: "Close" })).toBeNull()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Module settings" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    release()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps the question about clearing values open and busy while the change is saved", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSettings(typist)
    const release = store.hold()

    await typist.click(sheet.getByRole("switch", { name: "Versions" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    const confirm = within(await screen.findByRole("alertdialog", { name: "Clear input values?" }))
    await typist.click(confirm.getByRole("button", { name: "Save and clear values" }))

    await waitFor(() =>
      expect(confirm.getByRole("button", { name: "Save and clear values" })).toBeDisabled(),
    )
    expect(spinning(confirm.getByRole("button", { name: "Save and clear values" }))).toBe(true)
    expect(confirm.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog", { name: "Clear input values?" })).toBeVisible()
    release()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("keeps the deletion open and its button busy until the module is gone", async () => {
    const typist = userEvent.setup()
    const { store, router, sheet } = await openSettings(typist)
    const release = store.hold()

    await typist.click(sheet.getByRole("button", { name: "Delete module" }))
    const confirm = within(await screen.findByRole("alertdialog", { name: "Delete Revenue?" }))
    await typist.click(confirm.getByRole("button", { name: "Delete module" }))

    await waitFor(() =>
      expect(confirm.getByRole("button", { name: "Delete module" })).toBeDisabled(),
    )
    expect(spinning(confirm.getByRole("button", { name: "Delete module" }))).toBe(true)
    expect(confirm.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog", { name: "Delete Revenue?" })).toBeVisible()
    release()
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${model.id}/modules`))
  })

  it("brings focus back to the button that opened it", async () => {
    const typist = userEvent.setup()
    await openSettings(typist)

    await typist.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Module settings" })).toHaveFocus(),
    )
  })
})

describe("closing the module settings with edits", () => {
  async function openEdited(typist: Typist) {
    const app = openApp(revenuePath)
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Module settings" }))
    const sheet = within(await screen.findByRole("dialog", { name: "Module settings" }))
    await typist.type(sheet.getByLabelText("Functional area"), " and Sales")
    return { ...app, sheet }
  }

  it("asks before it drops them, and keeps them when the answer is to keep editing", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openEdited(typist)

    await typist.keyboard("{Escape}")
    const ask = within(await screen.findByRole("alertdialog", { name: "Discard changes?" }))
    expect(ask.getByText("Your changes to this module have not been saved.")).toBeVisible()
    await typist.click(ask.getByRole("button", { name: "Keep editing" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByRole("dialog", { name: "Module settings" })).toBeVisible()
    expect(sheet.getByLabelText("Functional area")).toHaveValue("Finance and Sales")
    expect(store.requests).toEqual([])
  })

  it("closes without saving when the answer is to discard", async () => {
    const typist = userEvent.setup()
    const { store } = await openEdited(typist)

    await typist.keyboard("{Escape}")
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Discard changes",
      }),
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Module settings" })).toHaveFocus(),
    )
  })

  it("starts from the saved module when it is opened again after a discard", async () => {
    const typist = userEvent.setup()
    await openEdited(typist)
    await typist.keyboard("{Escape}")
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Discard changes",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await typist.click(screen.getByRole("button", { name: "Module settings" }))

    const sheet = within(await screen.findByRole("dialog", { name: "Module settings" }))
    expect(sheet.getByLabelText("Functional area")).toHaveValue("Finance")
  })

  it("does not ask when nothing was changed", async () => {
    const typist = userEvent.setup()
    openApp(revenuePath)
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Module settings" }))
    await screen.findByRole("dialog", { name: "Module settings" })

    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("does not ask when the Cancel button is pressed, which says what it means", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openEdited(typist)

    await typist.click(sheet.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("does not ask after the module is saved", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openEdited(typist)

    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})
