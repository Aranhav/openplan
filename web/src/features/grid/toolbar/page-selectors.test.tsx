import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { violations } from "@/test/axe"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { productsId, regionsId, revenueModule, structure } from "@/test/structure"
import { renderOverView } from "@/test/toolbar"
import { memberOf, serveMembers } from "@/test/views"
import { HttpResponse, http } from "msw"
import type { Member, PageMember, ViewDefinition, ViewDim } from "../view-types"
import { PageSelectors } from "./page-selectors"
import { MODEL_ID } from "@/test/view-query"

const regions = { kind: "list", list: regionsId } as const
const products = { kind: "list", list: productsId } as const

const regionMembers: Member[] = [
  memberOf("top", "All regions", { is_summary: true, has_children: true }),
  memberOf("emea", "EMEA", { depth: 1, has_children: true }),
  memberOf("uk", "United Kingdom", { depth: 2 }),
  memberOf("apac", "Asia Pacific", { depth: 1 }),
]
const manyProducts: Member[] = Array.from({ length: 150 }, (_, i) =>
  memberOf(`p${i}`, `Product ${i + 1}`),
)

const initial: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "time" }],
  pages: [
    { dim: regions, key: null },
    { dim: products, key: "p3" },
  ],
}

function renderSelectors(
  view = initial,
  shown: PageMember[] | undefined = [{ dim: regions, member: regionMembers[0] }],
) {
  return renderOverView(view, (current, dispatch) => (
    <PageSelectors
      modelId={MODEL_ID}
      module={revenueModule}
      structure={structure}
      view={current}
      shown={shown}
      dispatch={dispatch}
    />
  ))
}

const membersOf = (dim: ViewDim) =>
  dim.kind === "list" && dim.list === productsId ? manyProducts : regionMembers

describe("page selectors", () => {
  it("has a menu for a dimension of 20 members or fewer, showing the member the grid shows", async () => {
    serveMembers(membersOf)
    renderSelectors()

    const menu = await screen.findByRole("combobox", { name: /^Regions/ })
    expect(menu).toHaveTextContent("All regions")
  })

  it("changes the member of a page from the menu", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    const { state } = renderSelectors()

    await user.click(await screen.findByRole("combobox", { name: /^Regions/ }))
    await user.click(await screen.findByRole("option", { name: "United Kingdom" }))

    expect(state.view.pages?.[0]).toEqual({ dim: regions, key: "uk" })
    expect(screen.getByRole("combobox", { name: /^Regions/ })).toHaveTextContent("United Kingdom")
  })

  it("indents the members of a hierarchy and marks the totals", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    renderSelectors()

    await user.click(await screen.findByRole("combobox", { name: /^Regions/ }))

    expect(await screen.findByRole("option", { name: "All regions" })).toHaveClass("font-medium")
    expect(screen.getByRole("option", { name: "EMEA" })).toHaveStyle({ paddingLeft: "20px" })
    expect(screen.getByRole("option", { name: "United Kingdom" })).toHaveStyle({ paddingLeft: "32px" })
  })

  it("searches a dimension of more than 20 members instead", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    const { state } = renderSelectors()

    const trigger = await screen.findByRole("combobox", { name: /^Products/ })
    expect(trigger).toHaveTextContent("Product 4")
    await user.click(trigger)
    const search = await screen.findByPlaceholderText("Find in Products…")
    await user.type(search, "product 12")

    const options = within(screen.getByRole("listbox")).getAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([
      "Product 12",
      "Product 120",
      "Product 121",
      "Product 122",
      "Product 123",
      "Product 124",
      "Product 125",
      "Product 126",
      "Product 127",
      "Product 128",
      "Product 129",
    ])
    await user.click(screen.getByRole("option", { name: "Product 122" }))

    expect(state.view.pages?.[1]).toEqual({ dim: products, key: "p121" })
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it.each([
    [20, "a menu"],
    [21, "a search"],
  ])("has %i members chosen from %s", async (count, kind) => {
    const user = userEvent.setup()
    const members = Array.from({ length: count }, (_, i) => memberOf(`m${i}`, `Member ${i + 1}`))
    serveMembers(() => members)
    renderSelectors({ ...initial, pages: [{ dim: regions, key: "m0" }] })

    await user.click(await screen.findByRole("combobox", { name: /^Regions/ }))

    if (kind === "a menu") {
      expect(await screen.findAllByRole("option")).toHaveLength(20)
      expect(screen.queryByPlaceholderText("Find in Regions…")).not.toBeInTheDocument()
    } else {
      expect(await screen.findByPlaceholderText("Find in Regions…")).toBeVisible()
      expect(screen.getAllByRole("option")).toHaveLength(21)
    }
  })

  it("shows the first 100 of a long list and says how to find the rest", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    renderSelectors()

    await user.click(await screen.findByRole("combobox", { name: /^Products/ }))

    expect(await screen.findAllByRole("option")).toHaveLength(100)
    expect(screen.getByText("Showing the first 100 of 150 members. Type to narrow them down.")).toBeVisible()
  })

  it("says so when nothing matches", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    renderSelectors()

    await user.click(await screen.findByRole("combobox", { name: /^Products/ }))
    await user.type(await screen.findByPlaceholderText("Find in Products…"), "zzz")

    expect(screen.getByText("No member matches.")).toBeVisible()
  })

  it("lists the members with their totals when the view shows them, and without when not", async () => {
    const asked = serveMembers(membersOf)
    renderSelectors({ ...initial, show_summaries: false })

    await screen.findByRole("combobox", { name: /^Regions/ })

    expect(asked.requests.map((request) => request.show_summaries)).toEqual([false, false])
    expect(asked.requests.map((request) => request.module_id)).toEqual([
      revenueModule.id,
      revenueModule.id,
    ])
  })

  it("is a skeleton while the members load", async () => {
    serveMembers(membersOf)
    renderSelectors()

    expect(screen.getAllByRole("status", { name: /^Loading/ })).toHaveLength(2)
    await screen.findByRole("combobox", { name: /^Regions/ })
  })

  it("says why when the members cannot be read, offers to try again, and shows them once it can", async () => {
    const user = userEvent.setup()
    let failing = true
    server.use(
      http.post("/api/v1/models/:id/members", () =>
        failing
          ? problem(503, "server.busy", "Busy.")
          : HttpResponse.json({ members: regionMembers }),
      ),
    )
    renderSelectors({ ...initial, pages: [{ dim: regions, key: null }] })

    await user.click(await screen.findByRole("button", { name: "Regions: couldn't load" }))
    expect(await screen.findByText("Busy.")).toBeVisible()
    failing = false
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("combobox", { name: /^Regions/ })).toBeVisible()
  })

  it("is disabled for a dimension without members", async () => {
    serveMembers(() => [])
    renderSelectors({ ...initial, pages: [{ dim: regions, key: null }] })

    expect(await screen.findByRole("button", { name: /^Regions\s*No members/ })).toBeDisabled()
  })

  it("has no accessibility violations", async () => {
    serveMembers(membersOf)
    renderSelectors()
    await screen.findByRole("combobox", { name: /^Regions/ })

    await waitFor(async () => expect(await violations({ ignore: ["region"] })).toEqual([]))
  })
})
