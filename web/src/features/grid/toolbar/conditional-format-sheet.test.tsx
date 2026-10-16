import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
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
import type { ConditionalFormat, ViewDefinition } from "../view-types"
import { ConditionalFormatSheet } from "./conditional-format-sheet"

// Fifty rules are drawn in one of the tests, which jsdom does slowly while the suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const margin = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000404",
  module: revenueModule.id,
  name: "Margin",
  ordinal: 2,
  format: {
    type: "number",
    decimals: 1,
    thousands_sep: true,
    unit: { type: "percent" },
    negative: "minus",
  },
})
const notes = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000405",
  module: revenueModule.id,
  name: "Notes",
  ordinal: 3,
  format: { type: "text" },
})
const model = makeStructure({ ...structure, line_items: [unitsSold, revenueAmount, margin, notes] })

const initial: ViewDefinition = {
  rows: [{ kind: "line_items" }],
  columns: [{ kind: "time" }],
  pages: [],
}

const losses: ConditionalFormat = {
  name: "Losses",
  line_item_ids: [],
  op: "negative",
  style: { color: "red", bold: true },
}
const healthy: ConditionalFormat = {
  name: "Healthy",
  line_item_ids: [unitsSold.id],
  op: "between",
  value: 10,
  value2: 20,
  style: { color: "green", bold: false },
}

