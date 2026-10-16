import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewDefinition, ViewDim, ViewQuery } from "@/features/grid/view-types"
import type { components } from "@/lib/api/schema"
import { queryKeys } from "@/lib/api/keys"
import { problem } from "@/test/problem"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { formulaText, setFormula } from "@/test/formula"
import { serveModuleStore } from "@/test/module-edits"
import { server } from "@/test/server"
import {
  costsModule,
  makeLineItem,
  makeStructure,
  productsId,
  regionsId,
  revenueAmount,
  revenueModule,
  structure,
  unitsSold,
} from "@/test/structure"
import type { StructureDto } from "@/features/structure/types"
import {
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import { makeView, memberOf, serveMembers, serveViews } from "@/test/views"
import { mockViewport } from "@/test/viewport"
import { DEFAULT_VIEW_KEY } from "@/features/grid/toolbar/view-draft"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
// jsdom has no canvas: every character is 8 px wide.
vi.mock("@/features/grid/measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test draws the whole app and drives it through msw, which is slow while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const model = makeModel({ name: "Revenue plan" })
const revenuePath = `/m/${model.id}/modules/${revenueModule.id}`

const regions: ViewDim = { kind: "list", list: regionsId }
const products: ViewDim = { kind: "list", list: productsId }
const time: ViewDim = { kind: "time" }
const versions: ViewDim = { kind: "versions" }

/** The default pivot of Revenue, as a saved view holds it. */
const standard: ViewDefinition = {
  rows: [lineItemsDim],
  columns: [time],
  pages: [
    { dim: regions, key: null },
    { dim: products, key: null },
    { dim: versions, key: null },
  ],
}

const regionMembers = [
  memberOf("top", "All regions", { is_summary: true, has_children: true }),
  memberOf("emea", "EMEA", { depth: 1 }),
  memberOf("apac", "Asia Pacific", { depth: 1 }),
]

function membersOf(dim: ViewDim) {
  if (dim.kind === "versions") {
    return [memberOf("v-actual", "Actual"), memberOf("v-forecast", "Forecast")]
  }
  return dim.kind === "list" && dim.list === regionsId
    ? regionMembers
    : [memberOf("p1", "Widgets"), memberOf("p2", "Gadgets")]
}

interface Options {
  role?: components["schemas"]["WorkspaceRole"]
  mode?: "dev" | "prod"
  views?: ReturnType<typeof makeView>[]
  path?: string
  structure?: StructureDto
}

function openModule({
  role = "admin",
  mode = "dev",
  views = [],
  path = revenuePath,
  structure: served = structure,
}: Options = {}) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const modules = serveModuleStore(served)
  const store = serveViews(views)
  const members = serveMembers(membersOf)
  // After the module store, which answers queries with no rows, so that the grid has some to show.
  const queries = serveViewQuery()
  const app = renderApp(path)
  return { store, members, served: queries, modules, ...app }
}

const lastQuery = (served: { requests: ViewQuery[] }) => served.requests.at(-1) as ViewQuery

async function grid() {
  return within(await screen.findByRole("main")).findByRole("grid", { name: "Revenue grid" })
}

/** The toolbar, once the grid has drawn. */
async function toolbar() {
  await grid()
  return within(screen.getByRole("group", { name: "Grid controls" }))
}

async function chooseView(name: string | RegExp) {
  const user = userEvent.setup()
  await user.click((await toolbar()).getByRole("combobox", { name: "Saved view" }))
  await user.click(await screen.findByRole("option", { name }))
}

async function viewAction(name: string) {
  const user = userEvent.setup()
  await user.click((await toolbar()).getByRole("button", { name: "View actions" }))
  await user.click(await screen.findByRole("menuitem", { name }))
  return user
}

async function swap() {
  const user = userEvent.setup()
  await user.click((await toolbar()).getByRole("button", { name: "Pivot" }))
  await user.click(await screen.findByRole("button", { name: "Swap rows and columns" }))
  await user.keyboard("{Escape}")
}

const draftKey = (view = DEFAULT_VIEW_KEY) =>
  `openplan.view-draft.${revenueModule.id}.${view}`

/** A second module with a line item of its own, to move to and from Revenue. */
const costsAmount = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000405",
  module: costsModule.id,
  name: "Cost amount",
  ordinal: 0,
})
const twoModules = makeStructure({
  ...structure,
  line_items: [...structure.line_items, costsAmount],
})
const costsPath = `/m/${model.id}/modules/${costsModule.id}`
const costsDraftKey = `openplan.view-draft.${costsModule.id}.${DEFAULT_VIEW_KEY}`

