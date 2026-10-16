import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { formulaText, setFormula } from "@/test/formula"
import { serveModuleStore } from "@/test/module-edits"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { spinning } from "@/test/spinning"
import {
  makeLineItem,
  makeStructure,
  productsId,
  revenueAmount,
  revenueMargin,
  revenueModule,
  revenuePlan,
  structure,
  unitsSold,
} from "@/test/structure"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

const margin = revenueMargin
const withLineItems = revenuePlan

const blueprintPath = `/m/${model.id}/modules/${revenueModule.id}?tab=blueprint`

type Typist = ReturnType<typeof userEvent.setup>

function openBlueprint(
  modelStructure: StructureDto = withLineItems,
  {
    role = "admin",
    mode = "dev",
    path = blueprintPath,
  }: {
    role?: components["schemas"]["WorkspaceRole"]
    mode?: "dev" | "prod"
    path?: string
  } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveModuleStore(modelStructure)
  const app = renderApp(path)
  return { store, ...app }
}

async function findTable() {
  return within(await screen.findByRole("main")).findByRole("grid", { name: "Line items" })
}

function rowNamed(table: HTMLElement, name: string) {
  const title = within(table).getByText(name, { exact: true })
  return title.closest("tr") as HTMLElement
}

/** The names of the line items in the order the table lists them. */
function names(table: HTMLElement) {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("[title]")?.getAttribute("title"))
}

