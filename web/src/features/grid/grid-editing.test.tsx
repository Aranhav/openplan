import { QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import {
  ACTIVE,
  BUDGET,
  CALCULATED,
  GROWTH,
  NOTES,
  REGION,
  START,
  SWITCHOVER,
  type Body,
  cellAt,
  editCell,
  editQuery,
  editView,
  expectActive,
  holdCells,
  lineItems,
  number,
  reference,
  renderGrid,
  select,
  serveCells,
  setup,
  written,
} from "@/test/edit-view"
import {
  MODEL_ID,
  header,
  lineItem,
  member,
  numberCell,
  productsList,
  salesView,
  serveViewQuery,
  serveViewQueryBy,
} from "@/test/view-query"
import { numberFormat } from "@/test/number-format"
import { mockViewport } from "@/test/viewport"
import { Grid } from "./grid"
import type { GridQuery, ViewQuery } from "./view-types"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// jsdom has no canvas: every character is 8 px wide.
vi.mock("./measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

vi.setConfig({ testTimeout: 20_000 })

beforeEach(() => {
  mockViewport(800, 400)
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("typing into a cell", () => {
  it("replaces the value with what is typed, and Enter saves it and moves down", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 1, number(42))] }]))
    expectActive(grid, 2, BUDGET)
    expect(grid).toHaveFocus()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("shows the typed text while it is typed", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("4")

    const input = screen.getByRole("textbox", { name: "Budget, Product 1" })
    expect(input).toHaveFocus()
    expect(input).toHaveValue("4")
    await userEvent.keyboard("2")
    expect(input).toHaveValue("42")
  })

  it("moves right on Tab and left on Shift+Tab", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, NOTES)

    await userEvent.keyboard("hello{Tab}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    expectActive(grid, 1, CALCULATED)

    await select(grid, 2, NOTES)
    await userEvent.keyboard("x{Shift>}{Tab}{/Shift}")
    await waitFor(() => expect(bodies).toHaveLength(2))
    expectActive(grid, 2, ACTIVE)
  })

  it("moves up on Shift+Enter", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, BUDGET)

    await userEvent.keyboard("5{Shift>}{Enter}{/Shift}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expectActive(grid, 1, BUDGET)
  })

  it("gives up with Escape and leaves the cell alone", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("99{Escape}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("10.00")
    expectActive(grid, 1, BUDGET)
    expect(grid).toHaveFocus()
    expect(bodies).toEqual([])
  })

  it("saves what was typed when the focus goes elsewhere", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("77")

    await userEvent.click(cellAt(grid, 3, BUDGET))

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 1, number(77))] }]))
    expectActive(grid, 3, BUDGET)
  })

  it("sends nothing when the typed value is the value the cell has", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("10{Enter}")
    await select(grid, 2, BUDGET)
    await userEvent.keyboard("20.00{Enter}")

    expect(bodies).toEqual([])
    expectActive(grid, 3, BUDGET)
  })

  it("keeps the editor open and says why when the text is not a value of the cell", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("abc{Enter}")

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("'abc' isn't a number.")
    expect(screen.getByRole("textbox")).toHaveValue("abc")
    expect(screen.getByRole("textbox")).toBeInvalid()
    expectActive(grid, 1, BUDGET)
    expect(bodies).toEqual([])
  })

  it("reads a percentage in percent points", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, GROWTH)

    await userEvent.keyboard("12.5{Enter}")

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-growth", 1, number(0.125))] }]),
    )
  })

  it("leaves the keys of an input method that is composing alone", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    fireEvent.keyDown(grid, { key: "Enter", isComposing: true })
    fireEvent.keyDown(grid, { key: "Enter", keyCode: 229 })
    fireEvent.keyDown(grid, { key: "a", keyCode: 229 })

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it("does not start an editor for a key held with Ctrl or Command", async () => {
    const { grid } = await setup()
    await select(grid, 1, NOTES)

    await userEvent.keyboard("{Control>}x{/Control}")
    await userEvent.keyboard("{Meta>}x{/Meta}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })
})

describe("opening the editor on the value", () => {
  it.each([
    ["Enter", "{Enter}"],
    ["F2", "{F2}"],
  ])("%s opens the editor on the value with the caret after it", async (_name, keys) => {
    const { grid } = await setup()
    await select(grid, 2, BUDGET)

    await userEvent.keyboard(keys)

    const input = screen.getByRole("textbox", { name: "Budget, Product 2" })
    expect(input).toHaveFocus()
    expect(input).toHaveValue("20")
    expect((input as HTMLInputElement).selectionStart).toBe(2)
  })

  it("a double click opens it", async () => {
    const { grid } = await setup()

    await userEvent.dblClick(cellAt(grid, 2, NOTES))

    expect(screen.getByRole("textbox", { name: "Notes, Product 2" })).toHaveValue("Note 2")
  })

  it("opens a percentage on its percent points and a text on its text", async () => {
    const { grid } = await setup()
    await select(grid, 0, GROWTH)

    await userEvent.keyboard("{F2}")

    expect(screen.getByRole("textbox")).toHaveValue("25")
  })

  it("saves an edit of the value and moves down on Enter", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, NOTES)

    await userEvent.keyboard("{F2} and more{Enter}")

    await waitFor(() =>
      expect(bodies).toEqual([
        { edits: [written("li-notes", 2, { t: "text", v: "Note 2 and more" })] },
      ]),
    )
  })
})