async function gridOf(moduleName: string) {
  return within(await screen.findByRole("main")).findByRole("grid", { name: `${moduleName} grid` })
}

function goTo(router: ReturnType<typeof renderApp>["router"], moduleId: string) {
  return act(() =>
    router.navigate({
      to: "/m/$modelId/modules/$moduleId",
      params: { modelId: model.id, moduleId },
    }),
  )
}

beforeEach(() => {
  mockViewport(900, 500)
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("which view the grid opens", () => {
  it("opens the default pivot when the module has no saved view", async () => {
    const { served } = openModule()

    await grid()

    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] })
    expect((await toolbar()).getByRole("combobox", { name: "Saved view" })).toHaveTextContent("Default")
  })

  it("opens the module's default saved view when there is one", async () => {
    const forecast = makeView({
      id: "view-forecast",
      module_id: revenueModule.id,
      name: "Forecast review",
      is_default: true,
      definition: { ...standard, rows: [time], columns: [lineItemsDim], show_summaries: false },
    })
    const { served, router } = openModule({ views: [forecast, makeView({ name: "Other", id: "o" })] })

    expect((await toolbar()).getByRole("combobox", { name: "Saved view" })).toHaveTextContent(
      "Forecast review",
    )
    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    expect(lastQuery(served)).toMatchObject({
      rows: [time],
      columns: [lineItemsDim],
      show_summaries: false,
    })
    expect(router.state.location.search).toEqual({})
  })

  it("opens the view named in the address", async () => {
    const other = makeView({
      id: "view-other",
      module_id: revenueModule.id,
      name: "Quarterly",
      definition: { ...standard, columns: [versions], pages: [{ dim: time, key: null }] },
    })
    const { served } = openModule({ views: [other], path: `${revenuePath}?view=view-other` })

    expect((await toolbar()).getByRole("combobox", { name: "Saved view" })).toHaveTextContent("Quarterly")
    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    expect(lastQuery(served).columns).toEqual([versions])
  })

  it("falls back to the default view, with a toast, for a view that is not there", async () => {
    const { router, served } = openModule({ path: `${revenuePath}?view=view-gone` })

    await grid()

    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(
      "That view no longer exists. Showing the default view instead.",
    )
    expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] })
  })

  it("puts the chosen view in the address, and leaves the default out of it", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly" })
    const { router, served } = openModule({ views: [quarterly] })

    await chooseView("Quarterly")
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "view-q" }))

    await chooseView("Default")
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] })
  })

  it("tells the user when a view was cut down to what the module still has", async () => {
    const pruned = makeView({
      id: "view-p",
      module_id: revenueModule.id,
      name: "Old",
      pruned: true,
      definition: standard,
    })
    openModule({ views: [pruned], path: `${revenuePath}?view=view-p` })

    await grid()

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Some of this view's settings no longer apply to the module. Save the view to keep it as shown.",
        { id: "pruned-view-p" },
      ),
    )
    expect(
      (await toolbar()).queryByText("Modified"),
    ).not.toBeInTheDocument()
  })

  it("keeps showing the grid when the saved views cannot be read, says why, and offers to read them again", async () => {
    const user = userEvent.setup()
    openModule()
    let failing = true
    server.use(
      http.get("/api/v1/models/:id/modules/:moduleId/views", () =>
        failing
          ? HttpResponse.json(
              { type: "about:blank", title: "Busy", status: 503, code: "server.busy", detail: "Busy." },
              { status: 503, headers: { "Content-Type": "application/problem+json" } },
            )
          : HttpResponse.json([]),
      ),
    )

    const bar = await toolbar()
    failing = false
    await user.click(await bar.findByRole("button", { name: "Saved views: couldn't load" }))
    expect(await screen.findByText("Busy.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(await bar.findByRole("combobox", { name: "Saved view" })).toBeVisible()
  })
})