async function openRowMenu(typist: Typist, table: HTMLElement, name: string) {
  await typist.click(within(table).getByRole("button", { name: `Actions for ${name}` }))
  return within(await screen.findByRole("menu"))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the line items", () => {
  it("lists the line items of the module, and only those, in order", async () => {
    openBlueprint(
      makeStructure({
        ...withLineItems,
        line_items: [margin, revenueAmount, unitsSold, makeLineItem({ module: "other" })],
      }),
    )
    const table = await findTable()

    expect(names(table)).toEqual(["Units sold", "Revenue amount", "Margin"])
  })

  it("shows the name, format, formula, scope, summary and notes of each", async () => {
    openBlueprint()
    const table = await findTable()

    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Reorder",
      "Name",
      "Format",
      "Formula",
      "Applies to",
      "Time scale",
      "Versions",
      "Summary",
      "Notes",
      "Actions",
    ])
    const cells = (name: string) =>
      Array.from(rowNamed(table, name).querySelectorAll("td"))
        .slice(1, -1)
        .map((cell) => cell.textContent)
    expect(cells("Units sold")).toEqual([
      "Units sold",
      "Number",
      "Input",
      "Regions, Products (from the module)",
      "Month (from the module)",
      "All versions (from the module)",
      "Sum",
      "",
    ])
    expect(cells("Revenue amount")).toEqual([
      "Revenue amount",
      "Currency (USD)",
      "Units sold * Pricing.Unit price",
      "Regions, Products (from the module)",
      "Month (from the module)",
      "All versions (from the module)",
      "Sum",
      "",
    ])
    expect(cells("Margin")).toEqual([
      "Margin",
      "Percent",
      "Input",
      "Regions",
      "Year",
      "Forecast",
      "Average",
      "Before tax",
    ])
  })

  it("shows what a line item gets from its module in muted text, and says where it is from", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()

    const inherited = within(rowNamed(table, "Units sold")).getByText(/^Month/)
    expect(inherited).toHaveClass("text-muted-foreground")
    await typist.hover(inherited)

    expect(await screen.findByRole("tooltip")).toHaveTextContent("From the module")
    // What the line item sets itself is not muted.
    expect(within(rowNamed(table, "Margin")).getByText("Year")).not.toHaveClass(
      "text-muted-foreground",
    )
  })

  it("has nothing from the module where the module has no such dimension", async () => {
    openBlueprint(
      makeStructure({
        ...structure,
        modules: [{ ...revenueModule, axes: [] }],
        line_items: [unitsSold],
      }),
    )
    const table = await findTable()

    const cells = Array.from(rowNamed(table, "Units sold").querySelectorAll("td")).map(
      (cell) => cell.textContent,
    )
    expect(cells.slice(4, 7)).toEqual([
      "None (from the module)",
      "None (from the module)",
      "None (from the module)",
    ])
  })

  describe("a formula that has errors", () => {
    const errors = [
      {
        code: "formula.unknown_name",
        message: "Unknown name 'Pricing.Unit price'",
        start: 14,
        end: 31,
      },
    ]

    it("is marked with an icon that says what is wrong, to a pointer", async () => {
      const typist = userEvent.setup()
      const { store } = openBlueprint()
      store.formulaErrors[revenueAmount.id] = errors
      const table = await findTable()

      const icon = await within(rowNamed(table, "Revenue amount")).findByRole("button", {
        name: "Formula error: Unknown name 'Pricing.Unit price'",
      })
      expect(
        within(rowNamed(table, "Units sold")).queryByRole("button", { name: /error/ }),
      ).toBeNull()
      await typist.hover(icon)
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Unknown name 'Pricing.Unit price'",
      )
    })

    it("says what is wrong in the name of its row, which the arrow keys read out", async () => {
      const { store } = openBlueprint()
      store.formulaErrors[revenueAmount.id] = errors
      const table = await findTable()

      await within(rowNamed(table, "Revenue amount")).findByRole("button", {
        name: /Formula error/,
      })

      expect(rowNamed(table, "Revenue amount")).toHaveAccessibleName(
        "Revenue amount, Currency (USD), calculated, formula has errors: Unknown name 'Pricing.Unit price'",
      )
      expect(rowNamed(table, "Units sold")).toHaveAccessibleName("Units sold, Number, input")
    })

    it("is reached with the Tab key on the selected row, and shows its message there", async () => {
      const typist = userEvent.setup()
      const { store } = openBlueprint(withLineItems, {
        path: `${blueprintPath}&li=${revenueAmount.id}`,
      })
      store.formulaErrors[revenueAmount.id] = errors
      const table = await findTable()
      const icon = await within(rowNamed(table, "Revenue amount")).findByRole("button", {
        name: /Formula error/,
      })

      table.focus()
      await typist.tab()
      expect(within(table).getByRole("button", { name: "Reorder Revenue amount" })).toHaveFocus()
      await typist.tab()

      expect(icon).toHaveFocus()
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Unknown name 'Pricing.Unit price'",
      )
    })

    it("opens the settings of the line item, where the problems are listed", async () => {
      const typist = userEvent.setup()
      const { store } = openBlueprint()
      store.formulaErrors[revenueAmount.id] = errors
      const table = await findTable()

      await typist.click(
        await within(rowNamed(table, "Revenue amount")).findByRole("button", {
          name: /Formula error/,
        }),
      )

      const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
      expect(sheet.getByLabelText("Name")).toHaveValue("Revenue amount")
      expect(sheet.getByText("The formula has a problem.")).toBeVisible()
    })
  })

  it("shows the whole formula in a tooltip", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()

    await typist.hover(within(table).getByText("Units sold * Pricing.Unit price"))

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Units sold * Pricing.Unit price")
  })

  it("asks for the first line item of a module without any", async () => {
    openBlueprint(makeStructure({ ...structure, line_items: [] }))

    const content = within(await screen.findByRole("main"))
    expect(await content.findByRole("heading", { name: "Add your first line item" })).toBeVisible()
    expect(content.getAllByRole("button", { name: "Add line item" })).toHaveLength(1)
    expect(content.queryByRole("grid", { name: "Line items" })).toBeNull()
  })
})

