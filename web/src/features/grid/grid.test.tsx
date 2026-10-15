import { QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import {
  MODEL_ID,
  MODULE_ID,
  answer,
  failViewQuery,
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  productsList,
  salesLineItemId,
  salesQuery,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import type { ViewFixture } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import { Grid } from "./grid"
import type { Cell, ConditionalFormat, GridQuery, ViewDim } from "./view-types"

// Each test loads blocks through msw into jsdom, which is slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const VIEWPORT = { width: 800, height: 400 }
// The sales fixture has two header rows of 32 px above the body.
const HEADER_HEIGHT = 64

const timeDim: ViewDim = { kind: "time" }
const regionsList: ViewDim = { kind: "list", list: "list-regions" }

type GridProps = Parameters<typeof Grid>[0]

function renderGrid(props: Partial<GridProps> = {}) {
  const queryClient = createTestQueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Grid modelId={MODEL_ID} query={salesQuery} {...props} />
    </QueryClientProvider>,
  )
  return { queryClient, ...view }
}

async function findGrid() {
  return screen.findByRole("grid")
}

/** The grid, once its first cells have loaded. */
async function loadedGrid() {
  const grid = await findGrid()
  await waitFor(() => expect(cellAt(grid, 0, 0).textContent).not.toBe(""))
  return grid
}

function cellAt(grid: HTMLElement, row: number, col: number): HTMLElement {
  const cell = grid.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)
  if (!cell) {
    throw new Error(`No cell rendered at row ${row}, column ${col}`)
  }
  return cell
}

function windows(requests: { window: { row_offset: number; col_offset: number } }[]) {
  return requests.map((r) => `${r.window.row_offset / 100},${r.window.col_offset / 40}`)
}

beforeEach(() => {
  mockViewport(VIEWPORT.width, VIEWPORT.height)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("states", () => {
  it("shows a skeleton while the first block loads", async () => {
    serveViewQuery()

    renderGrid()

    expect(screen.getByRole("status", { name: "Loading grid" })).toBeInTheDocument()
    await findGrid()
    expect(screen.queryByRole("status", { name: "Loading grid" })).not.toBeInTheDocument()
  })

  it("explains a view with no rows and offers to reset it", async () => {
    serveViewQuery(salesView({ totalRows: 0 }))
    const onResetView = vi.fn()
    renderGrid({ onResetView })

    expect(await screen.findByText("Nothing to show with this pivot.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset view" }))

    expect(onResetView).toHaveBeenCalledOnce()
    expect(screen.queryByRole("grid")).not.toBeInTheDocument()
  })

  it("explains a view with no columns", async () => {
    serveViewQuery(salesView({ totalColumns: 0 }))
    renderGrid()

    expect(await screen.findByText("Nothing to show with this pivot.")).toBeInTheDocument()
  })

  it("offers no reset without a handler for it", async () => {
    serveViewQuery(salesView({ totalRows: 0 }))
    renderGrid()

    await screen.findByText("Nothing to show with this pivot.")
    expect(screen.queryByRole("button", { name: "Reset view" })).not.toBeInTheDocument()
  })

  it("shows the server's refusal with a retry that loads the grid", async () => {
    failViewQuery("The pivot has no line items.")
    renderGrid()

    expect(await screen.findByText("The pivot has no line items.")).toBeInTheDocument()
    serveViewQuery()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("grid")).toBeInTheDocument()
  })

  it("keeps the grid and shows the error above it when a later block fails", async () => {
    const served = serveViewQuery()
    const { queryClient } = renderGrid()
    const grid = await loadedGrid()
    failViewQuery("The model is busy.")

    await act(() => queryClient.refetchQueries({ queryKey: ["models", MODEL_ID, "query"] }))

    expect(await screen.findByText("The model is busy.")).toBeInTheDocument()
    expect(grid).toBeInTheDocument()
    serveViewQuery(served.fixture)
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.queryByText("The model is busy.")).not.toBeInTheDocument())
  })
})