describe("changing the pivot", () => {
  it("swaps the rows and the columns, marks the view as modified, and asks for the swapped pivot", async () => {
    const { served } = openModule()

    await swap()

    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [time], columns: [lineItemsDim] }))
    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })

  it("moves a dimension to another zone from the menu of its chip", async () => {
    const user = userEvent.setup()
    const { served } = openModule()

    await user.click((await toolbar()).getByRole("button", { name: "Pivot" }))
    await user.click(await screen.findByRole("button", { name: "Move Regions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Move to Columns" }))

    await waitFor(() =>
      expect(lastQuery(served)).toMatchObject({
        columns: [time, regions],
        pages: [
          { dim: products, key: null },
          { dim: versions, key: null },
        ],
      }),
    )
  })

  it("shows the names of the row and column dimensions in the corner", async () => {
    openModule()

    const corner = (await grid()).querySelector<HTMLElement>("[data-corner-label]")
    expect(corner).toHaveTextContent("Line items / Months")
    await swap()
    await waitFor(() =>
      expect(document.querySelector("[data-corner-label]")).toHaveTextContent("Months / Line items"),
    )
  })

  it("chooses the member of a page from its selector", async () => {
    const user = userEvent.setup()
    const { served } = openModule()

    const bar = await toolbar()
    await user.click(await bar.findByRole("combobox", { name: /^Regions/ }))
    await user.click(await screen.findByRole("option", { name: "EMEA" }))

    await waitFor(() =>
      expect(lastQuery(served).pages?.[0]).toEqual({ dim: regions, key: "emea" }),
    )
    expect(bar.getByText("Modified")).toBeVisible()
  })

  it("asks for the members of the dimensions on the pages, with the totals the view shows", async () => {
    const { members } = openModule()

    await toolbar()

    await waitFor(() => expect(members.requests.length).toBe(3))
    expect(members.requests.map((request) => request.dim).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      regions,
      products,
      versions,
    ])
    expect(members.requests.every((request) => request.show_summaries === true)).toBe(true)
  })

  it("turns the summaries off from the toolbar", async () => {
    const user = userEvent.setup()
    const { served } = openModule()

    await user.click((await toolbar()).getByRole("button", { name: "Summaries" }))

    await waitFor(() => expect(lastQuery(served).show_summaries).toBe(false))
    expect(screen.getByRole("button", { name: "Summaries" })).toHaveAttribute("aria-pressed", "false")
  })

  it("applies a filter to the query", async () => {
    const user = userEvent.setup()
    const { served } = openModule()

    await user.click((await toolbar()).getByRole("button", { name: "Filter" }))
    await user.click(await screen.findByRole("button", { name: "Add filter" }))
    await user.click(screen.getByRole("combobox", { name: /Line item of filter 1/ }))
    await user.click(await screen.findByRole("option", { name: "Revenue amount" }))
    await user.click(screen.getByRole("combobox", { name: /Condition of filter 1/ }))
    await user.click(await screen.findByRole("option", { name: "is greater than" }))
    await user.type(screen.getByRole("textbox", { name: "Value of filter 1" }), "100")
    await user.click(screen.getByRole("button", { name: "Apply" }))

    await waitFor(() =>
      expect(lastQuery(served).filters).toEqual([
        { line_item: "0192f3a0-0000-7000-8000-000000000403", op: "gt", value: { t: "number", v: 100 } },
      ]),
    )
    expect(await screen.findByRole("button", { name: "Filter, 1 active" })).toBeVisible()
  })

  it("hides a member from the query", async () => {
    const user = userEvent.setup()
    const saved = makeView({
      id: "view-r",
      module_id: revenueModule.id,
      name: "By region",
      is_default: true,
      definition: { ...standard, rows: [regions, lineItemsDim], pages: [{ dim: products, key: null }, { dim: versions, key: null }] },
    })
    const { served } = openModule({ views: [saved] })

    await user.click((await toolbar()).getByRole("button", { name: "Show/hide" }))
    await user.click(await screen.findByRole("checkbox", { name: "Asia Pacific" }))

    await waitFor(() =>
      expect(lastQuery(served).hidden).toEqual([{ dim: regions, key: "apac" }]),
    )
    expect(await screen.findByRole("button", { name: "Show/hide, 1 hidden" })).toBeVisible()
  })

  it("colours the cells a rule matches", async () => {
    const user = userEvent.setup()
    openModule()
    const cells = await grid()
    await waitFor(() => expect(cells.querySelector("[data-row='0'][data-col='0']")?.textContent).not.toBe(""))

    await user.click((await toolbar()).getByRole("button", { name: "Conditional formatting" }))
    await user.click(await screen.findByRole("button", { name: "Add rule" }))
    await user.click(screen.getByRole("combobox", { name: /Condition of rule 1/ }))
    await user.click(await screen.findByRole("option", { name: "is greater than" }))
    await user.type(screen.getByRole("textbox", { name: "Value of rule 1" }), "10")
    await user.click(screen.getByRole("radio", { name: "Blue" }))
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    // Number line items of the sales view hold row * 1000 + column, so the first row is 0, 25 ..., the second above 10.
    await waitFor(() =>
      expect(cells.querySelector("[data-row='1'][data-col='0']")).toHaveClass("bg-blue-500/15"),
    )
    expect(cells.querySelector("[data-row='0'][data-col='0']")).not.toHaveClass("bg-blue-500/15")
    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })

  it("keeps a resized column with the view, which is then modified", async () => {
    openModule()
    const cells = await grid()
    await waitFor(() => expect(cells.querySelector("[data-row='0'][data-col='0']")).not.toBeNull())
    const handle = cells.querySelector<HTMLElement>("[data-resize='column']") as HTMLElement

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 350, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 350, pointerId: 1 })

    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })
})