describe("cells that cannot be edited", () => {
  it.each([
    ["a calculated cell", CALCULATED],
    ["a cell showing the actual before a switchover", SWITCHOVER],
  ])("does not open an editor on %s", async (_name, col) => {
    const { grid, bodies } = await setup()
    await select(grid, 1, col)

    await userEvent.keyboard("5")
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard("{F2}")
    await userEvent.dblClick(cellAt(grid, 1, col))
    await userEvent.keyboard("{Delete}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it("does not open an editor on a cell that is not applicable", async () => {
    const naView = editView({
      cell: (row, col) =>
        col === NOTES
          ? { value: { t: "text", v: "" }, flags: ["na", "readonly"] }
          : editCell(row, col),
    })
    const { grid, bodies } = await setup({}, naView)
    await select(grid, 1, NOTES)

    await userEvent.keyboard("hello{Enter}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it("does not edit a cell of a line item the view has no dimension for", async () => {
    const odd = lineItem("li-budget", "Budget", {
      dims: [{ kind: "list", list: "list-elsewhere" }],
      format: numberFormat({ decimals: 2 }),
    })
    const { grid, bodies } = await setup({}, editView({ lineItems: [odd, ...lineItems.slice(1)] }))
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("5{Enter}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })
})

describe("a grid that is read only", () => {
  it("never enters edit mode, whatever is pressed", async () => {
    const { grid, bodies } = await setup({ readOnly: true })
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("5")
    await userEvent.keyboard("{Enter}{F2}{Delete}{Backspace} ")
    await userEvent.dblClick(cellAt(grid, 1, BUDGET))
    await userEvent.keyboard("{Control>}d{/Control}")
    await userEvent.keyboard("{Control>}z{/Control}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
    expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("10.00")
  })

  it("does not toggle a check box", async () => {
    const { grid, bodies } = await setup({ readOnly: true })
    await select(grid, 0, ACTIVE)

    await userEvent.keyboard(" ")
    await userEvent.click(
      within(cellAt(grid, 0, ACTIVE)).getByText("Checked").previousElementSibling!,
    )

    expect(bodies).toEqual([])
  })

  it("does not paste or cut", async () => {
    const { grid, bodies } = await setup({ readOnly: true })
    await select(grid, 1, BUDGET)

    fireEvent.paste(grid, { clipboardData: { getData: () => "9" } })
    fireEvent.cut(grid, { clipboardData: { setData: vi.fn() } })

    expect(bodies).toEqual([])
  })

  it("still copies", async () => {
    const { grid } = await setup({ readOnly: true })
    await select(grid, 1, BUDGET)
    const setData = vi.fn()

    fireEvent.copy(grid, { clipboardData: { setData } })

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "10\n")
  })
})

describe("the pending style", () => {
  it("shows a saved value in muted italics until the server has answered", async () => {
    let answer!: () => void
    const response = new Promise<void>((resolve) => {
      answer = resolve
    })
    const { grid, bodies } = await setup()
    server.use(
      http.post("/api/v1/models/:id/cells", async ({ request }) => {
        bodies.push((await request.json()) as Body)
        await response
        return HttpResponse.json({ seq: 1, changed_line_item_ids: [] })
      }),
    )
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")

    const pending = within(cellAt(grid, 1, BUDGET)).getByText("42.00")
    expect(pending).toHaveClass("italic", "text-muted-foreground")
    expect(within(cellAt(grid, 0, BUDGET)).getByText("0.00")).not.toHaveClass("italic")

    answer()
    await waitFor(() =>
      expect(within(cellAt(grid, 1, BUDGET)).queryByText("42.00")).not.toBeInTheDocument(),
    )
  })

  it("shows the value the server keeps once the cells have been read again", async () => {
    const { grid, served } = await setup()
    served.fixture = editView({
      cell: (row, col) => (row === 1 && col === BUDGET ? numberCell(42) : editCell(row, col)),
    })
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    await waitFor(() => expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("42.00"))
    await waitFor(() =>
      expect(within(cellAt(grid, 1, BUDGET)).getByText("42.00")).not.toHaveClass("italic"),
    )
  })

  it("takes the value back and says why when the server refuses it", async () => {
    serveViewQuery(editView())
    server.use(
      http.post("/api/v1/models/:id/cells", async () => {
        await delay(50)
        return problem(422, "cells.invalid_value", "Some fields are invalid.", {
          errors: [{ field: "edits[0]", message: "Enter a number" }],
        })
      }),
    )
    renderGrid()
    const grid = await screen.findByRole("grid")
    await waitFor(() => expect(cellAt(grid, 0, BUDGET)).toHaveTextContent("0.00"))
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")
    expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("42.00")

    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith("Enter a number"))
    await waitFor(() => expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("10.00"))
  })

  it("says what the server said when it refuses for any other reason", async () => {
    serveViewQuery(editView())
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(403, "auth.forbidden", "You need the Planner role to change cells."),
      ),
    )
    renderGrid()
    const grid = await screen.findByRole("grid")
    await waitFor(() => expect(cellAt(grid, 0, BUDGET)).toHaveTextContent("0.00"))
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "You need the Planner role to change cells.",
      ),
    )
    await waitFor(() => expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("10.00"))
  })
})