describe("the formula bar", () => {
  async function findBar() {
    return within(await screen.findByRole("group", { name: "Formula bar" }))
  }

  it("asks to select a line item while none is selected", async () => {
    openBlueprint()

    expect(await (await findBar()).findByText("Select a line item to see its formula.")).toBeVisible()
  })

  it("shows the formula of the selected line item, and follows the selection", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { path: `${blueprintPath}&li=${revenueAmount.id}` })
    const bar = await findBar()

    const formula = await bar.findByRole("textbox", { name: "Formula of Revenue amount" })
    expect(formulaText(formula)).toBe("Units sold * Pricing.Unit price")
    expect(bar.getByText("Revenue amount")).toBeVisible()

    await typist.click(rowNamed(await findTable(), "Units sold"))

    const input = await bar.findByRole("textbox", { name: "Formula of Units sold" })
    expect(formulaText(input)).toBe("")
    expect(input.closest(".cm-editor")).toHaveTextContent("Type a formula to calculate")
  })

  it("saves a formula, which the table then shows", async () => {
    const typist = userEvent.setup()
    const { store } = openBlueprint(withLineItems, {
      path: `${blueprintPath}&li=${revenueAmount.id}`,
    })
    const bar = await findBar()
    setFormula(await bar.findByRole("textbox", { name: "Formula of Revenue amount" }), "1 + 1")

    await typist.click(await bar.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Formula saved"))
    expect(store.requests).toEqual([
      { action: "update line item", id: revenueAmount.id, body: { formula: "1 + 1" } },
    ])
    expect(await within(await findTable()).findByText("1 + 1")).toBeVisible()
  })

  it("shows a planner the formula but lets them change nothing", async () => {
    openBlueprint(withLineItems, {
      role: "planner",
      path: `${blueprintPath}&li=${revenueAmount.id}`,
    })
    const bar = await findBar()

    const formula = await bar.findByRole("textbox", { name: "Formula of Revenue amount" })
    expect(formulaText(formula)).toBe("Units sold * Pricing.Unit price")
    expect(formula).toHaveAttribute("aria-readonly", "true")
  })

  it("is switched off in production mode", async () => {
    openBlueprint(withLineItems, { mode: "prod", path: `${blueprintPath}&li=${revenueAmount.id}` })
    const bar = await findBar()

    expect(await bar.findByRole("textbox", { name: "Formula of Revenue amount" })).toHaveAttribute(
      "aria-readonly",
      "true",
    )
  })
})

describe("selecting a line item", () => {
  it("selects a row on a click, and puts it in the address", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint()
    const table = await findTable()

    await typist.click(within(table).getByText("Revenue amount"))

    expect(router.state.location.search).toEqual({ tab: "blueprint", li: revenueAmount.id })
    expect(rowNamed(table, "Revenue amount")).toHaveAttribute("aria-selected", "true")
    expect(rowNamed(table, "Units sold")).toHaveAttribute("aria-selected", "false")
    expect(table).toHaveAttribute("aria-activedescendant", rowNamed(table, "Revenue amount").id)
  })

  it("does not add a step to go back over for each selection", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint()
    const table = await findTable()
    const before = router.history.length

    await typist.click(within(table).getByText("Revenue amount"))
    await typist.click(within(table).getByText("Margin"))

    expect(router.history.length).toBe(before)
  })

  it("marks the line item named in the address", async () => {
    openBlueprint(withLineItems, { path: `${blueprintPath}&li=${margin.id}` })
    const table = await findTable()

    expect(rowNamed(table, "Margin")).toHaveAttribute("aria-selected", "true")
    expect(rowNamed(table, "Units sold")).toHaveAttribute("aria-selected", "false")
  })

  it("ignores a line item that is not in the module", async () => {
    openBlueprint(withLineItems, {
      path: `${blueprintPath}&li=0192f3a0-0000-7000-8000-0000000000ff`,
    })
    const table = await findTable()

    expect(within(table).queryAllByRole("row", { selected: true })).toEqual([])
    expect(table).not.toHaveAttribute("aria-activedescendant")
  })

  it("moves the selection with the arrow keys, Home and End", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint()
    const table = await findTable()
    table.focus()

    await typist.keyboard("{ArrowDown}")
    expect(router.state.location.search).toMatchObject({ li: unitsSold.id })
    await typist.keyboard("{ArrowDown}")
    expect(router.state.location.search).toMatchObject({ li: revenueAmount.id })
    await typist.keyboard("{ArrowDown}{ArrowDown}")
    expect(router.state.location.search).toMatchObject({ li: margin.id })
    await typist.keyboard("{ArrowUp}")
    expect(router.state.location.search).toMatchObject({ li: revenueAmount.id })
    await typist.keyboard("{Home}")
    expect(router.state.location.search).toMatchObject({ li: unitsSold.id })
    await typist.keyboard("{End}")
    expect(router.state.location.search).toMatchObject({ li: margin.id })
  })

  it("starts from the last row when the arrow up is the first key", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint()
    const table = await findTable()
    table.focus()

    await typist.keyboard("{ArrowUp}")

    expect(router.state.location.search).toMatchObject({ li: margin.id })
  })

  it("makes the controls of the selected row the ones the Tab key reaches", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { path: `${blueprintPath}&li=${revenueAmount.id}` })
    const table = await findTable()

    expect(within(table).getByRole("button", { name: "Reorder Revenue amount" })).toHaveAttribute(
      "tabindex",
      "0",
    )
    expect(within(table).getByRole("button", { name: "Reorder Units sold" })).toHaveAttribute(
      "tabindex",
      "-1",
    )
    table.focus()
    await typist.tab()
    expect(within(table).getByRole("button", { name: "Reorder Revenue amount" })).toHaveFocus()
    await typist.tab()
    expect(within(table).getByRole("button", { name: "Actions for Revenue amount" })).toHaveFocus()
  })
})