describe("saved views", () => {
  it("saves the view as a new one, as the default, and then opens it when the module is reopened", async () => {
    const user = userEvent.setup()
    const { store, router } = openModule()
    await swap()

    await viewAction("Save as…")
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Months down")
    await user.click(screen.getByRole("checkbox", { name: "Set as default" }))
    await user.click(screen.getByRole("button", { name: "Save view" }))

    await waitFor(() => expect(store.views).toHaveLength(1))
    expect(store.views[0]).toMatchObject({
      name: "Months down",
      is_default: true,
      definition: { rows: [time], columns: [lineItemsDim] },
    })
    const bar = await toolbar()
    await waitFor(() => expect(bar.queryByText("Modified")).not.toBeInTheDocument())
    expect(router.state.location.search).toEqual({})
    expect(sessionStorage.getItem(draftKey())).toBeNull()
    expect(bar.getByRole("combobox", { name: "Saved view" })).toHaveTextContent("Months down")
    expect(toast.success).toHaveBeenCalledWith("View saved")
  })

  it("opens a module again on the view that was saved as the default", async () => {
    const saved = makeView({
      id: "view-d",
      module_id: revenueModule.id,
      name: "Months down",
      is_default: true,
      definition: { ...standard, rows: [time], columns: [lineItemsDim] },
    })
    const { served } = openModule({ views: [saved] })

    await grid()

    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [time], columns: [lineItemsDim] }))
  })

  it("marks a view as modified, and clears the mark when it is saved", async () => {
    const quarterly = makeView({
      id: "view-q",
      module_id: revenueModule.id,
      name: "Quarterly",
      definition: standard,
    })
    const { store } = openModule({ views: [quarterly], path: `${revenuePath}?view=view-q` })
    await swap()
    const bar = await toolbar()
    expect(bar.getByText("Modified")).toBeVisible()

    await viewAction("Save")

    await waitFor(() => expect(bar.queryByText("Modified")).not.toBeInTheDocument())
    expect(store.views[0].definition).toMatchObject({ rows: [time], columns: [lineItemsDim] })
    expect(store.requests).toEqual([
      { action: "update", id: "view-q", body: { definition: expect.objectContaining({ rows: [time] }) } },
    ])
  })

  it("gives up the changes on Discard changes", async () => {
    const { served } = openModule()
    await swap()
    const bar = await toolbar()
    expect(bar.getByText("Modified")).toBeVisible()

    await viewAction("Discard changes")

    await waitFor(() => expect(bar.queryByText("Modified")).not.toBeInTheDocument())
    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] }))
    expect(sessionStorage.getItem(draftKey())).toBeNull()
  })

  it("shows a planner the views and the changes, but no way to save", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly" })
    const user = userEvent.setup()
    openModule({ role: "planner", views: [quarterly] })
    const bar = await toolbar()

    expect(bar.getByRole("combobox", { name: "Saved view" })).toBeVisible()
    expect(bar.queryByRole("button", { name: "View actions" })).not.toBeInTheDocument()
    await swap()
    expect(bar.getByText("Modified")).toBeVisible()
    await user.click(bar.getByRole("button", { name: "View actions" }))
    expect(await screen.findByRole("menuitem", { name: "Discard changes" })).toBeVisible()
    expect(screen.queryByRole("menuitem", { name: /^Save/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Set as default" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Delete view…" })).not.toBeInTheDocument()
  })

  it("can be saved in production mode, which locks the structure and not the views", async () => {
    const user = userEvent.setup()
    openModule({ mode: "prod" })
    await swap()

    await user.click((await toolbar()).getByRole("button", { name: "View actions" }))

    expect(await screen.findByRole("menuitem", { name: "Save as…" })).not.toHaveAttribute("aria-disabled")
  })

  it("saves a view that was cut down to what the module has as it is shown, which ends the notice", async () => {
    const pruned = makeView({
      id: "view-p",
      module_id: revenueModule.id,
      name: "Old",
      pruned: true,
      definition: standard,
    })
    const { store } = openModule({ views: [pruned], path: `${revenuePath}?view=view-p` })
    const bar = await toolbar()
    expect(bar.queryByText("Modified")).not.toBeInTheDocument()

    const user = await viewAction("Save")

    await waitFor(() =>
      expect(store.requests).toEqual([
        { action: "update", id: "view-p", body: { definition: standard } },
      ]),
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("View saved"))
    await user.click(bar.getByRole("button", { name: "View actions" }))
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Save" })).toHaveAttribute("aria-disabled", "true"),
    )
  })

  it("says another view became the default, and reads the views again, when setting the default is refused", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly" })
    const detail = "Another view became the module's default at the same time. Try again."
    const { store } = openModule({ views: [quarterly], path: `${revenuePath}?view=view-q` })
    server.use(
      http.patch("/api/v1/models/:id/views/:viewId", () =>
        problem(409, "view.default_conflict", detail),
      ),
    )
    await toolbar()
    const reads = store.reads

    await viewAction("Set as default")

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(detail))
    await waitFor(() => expect(store.reads).toBeGreaterThan(reads))
  })

  it("says under Set as default that another view became the default, and reads the views again", async () => {
    const detail = "Another view became the module's default at the same time. Try again."
    const user = userEvent.setup()
    const { store } = openModule()
    server.use(
      http.post("/api/v1/models/:id/modules/:moduleId/views", () =>
        problem(409, "view.default_conflict", detail),
      ),
    )
    await swap()
    const reads = store.reads

    await viewAction("Save as…")
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Months down")
    await user.click(screen.getByRole("checkbox", { name: "Set as default" }))
    await user.click(screen.getByRole("button", { name: "Save view" }))

    expect(await screen.findByText(detail)).toBeVisible()
    expect(screen.getByRole("dialog", { name: "Save as a new view" })).toBeVisible()
    await waitFor(() => expect(store.reads).toBeGreaterThan(reads))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("deletes the view in use and falls back to the default, without a toast about a missing view", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly" })
    const { store, router } = openModule({ views: [quarterly], path: `${revenuePath}?view=view-q` })

    const user = await viewAction("Delete view…")
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete view" }),
    )

    await waitFor(() => expect(store.views).toEqual([]))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(toast.error).not.toHaveBeenCalled()
    expect((await toolbar()).getByRole("combobox", { name: "Saved view" })).toHaveTextContent("Default")
  })
})