describe("boolean cells", () => {
  it("toggle with Space", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, ACTIVE)

    await userEvent.keyboard(" ")

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-active", 1, { t: "boolean", v: true })] }]),
    )
    expectActive(grid, 1, ACTIVE)
  })

  it("toggle with Enter and F2", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 0, ACTIVE)

    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await userEvent.keyboard("{F2}")
    await waitFor(() => expect(bodies).toHaveLength(2))

    expect(bodies.map((body) => body.edits[0].value)).toEqual([
      { t: "boolean", v: false },
      { t: "boolean", v: false },
    ])
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("toggle with a click on the check box", async () => {
    const { grid, bodies } = await setup()

    const glyph = within(cellAt(grid, 1, ACTIVE)).getByText("Not checked").previousElementSibling
    await userEvent.click(glyph!)

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-active", 1, { t: "boolean", v: true })] }]),
    )
    expectActive(grid, 1, ACTIVE)
  })

  it("show the new state at once", async () => {
    const { grid, bodies } = await setup()
    holdCells(bodies)
    await select(grid, 1, ACTIVE)

    await userEvent.keyboard(" ")

    expect(within(cellAt(grid, 1, ACTIVE)).getByText("Checked")).toBeInTheDocument()
  })

  it("take no typing", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, ACTIVE)

    await userEvent.keyboard("true")
    await userEvent.dblClick(cellAt(grid, 1, ACTIVE))

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it("leave a space in a cell that is not a boolean alone", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, NOTES)

    await userEvent.keyboard(" ")

    expect(bodies).toEqual([])
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })
})