describe("headers and cells", () => {
  it("renders the row headers, column headers and cells of the visible window", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    expect(within(grid).getByRole("rowheader", { name: "Product 1" })).toBeInTheDocument()
    expect(within(grid).getByRole("rowheader", { name: "Product 5" })).toBeInTheDocument()
    expect(within(grid).getByRole("columnheader", { name: "Line item 0" })).toBeInTheDocument()
    expect(cellAt(grid, 0, 0)).toHaveTextContent("0")
    expect(cellAt(grid, 2, 1)).toHaveTextContent("$2,001.00")
    expect(cellAt(grid, 2, 2)).toHaveTextContent("200,200.0%")
    expect(cellAt(grid, 1, 4)).toHaveTextContent("Note 1")
  })

  it("renders only the rows and columns in view", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    const rows = grid.querySelectorAll("[data-row][data-col='0']")
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(40)
    expect(grid.querySelector("[data-col='30']")).toBeNull()
    expect(within(grid).queryByRole("rowheader", { name: "Product 500" })).not.toBeInTheDocument()
  })

  it("merges neighbouring members of a nested column dimension into one spanning header", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    const actual = within(grid).getByRole("columnheader", { name: "Actual" })
    expect(actual).toHaveAttribute("aria-colspan")
    expect(Number(actual.getAttribute("aria-colspan"))).toBeGreaterThan(3)
    expect(within(grid).getAllByRole("columnheader", { name: "Actual" })).toHaveLength(1)
    expect(actual).toHaveAttribute("aria-colindex", "2")
  })

  it("puts one header row on top for each column dimension", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    const rows = within(grid).getAllByRole("row")
    expect(rows[0]).toHaveAttribute("aria-rowindex", "1")
    expect(within(rows[0]).getByRole("columnheader", { name: "Actual" })).toBeInTheDocument()
    expect(rows[1]).toHaveAttribute("aria-rowindex", "2")
    expect(within(rows[1]).getByRole("columnheader", { name: "Line item 0" })).toBeInTheDocument()
    expect(rows[2]).toHaveAttribute("aria-rowindex", "3")
  })

  it("repeats an outer row label on every row, muted except on the first row of a group", async () => {
    const regions = ["EMEA", "APAC"]
    serveViewQuery(
      salesView({
        rowDims: [regionsList, productsList],
        columnDims: [lineItemsDim],
        totalRows: 4,
        totalColumns: 1,
        rowHeader: (row) =>
          header(
            member(`r${Math.floor(row / 2)}`, regions[Math.floor(row / 2)]),
            member(`p${row % 2}`, `Product ${(row % 2) + 1}`),
          ),
        columnHeader: () => header(member("li-0", "Line item 0")),
      }),
    )
    renderGrid({
      query: { ...salesQuery, rows: [regionsList, productsList], columns: [lineItemsDim] },
    })
    const grid = await loadedGrid()

    const emea = within(grid).getAllByRole("rowheader", { name: "EMEA" })
    expect(emea).toHaveLength(2)
    expect(emea[0]).not.toHaveClass("text-muted-foreground")
    expect(emea[1]).toHaveClass("text-muted-foreground")
    const apac = within(grid).getAllByRole("rowheader", { name: "APAC" })
    expect(apac[0]).not.toHaveClass("text-muted-foreground")
    expect(apac[1]).toHaveClass("text-muted-foreground")
    for (const inner of within(grid).getAllByRole("rowheader", { name: /^Product/ })) {
      expect(inner).not.toHaveClass("text-muted-foreground")
    }
    expect(within(grid).getAllByRole("rowheader", { name: "EMEA" })[0]).toHaveAttribute(
      "aria-colindex",
      "1",
    )
    expect(within(grid).getAllByRole("rowheader", { name: "Product 1" })[0]).toHaveAttribute(
      "aria-colindex",
      "2",
    )
  })

  it("lays the row header columns out side by side", async () => {
    serveViewQuery(
      salesView({
        rowDims: [regionsList, productsList],
        columnDims: [lineItemsDim],
        totalRows: 2,
        totalColumns: 1,
        rowHeader: (row) => header(member("r0", "EMEA"), member(`p${row}`, `Product ${row + 1}`)),
        columnHeader: () => header(member("li-0", "Line item 0")),
      }),
    )
    renderGrid({
      query: { ...salesQuery, rows: [regionsList, productsList], columns: [lineItemsDim] },
    })
    const grid = await loadedGrid()

    const [first] = within(grid).getAllByRole("rowheader", { name: "EMEA" })
    expect(first).toHaveStyle({ width: "160px" })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "320px", width: "120px" })
  })
})