describe("a view that is deleted or changed by someone else", () => {
  const quarterly = makeView({
    id: "view-q",
    module_id: revenueModule.id,
    name: "Quarterly",
    definition: standard,
  })

  it("is not an address that Back returns to once it is deleted", async () => {
    const { store, router } = openModule({ views: [quarterly] })
    await chooseView("Quarterly")
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "view-q" }))

    const user = await viewAction("Delete view…")
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete view" }),
    )
    await waitFor(() => expect(store.views).toEqual([]))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    await act(async () => router.history.back())

    expect(router.state.location.search).toEqual({})
    expect(router.history.location.pathname).toBe(revenuePath)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("is followed again once the changes made to it are undone", async () => {
    const user = userEvent.setup()
    const { store, served, queryClient } = openModule({
      views: [quarterly],
      path: `${revenuePath}?view=view-q`,
    })
    const bar = await toolbar()
    await user.click(bar.getByRole("button", { name: "Summaries" }))
    await waitFor(() => expect(bar.getByText("Modified")).toBeVisible())
    await user.click(bar.getByRole("button", { name: "Summaries" }))
    await waitFor(() => expect(bar.queryByText("Modified")).not.toBeInTheDocument())
    expect(sessionStorage.getItem(draftKey("view-q"))).toBeNull()

    // A colleague saves the view with the months down.
    store.views = [{ ...quarterly, definition: { ...standard, rows: [time], columns: [lineItemsDim] } }]
    await act(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.views(model.id, revenueModule.id) }),
    )

    await waitFor(() =>
      expect(lastQuery(served)).toMatchObject({ rows: [time], columns: [lineItemsDim] }),
    )
    expect(bar.queryByText("Modified")).not.toBeInTheDocument()
  })
})