describe("clearing", () => {
  it("clears the selected cells with Delete", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}")

    await userEvent.keyboard("{Delete}")

    await waitFor(() =>
      expect(bodies).toEqual([
        { edits: [written("li-budget", 1, number(0)), written("li-budget", 2, number(0))] },
      ]),
    )
    expect(cellAt(grid, 2, BUDGET)).toHaveTextContent("0.00")
  })

  it("clears with Backspace, each cell to the blank of its own format", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 0, REGION)
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}")

    await userEvent.keyboard("{Backspace}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits.map((edit) => [edit.line_item_id, edit.value])).toEqual([
      ["li-region", { t: "item", v: null }],
      ["li-start", { t: "date", v: null }],
      ["li-active", { t: "boolean", v: false }],
      ["li-notes", { t: "text", v: "" }],
    ])
  })

  it("leaves the cells that cannot be edited, and the ones that are already blank", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 0, NOTES)
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}")
    await userEvent.keyboard("{Delete}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits.map((edit) => edit.line_item_id)).toEqual(["li-notes"])

    await select(grid, 0, BUDGET)
    await userEvent.keyboard("{Delete}")

    expect(bodies).toHaveLength(1)
  })

  it("refuses a selection of more than 10,000 cells", async () => {
    const { grid, bodies } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}a{/Control}")

    await userEvent.keyboard("{Delete}")

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Select at most 10,000 cells to change at once.",
    )
    expect(bodies).toEqual([])
  })
})

describe("list cells", () => {
  it("open a dropdown of the list's items on Enter, and pick by clicking", async () => {
    const { grid, bodies } = await setup()
    holdCells(bodies)
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}")
    expect(screen.getByRole("combobox", { name: "Region, Product 1" })).toHaveFocus()
    expect(screen.getAllByRole("option")).toHaveLength(3)
    await userEvent.click(screen.getByRole("option", { name: /North America/ }))

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-region", 1, { t: "item", v: "r-na" })] }]),
    )
    expect(within(cellAt(grid, 1, REGION)).getByText("North America")).toBeInTheDocument()
    expect(grid).toHaveFocus()
    expectActive(grid, 1, REGION)
  })

  it("pick by the code that is typed", async () => {
    const { grid, bodies } = await setup()
    holdCells(bodies)
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}ap{Enter}")

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-region", 1, { t: "item", v: "r-apac" })] }]),
    )
    expect(within(cellAt(grid, 1, REGION)).getByText("Asia Pacific")).toBeInTheDocument()
    expectActive(grid, 2, REGION)
  })

  it("pick with Enter and move down, with Shift+Enter and move up", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, REGION)

    await userEvent.keyboard("{Enter}{ArrowDown}{Shift>}{Enter}{/Shift}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expectActive(grid, 1, REGION)
  })

  it("open with the typed text as the search", async () => {
    const { grid } = await setup()
    await select(grid, 1, REGION)

    await userEvent.keyboard("nor")

    expect(screen.getByRole("combobox")).toHaveValue("nor")
    expect(screen.getAllByRole("option")).toHaveLength(1)
  })

  it("open on a double click", async () => {
    const { grid } = await setup()

    await userEvent.dblClick(cellAt(grid, 1, REGION))

    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("pick with Tab and move right", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}{ArrowDown}{Tab}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expectActive(grid, 1, START)
  })

  it("send nothing when the item picked is the one the cell has", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}emea{Enter}")

    expect(bodies).toEqual([])
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("give up with Escape", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}{ArrowDown}{Escape}")

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(grid).toHaveFocus()
    expect(bodies).toEqual([])
  })

  it("say the list has no items when the reference knows none", async () => {
    const { grid } = await setup({ reference: { lists: {}, periods: [] } })
    await select(grid, 1, REGION)

    await userEvent.keyboard("{Enter}")

    expect(screen.getByText("This list has no items.")).toBeInTheDocument()
  })
})

