import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { violations } from "@/test/axe"
import { type ModuleStore, serveModuleStore } from "@/test/module-edits"
import {
  actualId,
  forecastId,
  makeLineItem,
  makeStructure,
  revenueAmount,
  revenueModule,
  structure,
  unitsSold,
} from "@/test/structure"
import { serveViewQuery } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"

vi.mock("@/features/grid/measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const margin = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000404",
  module: revenueModule.id,
  name: "Margin",
  ordinal: 2,
  notes: "Before tax",
  summary: { method: "ratio", numerator: unitsSold.id, denominator: revenueAmount.id },
  time_scale: { level: "year" },
  versions: { only: [forecastId] },
  applies_to: [{ kind: "list", list: structure.lists[0].id }],
})
const withLineItems = makeStructure({
  ...structure,
  versions: [
    { id: actualId, name: "Actual", is_actual: true, is_current: false },
    { id: forecastId, name: "Forecast", is_actual: false, is_current: true },
  ],
  line_items: [unitsSold, revenueAmount, margin],
})
const modulePath = `/m/${model.id}/modules/${revenueModule.id}`

function open(
  path: string,
  {
    role = "admin",
    modelStructure = withLineItems,
    prepare,
    rows = true,
  }: {
    role?: "admin" | "viewer"
    modelStructure?: StructureDto
    /** Sets the store up before the page is drawn. */
    prepare?: (store: ModuleStore) => void
    /** Answer queries with the rows of a grid, not the line items of the store. */
    rows?: boolean
  } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([model])
  const store = serveModuleStore(modelStructure)
  prepare?.(store)
  if (rows) {
    serveViewQuery()
  }
  renderApp(path)
  return store
}

beforeEach(() => {
  mockViewport(900, 500)
})

describe("the modules page", () => {
  it("has no accessibility violations", async () => {
    open(`/m/${model.id}/modules`)
    await screen.findByRole("table", { name: "Finance" })

    expect(await violations()).toEqual([])
  })

  it("has none when it is empty", async () => {
    open(`/m/${model.id}/modules`, { modelStructure: makeStructure() })
    await screen.findByRole("heading", { name: "No modules yet" })

    expect(await violations()).toEqual([])
  })

  it("has none with the dialog for a new module open and dimensions chosen", async () => {
    const typist = userEvent.setup()
    open(`/m/${model.id}/modules`)
    await typist.click(await screen.findByRole("button", { name: "New module" }))
    const dialog = within(await screen.findByRole("dialog", { name: "New module" }))
    await typist.click(dialog.getByRole("checkbox", { name: /Regions/ }))
    await typist.click(dialog.getByRole("checkbox", { name: /Products/ }))
    await typist.click(dialog.getByRole("switch", { name: "Time" }))

    expect(await violations()).toEqual([])
  })
})

describe("a module's page", () => {
  it("has none on the grid tab", async () => {
    open(modulePath)
    await screen.findByRole("grid", { name: "Revenue grid" })

    expect(await violations()).toEqual([])
  })

  it.each([
    ["for a builder", "admin"],
    ["for a viewer", "viewer"],
  ] as const)("has none on the Blueprint %s", async (_, role) => {
    open(`${modulePath}?tab=blueprint&li=${revenueAmount.id}`, { role })
    await screen.findByRole("grid", { name: "Line items" })

    expect(await violations()).toEqual([])
  })

  it("has none on a Blueprint with a formula error", async () => {
    open(`${modulePath}?tab=blueprint`, {
      rows: false,
      prepare: (store) => {
        store.formulaErrors[revenueAmount.id] = [
          { code: "formula.unknown_name", message: "Unknown name 'Units'", start: 0, end: 5 },
        ]
      },
    })
    const table = await screen.findByRole("grid", { name: "Line items" })
    await within(table).findByRole("img", { name: /Formula error/ })

    expect(await violations()).toEqual([])
  })

  it("has none while a title is being renamed", async () => {
    const typist = userEvent.setup()
    open(modulePath)
    await typist.click(await screen.findByRole("button", { name: "Rename module" }))
    await screen.findByRole("textbox", { name: "Module name" })

    expect(await violations()).toEqual([])
  })

  it("has none with the module settings open", async () => {
    const typist = userEvent.setup()
    open(modulePath)
    await typist.click(await screen.findByRole("button", { name: "Module settings" }))
    await screen.findByRole("dialog", { name: "Module settings" })

    expect(await violations()).toEqual([])
  })

  it("has none with the dialog for a new line item open", async () => {
    const typist = userEvent.setup()
    open(`${modulePath}?tab=blueprint`)
    await typist.click(await screen.findByRole("button", { name: "Add line item" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Add line item" }))
    await typist.click(dialog.getByRole("combobox", { name: "Format type" }))
    await typist.click(await screen.findByRole("option", { name: "List" }))

    expect(await violations()).toEqual([])
  })
})

describe("the settings of a line item", () => {
  async function openSheet(
    typist: ReturnType<typeof userEvent.setup>,
    lineItem: string,
    role: "admin" | "viewer" = "admin",
  ) {
    const store = open(`${modulePath}?tab=blueprint&li=${lineItem}`, { role })
    const table = await screen.findByRole("grid", { name: "Line items" })
    table.focus()
    await typist.keyboard("{Enter}")
    const sheet = within(await screen.findByRole("dialog", { name: "Line item settings" }))
    return Object.assign(sheet, { store })
  }

  it("has none for an input line item with number options", async () => {
    const typist = userEvent.setup()
    await openSheet(typist, unitsSold.id)

    expect(await violations()).toEqual([])
  })

  it("has none for a calculated line item with a currency", async () => {
    const typist = userEvent.setup()
    await openSheet(typist, revenueAmount.id)

    expect(await violations()).toEqual([])
  })

  it("has none for a line item with a ratio, chosen lists and chosen versions", async () => {
    const typist = userEvent.setup()
    await openSheet(typist, margin.id)

    expect(await violations()).toEqual([])
  })

  it("has none read-only", async () => {
    const typist = userEvent.setup()
    await openSheet(typist, margin.id, "viewer")

    expect(await violations()).toEqual([])
  })

  it("has none with the problems of a formula shown", async () => {
    const typist = userEvent.setup()
    const sheet = await openSheet(typist, revenueAmount.id)
    sheet.store.checkFormula = () => [
      {
        code: "formula.unknown_name",
        message: "Unknown name 'Units'",
        start: 0,
        end: 5,
        suggestion: "Units sold",
      },
    ]
    await typist.type(sheet.getByLabelText("Formula"), " + 1")
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    await sheet.findByRole("alert")

    expect(await violations()).toEqual([])
  })

  it("has none with the confirmation to clear values open", async () => {
    const typist = userEvent.setup()
    const sheet = await openSheet(typist, unitsSold.id)
    await typist.click(sheet.getByRole("combobox", { name: "Format type" }))
    await typist.click(await screen.findByRole("option", { name: "Text" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))
    await screen.findByRole("alertdialog", { name: "Clear input values?" })

    expect(await violations()).toEqual([])
  })
})