describe("moving to another module", () => {
  it("does not put the changes of one module on another that was opened before", async () => {
    const { served, router } = openModule({ structure: twoModules, path: costsPath })
    await gridOf("Costs")
    await goTo(router, revenueModule.id)
    await gridOf("Revenue")
    await swap()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).not.toBeNull())

    await goTo(router, costsModule.id)
    await gridOf("Costs")

    await waitFor(() =>
      expect(lastQuery(served)).toMatchObject({
        module: costsModule.id,
        rows: [lineItemsDim],
        columns: [time],
      }),
    )
    expect(screen.queryByText("Modified")).not.toBeInTheDocument()
    expect(sessionStorage.getItem(costsDraftKey)).toBeNull()
    expect(sessionStorage.getItem(draftKey())).not.toBeNull()
  })

  it("keeps the changes of a module while another one is looked at, and gives them back", async () => {
    const { served, router } = openModule({ structure: twoModules })
    await swap()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).not.toBeNull())

    await goTo(router, costsModule.id)
    await gridOf("Costs")
    await goTo(router, revenueModule.id)
    await gridOf("Revenue")

    await waitFor(() =>
      expect(lastQuery(served)).toMatchObject({
        module: revenueModule.id,
        rows: [time],
        columns: [lineItemsDim],
      }),
    )
    expect((await toolbar()).getByText("Modified")).toBeVisible()
    expect(sessionStorage.getItem(draftKey())).not.toBeNull()
  })
})

describe("changes that are not saved", () => {
  it("are kept for the browser session, and come back when the module is opened again", async () => {
    openModule()
    await swap()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).not.toBeNull())
    expect(JSON.parse(sessionStorage.getItem(draftKey()) as string)).toMatchObject({
      rows: [time],
      columns: [lineItemsDim],
    })
    cleanup()

    const { served } = openModule()

    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [time], columns: [lineItemsDim] }))
    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })

  it("are given up when another view is chosen", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly", definition: standard })
    openModule({ views: [quarterly] })
    await swap()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).not.toBeNull())

    await chooseView("Quarterly")

    await waitFor(() => expect(sessionStorage.getItem(draftKey())).toBeNull())
    expect((await toolbar()).queryByText("Modified")).not.toBeInTheDocument()
  })

  it("are kept per view", async () => {
    const quarterly = makeView({ id: "view-q", module_id: revenueModule.id, name: "Quarterly", definition: standard })
    openModule({ views: [quarterly], path: `${revenuePath}?view=view-q` })
    await swap()

    await waitFor(() => expect(sessionStorage.getItem(draftKey("view-q"))).not.toBeNull())
    expect(sessionStorage.getItem(draftKey())).toBeNull()
  })

  it("do not stop the grid when the browser will not keep them", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const { served } = openModule()

    await swap()

    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [time] }))
    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })

  it("are ignored when they are not a view of this module any more", async () => {
    sessionStorage.setItem(
      draftKey(),
      JSON.stringify({ rows: [lineItemsDim], columns: [], pages: [] }),
    )
    const { served } = openModule()

    await grid()

    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] })
    expect((await toolbar()).queryByText("Modified")).not.toBeInTheDocument()
  })
})