describe("date cells", () => {
  it("open the date as text with a calendar, and pick a day", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, START)

    await userEvent.keyboard("{Enter}")
    expect(screen.getByRole("textbox", { name: "Start, Product 1" })).toHaveValue("2026-03-15")
    await userEvent.click(screen.getByRole("button", { name: /March 20, 2026/ }))

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-start", 1, { t: "date", v: "2026-03-20" })] }]),
    )
    expect(grid).toHaveFocus()
    expectActive(grid, 1, START)
  })

  it("save a date that is typed", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, START)

    await userEvent.keyboard("2027-01-31{Enter}")

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-start", 1, { t: "date", v: "2027-01-31" })] }]),
    )
    expectActive(grid, 2, START)
  })

  it("refuse a date that is not one", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, START)

    await userEvent.keyboard("2027-02-31{Enter}")

    expect(toast.error).toHaveBeenCalledOnce()
    expect(bodies).toEqual([])
    expect(screen.getByRole("textbox")).toBeInvalid()
  })

  it("give up with Escape", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, START)

    await userEvent.keyboard("{Enter}{Escape}")

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(grid).toHaveFocus()
    expect(bodies).toEqual([])
  })
})

describe("undo and redo", () => {
  it("undo writes the values from before and redo the values after", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))

    await userEvent.keyboard("{Control>}z{/Control}")
    await waitFor(() => expect(bodies).toHaveLength(2))
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}")
    await waitFor(() => expect(bodies).toHaveLength(3))
    await userEvent.keyboard("{Control>}z{/Control}")
    await waitFor(() => expect(bodies).toHaveLength(4))
    await userEvent.keyboard("{Control>}y{/Control}")
    await waitFor(() => expect(bodies).toHaveLength(5))

    expect(bodies.map((body) => body.edits)).toEqual([
      [written("li-budget", 1, number(42))],
      [written("li-budget", 1, number(10))],
      [written("li-budget", 1, number(42))],
      [written("li-budget", 1, number(10))],
      [written("li-budget", 1, number(42))],
    ])
  })

  it("works with Command on a Mac", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))

    await userEvent.keyboard("{Meta>}z{/Meta}")
    await waitFor(() => expect(bodies).toHaveLength(2))
    await userEvent.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}")

    await waitFor(() => expect(bodies).toHaveLength(3))
  })

  it("undoes a whole clear as one step", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}{Delete}")
    await waitFor(() => expect(bodies).toHaveLength(1))

    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].edits).toEqual([
      written("li-budget", 1, number(10)),
      written("li-budget", 2, number(20)),
    ])
  })

  it("does nothing when there is nothing to undo", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("{Control>}z{/Control}")
    await userEvent.keyboard("{Control>}y{/Control}")

    expect(bodies).toEqual([])
  })

  it("leaves Ctrl+Z to the text while an editor is open", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await select(grid, 2, BUDGET)
    await userEvent.keyboard("{F2}")

    await userEvent.keyboard("{Control>}z{/Control}")

    expect(bodies).toHaveLength(1)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })
})

describe("typing into a cell and the arrow keys", () => {
  it.each([
    ["{ArrowDown}", [1, BUDGET], [2, BUDGET]],
    ["{ArrowUp}", [1, BUDGET], [0, BUDGET]],
    ["{ArrowRight}", [1, BUDGET], [1, REGION]],
    ["{ArrowLeft}", [1, NOTES], [1, ACTIVE]],
  ] as const)("saves a value that was typed and moves on %s", async (key, from, to) => {
    const { grid, bodies } = await setup()
    await select(grid, from[0], from[1])

    await userEvent.keyboard(`5${key}`)

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expectActive(grid, to[0], to[1])
  })

  it("moves the caret instead when the editor was opened on the value", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("{F2}{ArrowLeft}{ArrowDown}")

    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(bodies).toEqual([])
    expectActive(grid, 1, BUDGET)
  })

  it("moves the caret instead when the editor was opened with Enter or a double click", async () => {
    const { grid } = await setup()
    await select(grid, 1, NOTES)
    await userEvent.keyboard("{Enter}{ArrowLeft}")
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await userEvent.dblClick(cellAt(grid, 2, NOTES))
    await userEvent.keyboard("{ArrowUp}")

    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("lets F2 turn typing into editing, so the arrows move the caret", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, NOTES)

    await userEvent.keyboard("abc{F2}{ArrowLeft}{ArrowDown}")

    expect(screen.getByRole("textbox")).toHaveValue("abc")
    expect(bodies).toEqual([])
    expectActive(grid, 1, NOTES)
  })
})

