import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel } from "@/test/app"
import { apac, emea, listsStructure, openListsApp, regionsList } from "@/test/lists"
import { makeLineItem } from "@/test/structure"
import { header, lineItem, member, salesView, serveViewQuery } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import type { ViewQuery } from "@/features/grid/view-types"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// jsdom has no canvas: every character is 8 px wide.
vi.mock("@/features/grid/measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel()
const currencyId = "0192f3a0-0000-7000-8000-000000000801"
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

type Typist = ReturnType<typeof userEvent.setup>

/** Regions with one property, Currency, which the first region has as EUR and the second as JPY. */
function withProperty() {
  const structure = listsStructure()
  structure.modules = [
    {
      id: regionsList,
      name: "Regions Properties",
      functional_area: "System",
      axes: [{ kind: "list", list: regionsList }],
    },
  ]
  structure.line_items = [
    makeLineItem({
      id: currencyId,
      module: regionsList,
      name: "Currency",
      format: { type: "text" },
    }),
  ]
  return structure
}

function openProperties({
  path = `/lists/${regionsList}?tab=properties`,
  structure = withProperty(),
  ...options
}: Parameters<typeof openListsApp>[1] & { path?: string } = {}) {
  mockViewport(1000, 600)
  // Before the app is drawn, which asks for it at once.
  const served = serveViewQuery(
    salesView({
      rowDims: [{ kind: "list", list: regionsList }],
      columnDims: [{ kind: "line_items" }],
      totalRows: 2,
      totalColumns: 1,
      lineItems: [
        lineItem(currencyId, "Currency", {
          format: { type: "text" },
          dims: [{ kind: "list", list: regionsList }],
        }),
      ],
      rowHeader: (row) => header(member(row === 0 ? emea : apac, row === 0 ? "EMEA" : "APAC")),
      columnHeader: () => header(member(currencyId, "Currency")),
      cell: (row) => ({ value: { t: "text", v: row === 0 ? "EUR" : "JPY" }, flags: ["input"] }),
    }),
  )
  return { served, ...openListsApp(path, { structure, ...options }) }
}

async function page() {
  return within(await screen.findByRole("main"))
}

describe("the tabs of a list", () => {
  it("open on the items, with the properties one click away and in the address", async () => {
    const typist = userEvent.setup()
    const { router } = openProperties({ path: `/lists/${regionsList}` })
    const content = await page()

    expect(await content.findByRole("tab", { name: "Items" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(await content.findByRole("table", { name: "Items of Regions" })).toBeVisible()
    await typist.click(content.getByRole("tab", { name: "Properties" }))

    expect(router.state.location.search).toEqual({ tab: "properties" })
    expect(content.getByRole("tab", { name: "Properties" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(await content.findByRole("grid", { name: "Regions properties grid" })).toBeVisible()
    expect(content.queryByRole("table", { name: "Items of Regions" })).not.toBeInTheDocument()
  })

  it("open on the properties when the address says so", async () => {
    openProperties()

    expect(await (await page()).findByRole("tab", { name: "Properties" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("take any other tab in the address for the items", async () => {
    openProperties({ path: `/lists/${regionsList}?tab=nonsense` })

    expect(await (await page()).findByRole("tab", { name: "Items" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })
})

describe("the properties of a list", () => {
  it("show the grid with the items down the rows and the properties across", async () => {
    const { served } = openProperties()

    expect(
      await (await page()).findByRole("grid", { name: "Regions properties grid" }),
    ).toBeVisible()
    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    const query: ViewQuery = served.requests[0]
    expect(query).toMatchObject({
      module: regionsList,
      rows: [{ kind: "list", list: regionsList }],
      columns: [{ kind: "line_items" }],
      pages: [],
    })
    expect(await (await page()).findByRole("columnheader", { name: "Currency" })).toBeVisible()
    expect(await (await page()).findByRole("rowheader", { name: "EMEA" })).toBeVisible()
  })

  it("link to the Blueprint of the list's properties module", async () => {
    const typist = userEvent.setup()
    const { router } = openProperties()
    await typist.click(await (await page()).findByRole("link", { name: "Open Blueprint" }))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/m/${model.id}/modules/${regionsList}`),
    )
    expect(router.state.location.search).toEqual({ tab: "blueprint" })
  })

  it("let a viewer look but not enter values", async () => {
    openProperties({ role: "viewer" })

    const content = await page()
    expect(await content.findByRole("grid", { name: "Regions properties grid" })).toHaveAttribute(
      "aria-readonly",
      "true",
    )
    expect(content.queryByRole("button", { name: "Add property" })).not.toBeInTheDocument()
  })

  it("let a planner enter values but not add properties", async () => {
    openProperties({ role: "planner" })

    const content = await page()
    expect(
      await content.findByRole("grid", { name: "Regions properties grid" }),
    ).not.toHaveAttribute("aria-readonly")
    expect(content.queryByRole("button", { name: "Add property" })).not.toBeInTheDocument()
  })

  it("keep the grid and switch Add property off in production mode", async () => {
    openProperties({ mode: "prod" })

    const content = await page()
    expect(await content.findByRole("grid", { name: "Regions properties grid" })).toBeVisible()
    expect(content.getByText(PRODUCTION_MESSAGE)).toBeVisible()
    expect(content.getByRole("button", { name: "Add property" })).toBeDisabled()
  })
})

describe("a list without properties", () => {
  const without = () => listsStructure()

  it("says so and offers to add the first", async () => {
    openProperties({ structure: without() })

    const content = await page()
    expect(await content.findByRole("heading", { name: "No properties yet" })).toBeVisible()
    expect(content.getAllByRole("button", { name: "Add property" })).toHaveLength(1)
    expect(content.queryByRole("grid")).not.toBeInTheDocument()
  })

  it("offers a viewer nothing to add", async () => {
    openProperties({ structure: without(), role: "viewer" })

    const content = await page()
    expect(await content.findByRole("heading", { name: "No properties yet" })).toBeVisible()
    expect(content.queryByRole("button", { name: "Add property" })).not.toBeInTheDocument()
  })

  it("adds the first property to the list's own module and shows the grid", async () => {
    const typist = userEvent.setup()
    const { store } = openProperties({ structure: without() })
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Add property" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Add property" }))
    expect(
      dialog.getByText(
        "Name it and choose what it holds. Each item of Regions gets a value for it.",
      ),
    ).toBeVisible()
    await typist.type(dialog.getByRole("textbox", { name: "Name" }), "Currency")
    await typist.click(dialog.getByRole("button", { name: "Add property" }))

    expect(await content.findByRole("grid", { name: "Regions properties grid" })).toBeVisible()
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]).toMatchObject({
      method: "POST",
      path: `modules/${regionsList}/line-items`,
      body: { name: "Currency" },
    })
    expect(toast.success).toHaveBeenCalledWith("Property added")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("gives focus back to Add property when the dialog is dismissed", async () => {
    const typist: Typist = userEvent.setup()
    openProperties({ structure: without() })
    const content = await page()
    await typist.click(await content.findByRole("button", { name: "Add property" }))
    await typist.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(content.getByRole("button", { name: "Add property" })).toHaveFocus()
  })
})