describe("changes that no longer fit the module", () => {
  const deletedItem = "0192f3a0-0000-7000-8000-0000000000ff"

  it("are ignored when they name a member that was deleted since", async () => {
    sessionStorage.setItem(
      draftKey(),
      JSON.stringify({ ...standard, hidden: [{ dim: regions, key: deletedItem }] }),
    )
    const { served } = openModule()

    await grid()

    await waitFor(() => expect(served.requests.length).toBeGreaterThan(0))
    expect(lastQuery(served).hidden).toBeUndefined()
    expect((await toolbar()).queryByText("Modified")).not.toBeInTheDocument()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).toBeNull())
  })

  it("are given up when a dimension of the module is taken away under them", async () => {
    const { served, modules, queryClient } = openModule()
    await swap()
    await waitFor(() => expect(lastQuery(served)).toMatchObject({ rows: [time] }))

    modules.structure = {
      ...modules.structure,
      modules: modules.structure.modules.map((module) =>
        module.id === revenueModule.id
          ? { ...module, axes: module.axes.filter((axis) => axis.kind !== "versions") }
          : module,
      ),
    }
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.structure(model.id) }))

    await waitFor(() =>
      expect(lastQuery(served)).toMatchObject({ rows: [lineItemsDim], columns: [time] }),
    )
    expect(lastQuery(served).pages?.map((page) => page.dim)).toEqual([regions, products])
    expect((await toolbar()).queryByText("Modified")).not.toBeInTheDocument()
    await waitFor(() => expect(sessionStorage.getItem(draftKey())).toBeNull())
  })
})