describe("after undo, redo and paste", () => {
  it("undo selects the cell it restored and redo selects it again", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await select(grid, 4, NOTES)

    await userEvent.keyboard("{Control>}z{/Control}")
    await waitFor(() => expectActive(grid, 1, BUDGET))
    await select(grid, 4, NOTES)
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}")

    await waitFor(() => expectActive(grid, 1, BUDGET))
  })

  it("undo selects the whole range that was cleared", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{/Shift}{Delete}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await select(grid, 5, NOTES)

    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expectActive(grid, 1, BUDGET))
    for (const [row, col] of [
      [1, BUDGET],
      [2, BUDGET],
      [1, REGION],
      [2, REGION],
    ]) {
      expect(cellAt(grid, row, col)).toHaveAttribute("aria-selected", "true")
    }
    expect(cellAt(grid, 3, BUDGET)).toHaveAttribute("aria-selected", "false")
  })

  it("undo scrolls back to the restored cell", async () => {
    const { grid, bodies } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("9{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await userEvent.keyboard("{Control>}{ArrowDown}{/Control}")
    await waitFor(() => expect(grid.scrollTop).toBeGreaterThan(1000))

    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expect(grid.scrollTop).toBe(0))
    await waitFor(() => expectActive(grid, 0, 0))
  })

  it("does not select positions of the old view once the view has changed", async () => {
    // Hiding a product moves the ones below it up a row, so row 4 is another product.
    const rowsOf = (q: ViewQuery) => {
      const hidden = new Set((q.hidden ?? []).map((ref) => ref.key))
      return [0, 1, 2, 3, 4, 5].filter((product) => !hidden.has(`p${product}`))
    }
    serveViewQueryBy((q) => {
      const products = rowsOf(q)
      return editView({
        totalRows: products.length,
        rowHeader: (row) => header(member(`p${products[row]}`, `Product ${products[row]}`)),
      })
    })
    const bodies = serveCells()
    const queryClient = createTestQueryClient({ staleTime: QUERY_STALE_TIME })
    const gridOf = (query: GridQuery) => (
      <QueryClientProvider client={queryClient}>
        <Grid modelId={MODEL_ID} query={query} reference={reference} />
      </QueryClientProvider>
    )
    const { rerender } = render(gridOf(editQuery))
    const grid = await screen.findByRole("grid")
    await waitFor(() => expect(cellAt(grid, 0, 0).textContent).not.toBe(""))
    await select(grid, 4, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(bodies).toHaveLength(1))
    await select(grid, 0, NOTES)

    rerender(gridOf({ ...editQuery, hidden: [{ dim: productsList, key: "p1" }] }))
    await waitFor(() =>
      expect(within(grid).queryByRole("rowheader", { name: "Product 1" })).not.toBeInTheDocument(),
    )
    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].edits).toEqual([written("li-budget", 4, number(40))])
    expectActive(grid, 0, NOTES)
  })

  it("paste selects the block that was pasted, with the active cell at its top left", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    fireEvent.paste(document.body, { clipboardData: { getData: () => "5\tAP\n6\tNA\n7\tEU" } })

    await waitFor(() => expect(bodies).toHaveLength(1))
    expectActive(grid, 1, BUDGET)
    for (const [row, col] of [
      [1, BUDGET],
      [3, REGION],
    ]) {
      expect(cellAt(grid, row, col)).toHaveAttribute("aria-selected", "true")
    }
    expect(cellAt(grid, 4, BUDGET)).toHaveAttribute("aria-selected", "false")
    expect(cellAt(grid, 1, START)).toHaveAttribute("aria-selected", "false")
  })
})

