import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { formulaText, formulaView, setFormula } from "@/test/formula"
import { type ModuleStore, serveModuleStore } from "@/test/module-edits"
import { server } from "@/test/server"
import { spinning } from "@/test/spinning"
import {
  forecastId,
  makeLineItem,
  makeModule,
  makeStructure,
  productsId,
  regionsId,
  revenueAmount,
  revenueMargin,
  revenueModule,
  revenuePlan,
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
const blueprint = `/m/${model.id}/modules/${revenueModule.id}?tab=blueprint`

type Typist = ReturnType<typeof userEvent.setup>

async function openSheet(
  typist: Typist,
  lineItem = unitsSold.id,
  {
    modelStructure = withLineItems,
    role = "admin",
    mode = "dev",
    prepare,
  }: {
    modelStructure?: StructureDto
    role?: components["schemas"]["WorkspaceRole"]
    mode?: "dev" | "prod"
    /** Sets the store up before the page is drawn. */
    prepare?: (store: ModuleStore) => void
  } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveModuleStore(modelStructure)
  prepare?.(store)
  const app = renderApp(`${blueprint}&li=${lineItem}`)
  const table = await within(await screen.findByRole("main")).findByRole("grid", {
    name: "Line items",
  })
  table.focus()
  await typist.keyboard("{Enter}")
  const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
  return { ...app, store, table, sheet }
}

async function choose(typist: Typist, combobox: HTMLElement, option: string) {
  await typist.click(combobox)
  await typist.click(await screen.findByRole("option", { name: option }))
}

async function save(typist: Typist, sheet: ReturnType<typeof within>) {
  await typist.click(sheet.getByRole("button", { name: "Save changes" }))
}

describe("the settings of a line item", () => {
  it("shows the line item as it is", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id)

    expect(sheet.getByLabelText("Name")).toHaveValue("Revenue amount")
    expect(sheet.getByLabelText("Code")).toHaveValue("")
    expect(sheet.getByRole("combobox", { name: "Format type" })).toHaveTextContent("Number")
    expect(sheet.getByLabelText("Decimals")).toHaveValue(2)
    expect(sheet.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Currency")
    expect(sheet.getByLabelText("Currency code")).toHaveValue("USD")
    expect(sheet.getByRole("switch", { name: "Thousands separator" })).toBeChecked()
    expect(sheet.getByRole("radio", { name: "Parentheses" })).toBeChecked()
    expect(formulaText(sheet.getByLabelText("Formula"))).toBe("Units sold * Pricing.Unit price")
    expect(sheet.getByRole("combobox", { name: "Summary" })).toHaveTextContent("Sum")
    expect(sheet.getByRole("combobox", { name: "Time summary" })).toHaveTextContent(
      "Same as summary",
    )
    expect(
      within(sheet.getByRole("radiogroup", { name: "Applies to" })).getByRole("radio", {
        name: /Module default/,
      }),
    ).toBeChecked()
    expect(sheet.getByRole("combobox", { name: "Time scale" })).toHaveTextContent("Module default")
    expect(sheet.getByLabelText("Notes")).toHaveValue("")
    expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("names the line item and its module", async () => {
    const typist = userEvent.setup()
    await openSheet(typist)

    const dialog = screen.getByRole("dialog", { name: "Line item settings" })
    expect(within(dialog).getByText("Units sold", { selector: "span.font-medium" })).toBeVisible()
    expect(dialog).toHaveTextContent("Units sold in Revenue.")
  })

  it("saves a new name, code and notes, sending only those", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await typist.clear(sheet.getByLabelText("Name"))
    await typist.type(sheet.getByLabelText("Name"), "Units")
    await typist.type(sheet.getByLabelText("Code"), "U1")
    await typist.type(sheet.getByLabelText("Notes"), "Per month")
    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([
      {
        action: "update line item",
        id: unitsSold.id,
        body: { name: "Units", code: "U1", notes: "Per month" },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Line item saved")
  })

  it("brings focus back to the table once it is saved", async () => {
    const typist = userEvent.setup()
    const { table, sheet } = await openSheet(typist)

    await typist.type(sheet.getByLabelText("Notes"), "x")
    await save(typist, sheet)

    await waitFor(() => expect(table).toHaveFocus())
  })

  it("shows a name that is taken under the name", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    await typist.clear(sheet.getByLabelText("Name"))
    await typist.type(sheet.getByLabelText("Name"), "Margin")
    await save(typist, sheet)

    expect(await sheet.findByText("That name is already in use.")).toBeVisible()
    expect(sheet.getByLabelText("Name")).toHaveFocus()
  })

  it("asks for a name", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await typist.clear(sheet.getByLabelText("Name"))
    await save(typist, sheet)

    expect(await sheet.findByText("Name is required.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("leaves the sheet open and the button busy while it saves, and cannot be dismissed", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    const release = store.hold()

    await typist.type(sheet.getByLabelText("Notes"), "x")
    await save(typist, sheet)

    await waitFor(() => expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled())
    expect(spinning(sheet.getByRole("button", { name: "Save changes" }))).toBe(true)
    expect(sheet.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(sheet.queryByRole("button", { name: "Close" })).toBeNull()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    release()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("puts the focus in the name without selecting it, so that typing adds to it", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)
    const name = sheet.getByLabelText<HTMLInputElement>("Name")

    expect(name).toHaveFocus()
    expect(name.selectionStart).toBe(name.selectionEnd)
    await typist.keyboard("s")

    expect(name).toHaveValue("Units solds")
  })
})

describe("closing the sheet with edits", () => {
  it("asks before it drops them, and keeps them when the answer is to keep editing", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    await typist.type(sheet.getByLabelText("Notes"), "Per month")

    await typist.keyboard("{Escape}")

    const ask = within(await screen.findByRole("alertdialog", { name: "Discard changes?" }))
    expect(ask.getByText("Your changes to this line item have not been saved.")).toBeVisible()
    await typist.click(ask.getByRole("button", { name: "Keep editing" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
    expect(sheet.getByLabelText("Notes")).toHaveValue("Per month")
    expect(store.requests).toEqual([])
  })

  it("closes without saving when the answer is to discard", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    await typist.type(sheet.getByLabelText("Notes"), "Per month")

    await typist.click(sheet.getByRole("button", { name: "Close" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests).toEqual([])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("starts from the saved line item when it is opened again after a discard", async () => {
    const typist = userEvent.setup()
    const { table, sheet } = await openSheet(typist)
    await typist.type(sheet.getByLabelText("Notes"), "Per month")
    await typist.keyboard("{Escape}")
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    table.focus()
    await typist.keyboard("{Enter}")

    expect(
      within(await screen.findByRole("dialog", { name: "Line item settings" })).getByLabelText(
        "Notes",
      ),
    ).toHaveValue("")
  })

  it("does not ask when nothing was changed", async () => {
    const typist = userEvent.setup()
    await openSheet(typist)

    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("does not ask when a change is typed back to what it was", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    await typist.type(sheet.getByLabelText("Notes"), "x")
    await typist.type(sheet.getByLabelText("Notes"), "{Backspace}")
    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("does not ask when the Cancel button is pressed, which says what it means", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)
    await typist.type(sheet.getByLabelText("Notes"), "Per month")

    await typist.click(sheet.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("does not ask after the line item is saved", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)
    await typist.type(sheet.getByLabelText("Notes"), "Per month")

    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})

describe("the number format", () => {
  it("changes the decimals, thousands separator, unit and negatives, and previews them", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    expect(sheet.getByText("1,235")).toBeVisible()

    await typist.clear(sheet.getByLabelText("Decimals"))
    await typist.type(sheet.getByLabelText("Decimals"), "2")
    await choose(typist, sheet.getByRole("combobox", { name: "Unit" }), "Currency")
    await typist.type(sheet.getByLabelText("Currency code"), "eur")
    await typist.click(sheet.getByRole("radio", { name: "Parentheses" }))
    await typist.click(sheet.getByRole("switch", { name: "Thousands separator" }))

    expect(sheet.getByLabelText("Currency code")).toHaveValue("EUR")
    expect(sheet.getByText(/^Shown as/)).toHaveTextContent("Shown as €1234.57 and (€1234.57).")
    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests[0].body).toEqual({
      format: {
        type: "number",
        decimals: 2,
        thousands_sep: false,
        unit: { type: "currency", code: "EUR" },
        negative: "parens",
      },
    })
  })

  it("shows a percentage in the preview", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, margin.id)

    expect(sheet.getByRole("combobox", { name: "Unit" })).toHaveTextContent("Percent")
    expect(sheet.getByText(/^Shown as/)).toHaveTextContent("Shown as 12.3% and -12.3%.")
  })

  it("asks for decimals from 0 to 10", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await typist.clear(sheet.getByLabelText("Decimals"))
    await typist.type(sheet.getByLabelText("Decimals"), "11")
    await save(typist, sheet)

    expect(await sheet.findByText("Decimals must be between 0 and 10.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("asks for three letters for a currency", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Unit" }), "Currency")
    await typist.type(sheet.getByLabelText("Currency code"), "us")
    await save(typist, sheet)

    expect(
      await sheet.findByText("Currency code must be three uppercase letters, such as USD."),
    ).toBeVisible()
  })

  it("has no currency code to fill in for another unit", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    expect(sheet.queryByLabelText("Currency code")).toBeNull()
    await choose(typist, sheet.getByRole("combobox", { name: "Unit" }), "Currency")
    expect(sheet.getByLabelText("Currency code")).toBeVisible()
    await choose(typist, sheet.getByRole("combobox", { name: "Unit" }), "None")
    expect(sheet.queryByLabelText("Currency code")).toBeNull()
  })
})

describe("the other formats", () => {
  it("chooses the list of a list format", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "List")
    expect(sheet.queryByLabelText("Decimals")).toBeNull()
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    expect(await sheet.findByText("Choose a list.")).toBeVisible()
    await choose(typist, sheet.getByRole("combobox", { name: "List" }), "Products")
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )

    await waitFor(() =>
      expect(store.requests[0].body).toMatchObject({
        format: { type: "list", list: productsId },
        // Numbers are summed, lists are not.
        summary: { method: "none" },
      }),
    )
  })

  it("chooses the level of a time period format", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Time period")
    await choose(typist, sheet.getByRole("combobox", { name: "Period level" }), "Quarter")

    expect(sheet.getByRole("combobox", { name: "Period level" })).toHaveTextContent("Quarter")
  })

  it("offers only None as the summary of text, and Any and All for a boolean", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Text")
    expect(sheet.getByRole("combobox", { name: "Summary" })).toHaveTextContent("None")
    expect(sheet.getByRole("combobox", { name: "Summary" })).toBeDisabled()
    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Boolean")
    await typist.click(sheet.getByRole("combobox", { name: "Summary" }))

    const options = (await screen.findAllByRole("option")).map((option) => option.textContent)
    expect(options).toEqual(expect.arrayContaining(["Any", "All", "None"]))
    expect(options).not.toContain("Sum")
  })
})

describe("the summary", () => {
  it("takes a ratio of two other number line items of the module", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, margin.id)

    await choose(typist, sheet.getByRole("combobox", { name: "Summary" }), "Ratio")
    await typist.click(sheet.getByRole("combobox", { name: "Numerator" }))
    // Not itself, and only the number line items.
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Units sold",
      "Revenue amount",
    ])
    await typist.click(screen.getByRole("option", { name: "Revenue amount" }))
    await choose(typist, sheet.getByRole("combobox", { name: "Denominator" }), "Units sold")
    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests[0].body).toEqual({
      summary: {
        method: "ratio",
        numerator: revenueAmount.id,
        denominator: unitsSold.id,
      },
    })
  })

  it("asks for both parts of a ratio", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, margin.id)

    await choose(typist, sheet.getByRole("combobox", { name: "Summary" }), "Ratio")
    await save(typist, sheet)

    expect(await sheet.findByText("Choose the numerator.")).toBeVisible()
    expect(sheet.getByText("Choose the denominator.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("shows a ratio the line item already has", async () => {
    const typist = userEvent.setup()
    const ratio = makeLineItem({
      ...margin,
      summary: {
        method: "ratio",
        numerator: unitsSold.id,
        denominator: revenueAmount.id,
      },
    })
    const { sheet } = await openSheet(typist, margin.id, {
      modelStructure: makeStructure({
        ...withLineItems,
        line_items: [unitsSold, revenueAmount, ratio],
      }),
    })

    expect(sheet.getByRole("combobox", { name: "Summary" })).toHaveTextContent("Ratio")
    expect(sheet.getByRole("combobox", { name: "Numerator" })).toHaveTextContent("Units sold")
    expect(sheet.getByRole("combobox", { name: "Denominator" })).toHaveTextContent("Revenue amount")
  })

  it("sets a time summary", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Time summary" }), "Closing balance")
    await save(typist, sheet)
    await waitFor(() => expect(store.requests).toHaveLength(1))

    expect(store.requests[0].body).toEqual({
      time_summary: { method: "closing" },
    })
  })

  it("goes back to the same as the summary with a null time summary", async () => {
    const typist = userEvent.setup()
    const withTimeSummary = makeLineItem({
      ...unitsSold,
      time_summary: { method: "closing" },
    })
    const { store, sheet } = await openSheet(typist, unitsSold.id, {
      modelStructure: makeStructure({
        ...withLineItems,
        line_items: [withTimeSummary],
      }),
    })

    expect(sheet.getByRole("combobox", { name: "Time summary" })).toHaveTextContent(
      "Closing balance",
    )
    await choose(typist, sheet.getByRole("combobox", { name: "Time summary" }), "Same as summary")
    await save(typist, sheet)

    await waitFor(() => expect(store.requests).toHaveLength(1))
    expect(store.requests[0].body).toEqual({ time_summary: null })
  })

  it("has no time summary to choose for a module without Time", async () => {
    const typist = userEvent.setup()
    const noTime = makeModule({
      ...revenueModule,
      axes: [{ kind: "list", list: regionsId }],
    })
    const { sheet } = await openSheet(typist, unitsSold.id, {
      modelStructure: makeStructure({
        ...withLineItems,
        modules: [noTime],
      }),
    })

    expect(sheet.getByRole("combobox", { name: "Time summary" })).toBeDisabled()
    expect(sheet.getByRole("combobox", { name: "Time scale" })).toBeDisabled()
    expect(sheet.getAllByText("This module has no Time dimension.")).toHaveLength(2)
    expect(sheet.getByText("This module has no Versions dimension.")).toBeVisible()
  })
})

