import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { violations } from "@/test/axe"
import {
  makeLineItem,
  makeStructure,
  revenueAmount,
  revenueModule,
  structure,
  unitsSold,
} from "@/test/structure"
import { renderOverView } from "@/test/toolbar"
import { NO_REFERENCE } from "../edit-reference"
import type { RowFilter, ViewDefinition } from "../view-types"
import { FilterPopover } from "./filter-popover"

const customer = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000410",
  module: revenueModule.id,
  name: "Customer",
  ordinal: 2,
  format: { type: "text" },
})
const model = makeStructure({ ...structure, line_items: [unitsSold, revenueAmount, customer] })

const initial: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "time" }],
  pages: [],
}

function renderFilter(view: ViewDefinition = initial) {
  let closed = 0
  const rendered = renderOverView(view, (current, dispatch) => {
    function Controlled() {
      const [open, setOpen] = useState(true)
      return (
        <FilterPopover
          open={open}
          onOpenChange={(next) => {
            if (!next) {
              closed += 1
            }
            setOpen(next)
          }}
          module={revenueModule}
          structure={model}
          view={current}
          reference={NO_REFERENCE}
          dispatch={dispatch}
        />
      )
    }
    return <Controlled />
  })
  return { ...rendered, closes: () => closed }
}

async function choose(label: RegExp | string, option: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("combobox", { name: label }))
  await user.click(await screen.findByRole("option", { name: option }))
}

describe("the filter popover", () => {
  it("starts empty, with a way to add a filter", () => {
    renderFilter()

    expect(screen.getByText("No filters. Add one to show only the rows that pass it.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Add filter" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled()
  })

  it("applies a filter of a line item, a condition and a value", async () => {
    const user = userEvent.setup()
    const { state, closes } = renderFilter()

    await user.click(screen.getByRole("button", { name: "Add filter" }))
    await choose(/Line item of filter 1/, "Revenue amount")
    await choose(/Condition of filter 1/, "is greater than")
    await user.type(screen.getByRole("textbox", { name: "Value of filter 1" }), "1,000")
    await user.click(screen.getByRole("button", { name: "Apply" }))

    expect(state.view.filters).toEqual([
      { line_item: revenueAmount.id, op: "gt", value: { t: "number", v: 1000 } },
    ])
    expect(closes()).toBe(1)
  })

  it("offers the conditions that fit the format of the line item", async () => {
    const user = userEvent.setup()
    renderFilter()

    await user.click(screen.getByRole("button", { name: "Add filter" }))
    await user.click(screen.getByRole("combobox", { name: /Condition of filter 1/ }))
    const numberOptions = (await screen.findAllByRole("option")).map((option) => option.textContent)
    expect(numberOptions).toEqual([
      "equals",
      "does not equal",
      "is less than",
      "is at most",
      "is greater than",
      "is at least",
    ])
    await user.keyboard("{Escape}")

    await choose(/Line item of filter 1/, "Customer")
    await user.click(screen.getByRole("combobox", { name: /Condition of filter 1/ }))
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "equals",
      "does not equal",
      "contains",
      "is blank",
      "is not blank",
    ])
  })

  it("leaves out the value for a condition that has none, and does not send one", async () => {
    const user = userEvent.setup()
    const { state } = renderFilter()

    await user.click(screen.getByRole("button", { name: "Add filter" }))
    await choose(/Line item of filter 1/, "Customer")
    await choose(/Condition of filter 1/, "is blank")

    expect(screen.queryByRole("textbox", { name: "Value of filter 1" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(state.view.filters).toEqual([{ line_item: customer.id, op: "is_blank" }])
  })

  it("starts the condition over when the line item changes", async () => {
    const user = userEvent.setup()
    renderFilter()

    await user.click(screen.getByRole("button", { name: "Add filter" }))
    await choose(/Line item of filter 1/, "Customer")
    await choose(/Condition of filter 1/, "contains")
    await user.type(screen.getByRole("textbox", { name: "Value of filter 1" }), "Acme")
    await choose(/Line item of filter 1/, "Units sold")

    expect(screen.getByRole("combobox", { name: /Condition of filter 1/ })).toHaveTextContent("equals")
    expect(screen.getByRole("textbox", { name: "Value of filter 1" })).toHaveValue("")
  })

  it("says what is wrong under the value, and applies nothing", async () => {
    const user = userEvent.setup()
    const { state, closes } = renderFilter()

    await user.click(screen.getByRole("button", { name: "Add filter" }))
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(await screen.findByText("Enter a value to compare with.")).toBeVisible()

    await user.type(screen.getByRole("textbox", { name: "Value of filter 1" }), "abc")
    await user.click(screen.getByRole("button", { name: "Apply" }))
    expect(await screen.findByText(/number/i)).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Value of filter 1" })).toBeInvalid()
    expect(state.view.filters).toBeUndefined()
    expect(closes()).toBe(0)
  })

  it("shows the filters in force as they were typed, with their number on the button", () => {
    const filters: RowFilter[] = [
      { line_item: unitsSold.id, op: "le", value: { t: "number", v: 5 } },
      { line_item: customer.id, op: "contains", value: { t: "text", v: "Acme" } },
    ]
    renderFilter({ ...initial, filters })

    expect(screen.getByRole("textbox", { name: "Value of filter 1" })).toHaveValue("5")
    expect(screen.getByRole("combobox", { name: /Condition of filter 1/ })).toHaveTextContent("is at most")
    expect(screen.getByRole("textbox", { name: "Value of filter 2" })).toHaveValue("Acme")
    expect(screen.getByRole("button", { name: "Filter, 2 active" })).toBeVisible()
  })

  it("removes a row", async () => {
    const user = userEvent.setup()
    const { state } = renderFilter({
      ...initial,
      filters: [
        { line_item: unitsSold.id, op: "le", value: { t: "number", v: 5 } },
        { line_item: customer.id, op: "is_blank" },
      ],
    })

    await user.click(screen.getByRole("button", { name: "Remove filter 1" }))
    await user.click(screen.getByRole("button", { name: "Apply" }))

    expect(state.view.filters).toEqual([{ line_item: customer.id, op: "is_blank" }])
  })

  it("clears every filter at once and closes", async () => {
    const user = userEvent.setup()
    const { state, closes } = renderFilter({
      ...initial,
      filters: [{ line_item: customer.id, op: "is_blank" }],
    })

    await user.click(screen.getByRole("button", { name: "Clear" }))

    expect(state.view.filters).toEqual([])
    expect(closes()).toBe(1)
  })

  it("takes at most ten filters", async () => {
    const user = userEvent.setup()
    renderFilter({
      ...initial,
      filters: Array.from({ length: 9 }, () => ({ line_item: customer.id, op: "is_blank" as const })),
    })

    await user.click(screen.getByRole("button", { name: "Add filter" }))

    expect(screen.getByRole("button", { name: "Add filter" })).toBeDisabled()
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem")).toHaveLength(10)
  })

  it("has no accessibility violations", async () => {
    const user = userEvent.setup()
    renderFilter({ ...initial, filters: [{ line_item: customer.id, op: "contains", value: { t: "text", v: "A" } }] })
    await user.click(screen.getByRole("button", { name: "Add filter" }))

    await waitFor(async () => expect(await violations({ ignore: ["region"] })).toEqual([]))
  })
})