describe("hierarchy", () => {
  const regionTree = [
    member("top", "All Regions", { is_summary: true, has_children: true }),
    member("emea", "EMEA", { depth: 1, has_children: true, collapsed: true }),
    member("uk", "United Kingdom", { depth: 2 }),
  ]
  const months = [
    member("Jan 26", "Jan 26"),
    member("Feb 26", "Feb 26"),
    member("Q1 FY26", "Q1 FY26", { depth: 1, is_summary: true, has_children: true }),
  ]

  function hierarchyView() {
    return salesView({
      rowDims: [regionsList],
      columnDims: [timeDim],
      pages: [{ dim: lineItemsDim, member: member("li-0", "Revenue") }],
      lineItems: [lineItem("li-0", "Revenue")],
      totalRows: 3,
      totalColumns: 3,
      rowHeader: (row) => header(regionTree[row]),
      columnHeader: (col) => header(months[col]),
      cell: (row, col) => numberCell(row * 10 + col),
    })
  }

  const query: GridQuery = {
    module: MODULE_ID,
    rows: [regionsList],
    columns: [timeDim],
    pages: [{ dim: lineItemsDim, key: "li-0" }],
  }

  it("indents each level of depth by 16 px", async () => {
    serveViewQuery(hierarchyView())
    renderGrid({ query })
    const grid = await loadedGrid()

    const indent = (name: string) =>
      parseInt(within(grid).getByRole("rowheader", { name }).style.paddingLeft, 10)
    expect(indent("EMEA") - indent("All Regions")).toBe(16)
    expect(indent("United Kingdom") - indent("EMEA")).toBe(16)
  })

  it("toggles collapse from a chevron on a row header", async () => {
    serveViewQuery(hierarchyView())
    const onToggleCollapse = vi.fn()
    renderGrid({ query, onToggleCollapse })
    const grid = await loadedGrid()

    await userEvent.click(within(grid).getByRole("button", { name: "Collapse All Regions" }))
    await userEvent.click(within(grid).getByRole("button", { name: "Expand EMEA" }))

    expect(onToggleCollapse).toHaveBeenNthCalledWith(1, { dim: regionsList, key: "top" })
    expect(onToggleCollapse).toHaveBeenNthCalledWith(2, { dim: regionsList, key: "emea" })
    expect(within(grid).queryByRole("button", { name: /United Kingdom/ })).not.toBeInTheDocument()
  })

  it("draws the chevron of an outer row label on the first row of its group only", async () => {
    serveViewQuery(
      salesView({
        rowDims: [regionsList, lineItemsDim],
        columnDims: [timeDim],
        totalRows: 3,
        totalColumns: 1,
        lineItems: [lineItem("li-a", "Units"), lineItem("li-b", "Price")],
        rowHeader: (row) =>
          row < 2
            ? header(
                member("emea", "EMEA", { is_summary: true, has_children: true }),
                member(`li-${row === 0 ? "a" : "b"}`, row === 0 ? "Units" : "Price"),
              )
            : header(member("uk", "United Kingdom", { depth: 1 }), member("li-a", "Units")),
        columnHeader: () => header(member("Jan 26", "Jan 26")),
        cell: () => numberCell(1),
      }),
    )
    renderGrid({
      query: { ...salesQuery, rows: [regionsList, lineItemsDim], columns: [timeDim] },
      onToggleCollapse: vi.fn(),
    })
    const grid = await loadedGrid()

    expect(within(grid).getAllByRole("rowheader", { name: "EMEA" })).toHaveLength(2)
    expect(within(grid).getAllByRole("button", { name: "Collapse EMEA" })).toHaveLength(1)
  })

  it("toggles collapse from a chevron on a time column header", async () => {
    serveViewQuery(hierarchyView())
    const onToggleCollapse = vi.fn()
    renderGrid({ query, onToggleCollapse })
    const grid = await loadedGrid()

    const quarter = within(grid).getByRole("columnheader", { name: /Q1 FY26/ })
    await userEvent.click(within(quarter).getByRole("button", { name: "Collapse Q1 FY26" }))

    expect(onToggleCollapse).toHaveBeenCalledExactlyOnceWith({ dim: timeDim, key: "Q1 FY26" })
    expect(within(grid).queryByRole("button", { name: /Jan 26/ })).not.toBeInTheDocument()
  })

  it("keeps the keyboard on the grid after a chevron is clicked", async () => {
    serveViewQuery(hierarchyView())
    renderGrid({ query, onToggleCollapse: vi.fn() })
    const grid = await loadedGrid()

    await userEvent.click(within(grid).getByRole("button", { name: "Collapse All Regions" }))

    expect(grid).toHaveFocus()
  })
})