describe("the settings of a line item", () => {
  it("opens on Enter for the selected line item", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { path: `${blueprintPath}&li=${margin.id}` })
    const table = await findTable()
    table.focus()

    await typist.keyboard("{Enter}")

    const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
    expect(sheet.getByLabelText("Name")).toHaveValue("Margin")
  })

  it("opens on a double click, selecting the row", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint()
    const table = await findTable()

    await typist.dblClick(within(table).getByText("Revenue amount"))

    const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
    expect(sheet.getByLabelText("Name")).toHaveValue("Revenue amount")
    expect(router.state.location.search).toMatchObject({ li: revenueAmount.id })
  })

  it("opens from the actions menu of a row", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Line item settings" }))

    expect(
      within(await screen.findByRole("dialog", { name: "Line item settings" })).getByLabelText(
        "Name",
      ),
    ).toHaveValue("Units sold")
  })

  it("brings focus back to the table when it closes", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { path: `${blueprintPath}&li=${margin.id}` })
    const table = await findTable()
    table.focus()
    await typist.keyboard("{Enter}")
    await screen.findByRole("dialog", { name: "Line item settings" })

    await typist.keyboard("{Escape}")

    await waitFor(() => expect(table).toHaveFocus())
  })

  it("does nothing on Enter without a selection", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()
    table.focus()

    await typist.keyboard("{Enter}")

    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("adding a line item", () => {
  async function openDialog(typist: Typist, selected?: string) {
    const app = openBlueprint(
      withLineItems,
      selected ? { path: `${blueprintPath}&li=${selected}` } : {},
    )
    const content = within(await screen.findByRole("main"))
    await typist.click(await content.findByRole("button", { name: "Add line item" }))
    return { ...app, dialog: within(await screen.findByRole("dialog", { name: "Add line item" })) }
  }

  it("adds it at the end when none is selected", async () => {
    const typist = userEvent.setup()
    const { store, router, dialog } = await openDialog(typist)
    expect(dialog.getByText(/It goes at the end/)).toBeVisible()

    await typist.type(dialog.getByLabelText("Name"), "Discount")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([
      {
        action: "create line item",
        id: revenueModule.id,
        body: {
          name: "Discount",
          format: {
            type: "number",
            decimals: 0,
            thousands_sep: true,
            unit: { type: "none" },
            negative: "minus",
          },
          summary: { method: "sum" },
        },
      },
    ])
    const table = await findTable()
    await waitFor(() =>
      expect(names(table)).toEqual(["Units sold", "Revenue amount", "Margin", "Discount"]),
    )
    expect(toast.success).toHaveBeenCalledWith("Line item added")
    const added = store.structure.line_items.find((item) => item.name === "Discount")
    expect(router.state.location.search).toMatchObject({ li: added?.id })
  })

  it("inserts it below the selected line item", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist, unitsSold.id)
    expect(dialog.getByText(/It goes below Units sold/)).toBeVisible()

    await typist.type(dialog.getByLabelText("Name"), "Discount")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    const table = await findTable()
    await waitFor(() =>
      expect(names(table)).toEqual(["Units sold", "Discount", "Revenue amount", "Margin"]),
    )
    const added = store.structure.line_items.find((item) => item.name === "Discount")
    expect(store.requests[1]).toEqual({
      action: "reorder",
      id: revenueModule.id,
      body: {
        module_id: revenueModule.id,
        ids: [unitsSold.id, added?.id, revenueAmount.id, margin.id],
      },
    })
  })

  it("adds it last, without reordering, below the last line item", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist, margin.id)

    await typist.type(dialog.getByLabelText("Name"), "Discount")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests.map((request) => request.action)).toEqual(["create line item"])
  })

  it("creates the other kinds of line item with their format", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist)

    await typist.type(dialog.getByLabelText("Name"), "Region")
    await typist.click(dialog.getByRole("combobox", { name: "Format type" }))
    await typist.click(await screen.findByRole("option", { name: "List" }))
    await typist.click(dialog.getByRole("combobox", { name: "List" }))
    await typist.click(await screen.findByRole("option", { name: "Products" }))
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    await waitFor(() =>
      expect(store.requests[0].body).toMatchObject({
        format: { type: "list", list: productsId },
        summary: { method: "none" },
      }),
    )
  })

  it("asks for a list when the format is a list", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist)

    await typist.type(dialog.getByLabelText("Name"), "Region")
    await typist.click(dialog.getByRole("combobox", { name: "Format type" }))
    await typist.click(await screen.findByRole("option", { name: "List" }))
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    expect(await dialog.findByText("Choose a list.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("asks for a name, and shows a name that is taken under it", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist)

    await typist.click(dialog.getByRole("button", { name: "Add line item" }))
    expect(await dialog.findByText("Name is required.")).toBeVisible()
    await typist.type(dialog.getByLabelText("Name"), "Margin")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    expect(await dialog.findByText("That name is already in use.")).toBeVisible()
  })

  it("says so when the line item was added but could not be moved below the selection", async () => {
    const typist = userEvent.setup()
    const { dialog } = await openDialog(typist, unitsSold.id)
    server.use(
      http.post("/api/v1/models/:id/line-items/reorder", () =>
        problem(500, "internal", "The database is starting up."),
      ),
    )

    await typist.type(dialog.getByLabelText("Name"), "Discount")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The line item was added at the end; moving it below Units sold failed.",
      ),
    )
    expect(toast.success).toHaveBeenCalledWith("Line item added")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("holds the dialog open and the button busy while the line item is added", async () => {
    const typist = userEvent.setup()
    const { store, dialog } = await openDialog(typist)
    const release = store.hold()

    await typist.type(dialog.getByLabelText("Name"), "Discount")
    await typist.click(dialog.getByRole("button", { name: "Add line item" }))

    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Add line item" })).toBeDisabled(),
    )
    expect(spinning(dialog.getByRole("button", { name: "Add line item" }))).toBe(true)
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Add line item" })).toBeVisible()
    release()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("brings focus back to the button that opened the dialog", async () => {
    const typist = userEvent.setup()
    await openDialog(typist)

    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.getByRole("button", { name: "Add line item" })).toHaveFocus())
  })
})