describe("cells in error", () => {
  const errorView = () =>
    editView({
      cell: (row, col) =>
        col === NOTES
          ? { value: { t: "text", v: "stale" }, flags: ["error", "readonly"] }
          : editCell(row, col),
    })

  it("copy as empty, like cells that do not apply", async () => {
    const { grid } = await setup({}, errorView())
    await select(grid, 1, ACTIVE)
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}")
    const setData = vi.fn()

    fireEvent.copy(grid, { clipboardData: { setData } })

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "FALSE\t\n")
  })

  it("fill down as empty", async () => {
    const view = editView({
      cell: (row, col) =>
        col === BUDGET && row === 1
          ? { value: { t: "number", v: 99 }, flags: ["error", "readonly"] }
          : editCell(row, col),
    })
    const { grid, bodies } = await setup({}, view)
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}{Control>}d{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits).toEqual([written("li-budget", 2, number(0))])
  })
})

describe("saying what happened", () => {
  it("marks a cell that is being written as busy, and not once it is written", async () => {
    const { grid, bodies } = await setup()
    const release = holdCells(bodies)
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    expect(cellAt(grid, 1, BUDGET)).toHaveAttribute("aria-busy", "true")
    expect(cellAt(grid, 0, BUDGET)).not.toHaveAttribute("aria-busy")
    release()
    await waitFor(() => expect(cellAt(grid, 1, BUDGET)).not.toHaveAttribute("aria-busy"))
  })

  it("says Saved, politely, when the edit of one cell is written", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    const message = await screen.findByText("Saved")
    expect(message.closest("[role='status']")).toHaveClass("sr-only")
  })

  it("leaves a refusal to its toast, which is read out on its own", async () => {
    const { grid } = await setup()
    server.use(
      http.post("/api/v1/models/:id/cells", () =>
        problem(422, "cells.invalid_value", "Some fields are invalid.", {
          errors: [{ field: "edits[0]", message: "Enter a number" }],
        }),
      ),
    )
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("42{Enter}")

    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith("Enter a number"))
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
    expect(screen.queryByText("Enter a number")).not.toBeInTheDocument()
  })

  it("does not say Saved for a paste, which has its toast", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    fireEvent.paste(document.body, { clipboardData: { getData: () => "5\n6" } })

    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
  })

  it("does not say Saved for a paste of one cell either", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    fireEvent.paste(document.body, { clipboardData: { getData: () => "5" } })

    await waitFor(() => expect(bodies).toHaveLength(1))
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 1 cell"))
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
  })

  it("does not say Saved for a paste of which one cell differs from what it holds", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    fireEvent.paste(document.body, { clipboardData: { getData: () => "10\n6" } })

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 2, number(6))] }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 2 cells"))
    expect(screen.queryByText("Saved")).not.toBeInTheDocument()
  })

  it("says Filled when a fill changes one cell and skips nothing, which has no toast", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, NOTES)

    await userEvent.keyboard("{Control>}d{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    const message = await screen.findByText("Filled 1 cell")
    expect(message.closest("[role='status']")).toHaveClass("sr-only")
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("says Saved when one cell is cleared, which has no message of its own", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    await userEvent.keyboard("{Delete}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(await screen.findByText("Saved")).toBeInTheDocument()
  })
})

describe("a grid that is read only, in its look", () => {
  it("gives every cell the default cursor, not the cell cursor", async () => {
    const { grid } = await setup({ readOnly: true })

    expect(cellAt(grid, 1, BUDGET)).toHaveClass("cursor-default")
    expect(cellAt(grid, 1, BUDGET)).not.toHaveClass("cursor-cell")
    expect(cellAt(grid, 1, CALCULATED)).toHaveClass("cursor-default")
  })

  it("keeps the cell cursor for the cells that can be edited in a grid that is not", async () => {
    const { grid } = await setup()

    expect(cellAt(grid, 1, BUDGET)).toHaveClass("cursor-cell")
    expect(cellAt(grid, 1, CALCULATED)).toHaveClass("cursor-not-allowed")
  })
})