describe("cell styling", () => {
  const flagged: Record<number, Cell["flags"]> = {
    0: ["input"],
    1: ["calculated", "readonly"],
    2: ["summary", "readonly"],
    3: ["na", "readonly"],
    4: ["calculated", "readonly", "switchover"],
    5: ["error", "readonly"],
  }

  function flagsView(): ViewFixture {
    return salesView({
      rowDims: [productsList],
      columnDims: [lineItemsDim],
      totalRows: 3,
      totalColumns: 6,
      lineItems: Array.from({ length: 6 }, (_, i) => lineItem(`li-${i}`, `Line item ${i}`)),
      rowHeader: (row) => header(member(`p${row}`, `Product ${row + 1}`)),
      columnHeader: (col) => header(member(`li-${col}`, `Line item ${col}`)),
      cell: (row, col) =>
        col === 3 || col === 5
          ? { value: { t: "number", v: 0 }, flags: flagged[col] }
          : numberCell(1234 + row, flagged[col]),
    })
  }

  const flagsQuery: GridQuery = { ...salesQuery, columns: [lineItemsDim] }

  async function renderFlags() {
    serveViewQuery(flagsView())
    renderGrid({ query: flagsQuery })
    return loadedGrid()
  }

  it("draws input cells on the page background", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 0)).toHaveClass("bg-background", "text-foreground")
    expect(cellAt(grid, 0, 0)).not.toHaveAttribute("aria-readonly")
    expect(cellAt(grid, 0, 0)).not.toHaveClass("cursor-not-allowed")
  })

  it("tints calculated cells, locks them and shows a lock on hover", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 1)
    expect(cell).toHaveClass("bg-muted/30", "text-foreground", "cursor-not-allowed", "group/cell")
    expect(cell).toHaveAttribute("aria-readonly", "true")
    expect(cell.querySelector(".lucide-lock")).toHaveClass(
      "opacity-0",
      "group-hover/cell:opacity-100",
    )
    expect(cellAt(grid, 0, 0).querySelector(".lucide-lock")).toBeNull()
  })

  it("makes summary cells bold with a stronger tint", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 2)).toHaveClass("font-semibold", "bg-muted/40", "cursor-not-allowed")
  })

  it("leaves a cell that does not apply empty and darker", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 3)
    expect(cell).toHaveClass("bg-muted/60")
    expect(cell).toHaveTextContent("")
    expect(cell).toHaveAttribute("aria-readonly", "true")
    expect(cell.querySelector(".lucide-lock")).toBeNull()
  })

  it("explains a cell that shows the actual before the switchover", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 4)
    expect(cell).toHaveClass("bg-muted/30")
    await userEvent.hover(cell)

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Before the switchover: showing Actual.",
    )
  })

  it("leaves a cell in error blank", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 5)).toHaveTextContent("")
    expect(cellAt(grid, 0, 5)).toHaveAttribute("aria-readonly", "true")
  })

  it("right-aligns numbers in tabular figures", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 0)).toHaveClass("justify-end", "tabular-nums")
    expect(cellAt(grid, 0, 0)).toHaveTextContent("1,234")
  })

  it("marks a line item in error in its header, with the first message as a tooltip", async () => {
    const view = flagsView()
    view.lineItems[1] = lineItem("li-1", "Line item 1", {
      errors: [
        {
          code: "formula.unknown_name",
          message: "Unknown name 'Pricee'.",
          start: 0,
          end: 6,
          suggestion: "Price",
        },
        { code: "formula.other", message: "Second problem.", start: 0, end: 1, suggestion: null },
      ],
    })
    serveViewQuery(view)
    renderGrid({ query: flagsQuery })
    const grid = await loadedGrid()

    const header = within(grid).getByRole("columnheader", { name: /Line item 1/ })
    const icon = within(header).getByRole("img", { name: "Unknown name 'Pricee'." })
    expect(icon).toHaveClass("text-destructive")
    expect(within(grid).getByRole("columnheader", { name: "Line item 0" })).toBeInTheDocument()
    await userEvent.hover(icon)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Unknown name 'Pricee'.")
  })

  it("applies the first conditional format that matches", async () => {
    serveViewQuery(flagsView())
    const conditionalFormats: ConditionalFormat[] = [
      {
        name: "Big",
        line_item_ids: [],
        op: "gt",
        value: 1235,
        style: { color: "green", bold: true },
      },
      {
        name: "Positive",
        line_item_ids: [],
        op: "positive",
        style: { color: "blue", bold: false },
      },
    ]
    renderGrid({ query: flagsQuery, conditionalFormats })
    const grid = await loadedGrid()

    expect(cellAt(grid, 2, 0)).toHaveClass("bg-green-500/15", "text-green-700", "font-bold")
    expect(cellAt(grid, 2, 0)).not.toHaveClass("bg-background", "text-foreground")
    expect(cellAt(grid, 0, 0)).toHaveClass("bg-blue-500/15", "dark:text-blue-300")
    expect(cellAt(grid, 0, 3)).toHaveClass("bg-muted/60")
  })

  it("colours a muted rule with the muted tokens", async () => {
    serveViewQuery(flagsView())
    renderGrid({
      query: flagsQuery,
      conditionalFormats: [
        {
          name: "Quiet",
          line_item_ids: ["li-0"],
          op: "positive",
          style: { color: "muted", bold: false },
        },
      ],
    })
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, 0)).toHaveClass("bg-muted", "text-muted-foreground")
  })
})