describe("reordering", () => {
  it("moves a line item down from its actions menu", async () => {
    const typist = userEvent.setup()
    const { store } = openBlueprint()
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Move down" }))

    await waitFor(() => expect(names(table)).toEqual(["Revenue amount", "Units sold", "Margin"]))
    expect(store.requests).toEqual([
      {
        action: "reorder",
        id: revenueModule.id,
        body: { module_id: revenueModule.id, ids: [revenueAmount.id, unitsSold.id, margin.id] },
      },
    ])
    expect(screen.getByText("Moved Units sold to position 2 of 3.")).toBeInTheDocument()
  })

  it("moves a line item up, and cannot move the first up or the last down", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()

    const first = await openRowMenu(typist, table, "Units sold")
    expect(first.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    await typist.keyboard("{Escape}")
    const last = await openRowMenu(typist, table, "Margin")
    expect(last.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    await typist.click(last.getByRole("menuitem", { name: "Move up" }))

    await waitFor(() => expect(names(table)).toEqual(["Units sold", "Margin", "Revenue amount"]))
  })

  it("shows the new order at once, while it is saved", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/models/:id/line-items/reorder", async () => {
        await gate
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Move down" }))

    expect(names(table)).toEqual(["Revenue amount", "Units sold", "Margin"])
    expect(within(table).getByRole("button", { name: "Reorder Margin" })).toBeDisabled()
    expect(table).toHaveAttribute("aria-busy", "true")
    release()
    await waitFor(() =>
      expect(within(table).getByRole("button", { name: "Reorder Margin" })).toBeEnabled(),
    )
    expect(table).not.toHaveAttribute("aria-busy")
  })

  it("goes back to the saved order when the move is refused", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()
    server.use(
      http.post("/api/v1/models/:id/line-items/reorder", () =>
        problem(422, "structure.invalid", "List every line item of the module once."),
      ),
    )

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Move down" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("List every line item of the module once."),
    )
    expect(names(table)).toEqual(["Units sold", "Revenue amount", "Margin"])
  })

  it("moves a line item with the keyboard: space picks it up, the arrows move it, space drops it", async () => {
    const typist = userEvent.setup()
    const { store } = openBlueprint(withLineItems, { path: `${blueprintPath}&li=${unitsSold.id}` })
    const table = await findTable()
    // jsdom has no layout; give the rows the places of a table with rows 40 px high.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const row = this.closest("tr")
      const index = row ? Array.from(row.parentElement?.children ?? []).indexOf(row) : 0
      const top = this.matches("tr") || row ? index * 40 : 0
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 800,
        bottom: top + 40,
        width: 800,
        height: 40,
        toJSON: () => ({}),
      }
    })
    const handle = within(table).getByRole("button", { name: "Reorder Units sold" })
    handle.focus()

    await typist.keyboard(" ")
    await typist.keyboard("{ArrowDown}")
    await typist.keyboard(" ")

    await waitFor(() =>
      expect(store.requests.map((request) => request.action)).toEqual(["reorder"]),
    )
    expect(store.requests[0].body).toEqual({
      module_id: revenueModule.id,
      ids: [revenueAmount.id, unitsSold.id, margin.id],
    })
    await waitFor(() => expect(names(table)).toEqual(["Revenue amount", "Units sold", "Margin"]))
  })
})