function renderSheet(view: ViewDefinition = initial) {
  let closed = 0
  const rendered = renderOverView(view, (current, dispatch) => {
    function Controlled() {
      const [open, setOpen] = useState(true)
      return (
        <ConditionalFormatSheet
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

describe("the conditional formatting sheet", () => {
  it("starts with no rules and a way to add one", async () => {
    renderSheet()

    expect(await screen.findByRole("dialog", { name: "Conditional formatting" })).toBeVisible()
    expect(screen.getByText("No rules yet. Add one to colour the cells that match it.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Add rule" })).toBeEnabled()
  })

  it("adds a rule, with its numbers, colour and weight, and applies it", async () => {
    const user = userEvent.setup()
    const { state, closes } = renderSheet()

    await user.click(await screen.findByRole("button", { name: "Add rule" }))
    expect(screen.getByRole("textbox", { name: "Name of rule 1" })).toHaveValue("Rule 1")
    await user.clear(screen.getByRole("textbox", { name: "Name of rule 1" }))
    await user.type(screen.getByRole("textbox", { name: "Name of rule 1" }), "Too low")
    await choose(/Condition of rule 1/, "is less than")
    await user.type(screen.getByRole("textbox", { name: "Value of rule 1" }), "1,500")
    await user.click(screen.getByRole("radio", { name: "Amber" }))
    await user.click(screen.getByRole("switch", { name: "Bold for rule 1" }))
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(state.view.conditional_formats).toEqual([
      {
        name: "Too low",
        line_item_ids: [],
        op: "lt",
        value: 1500,
        style: { color: "amber", bold: true },
      },
    ])
    expect(closes()).toBe(1)
  })

  it("applies to every number line item, or to the ones chosen", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({ ...initial, conditional_formats: [losses] })

    const picker = await screen.findByRole("button", {
      name: "Line items of rule 1: All number line items",
    })
    await user.click(picker)
    await user.click(await screen.findByRole("checkbox", { name: "Units sold" }))
    await user.click(screen.getByRole("checkbox", { name: "Revenue amount" }))
    await user.click(screen.getByRole("checkbox", { name: "Units sold" }))
    await user.keyboard("{Escape}")

    expect(
      screen.getByRole("button", { name: "Line items of rule 1: Revenue amount" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Apply rules" }))
    expect(state.view.conditional_formats?.[0].line_item_ids).toEqual([revenueAmount.id])
  })

  it("goes back to every number line item when 'All number line items' is chosen", async () => {
    const user = userEvent.setup()
    renderSheet({ ...initial, conditional_formats: [{ ...losses, line_item_ids: [unitsSold.id] }] })

    await user.click(await screen.findByRole("button", { name: "Line items of rule 1: Units sold" }))
    await user.click(await screen.findByRole("checkbox", { name: "All number line items" }))

    expect(
      screen.getByRole("button", { name: "Line items of rule 1: All number line items" }),
    ).toBeVisible()
  })

  it("asks for two numbers in order for a range", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({ ...initial, conditional_formats: [healthy] })

    expect(await screen.findByRole("textbox", { name: "From of rule 1" })).toHaveValue("10")
    expect(screen.getByRole("textbox", { name: "To of rule 1" })).toHaveValue("20")
    await user.clear(screen.getByRole("textbox", { name: "From of rule 1" }))
    await user.type(screen.getByRole("textbox", { name: "From of rule 1" }), "50")
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(await screen.findByText("The first number must not be more than the second.")).toBeVisible()
    expect(state.view.conditional_formats).toEqual([healthy])
  })

  it("says what is missing and applies nothing", async () => {
    const user = userEvent.setup()
    const { closes } = renderSheet()

    await user.click(await screen.findByRole("button", { name: "Add rule" }))
    await user.clear(screen.getByRole("textbox", { name: "Name of rule 1" }))
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(await screen.findByText("Name is required.")).toBeVisible()
    expect(screen.getByText("Enter a number.")).toBeVisible()
    expect(closes()).toBe(0)
  })

  it("has no number to type for a condition that has none", async () => {
    renderSheet({ ...initial, conditional_formats: [losses] })

    expect(await screen.findByRole("combobox", { name: /Condition of rule 1/ })).toHaveTextContent(
      "is negative",
    )
    expect(screen.queryByRole("textbox", { name: "Value of rule 1" })).not.toBeInTheDocument()
  })

  it("takes the number of a rule for percentages in percent points, as a cell does", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({
      ...initial,
      conditional_formats: [{ ...healthy, line_item_ids: [margin.id], op: "lt", value: 0.05, value2: null }],
    })

    const value = await screen.findByRole("textbox", { name: "Value of rule 1" })
    expect(value).toHaveValue("5")
    expect(screen.queryByText(/compared as stored/)).not.toBeInTheDocument()
    await user.clear(value)
    await user.type(value, "7.5%")
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(state.view.conditional_formats?.[0].value).toBe(0.075)
  })

  it("says that a number is compared as stored when the line items are not all percentages", async () => {
    renderSheet({
      ...initial,
      conditional_formats: [{ ...healthy, line_item_ids: [margin.id, unitsSold.id], op: "lt", value: 0.05 }],
    })

    expect(
      await screen.findByText(
        "These line items are not all percentages, so a number is compared as stored: 0.05 is 5%.",
      ),
    ).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Value of rule 1" })).toHaveValue("0.05")
  })

  it("offers is blank only for line items that can be blank", async () => {
    const user = userEvent.setup()
    renderSheet({ ...initial, conditional_formats: [losses] })

    await user.click(await screen.findByRole("combobox", { name: /Condition of rule 1/ }))
    expect(await screen.findByRole("option", { name: "is blank" })).toHaveAttribute("aria-disabled", "true")
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: /^Line items of rule 1/ }))
    await user.click(await screen.findByRole("checkbox", { name: "Notes" }))
    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("combobox", { name: /Condition of rule 1/ }))
    expect(await screen.findByRole("option", { name: "is blank" })).not.toHaveAttribute("aria-disabled")
  })

  it("refuses a rule that is blank for numbers, which it was before the line items changed", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({
      ...initial,
      conditional_formats: [{ ...losses, op: "blank" }],
    })

    await user.click(await screen.findByRole("button", { name: "Apply rules" }))

    expect(await screen.findByText(/A number is never blank/)).toBeVisible()
    expect(state.actions).toEqual([])
  })

  it("gives the checkboxes of the line items ids without spaces, one set for each rule", async () => {
    const user = userEvent.setup()
    renderSheet({ ...initial, conditional_formats: [losses, healthy] })

    await user.click(await screen.findByRole("button", { name: /^Line items of rule 2/ }))
    const popover = await screen.findByRole("dialog", { name: "Line items of rule 2" })
    const ids = within(popover)
      .getAllByRole("checkbox")
      .map((checkbox) => checkbox.getAttribute("id"))

    expect(ids).toHaveLength(5)
    for (const id of ids) {
      expect(id).not.toMatch(/\s/)
    }
    expect(new Set(ids).size).toBe(5)
  })

  it("keeps a colour: choosing the chosen one again does not clear it", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({ ...initial, conditional_formats: [losses] })

    const colours = await screen.findByRole("radiogroup", { name: "Colour of rule 1" })
    await user.click(within(colours).getByRole("radio", { name: "Red" }))
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(state.view.conditional_formats?.[0].style.color).toBe("red")
  })

  it("moves rules up and down, which changes which one applies first", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({ ...initial, conditional_formats: [losses, healthy] })

    await screen.findByRole("list", { name: "Rules" })
    expect(screen.getByRole("button", { name: "Move rule 1 up" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Move rule 2 down" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Move rule 2 up" }))

    expect(screen.getByText("Moved Healthy to position 1 of 2.")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Name of rule 1" })).toHaveValue("Healthy")
    await user.click(screen.getByRole("button", { name: "Apply rules" }))
    expect(state.view.conditional_formats?.map((rule) => rule.name)).toEqual(["Healthy", "Losses"])
  })

  it("deletes a rule", async () => {
    const user = userEvent.setup()
    const { state } = renderSheet({ ...initial, conditional_formats: [losses, healthy] })

    await user.click(await screen.findByRole("button", { name: "Delete rule 1" }))
    await user.click(screen.getByRole("button", { name: "Apply rules" }))

    expect(state.view.conditional_formats?.map((rule) => rule.name)).toEqual(["Healthy"])
  })

  it("takes at most 50 rules", async () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({ ...losses, name: `Rule ${i + 1}` }))
    renderSheet({ ...initial, conditional_formats: rules })

    expect(await screen.findByRole("button", { name: "Add rule" })).toBeDisabled()
  })

  it("asks before dismissing edits, and closes at once with Cancel", async () => {
    const user = userEvent.setup()
    const { closes } = renderSheet({ ...initial, conditional_formats: [losses] })

    await user.type(await screen.findByRole("textbox", { name: "Name of rule 1" }), "!")
    await user.keyboard("{Escape}")

    const dialog = await screen.findByRole("alertdialog", { name: "Discard changes?" })
    expect(closes()).toBe(0)
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }))
    expect(screen.getByRole("dialog", { name: "Conditional formatting" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(closes()).toBe(1)
  })

  it("closes at once when nothing was changed", async () => {
    const user = userEvent.setup()
    const { closes } = renderSheet({ ...initial, conditional_formats: [losses] })

    await screen.findByRole("textbox", { name: "Name of rule 1" })
    await user.keyboard("{Escape}")

    expect(closes()).toBe(1)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("has no accessibility violations", async () => {
    renderSheet({ ...initial, conditional_formats: [losses, healthy] })
    await screen.findByRole("list", { name: "Rules" })

    await waitFor(async () => expect(await violations({ ignore: ["region"] })).toEqual([]))
  })
})