describe("boolean cells", () => {
  const booleanColumn = 3

  it("draws a check box that is checked for true", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    const checked = cellAt(grid, 0, booleanColumn)
    const unchecked = cellAt(grid, 1, booleanColumn)
    expect(checked).toHaveAttribute("aria-checked", "true")
    expect(unchecked).toHaveAttribute("aria-checked", "false")
    expect(checked.querySelector(".lucide-check")).not.toBeNull()
    expect(unchecked.querySelector(".lucide-check")).toBeNull()
    expect(checked).toHaveClass("justify-center")
  })

  it("reports a click on the check box of an editable cell", async () => {
    serveViewQuery()
    const onToggleBoolean = vi.fn()
    renderGrid({ onToggleBoolean })
    const grid = await loadedGrid()

    await userEvent.click(cellAt(grid, 1, booleanColumn).querySelector("[data-toggle]")!)

    expect(onToggleBoolean).toHaveBeenCalledExactlyOnceWith({ row: 1, col: booleanColumn })
  })

  it("does not toggle in a read-only grid", async () => {
    serveViewQuery()
    const onToggleBoolean = vi.fn()
    renderGrid({ onToggleBoolean, readOnly: true })
    const grid = await loadedGrid()

    expect(grid).toHaveAttribute("aria-readonly", "true")
    expect(grid.querySelector("[data-toggle]")).toBeNull()
    await userEvent.click(cellAt(grid, 1, booleanColumn))
    expect(onToggleBoolean).not.toHaveBeenCalled()
  })

  it("does not toggle a cell that is read-only", async () => {
    serveViewQuery(
      salesView({
        cell: (row, col) =>
          col % 25 === 3
            ? { value: { t: "boolean", v: true }, flags: ["calculated", "readonly"] }
            : numberCell(row),
      }),
    )
    renderGrid({ onToggleBoolean: vi.fn() })
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, booleanColumn).querySelector("[data-toggle]")).toBeNull()
    expect(cellAt(grid, 0, booleanColumn).querySelector(".lucide-check")).not.toBeNull()
  })
})