describe("deleting a line item", () => {
  it("asks first, says what happens to formulas that use it, and deletes", async () => {
    const typist = userEvent.setup()
    const { store } = openBlueprint(withLineItems, { path: `${blueprintPath}&li=${unitsSold.id}` })
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    const confirm = within(await screen.findByRole("alertdialog", { name: "Delete Units sold?" }))
    expect(confirm.getByText("Formulas that reference it will show errors.")).toBeVisible()
    expect(store.requests).toEqual([])
    await typist.click(confirm.getByRole("button", { name: "Delete line item" }))

    await waitFor(() => expect(names(table)).toEqual(["Revenue amount", "Margin"]))
    expect(store.requests).toEqual([{ action: "delete line item", id: unitsSold.id }])
    expect(toast.success).toHaveBeenCalledWith("Line item deleted")
  })

  it("selects the next line item when the selected one goes, and gives focus to the table", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint(withLineItems, {
      path: `${blueprintPath}&li=${revenueAmount.id}`,
    })
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Revenue amount")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete line item",
      }),
    )

    await waitFor(() => expect(router.state.location.search).toMatchObject({ li: margin.id }))
    await waitFor(() => expect(table).toHaveFocus())
  })

  it("selects the line item before when the last one goes", async () => {
    const typist = userEvent.setup()
    const { router } = openBlueprint(withLineItems, { path: `${blueprintPath}&li=${margin.id}` })
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Margin")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete line item",
      }),
    )

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ li: revenueAmount.id }),
    )
  })

  it("holds the confirmation open and the button busy while the line item is deleted", async () => {
    const typist = userEvent.setup()
    const { store } = openBlueprint()
    const table = await findTable()
    const release = store.hold()

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    const confirm = within(await screen.findByRole("alertdialog", { name: "Delete Units sold?" }))
    await typist.click(confirm.getByRole("button", { name: "Delete line item" }))

    await waitFor(() =>
      expect(confirm.getByRole("button", { name: "Delete line item" })).toBeDisabled(),
    )
    expect(spinning(confirm.getByRole("button", { name: "Delete line item" }))).toBe(true)
    expect(confirm.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog")).toBeVisible()
    release()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("keeps the line item and says why when the server refuses", async () => {
    const typist = userEvent.setup()
    openBlueprint()
    const table = await findTable()
    server.use(
      http.delete("/api/v1/models/:id/line-items/:lineItemId", () =>
        problem(409, "structure.in_use", "Another line item uses it as a ratio part."),
      ),
    )

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete line item",
      }),
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Another line item uses it as a ratio part."),
    )
    expect(screen.getByRole("alertdialog")).toBeVisible()
    expect(within(table).getByText("Units sold", { exact: true })).toBeInTheDocument()
  })

  it("leaves a module with an empty message, and focus on the button that adds", async () => {
    const typist = userEvent.setup()
    openBlueprint(makeStructure({ ...structure, line_items: [unitsSold] }))
    const table = await findTable()

    const menu = await openRowMenu(typist, table, "Units sold")
    await typist.click(menu.getByRole("menuitem", { name: "Delete line item" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete line item",
      }),
    )

    const content = within(await screen.findByRole("main"))
    expect(await content.findByRole("heading", { name: "Add your first line item" })).toBeVisible()
    await waitFor(() =>
      expect(content.getByRole("button", { name: "Add line item" })).toHaveFocus(),
    )
  })
})

