import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { renderOverView } from "@/test/toolbar"
import { productsId, regionsId, revenueModule, structure } from "@/test/structure"
import { violations } from "@/test/axe"
import type { ViewDefinition } from "../view-types"
import { PivotPopover } from "./pivot-popover"

const regions = { kind: "list", list: regionsId } as const
const products = { kind: "list", list: productsId } as const
const versions = { kind: "versions" } as const
const time = { kind: "time" } as const
const lineItems = { kind: "line_items" } as const

const initial: ViewDefinition = {
  rows: [lineItems],
  columns: [time],
  pages: [
    { dim: regions, key: null },
    { dim: products, key: null },
    { dim: versions, key: null },
  ],
}

function renderPivot(view = initial) {
  return renderOverView(view, (current, dispatch) => (
    <PivotPopover
      open
      onOpenChange={() => {}}
      module={revenueModule}
      structure={structure}
      view={current}
      dispatch={dispatch}
    />
  ))
}

function zone(name: string) {
  return within(screen.getByRole("region", { name }))
}

/** Opens the menu of a dimension's chip from the keyboard and chooses an item. */
async function chooseFor(dimension: string, item: string) {
  const user = userEvent.setup()
  screen.getByRole("button", { name: `Move ${dimension}` }).focus()
  await user.keyboard("{Enter}")
  await user.click(await screen.findByRole("menuitem", { name: item }))
}

describe("the pivot popover", () => {
  it("shows where each dimension is: rows, columns and pages", () => {
    renderPivot()

    expect(zone("Rows").getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Line items"])
    expect(zone("Columns").getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Time (Month)",
    ])
    expect(zone("Pages").getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Regions",
      "Products",
      "Versions",
    ])
  })

  it("moves a dimension from the menu on its chip, and keeps focus on that chip's menu", async () => {
    const { state } = renderPivot()

    await chooseFor("Regions", "Move to Columns")

    expect(state.view.columns).toEqual([time, regions])
    expect(state.view.pages?.map((page) => page.dim)).toEqual([products, versions])
    expect(zone("Columns").getByRole("button", { name: "Move Regions" })).toHaveFocus()
    expect(screen.getByText("Moved Regions to Columns.")).toBeInTheDocument()
  })

  it("puts an empty zone in plain words, and a dimension dropped in it there", async () => {
    const { state } = renderPivot()

    await chooseFor("Time (Month)", "Move to Pages")

    expect(zone("Columns").getByText("Drop a dimension here")).toBeVisible()
    expect(state.view.columns).toEqual([])
    expect(state.view.pages?.at(-1)).toEqual({ dim: time, key: null })
  })

  it("reorders the dimensions of a zone", async () => {
    const { state } = renderPivot()

    await chooseFor("Versions", "Move earlier")

    expect(state.view.pages?.map((page) => page.dim)).toEqual([regions, versions, products])
  })

  it("cannot move the first or last of a zone past its end", async () => {
    renderPivot()
    const user = userEvent.setup()
    screen.getByRole("button", { name: "Move Regions" }).focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("menuitem", { name: "Move earlier" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.getByRole("menuitem", { name: "Move later" })).not.toHaveAttribute("aria-disabled")
    expect(screen.getByRole("menuitem", { name: "Move to Pages" })).toHaveAttribute(
      "aria-disabled",
      "true",
    )
  })

  it("keeps the last dimension on the rows, and says so", async () => {
    renderPivot()
    const user = userEvent.setup()
    screen.getByRole("button", { name: "Move Line items" }).focus()
    await user.keyboard("{Enter}")

    for (const item of ["Move to Rows", "Move to Columns", "Move to Pages"]) {
      expect(await screen.findByRole("menuitem", { name: item })).toHaveAttribute(
        "aria-disabled",
        "true",
      )
    }
    expect(screen.getByText("One dimension stays on the rows.")).toBeVisible()
  })

  it("lets the one dimension of the rows be moved by nobody: its grip is off", () => {
    renderPivot()

    expect(screen.getByRole("button", { name: "Drag Line items" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Drag Time (Month)" })).toBeEnabled()
  })

  it("swaps the rows and the columns, and cannot when there are no columns", async () => {
    const user = userEvent.setup()
    const { state } = renderPivot()

    await user.click(screen.getByRole("button", { name: "Swap rows and columns" }))

    expect(state.view.rows).toEqual([time])
    expect(state.view.columns).toEqual([lineItems])
    expect(screen.getByText("Swapped rows and columns.")).toBeInTheDocument()
  })

  it("has no swap without columns", () => {
    renderPivot({ ...initial, columns: [] })

    expect(screen.getByRole("button", { name: "Swap rows and columns" })).toBeDisabled()
  })

  it("opens from its button and closes with Escape, back to the button", async () => {
    const user = userEvent.setup()
    function Controlled({ view, dispatch }: Pick<Parameters<typeof PivotPopover>[0], "view" | "dispatch">) {
      const [open, setOpen] = useState(false)
      return (
        <PivotPopover
          open={open}
          onOpenChange={setOpen}
          module={revenueModule}
          structure={structure}
          view={view}
          dispatch={dispatch}
        />
      )
    }
    renderOverView(initial, (view, dispatch) => <Controlled view={view} dispatch={dispatch} />)
    expect(screen.queryByRole("region", { name: "Rows" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Pivot" }))
    expect(await screen.findByRole("dialog", { name: "Pivot" })).toBeVisible()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Pivot" })).toHaveFocus()
  })

  it("has no accessibility violations", async () => {
    renderPivot()

    expect(await violations({ ignore: ["region"] })).toEqual([])
  })
})