describe("the dimensions", () => {
  it("applies to the module's lists by default, and to chosen ones in an order of their own", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    expect(sheet.getByText("Regions, Products")).toBeVisible()

    await typist.click(sheet.getByRole("radio", { name: /Chosen lists and subsets/ }))
    // Starts from the module's own lists.
    const order = sheet.getByRole("list", { name: "Order of dimensions" })
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["1Regions", "2Products"])
    await typist.click(sheet.getByRole("checkbox", { name: /Regions/ }))
    await save(typist, sheet)
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )

    await waitFor(() =>
      expect(store.requests[0].body).toEqual({
        applies_to: [{ kind: "list", list: productsId }],
      }),
    )
  })

  it("chooses a time scale of the module's level or coarser", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await typist.click(sheet.getByRole("combobox", { name: "Time scale" }))
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Module default",
      "None",
      "Month",
      "Quarter",
      "Half year",
      "Year",
      "Total",
    ])
    await typist.click(screen.getByRole("option", { name: "Year" }))
    await save(typist, sheet)
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )

    await waitFor(() => expect(store.requests[0].body).toEqual({ time_scale: { level: "year" } }))
  })

  it("chooses the versions the line item has values for", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await typist.click(sheet.getByRole("radio", { name: "Chosen versions" }))
    await save(typist, sheet)
    expect(await sheet.findByText("Choose at least one version.")).toBeVisible()
    await typist.click(sheet.getByRole("checkbox", { name: "Forecast" }))
    await save(typist, sheet)
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )

    await waitFor(() =>
      expect(store.requests[0].body).toEqual({
        versions: { only: [forecastId] },
      }),
    )
  })
})