describe("who may change the line items", () => {
  it("shows a planner the line items without the controls that change them", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { role: "planner" })
    const table = await findTable()

    expect(names(table)).toEqual(["Units sold", "Revenue amount", "Margin"])
    expect(within(table).queryByRole("button", { name: /^Reorder/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Add line item" })).toBeNull()
    const menu = await openRowMenu(typist, table, "Units sold")
    expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Line item settings",
    ])
  })

  it("shows a planner the settings of a line item, none of them to change", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { role: "planner", path: `${blueprintPath}&li=${margin.id}` })
    const table = await findTable()
    table.focus()

    await typist.keyboard("{Enter}")

    const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
    expect(sheet.getByLabelText("Name")).toBeDisabled()
    expect(sheet.getByLabelText("Formula")).toHaveAttribute("aria-readonly", "true")
    expect(sheet.queryByRole("button", { name: "Save changes" })).toBeNull()
    expect(sheet.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0)
  })

  it("tells a planner of an empty module that there are no line items, and no more", async () => {
    openBlueprint(makeStructure({ ...structure, line_items: [] }), { role: "viewer" })

    const content = within(await screen.findByRole("main"))
    expect(await content.findByRole("heading", { name: "No line items yet" })).toBeVisible()
    expect(content.queryByRole("button", { name: "Add line item" })).toBeNull()
  })

  it("keeps the controls on screen in production mode, switched off, and says why", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { mode: "prod" })
    const table = await findTable()
    const content = within(await screen.findByRole("main"))

    const add = content.getByRole("button", { name: "Add line item" })
    expect(add).toBeDisabled()
    expect(within(table).getByRole("button", { name: "Reorder Units sold" })).toBeDisabled()
    expect(content.getByText(PRODUCTION_MESSAGE)).toBeVisible()
    await typist.hover(add.parentElement as HTMLElement)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
    const menu = await openRowMenu(typist, table, "Units sold")
    expect(menu.getByRole("menuitem", { name: "Delete line item" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(menu.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
  })

  it.each(["Move up", "Move down", "Delete line item"])(
    "says why %s in the row menu is off in production mode",
    async (name) => {
      const typist = userEvent.setup()
      openBlueprint(withLineItems, { mode: "prod" })
      const table = await findTable()
      const menu = await openRowMenu(typist, table, "Revenue amount")

      const item = menu.getByRole("menuitem", { name })
      expect(item).toHaveAttribute("aria-disabled", "true")
      await typist.hover(item.parentElement as HTMLElement)

      expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
    },
  )

  it("gives no reason for a Move that is off because the row is at the end", async () => {
    const typist = userEvent.setup()
    openBlueprint(withLineItems, { mode: "dev" })
    const table = await findTable()
    const menu = await openRowMenu(typist, table, "Units sold")

    const up = menu.getByRole("menuitem", { name: "Move up" })
    expect(up).toHaveAttribute("aria-disabled", "true")
    await typist.hover(up.parentElement as HTMLElement)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
})

describe("the structure changing underneath", () => {
  it("shows a line item added by someone else once the structure is read again", async () => {
    const { store, queryClient } = openBlueprint()
    const table = await findTable()
    store.structure = {
      ...store.structure,
      line_items: [
        ...store.structure.line_items,
        makeLineItem({ id: "other", module: revenueModule.id, name: "Cost", ordinal: 3 }),
      ],
    }

    await act(() => queryClient.invalidateQueries())

    await waitFor(() =>
      expect(names(table)).toEqual(["Units sold", "Revenue amount", "Margin", "Cost"]),
    )
  })
})