describe("accessibility", () => {
  it("describes the grid and its size to assistive technology", async () => {
    serveViewQuery()
    renderGrid({ label: "Revenue plan" })
    const grid = await loadedGrid()

    expect(grid).toHaveAccessibleName("Revenue plan")
    expect(grid).toHaveAttribute("aria-rowcount", "1002")
    expect(grid).toHaveAttribute("aria-colcount", "51")
    expect(grid).toHaveAttribute("aria-multiselectable", "true")
    expect(grid).toHaveAttribute("tabindex", "0")
    expect(grid).not.toHaveAttribute("aria-readonly")
  })

  it("numbers rows and columns from the top left, headers included", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    const firstCell = cellAt(grid, 0, 0)
    expect(firstCell).toHaveAttribute("role", "gridcell")
    expect(firstCell).toHaveAttribute("aria-colindex", "2")
    expect(firstCell.closest("[role='row']")).toHaveAttribute("aria-rowindex", "3")
    expect(cellAt(grid, 4, 6).closest("[role='row']")).toHaveAttribute("aria-rowindex", "7")
    expect(cellAt(grid, 4, 6)).toHaveAttribute("aria-colindex", "8")
    expect(within(grid).getByRole("rowheader", { name: "Product 1" })).toHaveAttribute(
      "aria-colindex",
      "1",
    )
  })

  it("marks the selected cells and points the grid at the active one", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, 0)).toHaveAttribute("aria-selected", "true")
    expect(cellAt(grid, 0, 1)).toHaveAttribute("aria-selected", "false")
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 0).id)
    expect(cellAt(grid, 0, 0).id).not.toBe("")
  })

  it("is one tab stop that takes focus", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    await userEvent.tab()

    expect(grid).toHaveFocus()
  })
})