describe("the formula bar across views", () => {
  const revenueRows = salesView({
    rowDims: [lineItemsDim],
    columnDims: [time],
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

  async function selectRevenueRow(user: ReturnType<typeof userEvent.setup>) {
    const cells = await grid()
    await screen.findByRole("textbox", { name: /^Formula of / })
    const cell = await waitFor(() => {
      const found = cells.querySelector<HTMLElement>("[data-row='1'][data-col='0']")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    await user.click(cell)
    return screen.findByRole("textbox", { name: "Formula of Revenue amount" })
  }

  it("keeps the formula that was typed when another view is chosen", async () => {
    const quarterly = makeView({
      id: "view-q",
      module_id: revenueModule.id,
      name: "Quarterly",
      definition: standard,
    })
    const user = userEvent.setup()
    const { served } = openModule({ views: [quarterly] })
    served.fixture = revenueRows
    setFormula(await selectRevenueRow(user), "Units sold * 2")

    await chooseView("Quarterly")

    expect(formulaText(await selectRevenueRow(user))).toBe("Units sold * 2")
  })
})

describe("row headers sized up front", () => {
  const regionView = makeView({
    id: "view-r",
    module_id: revenueModule.id,
    name: "By region",
    is_default: true,
    definition: {
      ...standard,
      rows: [regions],
      columns: [lineItemsDim],
      pages: [
        { dim: products, key: null },
        { dim: versions, key: null },
        { dim: time, key: null },
      ],
    },
  })

  it("holds the grid back until the members of the row dimensions say how they nest", async () => {
    mockSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    openModule({ views: [regionView] })
    server.use(
      http.post("/api/v1/models/:id/members", async ({ request }) => {
        const body = (await request.json()) as { dim: ViewDim }
        if (body.dim.kind === "list" && body.dim.list === regionsId) {
          await gate
        }
        return HttpResponse.json({ members: membersOf(body.dim) })
      }),
    )

    await screen.findAllByRole("status", { name: "Loading grid" })
    expect(screen.queryByRole("grid", { name: "Revenue grid" })).not.toBeInTheDocument()
    await act(async () => release())

    expect(await grid()).toBeVisible()
  })

  it("keeps the room of a chevron on every row of a dimension that has children, and sizes the header from the labels", async () => {
    openModule({ views: [regionView] })

    const cells = await grid()
    await waitFor(() => expect(cells.querySelector("[data-row='0'][data-col='0']")).not.toBeNull())

    const first = within(cells).getAllByRole("rowheader")[0]
    expect(first.querySelector("span[aria-hidden].size-6")).toBeInTheDocument()
    // "Asia Pacific" (12 characters of 8 px) with the padding, a step and a chevron comes to 158;
    // the name in the corner, "Regions / Line items", asks for more: 20 characters and 20 of padding.
    expect(first).toHaveStyle({ width: `${20 * 8 + 20}px` })
  })

  it("asks for no members of the line items, which the structure names", async () => {
    const { members } = openModule()

    await grid()

    expect(members.requests.some((request) => request.dim.kind === "line_items")).toBe(false)
  })
})

describe("collapsing from the grid", () => {
  it("collapses a member with its chevron, which is part of the view", async () => {
    const user = userEvent.setup()
    const saved = makeView({
      id: "view-r",
      module_id: revenueModule.id,
      name: "By region",
      is_default: true,
      definition: { ...standard, rows: [regions], columns: [lineItemsDim], pages: [{ dim: products, key: null }, { dim: versions, key: null }, { dim: time, key: null }] },
    })
    const { served } = openModule({ views: [saved] })
    served.fixture = salesView({
      rowDims: [regions],
      columnDims: [lineItemsDim],
      totalRows: 2,
      totalColumns: 1,
      lineItems: [lineItem("li-0", "Revenue")],
      rowHeader: (row) =>
        header(
          row === 0
            ? member("top", "All regions", { is_summary: true, has_children: true })
            : member("emea", "EMEA", { depth: 1 }),
        ),
      columnHeader: () => header(member("li-0", "Revenue")),
      cell: () => numberCell(1),
    })

    const cells = await grid()
    await user.click(await within(cells).findByRole("button", { name: "Collapse All regions" }))

    await waitFor(() =>
      expect(lastQuery(served).collapsed).toEqual([{ dim: regions, key: "top" }]),
    )
    expect((await toolbar()).getByText("Modified")).toBeVisible()
  })
})

describe("a narrow toolbar", () => {
  it("puts filter, show/hide, summaries and formatting in a More menu that opens the same panels", async () => {
    const user = userEvent.setup()
    // The page selectors have more in them than room.
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1200)
    const { served } = openModule()

    const bar = await toolbar()
    expect(bar.queryByRole("button", { name: "Filter" })).not.toBeInTheDocument()
    expect(bar.queryByRole("button", { name: "Conditional formatting" })).not.toBeInTheDocument()
    await user.click(bar.getByRole("button", { name: "More" }))
    await user.click(await screen.findByRole("menuitem", { name: "Filter…" }))

    expect(await screen.findByRole("dialog", { name: "Filter rows" })).toBeVisible()
    await user.keyboard("{Escape}")
    expect(bar.getByRole("button", { name: "More" })).toHaveFocus()

    await user.click(bar.getByRole("button", { name: "More" }))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Summaries" }))
    await waitFor(() => expect(lastQuery(served).show_summaries).toBe(false))

    await user.click(bar.getByRole("button", { name: "More" }))
    await user.click(await screen.findByRole("menuitem", { name: "Conditional formatting…" }))
    expect(await screen.findByRole("dialog", { name: "Conditional formatting" })).toBeVisible()
  })

  it("keeps everything in the row when it fits", async () => {
    openModule()

    const bar = await toolbar()

    expect(bar.getByRole("button", { name: "Filter" })).toBeVisible()
    expect(bar.getByRole("button", { name: "Show/hide" })).toBeVisible()
    expect(bar.getByRole("button", { name: "Summaries" })).toBeVisible()
    expect(bar.getByRole("button", { name: "Conditional formatting" })).toBeVisible()
    expect(bar.queryByRole("button", { name: "More" })).not.toBeInTheDocument()
  })
})