describe("clearing input values", () => {
  it("asks before it changes the format type of an input line item", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Text")
    await save(typist, sheet)

    const confirm = within(await screen.findByRole("alertdialog", { name: "Clear input values?" }))
    expect(confirm.getByText("This clears the line item's input values.")).toBeVisible()
    expect(store.requests).toEqual([])
    await typist.click(confirm.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(store.requests).toEqual([])
    expect(screen.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
    expect(sheet.getByRole("button", { name: "Save changes" })).toHaveFocus()

    await save(typist, sheet)
    await typist.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Save and clear values",
      }),
    )
    await waitFor(() => expect(store.requests).toHaveLength(1))
    expect(store.requests[0].body).toMatchObject({ format: { type: "text" } })
  })

  it("keeps the question open and its buttons busy while the change is saved", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)
    const release = store.hold()

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Text")
    await save(typist, sheet)
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

  it("asks before an input line item is given a formula", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    setFormula(sheet.getByLabelText("Formula"), "1 + 1")
    await save(typist, sheet)

    expect(await screen.findByRole("alertdialog", { name: "Clear input values?" })).toBeVisible()
  })

  it("does not ask for a change that keeps the values", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist)

    await choose(typist, sheet.getByRole("combobox", { name: "Summary" }), "Average")
    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests[0].body).toEqual({ summary: { method: "average" } })
  })

  it("does not ask for a calculated line item, which holds no values of its own", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)

    await choose(typist, sheet.getByRole("combobox", { name: "Format type" }), "Text")
    await save(typist, sheet)

    await waitFor(() => expect(store.requests).toHaveLength(1))
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})