describe("selection", () => {
  it("moves with the arrow keys and follows the active cell", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{ArrowDown}{ArrowRight}{ArrowRight}")

    expect(cellAt(grid, 1, 2)).toHaveAttribute("aria-selected", "true")
    expect(cellAt(grid, 0, 0)).toHaveAttribute("aria-selected", "false")
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 1, 2).id)
  })

  it("extends the range with Shift and arrows", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{/Shift}")

    for (const [row, col] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      expect(cellAt(grid, row, col)).toHaveAttribute("aria-selected", "true")
    }
    expect(cellAt(grid, 2, 0)).toHaveAttribute("aria-selected", "false")
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 0).id)
  })

  it("selects every cell with Ctrl+A", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{Control>}a{/Control}")

    expect(cellAt(grid, 3, 3)).toHaveAttribute("aria-selected", "true")
  })

  it("scrolls to the last row and column with Ctrl and arrows, and loads them", async () => {
    const served = serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{Control>}{ArrowDown}{/Control}")

    // The last row ends 32 px below its start: header + 999 rows + 1 row, less the viewport.
    expect(grid.scrollTop).toBe(HEADER_HEIGHT + 1000 * 32 - VIEWPORT.height)
    fireEvent.scroll(grid)
    expect(await screen.findByRole("rowheader", { name: "Product 1000" })).toBeInTheDocument()
    expect(await screen.findByText("Note 999")).toBeInTheDocument()
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 999, 0).id)
    expect(windows(served.requests)).toContain("9,0")

    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}")

    // The row headers (240 px) and 50 columns of 120 px, less the viewport width.
    expect(grid.scrollLeft).toBe(240 + 50 * 120 - VIEWPORT.width)
    fireEvent.scroll(grid)
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 999, 49).id)
    expect(
      await within(grid).findByRole("columnheader", { name: "Line item 24" }),
    ).toBeInTheDocument()
  })

  it("scrolls back up to an active cell hidden under the headers", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()
    await userEvent.keyboard("{PageDown}{PageDown}")
    fireEvent.scroll(grid)
    const scrolled = grid.scrollTop
    expect(scrolled).toBeGreaterThan(0)

    await userEvent.keyboard("{Control>}{ArrowUp}{/Control}")

    expect(grid.scrollTop).toBe(0)
  })

  it("moves a page of rows at a time", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{PageDown}")

    // (400 - 64) / 32 = 10 rows are in view.
    expect(grid).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-r10c0$/))
  })

  it("lets Tab leave the grid from the last cell", async () => {
    serveViewQuery(salesView({ totalRows: 1, totalColumns: 1 }))
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Grid modelId={MODEL_ID} query={salesQuery} />
        <button type="button">After</button>
      </QueryClientProvider>,
    )
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.tab()

    expect(screen.getByRole("button", { name: "After" })).toHaveFocus()
  })

  it("keeps Tab in the grid while there is a next cell", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.tab()

    expect(grid).toHaveFocus()
    expect(cellAt(grid, 0, 1)).toHaveAttribute("aria-selected", "true")
  })

  it("selects a cell on click and extends the range on Shift+click", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    await userEvent.click(cellAt(grid, 2, 2))
    expect(cellAt(grid, 2, 2)).toHaveAttribute("aria-selected", "true")
    expect(cellAt(grid, 0, 0)).toHaveAttribute("aria-selected", "false")
    expect(grid).toHaveFocus()

    fireEvent.pointerDown(cellAt(grid, 4, 3), { shiftKey: true })
    fireEvent.pointerUp(cellAt(grid, 4, 3))

    for (const [row, col] of [
      [2, 2],
      [3, 3],
      [4, 3],
    ]) {
      expect(cellAt(grid, row, col)).toHaveAttribute("aria-selected", "true")
    }
    expect(cellAt(grid, 1, 2)).toHaveAttribute("aria-selected", "false")
    expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 2, 2).id)
  })

  it("selects a range by dragging, and stops when the button is released", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    fireEvent.pointerDown(cellAt(grid, 1, 1))
    fireEvent.pointerMove(cellAt(grid, 3, 2))
    fireEvent.pointerUp(cellAt(grid, 3, 2))
    fireEvent.pointerMove(cellAt(grid, 6, 4))

    for (const [row, col] of [
      [1, 1],
      [2, 1],
      [3, 2],
    ]) {
      expect(cellAt(grid, row, col)).toHaveAttribute("aria-selected", "true")
    }
    expect(cellAt(grid, 6, 4)).toHaveAttribute("aria-selected", "false")
    expect(cellAt(grid, 4, 2)).toHaveAttribute("aria-selected", "false")
  })

  it("keeps extending a drag that leaves the cells, to the nearest cell", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 400))

    fireEvent.pointerDown(cellAt(grid, 0, 0))
    // Below the last visible row and right of the last visible column.
    fireEvent.pointerMove(grid, { clientX: 500, clientY: 300 })
    fireEvent.pointerUp(grid)

    // x = 500 - 240 headers = 260 -> column 2; y = 300 - 64 = 236 -> row 7.
    expect(cellAt(grid, 7, 2)).toHaveAttribute("aria-selected", "true")
    expect(cellAt(grid, 8, 2)).toHaveAttribute("aria-selected", "false")
  })

  it("reports the line item of the active cell", async () => {
    serveViewQuery()
    const onSelectLineItem = vi.fn()
    renderGrid({ onSelectLineItem })
    const grid = await loadedGrid()

    await waitFor(() => expect(onSelectLineItem).toHaveBeenCalledWith(salesLineItemId(0)))
    await userEvent.click(cellAt(grid, 1, 7))

    await waitFor(() => expect(onSelectLineItem).toHaveBeenLastCalledWith(salesLineItemId(7)))
    onSelectLineItem.mockClear()
    await userEvent.click(cellAt(grid, 3, 7))
    expect(onSelectLineItem).not.toHaveBeenCalled()
  })

  it("reads the line item of the cell from the row headers when they hold the line items", async () => {
    serveViewQuery(
      salesView({
        rowDims: [lineItemsDim],
        columnDims: [timeDim],
        totalRows: 2,
        totalColumns: 2,
        lineItems: [lineItem("li-a", "Units"), lineItem("li-b", "Price")],
        rowHeader: (row) =>
          header(member(row === 0 ? "li-a" : "li-b", row === 0 ? "Units" : "Price")),
        columnHeader: (col) => header(member(`m${col}`, `Month ${col + 1}`)),
        cell: (row) => numberCell(row + 1),
      }),
    )
    const onSelectLineItem = vi.fn()
    renderGrid({
      query: { ...salesQuery, rows: [lineItemsDim], columns: [timeDim] },
      onSelectLineItem,
    })
    const grid = await loadedGrid()

    await waitFor(() => expect(onSelectLineItem).toHaveBeenCalledWith("li-a"))
    await userEvent.click(cellAt(grid, 1, 1))
    await waitFor(() => expect(onSelectLineItem).toHaveBeenLastCalledWith("li-b"))
  })
})

