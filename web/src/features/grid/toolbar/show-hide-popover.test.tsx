import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { violations } from "@/test/axe"
import { productsId, regionsId, revenueModule, structure } from "@/test/structure"
import { renderOverView } from "@/test/toolbar"
import { MODEL_ID } from "@/test/view-query"
import { memberOf, serveMembers } from "@/test/views"
import type { Member, ViewDefinition, ViewDim } from "../view-types"
import { ShowHidePopover } from "./show-hide-popover"

const regions: ViewDim = { kind: "list", list: regionsId }
const products: ViewDim = { kind: "list", list: productsId }
const time: ViewDim = { kind: "time" }

const regionMembers: Member[] = [
  memberOf("top", "All regions", { is_summary: true, has_children: true }),
  memberOf("emea", "EMEA", { depth: 1, has_children: true }),
  memberOf("uk", "United Kingdom", { depth: 2 }),
  memberOf("apac", "Asia Pacific", { depth: 1 }),
]
const periodMembers: Member[] = [
  memberOf("Jan 26", "Jan 26"),
  memberOf("Q1 FY26", "Q1 FY26", { depth: 1, is_summary: true, has_children: true }),
  memberOf("Total", "Total", { depth: 2, is_summary: true, has_children: true }),
]
const manyProducts = Array.from({ length: 130 }, (_, i) => memberOf(`p${i}`, `Product ${i + 1}`))

function membersOf(dim: ViewDim): Member[] {
  if (dim.kind === "time") {
    return periodMembers
  }
  return dim.kind === "list" && dim.list === productsId ? manyProducts : regionMembers
}

const initial: ViewDefinition = {
  rows: [regions, { kind: "line_items" }],
  columns: [time],
  pages: [{ dim: products, key: null }],
}

function renderShowHide(view = initial) {
  return renderOverView(view, (current, dispatch) => {
    function Controlled() {
      const [open, setOpen] = useState(true)
      return (
        <ShowHidePopover
          open={open}
          onOpenChange={setOpen}
          modelId={MODEL_ID}
          module={revenueModule}
          structure={structure}
          view={current}
          dispatch={dispatch}
        />
      )
    }
    return <Controlled />
  })
}

const checkbox = (name: string) => screen.findByRole("checkbox", { name })

describe("the show/hide popover", () => {
  it("lists the members of the first dimension, all of them checked", async () => {
    serveMembers(membersOf)
    renderShowHide()

    const list = await screen.findByRole("list", { name: "Members of Regions" })
    expect(within(list).getAllByRole("checkbox").map((box) => box.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "true",
    ])
    expect(screen.getByText("All shown")).toBeVisible()
  })

  it("indents the members of a hierarchy and makes the totals bold", async () => {
    serveMembers(membersOf)
    renderShowHide()

    const list = await screen.findByRole("list", { name: "Members of Regions" })
    const items = within(list).getAllByRole("listitem")
    expect(items.map((item) => item.style.paddingLeft)).toEqual(["4px", "20px", "36px", "20px"])
    expect(screen.getByText("All regions")).toHaveClass("font-semibold")
  })

  it("hides a member when it is unchecked and shows it again when it is checked", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    const { state } = renderShowHide()

    await user.click(await checkbox("EMEA"))
    expect(state.view.hidden).toEqual([{ dim: regions, key: "emea" }])
    expect(screen.getByRole("checkbox", { name: "EMEA" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText("1 member hidden")).toBeVisible()

    await user.click(screen.getByRole("checkbox", { name: "EMEA" }))
    expect(state.view.hidden).toEqual([])
  })

  it("hides only the member that is unchecked, not the members below it", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    const { state } = renderShowHide()

    await user.click(await checkbox("EMEA"))

    expect(state.view.hidden).toEqual([{ dim: regions, key: "emea" }])
    expect(screen.getByRole("checkbox", { name: "United Kingdom" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
  })

  it("shows every hidden member of the dimension at once", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    const { state } = renderShowHide({
      ...initial,
      hidden: [
        { dim: regions, key: "emea" },
        { dim: regions, key: "apac" },
        { dim: time, key: "Jan 26" },
      ],
    })

    expect(await screen.findByText("2 members hidden")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Show all" }))

    expect(state.view.hidden).toEqual([{ dim: time, key: "Jan 26" }])
    expect(screen.getByRole("button", { name: "Show all" })).toBeDisabled()
  })

  it("searches the members", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    renderShowHide()

    await screen.findByRole("list", { name: "Members of Regions" })
    await user.type(screen.getByRole("searchbox", { name: "Search members" }), "asia")

    const list = screen.getByRole("list", { name: "Members of Regions" })
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Asia Pacific"])
    await user.clear(screen.getByRole("searchbox", { name: "Search members" }))
    await user.type(screen.getByRole("searchbox", { name: "Search members" }), "zzz")
    expect(screen.getByText("No member matches.")).toBeVisible()
  })

  it("switches to another dimension of the rows or columns, which loads its own members", async () => {
    const user = userEvent.setup()
    const asked = serveMembers(membersOf)
    renderShowHide()
    await screen.findByRole("list", { name: "Members of Regions" })

    await user.click(screen.getByRole("combobox", { name: "Dimension" }))
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Regions",
      "Line items",
      "Time (Month)",
    ])
    await user.click(screen.getByRole("option", { name: "Time (Month)" }))

    const list = await screen.findByRole("list", { name: "Members of Time (Month)" })
    // Time steps in from its top total, which is the deepest member.
    expect(within(list).getAllByRole("listitem").map((item) => item.style.paddingLeft)).toEqual([
      "36px",
      "20px",
      "4px",
    ])
    expect(asked.requests.at(-1)).toMatchObject({ module_id: revenueModule.id, dim: { kind: "time" } })
  })

  it("lists the first 100 members of a long dimension and says how to find the rest", async () => {
    const user = userEvent.setup()
    serveMembers(membersOf)
    renderShowHide({ ...initial, rows: [products, { kind: "line_items" }], pages: [{ dim: regions, key: null }] })

    const list = await screen.findByRole("list", { name: "Members of Products" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(100)
    expect(screen.getByText("Showing the first 100 of 130 members. Search to find the rest.")).toBeVisible()

    await user.type(screen.getByRole("searchbox", { name: "Search members" }), "product 130")
    expect(within(screen.getByRole("list", { name: "Members of Products" })).getAllByRole("listitem")).toHaveLength(1)
  })

  it("asks for the totals only when the view shows them", async () => {
    const asked = serveMembers(membersOf)
    renderShowHide({ ...initial, show_summaries: false })

    await screen.findByRole("list", { name: "Members of Regions" })

    expect(asked.requests.at(-1)?.show_summaries).toBe(false)
  })

  it("has a skeleton while the members load", async () => {
    serveMembers(membersOf)
    renderShowHide()

    expect(screen.getByRole("status", { name: "Loading members" })).toBeVisible()
    await screen.findByRole("list", { name: "Members of Regions" })
  })

  it("shows how many members are hidden on its button", () => {
    serveMembers(membersOf)
    renderShowHide({ ...initial, hidden: [{ dim: regions, key: "emea" }] })

    expect(screen.getByRole("button", { name: "Show/hide, 1 hidden" })).toBeVisible()
  })

  it("has no accessibility violations", async () => {
    serveMembers(membersOf)
    renderShowHide()
    await screen.findByRole("list", { name: "Members of Regions" })

    await waitFor(async () => expect(await violations({ ignore: ["region"] })).toEqual([]))
  })
})