describe("the formula", () => {
  const problems = [
    {
      code: "formula.unknown_name",
      message: "Unknown name 'Revnue'",
      start: 4,
      end: 10,
      suggestion: "Revenue",
    },
    {
      code: "formula.arity",
      message: "SUM takes 1 argument",
      start: 13,
      end: 20,
    },
  ]

  it("lists every problem the server finds under the formula, and selects the first", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)
    store.checkFormula = () => problems

    const formula = sheet.getByLabelText("Formula")
    setFormula(formula, "1 + Revnue + SUM(1, 2)")
    await save(typist, sheet)

    const alert = within(await sheet.findByRole("alert"))
    expect(alert.getByText("The formula has 2 problems.")).toBeVisible()
    expect(alert.getByText(/Unknown name 'Revnue'/)).toBeVisible()
    expect(alert.getByText(/Did you mean 'Revenue'\?/)).toBeVisible()
    expect(alert.getByText(/SUM takes 1 argument/)).toBeVisible()
    expect(formula).toHaveAttribute("aria-invalid", "true")
    expect(formula).toHaveFocus()
    const { from, to } = formulaView(formula).state.selection.main
    expect([from, to]).toEqual([4, 10])
    expect(screen.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
  })

  it("finds the problem by bytes, in a formula with letters of more than one", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)
    // "Umsätze" is 8 bytes and 7 characters; the problem is the name after it.
    store.checkFormula = () => [
      {
        code: "formula.unknown_name",
        message: "Unknown name",
        start: 11,
        end: 15,
      },
    ]

    const formula = sheet.getByLabelText("Formula")
    setFormula(formula, "Umsätze + Cost")
    await save(typist, sheet)

    await sheet.findByRole("alert")
    const { from, to } = formulaView(formula).state.selection.main
    expect([from, to]).toEqual([10, 14])
  })

  it("lists the problems of the saved formula as soon as the sheet opens, without announcing them", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id, {
      prepare: (store) => {
        store.formulaErrors[revenueAmount.id] = problems
      },
    })

    const formula = sheet.getByLabelText("Formula")
    expect(await sheet.findByText("The formula has 2 problems.")).toBeVisible()
    expect(sheet.getByText(/Unknown name 'Revnue'/)).toBeVisible()
    expect(sheet.getByText(/SUM takes 1 argument/)).toBeVisible()
    expect(formula).toHaveAttribute("aria-invalid", "true")
    expect(formula).toHaveAccessibleDescription(/The formula has 2 problems\./)
    expect(sheet.queryByRole("alert")).toBeNull()
  })

  it("shows no problem on open for a formula that works", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id)

    expect(sheet.getByLabelText("Formula")).not.toHaveAttribute("aria-invalid", "true")
    expect(sheet.queryByText(/The formula has/)).toBeNull()
  })

  it("replaces the problems of the saved formula with the server's refusal of a new one", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id, {
      prepare: (prepared) => {
        prepared.formulaErrors[revenueAmount.id] = [problems[0]]
      },
    })
    store.checkFormula = () => [problems[1]]
    await sheet.findByText("The formula has a problem.")

    setFormula(sheet.getByLabelText("Formula"), "Units sold + 1")
    expect(sheet.queryByText("The formula has a problem.")).toBeNull()
    await save(typist, sheet)

    const alert = within(await sheet.findByRole("alert"))
    expect(alert.getByText(/SUM takes 1 argument/)).toBeVisible()
    expect(alert.queryByText(/Unknown name 'Revnue'/)).toBeNull()
  })

  it("takes the refusal away once the formula is edited, and the problems once it checks out", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)
    store.checkFormula = () => problems

    setFormula(sheet.getByLabelText("Formula"), "Units sold + 1")
    await save(typist, sheet)
    await sheet.findByRole("alert")
    store.checkFormula = () => []
    setFormula(sheet.getByLabelText("Formula"), "Units sold + 2")

    expect(sheet.queryByRole("alert")).toBeNull()
    expect(sheet.queryByText(/The formula has/)).toBeNull()
    // The form takes the server's refusal off the field once it has checked the new formula.
    await waitFor(() =>
      expect(sheet.getByLabelText("Formula")).not.toHaveAttribute("aria-invalid", "true"),
    )
    // And the new formula checks out, so the problems stay away.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(sheet.queryByText(/The formula has/)).toBeNull()
  })

  it("asks the server to check once for a formula typed with pauses of less than 300 ms", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id)
    const asked: string[] = []
    // After the store, which accepts every formula.
    server.use(
      http.post("/api/v1/models/:id/formula/check", async ({ request }) => {
        asked.push(((await request.json()) as { formula: string }).formula)
        return HttpResponse.json({ ok: true, type: { type: "number" } })
      }),
    )
    const formula = sheet.getByLabelText("Formula")
    formula.focus()

    for (const text of ["Units sold * 2", "Units sold * 20", "Units sold * 200", "Units sold * 2000"]) {
      setFormula(formula, text)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(asked).toEqual(["Units sold * 2000"])
  })

  it("marks the problems of the saved formula in the formula", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id, {
      prepare: (store) => {
        store.formulaErrors[revenueAmount.id] = [problems[0]]
      },
    })

    await sheet.findByText("The formula has a problem.")

    await waitFor(() =>
      expect(document.querySelector(".cm-lintRange-error")).not.toBeNull(),
    )
  })

  it("closes the list of completions on Escape before it closes the sheet", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id)
    // After the store, which offers nothing.
    server.use(
      http.get("/api/v1/models/:id/formula/completions", () =>
        HttpResponse.json([{ label: "Units sold", kind: "line_item", detail: "Number" }]),
      ),
    )
    const formula = sheet.getByLabelText("Formula")
    formula.focus()
    setFormula(formula, "Un")
    await screen.findAllByRole("option")
    // The list ignores keys for a moment after it opens.
    await new Promise((resolve) => setTimeout(resolve, 100))

    await typist.keyboard("{Escape}")

    expect(screen.queryByRole("option")).toBeNull()
    expect(screen.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("saves a formula the server accepts", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)

    setFormula(sheet.getByLabelText("Formula"), "Units sold * 2")
    await save(typist, sheet)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(store.requests[0].body).toEqual({ formula: "Units sold * 2" })
  })

  it("makes a line item an input again when the formula is emptied", async () => {
    const typist = userEvent.setup()
    const { store, sheet } = await openSheet(typist, revenueAmount.id)

    setFormula(sheet.getByLabelText("Formula"), "")
    await save(typist, sheet)

    await waitFor(() => expect(store.requests[0].body).toEqual({ formula: null }))
  })
})

describe("who may change the settings", () => {
  it("shows a viewer the settings, none of them to change", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, revenueAmount.id, {
      role: "viewer",
    })

    expect(sheet.getByLabelText("Name")).toBeDisabled()
    expect(sheet.getByRole("combobox", { name: "Format type" })).toBeDisabled()
    expect(sheet.getByRole("combobox", { name: "Summary" })).toBeDisabled()
    expect(sheet.getByLabelText("Formula")).toHaveAttribute("aria-readonly", "true")
    expect(formulaText(sheet.getByLabelText("Formula"))).toBe("Units sold * Pricing.Unit price")
    expect(sheet.queryByRole("button", { name: "Save changes" })).toBeNull()
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Only workspace builders and admins can change it.",
    )
  })

  it("switches the form off in production mode, and says why", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, unitsSold.id, { mode: "prod" })

    expect(sheet.getByLabelText("Name")).toBeDisabled()
    expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled()
    expect(sheet.getByText(PRODUCTION_MESSAGE)).toBeVisible()
  })
})