describe("data loading", () => {
  it("fetches only the blocks around what is visible", async () => {
    const served = serveViewQuery()
    renderGrid()
    await loadedGrid()
    await waitFor(() => expect(served.requests.length).toBeGreaterThanOrEqual(4))

    expect(new Set(windows(served.requests))).toEqual(new Set(["0,0", "0,1", "1,0", "1,1"]))
    expect(served.requests.every((r) => r.module === MODULE_ID)).toBe(true)
    expect(
      served.requests.every((r) => r.window.row_limit === 100 && r.window.col_limit === 40),
    ).toBe(true)
  })

  it("shows a placeholder in a cell whose block has not arrived", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const served = serveViewQuery()
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const body = (await request.json()) as { window: { row_offset: number } }
        if (body.window.row_offset > 0) {
          await gate
        }
        return HttpResponse.json(answer(served.fixture, body as never))
      }),
    )
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{Control>}{ArrowDown}{/Control}")
    fireEvent.scroll(grid)

    const cell = await waitFor(() => cellAt(grid, 999, 0))
    expect(cell.querySelector("[data-slot='skeleton']")).not.toBeNull()
    expect(cell).toHaveAttribute("aria-busy", "true")
    release()
  })
})

describe("column widths", () => {
  const key = "v0|li-0"

  function Controlled({ onChange }: { onChange: (widths: Record<string, number>) => void }) {
    const [widths, setWidths] = useState<Record<string, number>>({})
    return (
      <Grid
        modelId={MODEL_ID}
        query={salesQuery}
        columnWidths={widths}
        onColumnWidthsChange={(next) => {
          onChange(next)
          setWidths(next)
        }}
      />
    )
  }

  function renderControlled(onChange = vi.fn()) {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <Controlled onChange={onChange} />
      </QueryClientProvider>,
    )
    return onChange
  }

  it("uses the width kept for a column's header and shifts the columns after it", async () => {
    serveViewQuery()
    renderGrid({ columnWidths: { [key]: 200 } })
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "240px", width: "200px" })
    expect(cellAt(grid, 0, 1)).toHaveStyle({ left: "440px", width: "120px" })
  })

  it("resizes a column by dragging the edge of its header, and keeps the width on release", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [handle] = within(grid).getAllByRole("separator", { name: "Resize column" })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 350, pointerId: 1 })

    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "170px" })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle, { clientX: 350, pointerId: 1 })

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ [key]: 170 })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "170px" })
  })

  it("keeps a column within its minimum and maximum width", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [handle] = within(grid).getAllByRole("separator", { name: "Resize column" })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 0, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith({ [key]: 48 })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 5000, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith({ [key]: 640 })
  })

  it("does not report a click on the edge as a resize", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [handle] = within(grid).getAllByRole("separator", { name: "Resize column" })

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 300, pointerId: 1 })

    expect(onChange).not.toHaveBeenCalled()
  })

  it("resets a column to the default width on double click", async () => {
    serveViewQuery()
    const onChange = vi.fn()
    renderGrid({ columnWidths: { [key]: 200, other: 90 }, onColumnWidthsChange: onChange })
    const grid = await loadedGrid()
    const [handle] = within(grid).getAllByRole("separator", { name: "Resize column" })

    fireEvent.doubleClick(handle)

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ other: 90 })
  })

  it("resizes a row header column", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    const [handle] = within(grid).getAllByRole("separator", { name: "Resize row headers" })

    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 260, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 260, pointerId: 1 })

    expect(within(grid).getByRole("rowheader", { name: "Product 1" })).toHaveStyle({
      width: "300px",
    })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "300px" })

    fireEvent.doubleClick(handle)

    expect(within(grid).getByRole("rowheader", { name: "Product 1" })).toHaveStyle({
      width: "240px",
    })
  })
})
