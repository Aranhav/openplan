import { QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { useCallback, useMemo, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QUERY_STALE_TIME } from "@/lib/query-client"
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
  serveViewQueryBy,
  versionsDim,
} from "@/test/view-query"
import type { ViewFixture } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import { Grid } from "./grid"
import { measureTextWidth } from "./measure-text"
import type {
  Cell,
  ConditionalFormat,
  GridQuery,
  MemberRef,
  ViewDim,
  ViewQuery,
} from "./view-types"

// jsdom has no canvas: every character is 8 px wide.
vi.mock("./measure-text", () => ({
  measureTextWidth: vi.fn((text: string) => text.length * 8),
}))

// Each test loads blocks through msw into jsdom, which is slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 20_000 })

const VIEWPORT = { width: 800, height: 400 }
// The sales fixture has two header rows of 32 px above the body.
const HEADER_HEIGHT = 64

const timeDim: ViewDim = { kind: "time" }
const regionsList: ViewDim = { kind: "list", list: "list-regions" }

type GridProps = Parameters<typeof Grid>[0]

function renderGrid(props: Partial<GridProps> = {}) {
  const queryClient = createTestQueryClient({ staleTime: QUERY_STALE_TIME })
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

function handles(grid: HTMLElement, kind: "column" | "row-header") {
  return Array.from(grid.querySelectorAll<HTMLElement>(`[data-resize="${kind}"]`))
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
  const top = member("top", "All Regions", { is_summary: true, has_children: true })
  const uk = member("uk", "United Kingdom", { depth: 2 })
  const jan = member("Jan 26", "Jan 26")
  const feb = member("Feb 26", "Feb 26")
  const query: GridQuery = {
    module: MODULE_ID,
    rows: [regionsList],
    columns: [timeDim],
    pages: [{ dim: lineItemsDim, key: "li-0" }],
  }

  /** The regions and months of the query, with the members it collapses left out of the view. */
  function hierarchyFor(q: { collapsed?: MemberRef[] }): ViewFixture {
    const collapsed = new Set((q.collapsed ?? []).map((m) => m.key))
    const emea = member("emea", "EMEA", {
      depth: 1,
      has_children: true,
      collapsed: collapsed.has("emea"),
    })
    const quarter = member("Q1 FY26", "Q1 FY26", {
      depth: 1,
      is_summary: true,
      has_children: true,
      collapsed: collapsed.has("Q1 FY26"),
    })
    const rows = collapsed.has("emea") ? [top, emea] : [top, emea, uk]
    const columns = collapsed.has("Q1 FY26") ? [quarter] : [jan, feb, quarter]
    return salesView({
      rowDims: [regionsList],
      columnDims: [timeDim],
      pages: [{ dim: lineItemsDim, member: member("li-0", "Revenue") }],
      lineItems: [lineItem("li-0", "Revenue")],
      totalRows: rows.length,
      totalColumns: columns.length,
      rowHeader: (row) => header(rows[row]),
      columnHeader: (col) => header(columns[col]),
      cell: (row, col) => numberCell(row * 10 + col),
    })
  }

  /** A grid whose parent collapses what is toggled, as the module screen will. */
  function Collapsing({
    onToggle,
    base = query,
  }: {
    onToggle?: (member: MemberRef) => void
    base?: GridQuery
  }) {
    const [collapsed, setCollapsed] = useState<MemberRef[]>([])
    const toggle = useCallback(
      (target: MemberRef) => {
        onToggle?.(target)
        setCollapsed((now) =>
          now.some((m) => m.key === target.key)
            ? now.filter((m) => m.key !== target.key)
            : [...now, target],
        )
      },
      [onToggle],
    )
    const current = useMemo(() => ({ ...base, collapsed }), [base, collapsed])
    return <Grid modelId={MODEL_ID} query={current} onToggleCollapse={toggle} />
  }

  function renderCollapsing(
    onToggle?: (member: MemberRef) => void,
    fixtureFor: (q: { collapsed?: MemberRef[] }) => ViewFixture = hierarchyFor,
    base: GridQuery = query,
  ) {
    serveViewQueryBy(fixtureFor)
    render(
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
        <Collapsing onToggle={onToggle} base={base} />
      </QueryClientProvider>,
    )
    return loadedGrid()
  }

  it("indents each level of depth by 16 px", async () => {
    serveViewQuery(hierarchyFor(query))
    renderGrid({ query })
    const grid = await loadedGrid()

    const indent = (name: string) =>
      parseInt(within(grid).getByRole("rowheader", { name }).style.paddingLeft, 10)
    expect(indent("EMEA") - indent("All Regions")).toBe(16)
    expect(indent("United Kingdom") - indent("EMEA")).toBe(16)
  })

  it("indents time rows by their distance from the top, since time counts its height above the periods", async () => {
    const quarter = member("Q1 FY26", "Q1 FY26", {
      depth: 1,
      is_summary: true,
      has_children: true,
    })
    const total = member("Total", "Total", { depth: 2, is_summary: true, has_children: true })
    // Time lists each summary after its periods.
    const rows = [jan, feb, quarter, total]
    serveViewQuery(
      salesView({
        rowDims: [timeDim],
        columnDims: [lineItemsDim],
        totalRows: rows.length,
        totalColumns: 1,
        lineItems: [lineItem("li-0", "Revenue")],
        rowHeader: (row) => header(rows[row]),
        columnHeader: () => header(member("li-0", "Revenue")),
        cell: (row) => numberCell(row),
      }),
    )
    renderGrid({ query: { module: MODULE_ID, rows: [timeDim], columns: [lineItemsDim] } })
    const grid = await loadedGrid()

    const indent = (name: string) =>
      parseInt(within(grid).getByRole("rowheader", { name }).style.paddingLeft, 10)
    expect(indent("Total")).toBe(8)
    expect(indent("Q1 FY26")).toBe(8 + 16)
    expect(indent("Jan 26")).toBe(8 + 32)
    expect(indent("Feb 26")).toBe(indent("Jan 26"))
  })

  it("still indents a list by its depth below the top", async () => {
    serveViewQuery(hierarchyFor(query))
    renderGrid({ query })
    const grid = await loadedGrid()

    const indent = (name: string) =>
      parseInt(within(grid).getByRole("rowheader", { name }).style.paddingLeft, 10)
    expect(indent("All Regions")).toBe(8)
    expect(indent("United Kingdom")).toBe(8 + 32)
  })

  it("draws headers on the page background, summaries on the muted one", async () => {
    serveViewQuery(hierarchyFor(query))
    renderGrid({ query })
    const grid = await loadedGrid()

    const summaryRow = within(grid).getByRole("rowheader", { name: "All Regions" })
    expect(summaryRow).toHaveClass("bg-muted", "font-semibold", "text-foreground")
    const plainRow = within(grid).getByRole("rowheader", { name: "United Kingdom" })
    expect(plainRow).toHaveClass("bg-background", "font-medium")
    const month = within(grid).getByRole("columnheader", { name: "Jan 26" })
    expect(month).toHaveClass("bg-background", "font-medium", "text-muted-foreground")
    const quarter = within(grid).getByRole("columnheader", { name: "Q1 FY26" })
    expect(quarter).toHaveClass("bg-muted", "font-semibold", "text-foreground")
  })

  it("says in the header whether a member with children is expanded", async () => {
    serveViewQuery(hierarchyFor(query))
    renderGrid({ query })
    const grid = await loadedGrid()

    expect(within(grid).getByRole("rowheader", { name: "All Regions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(within(grid).getByRole("rowheader", { name: "EMEA" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(within(grid).getByRole("columnheader", { name: "Q1 FY26" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(within(grid).getByRole("rowheader", { name: "United Kingdom" })).not.toHaveAttribute(
      "aria-expanded",
    )
    expect(within(grid).getByRole("columnheader", { name: "Jan 26" })).not.toHaveAttribute(
      "aria-expanded",
    )
  })

  it("collapses a row member from its chevron and shows it collapsed", async () => {
    const onToggle = vi.fn()
    const grid = await renderCollapsing(onToggle)

    await userEvent.click(within(grid).getByRole("button", { name: "Collapse EMEA" }))

    expect(onToggle).toHaveBeenCalledExactlyOnceWith({ dim: regionsList, key: "emea" })
    await waitFor(() =>
      expect(
        within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
      ).not.toBeInTheDocument(),
    )
    expect(within(grid).getByRole("rowheader", { name: "EMEA" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
    expect(within(grid).getByRole("button", { name: "Expand EMEA" })).toBeInTheDocument()
    expect(screen.getByText("Collapsed EMEA")).toBeInTheDocument()

    await userEvent.click(within(grid).getByRole("button", { name: "Expand EMEA" }))

    expect(
      await within(grid).findByRole("rowheader", { name: "United Kingdom" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Expanded EMEA")).toBeInTheDocument()
  })

  it("collapses a time column member from its chevron", async () => {
    const onToggle = vi.fn()
    const grid = await renderCollapsing(onToggle)

    await userEvent.click(within(grid).getByRole("button", { name: "Collapse Q1 FY26" }))

    expect(onToggle).toHaveBeenCalledExactlyOnceWith({ dim: timeDim, key: "Q1 FY26" })
    await waitFor(() =>
      expect(within(grid).queryByRole("columnheader", { name: "Jan 26" })).not.toBeInTheDocument(),
    )
    expect(within(grid).getByRole("columnheader", { name: "Q1 FY26" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
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

  it("keeps the keyboard on the grid after a chevron is clicked", async () => {
    const grid = await renderCollapsing()

    await userEvent.click(within(grid).getByRole("button", { name: "Collapse All Regions" }))

    expect(grid).toHaveFocus()
  })

  describe("while a changed view loads", () => {
    function serveSlowCollapse() {
      server.use(
        http.post("/api/v1/models/:id/query", async ({ request }) => {
          const asked = (await request.json()) as ViewQuery
          if (asked.collapsed?.length) {
            await delay(300)
          }
          return HttpResponse.json(answer(hierarchyFor(asked), asked))
        }),
      )
      render(
        <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
          <Collapsing />
        </QueryClientProvider>,
      )
      return loadedGrid()
    }

    it("keeps the previous headers and cells on show, dimmed and busy", async () => {
      const grid = await serveSlowCollapse()
      expect(grid).not.toHaveAttribute("aria-busy")
      expect(grid).not.toHaveClass("opacity-60")

      await userEvent.click(within(grid).getByRole("button", { name: "Collapse EMEA" }))

      expect(grid).toHaveAttribute("aria-busy", "true")
      expect(grid).toHaveClass("opacity-60")
      expect(within(grid).getByRole("rowheader", { name: "United Kingdom" })).toBeInTheDocument()
      expect(cellAt(grid, 2, 0)).toHaveTextContent("20")
      expect(grid.querySelector("[aria-busy='true'][role='gridcell']")).toBeNull()

      await waitFor(() => expect(grid).not.toHaveAttribute("aria-busy"))
      expect(grid).not.toHaveClass("opacity-60")
      expect(
        within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
      ).not.toBeInTheDocument()
    })

    it("does not edit the previous view while the changed one loads", async () => {
      const grid = await serveSlowCollapse()
      grid.focus()
      await userEvent.click(within(grid).getByRole("button", { name: "Collapse EMEA" }))
      expect(grid).toHaveAttribute("aria-busy", "true")

      await userEvent.keyboard("5")
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
      await waitFor(() => expect(grid).not.toHaveAttribute("aria-busy"))
      await userEvent.keyboard("5")

      expect(screen.getByRole("textbox")).toHaveValue("5")
    })

    it("does not dim a grid that is only scrolling to blocks it has not loaded", async () => {
      serveViewQuery()
      renderGrid()
      const grid = await loadedGrid()

      await userEvent.keyboard("{Control>}{ArrowDown}{/Control}")

      expect(grid).not.toHaveClass("opacity-60")
      expect(grid).not.toHaveAttribute("aria-busy")
    })
  })

  describe("from the keyboard", () => {
    const altShift = (key: string) => `{Alt>}{Shift>}{${key}}{/Shift}{/Alt}`

    it("collapses and expands the member of the active row with Alt+Shift+Left and Right", async () => {
      const onToggle = vi.fn()
      const grid = await renderCollapsing(onToggle)
      grid.focus()
      await userEvent.keyboard("{ArrowDown}")

      await userEvent.keyboard(altShift("ArrowLeft"))

      expect(onToggle).toHaveBeenLastCalledWith({ dim: regionsList, key: "emea" })
      await waitFor(() =>
        expect(
          within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
        ).not.toBeInTheDocument(),
      )
      expect(screen.getByText("Collapsed EMEA")).toBeInTheDocument()
      expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 1, 0).id)

      await userEvent.keyboard(altShift("ArrowRight"))

      expect(
        await within(grid).findByRole("rowheader", { name: "United Kingdom" }),
      ).toBeInTheDocument()
      expect(screen.getByText("Expanded EMEA")).toBeInTheDocument()
    })

    it("collapses the member of the active column with Alt+Shift+Up", async () => {
      const onToggle = vi.fn()
      const grid = await renderCollapsing(onToggle)
      grid.focus()
      await userEvent.keyboard("{ArrowRight}{ArrowRight}")

      await userEvent.keyboard(altShift("ArrowUp"))

      expect(onToggle).toHaveBeenLastCalledWith({ dim: timeDim, key: "Q1 FY26" })
      await waitFor(() =>
        expect(
          within(grid).queryByRole("columnheader", { name: "Jan 26" }),
        ).not.toBeInTheDocument(),
      )
      expect(screen.getByText("Collapsed Q1 FY26")).toBeInTheDocument()

      await userEvent.keyboard(altShift("ArrowDown"))

      expect(await within(grid).findByRole("columnheader", { name: "Jan 26" })).toBeInTheDocument()
      expect(screen.getByText("Expanded Q1 FY26")).toBeInTheDocument()
    })

    it("leaves a member that is already in the asked state alone", async () => {
      const onToggle = vi.fn()
      const grid = await renderCollapsing(onToggle)
      grid.focus()
      await userEvent.keyboard("{ArrowDown}")

      await userEvent.keyboard(altShift("ArrowRight"))

      expect(onToggle).not.toHaveBeenCalled()
      expect(screen.queryByText(/^(Collapsed|Expanded)/)).not.toBeInTheDocument()
    })

    it("does nothing on a row or column whose members have no children", async () => {
      const onToggle = vi.fn()
      const grid = await renderCollapsing(onToggle)
      grid.focus()
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}")

      await userEvent.keyboard(altShift("ArrowLeft") + altShift("ArrowUp"))

      expect(onToggle).not.toHaveBeenCalled()
    })

    it("says so, politely, when the active row or column has nothing to collapse", async () => {
      const grid = await renderCollapsing()
      grid.focus()
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}")
      expect(screen.queryByText("Nothing to collapse")).not.toBeInTheDocument()

      await userEvent.keyboard(altShift("ArrowLeft"))

      const message = screen.getByText("Nothing to collapse")
      expect(message.closest("[role='status']")).toHaveClass("sr-only")

      // The same words again are a new message: the node is replaced, which a screen reader reads.
      await userEvent.keyboard(altShift("ArrowUp"))
      expect(screen.getByText("Nothing to collapse")).not.toBe(message)
    })

    it("says there is nothing to expand when the key asks to expand", async () => {
      const grid = await renderCollapsing()
      grid.focus()
      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowRight}")

      await userEvent.keyboard(altShift("ArrowRight"))
      expect(screen.getByText("Nothing to expand")).toBeInTheDocument()
      expect(screen.queryByText("Nothing to collapse")).not.toBeInTheDocument()

      await userEvent.keyboard(altShift("ArrowDown"))
      expect(screen.getByText("Nothing to expand")).toBeInTheDocument()
    })

    it("stays quiet about collapsing when the grid cannot collapse at all", async () => {
      serveViewQuery(hierarchyFor(query))
      renderGrid({ query })
      const grid = await loadedGrid()
      grid.focus()
      await userEvent.keyboard("{ArrowDown}{ArrowDown}")

      await userEvent.keyboard(altShift("ArrowLeft"))

      expect(screen.queryByText("Nothing to collapse")).not.toBeInTheDocument()
    })

    describe("follows the member that was collapsed or expanded", () => {
      const quarter = (key: string, collapsed: Set<string>) =>
        member(key, key, {
          depth: 1,
          is_summary: true,
          has_children: true,
          collapsed: collapsed.has(key),
        })
      const month = (key: string) => member(key, key)

      /** Two quarters, each after its months, and a month after them. */
      function quartersFor(q: { collapsed?: MemberRef[] }): ViewFixture {
        const collapsed = new Set((q.collapsed ?? []).map((m) => m.key))
        const columns = [
          ...(collapsed.has("Q1 FY26") ? [] : [month("Jan 26"), month("Feb 26")]),
          quarter("Q1 FY26", collapsed),
          ...(collapsed.has("Q2 FY26") ? [] : [month("Apr 26"), month("May 26")]),
          quarter("Q2 FY26", collapsed),
          month("Jul 26"),
        ]
        return salesView({
          rowDims: [regionsList],
          columnDims: [timeDim],
          pages: [{ dim: lineItemsDim, member: member("li-0", "Revenue") }],
          lineItems: [lineItem("li-0", "Revenue")],
          totalRows: 1,
          totalColumns: columns.length,
          rowHeader: () => header(member("top", "All Regions")),
          columnHeader: (col) => header(columns[col]),
          cell: (row, col) => numberCell(row * 10 + col),
        })
      }

      const columnOf = (grid: HTMLElement, name: string) =>
        Number(within(grid).getByRole("columnheader", { name }).getAttribute("aria-colindex")) - 2

      it("moves the active cell to the collapsed column, not to the one that takes its place", async () => {
        const grid = await renderCollapsing(undefined, quartersFor)
        grid.focus()
        await userEvent.keyboard("{ArrowRight}{ArrowRight}")
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 2).id)

        await userEvent.keyboard(altShift("ArrowUp"))

        await waitFor(() =>
          expect(
            within(grid).queryByRole("columnheader", { name: "Jan 26" }),
          ).not.toBeInTheDocument(),
        )
        const collapsed = columnOf(grid, "Q1 FY26")
        expect(collapsed).toBe(0)
        await waitFor(() =>
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, collapsed).id),
        )
      })

      it("moves it to the column that was expanded, where its children now come before it", async () => {
        const grid = await renderCollapsing(undefined, quartersFor)
        grid.focus()
        await userEvent.keyboard("{ArrowRight}{ArrowRight}" + altShift("ArrowUp"))
        await waitFor(() => expect(columnOf(grid, "Q1 FY26")).toBe(0))

        await userEvent.keyboard(altShift("ArrowDown"))

        await waitFor(() => expect(columnOf(grid, "Q1 FY26")).toBe(2))
        await waitFor(() =>
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 2).id),
        )
      })

      it("follows a member that moves because an earlier one collapsed", async () => {
        const grid = await renderCollapsing(undefined, quartersFor)
        grid.focus()
        await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 5).id)

        await userEvent.keyboard(altShift("ArrowUp"))

        await waitFor(() => expect(columnOf(grid, "Q2 FY26")).toBe(3))
        await waitFor(() =>
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 3).id),
        )
      })

      it("follows a row member in the same way", async () => {
        const rowsQuery: GridQuery = {
          module: MODULE_ID,
          rows: [timeDim],
          columns: [lineItemsDim],
        }
        function timeRowsFor(q: { collapsed?: MemberRef[] }): ViewFixture {
          const collapsed = new Set((q.collapsed ?? []).map((m) => m.key))
          const rows = [
            ...(collapsed.has("Q1 FY26") ? [] : [month("Jan 26"), month("Feb 26")]),
            quarter("Q1 FY26", collapsed),
            month("Apr 26"),
          ]
          return salesView({
            rowDims: [timeDim],
            columnDims: [lineItemsDim],
            totalRows: rows.length,
            totalColumns: 1,
            lineItems: [lineItem("li-0", "Revenue")],
            rowHeader: (row) => header(rows[row]),
            columnHeader: () => header(member("li-0", "Revenue")),
            cell: (row) => numberCell(row),
          })
        }
        const grid = await renderCollapsing(undefined, timeRowsFor, rowsQuery)
        grid.focus()
        await userEvent.keyboard("{ArrowDown}{ArrowDown}")
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 2, 0).id)

        await userEvent.keyboard(altShift("ArrowLeft"))

        await waitFor(() =>
          expect(within(grid).queryByRole("rowheader", { name: "Jan 26" })).not.toBeInTheDocument(),
        )
        await waitFor(() =>
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 0).id),
        )
      })

      it("keeps the active cell where it is when the member's place does not change", async () => {
        const grid = await renderCollapsing()
        grid.focus()
        await userEvent.keyboard("{ArrowDown}")

        await userEvent.keyboard(altShift("ArrowLeft"))

        await waitFor(() =>
          expect(
            within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
          ).not.toBeInTheDocument(),
        )
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 1, 0).id)
      })

      describe("with a dimension inside the one that collapses", () => {
        const nestedQuery: GridQuery = {
          module: MODULE_ID,
          rows: [regionsList],
          columns: [timeDim, versionsDim],
          pages: [{ dim: lineItemsDim, key: "li-0" }],
        }
        const versions = [member("v-actual", "Actual"), member("v-budget", "Budget")]

        /** Two months and their quarter, each in two versions, the versions varying fastest. */
        function nestedFor(q: { collapsed?: MemberRef[] }): ViewFixture {
          const collapsed = new Set((q.collapsed ?? []).map((m) => m.key))
          const times = collapsed.has("Q1 FY26")
            ? [quarter("Q1 FY26", collapsed)]
            : [month("Jan 26"), month("Feb 26"), quarter("Q1 FY26", collapsed)]
          const columns = times.flatMap((time) => versions.map((version) => [time, version]))
          return salesView({
            rowDims: [regionsList],
            columnDims: [timeDim, versionsDim],
            pages: [{ dim: lineItemsDim, member: member("li-0", "Revenue") }],
            lineItems: [lineItem("li-0", "Revenue")],
            totalRows: 1,
            totalColumns: columns.length,
            rowHeader: () => header(member("top", "All Regions")),
            columnHeader: (col) => header(...columns[col]),
            cell: (row, col) => numberCell(row * 10 + col),
          })
        }

        it("stays in the same version of the collapsed member", async () => {
          const grid = await renderCollapsing(undefined, nestedFor, nestedQuery)
          grid.focus()
          await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 4).id)

          await userEvent.keyboard(altShift("ArrowUp"))

          await waitFor(() =>
            expect(
              within(grid).queryByRole("columnheader", { name: "Jan 26" }),
            ).not.toBeInTheDocument(),
          )
          await waitFor(() =>
            expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 0).id),
          )
        })

        it("stays in the same version of the expanded member", async () => {
          const grid = await renderCollapsing(undefined, nestedFor, nestedQuery)
          grid.focus()
          await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
          await userEvent.keyboard(altShift("ArrowUp"))
          await waitFor(() =>
            expect(
              within(grid).queryByRole("columnheader", { name: "Jan 26" }),
            ).not.toBeInTheDocument(),
          )
          await userEvent.keyboard("{ArrowRight}")
          expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 1).id)

          await userEvent.keyboard(altShift("ArrowDown"))

          await waitFor(() =>
            expect(within(grid).getAllByRole("columnheader", { name: "Jan 26" })).not.toHaveLength(
              0,
            ),
          )
          await waitFor(() =>
            expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 5).id),
          )
        })
      })

      it("stops following when the user moves on while the view loads", async () => {
        server.use(
          http.post("/api/v1/models/:id/query", async ({ request }) => {
            const asked = (await request.json()) as ViewQuery
            if (asked.collapsed?.length) {
              await delay(300)
            }
            return HttpResponse.json(answer(quartersFor(asked), asked))
          }),
        )
        render(
          <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
            <Collapsing />
          </QueryClientProvider>,
        )
        const grid = await loadedGrid()
        grid.focus()
        await userEvent.keyboard("{ArrowRight}{ArrowRight}")

        await userEvent.keyboard(altShift("ArrowUp"))
        await userEvent.keyboard("{ArrowRight}")
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 3).id)
        await waitFor(() =>
          expect(
            within(grid).queryByRole("columnheader", { name: "Jan 26" }),
          ).not.toBeInTheDocument(),
        )

        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 3).id)
      })

      it("stops following when the user clicks another cell while the view loads", async () => {
        server.use(
          http.post("/api/v1/models/:id/query", async ({ request }) => {
            const asked = (await request.json()) as ViewQuery
            if (asked.collapsed?.length) {
              await delay(300)
            }
            return HttpResponse.json(answer(quartersFor(asked), asked))
          }),
        )
        render(
          <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
            <Collapsing />
          </QueryClientProvider>,
        )
        const grid = await loadedGrid()
        grid.focus()
        await userEvent.keyboard("{ArrowRight}{ArrowRight}")

        await userEvent.keyboard(altShift("ArrowUp"))
        await userEvent.click(cellAt(grid, 0, 4))
        await waitFor(() =>
          expect(
            within(grid).queryByRole("columnheader", { name: "Jan 26" }),
          ).not.toBeInTheDocument(),
        )

        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 4).id)
      })

      it("does not move the active cell for a collapse by chevron", async () => {
        const grid = await renderCollapsing(undefined, quartersFor)
        grid.focus()
        await userEvent.keyboard("{ArrowRight}")

        await userEvent.click(within(grid).getByRole("button", { name: "Collapse Q1 FY26" }))

        await waitFor(() =>
          expect(
            within(grid).queryByRole("columnheader", { name: "Jan 26" }),
          ).not.toBeInTheDocument(),
        )
        expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, 0, 1).id)
      })
    })

    it("does nothing when the grid cannot collapse", async () => {
      serveViewQuery(hierarchyFor(query))
      renderGrid({ query })
      const grid = await loadedGrid()
      grid.focus()
      await userEvent.keyboard("{ArrowDown}")

      await userEvent.keyboard(altShift("ArrowLeft"))

      expect(within(grid).getByRole("rowheader", { name: "United Kingdom" })).toBeInTheDocument()
      expect(screen.queryByText(/^Collapsed/)).not.toBeInTheDocument()
    })
  })
})

describe("cell styling", () => {
  // The tooltip hides itself when its anchor is out of sight, and jsdom, which has no layout, takes
  // every anchor for out of sight: its tooltip is in the page but not "visible" to role queries.

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
    expect(cell).toHaveClass("bg-muted/70", "text-foreground", "cursor-not-allowed", "group/cell")
    expect(cell).toHaveAttribute("aria-readonly", "true")
    expect(cell.querySelector(".lucide-lock")).toHaveClass(
      "opacity-0",
      "group-hover/cell:opacity-100",
    )
    expect(cellAt(grid, 0, 0).querySelector(".lucide-lock")).toBeNull()
  })

  it("puts the lock at the end of the cell the text is not at", async () => {
    serveViewQuery(
      salesView({
        cell: (row, col) =>
          col === 4
            ? { value: { t: "text", v: "Locked note" }, flags: ["calculated", "readonly"] }
            : numberCell(row, col === 5 ? ["calculated", "readonly"] : ["input"]),
      }),
    )
    renderGrid()
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, 5).querySelector(".lucide-lock")).toHaveClass("left-1.5")
    expect(cellAt(grid, 0, 4).querySelector(".lucide-lock")).toHaveClass("right-1.5")
  })

  it("makes summary cells bold on the muted surface", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 2)).toHaveClass("font-semibold", "bg-muted", "cursor-not-allowed")
    expect(cellAt(grid, 0, 2)).not.toHaveClass("bg-muted/70")
  })

  it("hatches a cell that does not apply, leaves it empty and says so to a screen reader", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 3)
    expect(cell.className).toContain("repeating-linear-gradient(135deg")
    expect(cell.className).toContain("color-mix(in_oklab,var(--muted-foreground)_18%,transparent)")
    expect(cell).not.toHaveClass("bg-muted/70")
    expect(cell).toHaveTextContent("Not applicable")
    expect(within(cell).getByText("Not applicable")).toHaveClass("sr-only")
    expect(cell).toHaveAttribute("aria-readonly", "true")
    expect(cell.querySelector(".lucide-lock")).toBeNull()
  })

  it("explains a cell that shows the actual before the switchover, to the pointer and to a screen reader", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 4)
    expect(cell).toHaveClass("bg-muted/70")
    expect(cell).toHaveAccessibleDescription("Before the switchover: showing Actual.")
    await userEvent.hover(cell)

    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent(
      "Before the switchover: showing Actual.",
    )
    expect(screen.getAllByRole("tooltip", { hidden: true })).toHaveLength(1)
  })

  it("leaves a cell in error blank and says so", async () => {
    const grid = await renderFlags()

    const cell = cellAt(grid, 0, 5)
    expect(cell).toHaveTextContent("Error")
    expect(within(cell).getByText("Error")).toHaveClass("sr-only")
    expect(cell).toHaveClass("bg-muted/70")
    expect(cell).toHaveAttribute("aria-readonly", "true")
  })

  it("gives the first formula error of a line item as the description of its blank cells", async () => {
    const view = flagsView()
    view.lineItems[5] = lineItem("li-5", "Line item 5", {
      errors: [
        {
          code: "formula.unknown_name",
          message: "Unknown name 'Pricee'.",
          start: 0,
          end: 6,
          suggestion: null,
        },
      ],
    })
    serveViewQuery(view)
    renderGrid({ query: flagsQuery })
    const grid = await loadedGrid()

    expect(cellAt(grid, 0, 5)).toHaveAccessibleDescription("Unknown name 'Pricee'.")
    expect(
      within(grid).getByRole("columnheader", { name: "Line item 5" }),
    ).toHaveAccessibleDescription("Unknown name 'Pricee'.")
    expect(cellAt(grid, 0, 0)).not.toHaveAttribute("aria-describedby")
    await userEvent.hover(cellAt(grid, 0, 5))
    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent(
      "Unknown name 'Pricee'.",
    )
  })

  it("shows the note of the active cell in the one tooltip while the grid has focus", async () => {
    const grid = await renderFlags()
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument()

    grid.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}")
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument()
    await userEvent.keyboard("{ArrowRight}")

    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent(
      "Before the switchover: showing Actual.",
    )
    expect(screen.getAllByRole("tooltip", { hidden: true })).toHaveLength(1)

    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(() =>
      expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument(),
    )
  })

  it("hides the tooltip when the grid loses focus", async () => {
    const grid = await renderFlags()
    grid.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
    await screen.findByRole("tooltip", { hidden: true })

    grid.blur()

    await waitFor(() =>
      expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument(),
    )
  })

  it("keeps the tooltip while the grid scrolls to the active cell", async () => {
    const grid = await renderFlags()
    grid.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
    await screen.findByRole("tooltip", { hidden: true })

    fireEvent.scroll(grid)
    fireEvent.scroll(window)

    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument()
  })

  it("dismisses the tooltip with Escape and shows it again for the next cell", async () => {
    const grid = await renderFlags()
    grid.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}")
    await screen.findByRole("tooltip", { hidden: true })

    await userEvent.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument(),
    )
    await userEvent.keyboard("{ArrowRight}")
    expect(await screen.findByRole("tooltip", { hidden: true })).toBeInTheDocument()
  })

  it("right-aligns numbers in tabular figures", async () => {
    const grid = await renderFlags()

    expect(cellAt(grid, 0, 0)).toHaveClass("justify-end", "tabular-nums")
    expect(cellAt(grid, 0, 0)).toHaveTextContent("1,234")
  })

  it("keeps the tooltip anchor on a cell that exists when the view shrinks under the pointer", async () => {
    const months = [member("Jan 26", "Jan 26"), member("Feb 26", "Feb 26")]
    const q1 = (collapsed: boolean) =>
      member("Q1 FY26", "Q1 FY26", { depth: 1, is_summary: true, has_children: true, collapsed })
    const hoverQuery: GridQuery = {
      module: MODULE_ID,
      rows: [regionsList],
      columns: [timeDim],
      pages: [{ dim: lineItemsDim, key: "li-0" }],
    }
    function Shrinking() {
      const [collapsed, setCollapsed] = useState<MemberRef[]>([])
      const current = useMemo(() => ({ ...hoverQuery, collapsed }), [collapsed])
      return (
        <Grid
          modelId={MODEL_ID}
          query={current}
          onToggleCollapse={(m) => setCollapsed((now) => [...now, m])}
        />
      )
    }
    serveViewQueryBy((q) => {
      const closed = (q.collapsed ?? []).length > 0
      const columns = closed ? [q1(true)] : [...months, q1(false)]
      return salesView({
        rowDims: [regionsList],
        columnDims: [timeDim],
        pages: [{ dim: lineItemsDim, member: member("li-0", "Revenue") }],
        lineItems: [lineItem("li-0", "Revenue")],
        totalRows: 1,
        totalColumns: columns.length,
        rowHeader: () => header(member("top", "All Regions")),
        columnHeader: (col) => header(columns[col]),
        cell: (_, col) =>
          numberCell(col, col === 1 ? ["calculated", "readonly", "switchover"] : ["input"]),
      })
    })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
        <Shrinking />
      </QueryClientProvider>,
    )
    const grid = await loadedGrid()
    await userEvent.hover(cellAt(grid, 0, 1))
    await screen.findByRole("tooltip", { hidden: true })

    // The pointer stays where it is while the keys collapse the quarter and the column goes.
    grid.focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}")
    await waitFor(() =>
      expect(within(grid).queryByRole("columnheader", { name: "Jan 26" })).not.toBeInTheDocument(),
    )

    const anchor = grid.querySelector<HTMLElement>("[data-tooltip-anchor]")!
    for (const property of ["top", "left", "width", "height"] as const) {
      expect(Number.isFinite(parseFloat(anchor.style[property])), property).toBe(true)
    }
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("shows ### for a number that does not fit its column, and the number as its label and title", async () => {
    serveViewQuery()
    renderGrid({ columnWidths: { "v0|li-0": 48, "v0|li-4": 48 } })
    const grid = await loadedGrid()

    const narrow = cellAt(grid, 2, 0)
    expect(narrow).toHaveTextContent("###")
    expect(narrow).toHaveAttribute("title", "2,000")
    expect(narrow).toHaveAccessibleName("2,000")
    expect(cellAt(grid, 2, 1)).toHaveTextContent("$2,001.00")
    expect(cellAt(grid, 2, 1)).not.toHaveAttribute("title")
    // Text is clipped with an ellipsis instead, however narrow.
    expect(cellAt(grid, 2, 4)).toHaveTextContent("Note 2")
  })

  it("keeps two pixels of slack: a number that just fits is cut off", async () => {
    serveViewQuery()
    // "2,000" is 40 px wide here; a 57 px column has 40 px of room, before the slack.
    renderGrid({ columnWidths: { "v0|li-0": 57, "v0|li-1": 130 } })
    const grid = await loadedGrid()

    expect(cellAt(grid, 2, 0)).toHaveTextContent("###")
    expect(cellAt(grid, 2, 1)).toHaveTextContent("$2,001.00")
  })

  it("measures a number in the weight it is drawn in", async () => {
    serveViewQuery(flagsView())
    renderGrid({
      query: flagsQuery,
      conditionalFormats: [
        {
          name: "Bold",
          line_item_ids: ["li-1"],
          op: "positive",
          style: { color: "blue", bold: true },
        },
      ],
    })
    await loadedGrid()

    // Input cells draw at 400, a summary at 600 (semibold), and a bold rule at 700.
    expect(measureTextWidth).toHaveBeenCalledWith("1,234", 400)
    expect(measureTextWidth).toHaveBeenCalledWith("1,234", 600)
    expect(measureTextWidth).toHaveBeenCalledWith("1,234", 700)
  })

  it("fits a number again when its column is wide enough", async () => {
    serveViewQuery()
    renderGrid({ columnWidths: { "v0|li-0": 60 } })
    const grid = await loadedGrid()

    expect(cellAt(grid, 2, 0)).toHaveTextContent("2,000")
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

    const header = within(grid).getByRole("columnheader", { name: "Line item 1" })
    const icon = within(header).getByRole("img", { name: "Unknown name 'Pricee'." })
    expect(icon).toHaveClass("text-destructive")
    expect(within(grid).getByRole("columnheader", { name: "Line item 0" })).toBeInTheDocument()
    await userEvent.hover(icon)
    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent(
      "Unknown name 'Pricee'.",
    )
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

    expect(cellAt(grid, 2, 0)).toHaveClass("bg-green-500/15", "text-green-800", "font-bold")
    expect(cellAt(grid, 2, 0)).not.toHaveClass("bg-background", "text-foreground")
    expect(cellAt(grid, 0, 0)).toHaveClass("bg-blue-500/15", "dark:text-blue-300")
    expect(cellAt(grid, 0, 3).className).not.toContain("bg-blue")
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

    expect(cellAt(grid, 0, 0)).toHaveClass("bg-neutral-500/15", "text-neutral-700")
    expect(cellAt(grid, 0, 0)).not.toHaveClass("bg-muted")
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
    expect(checked).not.toHaveAttribute("aria-checked")
    expect(within(checked).getByText("Checked")).toHaveClass("sr-only")
    expect(within(unchecked).getByText("Not checked")).toHaveClass("sr-only")
    expect(checked.querySelector(".lucide-check")).not.toBeNull()
    expect(unchecked.querySelector(".lucide-check")).toBeNull()
    expect(checked).toHaveClass("justify-center")
  })

  it("marks the check box of an editable cell as one that toggles", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    expect(cellAt(grid, 1, booleanColumn).querySelector("[data-toggle]")).not.toBeNull()
  })

  it("does not mark the check box of a read-only grid as one that toggles", async () => {
    serveViewQuery()
    renderGrid({ readOnly: true })
    const grid = await loadedGrid()

    expect(grid).toHaveAttribute("aria-readonly", "true")
    expect(grid.querySelector("[data-toggle]")).toBeNull()
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
    renderGrid()
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
    await waitFor(() => expect(served.requests).toHaveLength(4))
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Each block once, and nothing else, even after the neighbours have settled.
    expect(windows(served.requests).sort()).toEqual(["0,0", "0,1", "1,0", "1,1"])
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
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
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
    const [handle] = handles(grid, "column")

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
    const [handle] = handles(grid, "column")

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
    const [handle] = handles(grid, "column")

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 300, pointerId: 1 })

    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps the resize handles out of the accessibility tree", async () => {
    serveViewQuery()
    renderControlled()
    const grid = await loadedGrid()

    expect(handles(grid, "column").length).toBeGreaterThan(3)
    expect(handles(grid, "row-header")).toHaveLength(1)
    for (const handle of [...handles(grid, "column"), ...handles(grid, "row-header")]) {
      expect(handle).toHaveAttribute("aria-hidden", "true")
      expect(handle).not.toHaveAttribute("role")
    }
    expect(within(grid).queryAllByRole("separator")).toHaveLength(0)
  })

  it("puts a column back when the browser takes the pointer from the drag", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [handle] = handles(grid, "column")

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "200px" })
    fireEvent.pointerCancel(handle, { pointerId: 1 })

    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "120px" })
    fireEvent.pointerMove(handle, { clientX: 420, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 420, pointerId: 1 })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "120px" })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("puts a column back when the drag loses the pointer capture", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [handle] = handles(grid, "column")

    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 })
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })

    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "120px" })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("cancels a drag with Escape, whichever header it is on", async () => {
    serveViewQuery()
    const onChange = renderControlled()
    const grid = await loadedGrid()
    const [column] = handles(grid, "column")
    const [rowHeader] = handles(grid, "row-header")

    fireEvent.pointerDown(column, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(column, { clientX: 380, pointerId: 1 })
    await userEvent.keyboard("{Escape}")
    expect(cellAt(grid, 0, 0)).toHaveStyle({ width: "120px" })
    fireEvent.pointerUp(column, { clientX: 380, pointerId: 1 })

    fireEvent.pointerDown(rowHeader, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(rowHeader, { clientX: 260, pointerId: 1 })
    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "300px" })
    await userEvent.keyboard("{Escape}")
    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "240px" })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("resets a column to the default width on double click", async () => {
    serveViewQuery()
    const onChange = vi.fn()
    renderGrid({ columnWidths: { [key]: 200, other: 90 }, onColumnWidthsChange: onChange })
    const grid = await loadedGrid()
    const [handle] = handles(grid, "column")

    fireEvent.doubleClick(handle)

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ other: 90 })
  })

  it("resizes a row header column", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    const [handle] = handles(grid, "row-header")

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

describe("keyboard", () => {
  it("keeps the browser from scrolling the grid for any key the grid takes", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    // Space, typing, Enter, Delete and Escape are for the editor to come, but not for the page.
    for (const key of [
      " ",
      "a",
      "Enter",
      "Delete",
      "Escape",
      "F2",
      "PageDown",
      "ArrowDown",
      "Tab",
    ]) {
      expect(
        fireEvent.keyDown(grid, { key }),
        `${JSON.stringify(key)} was left to the browser`,
      ).toBe(false)
    }
    // Undo and redo are the grid's; the browser has nothing for them to do.
    for (const init of [
      { key: "z", ctrlKey: true },
      { key: "z", metaKey: true },
      { key: "z", ctrlKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
    ]) {
      expect(fireEvent.keyDown(grid, init), JSON.stringify(init)).toBe(false)
    }
  })

  it("leaves copy, cut and paste to the browser, so their own events fire", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()

    for (const key of ["c", "x", "v"]) {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        expect(
          fireEvent.keyDown(grid, { key, ...modifier }),
          `${key} ${JSON.stringify(modifier)}`,
        ).toBe(true)
      }
    }
  })

  it("leaves the keys that are not the grid's to the browser", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()

    expect(fireEvent.keyDown(grid, { key: "F5" })).toBe(true)
    expect(fireEvent.keyDown(grid, { key: "ArrowLeft", altKey: true })).toBe(true)
    expect(fireEvent.keyDown(grid, { key: "Shift", shiftKey: true })).toBe(true)
  })

  it("announces how many cells a range holds as it grows", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{ArrowRight}{/Shift}")
    expect(screen.getByText("2 rows by 3 columns selected")).toBeInTheDocument()

    await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowLeft}{ArrowLeft}{/Shift}")
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}")
    expect(screen.getByText("1 row by 2 columns selected")).toBeInTheDocument()
  })

  it("is a polite status region that a screen reader reads without moving focus", async () => {
    serveViewQuery()
    renderGrid()
    await loadedGrid()

    const regions = screen.getAllByRole("status")
    expect(regions.length).toBeGreaterThanOrEqual(2)
    for (const region of regions) {
      expect(region).toHaveClass("sr-only")
    }
  })
})

describe("scrolling to the active cell", () => {
  it("scrolls again when headers that arrive late change where the active column is", async () => {
    // Column 45 of the second block of columns has a custom width, and its headers come late.
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        if (query.window.col_offset > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return HttpResponse.json(answer(salesView(), query))
      }),
    )
    renderGrid({ columnWidths: { "v1|li-20": 300 } })
    const grid = await loadedGrid()
    grid.focus()

    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}")

    // Judged by the 120 px every column has until its header is known.
    expect(grid.scrollLeft).toBe(240 + 50 * 120 - VIEWPORT.width)
    await waitFor(() => expect(grid.scrollLeft).toBe(240 + 50 * 120 + 180 - VIEWPORT.width), {
      timeout: 3000,
    })
  })

  it("does not pull the grid back to the active cell once it has been scrolled away", async () => {
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        const query = (await request.json()) as ViewQuery
        return HttpResponse.json(answer(salesView(), query))
      }),
    )
    const { rerender, queryClient } = renderGrid({ columnWidths: {} })
    const grid = await loadedGrid()
    grid.focus()
    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    grid.scrollLeft = 0

    rerender(
      <QueryClientProvider client={queryClient}>
        <Grid modelId={MODEL_ID} query={salesQuery} columnWidths={{ "v0|li-3": 200 }} />
      </QueryClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(grid.scrollLeft).toBe(0)
  })
})

describe("views without a dimension on an axis", () => {
  it("draws a view with no column dimension as one column without a header", async () => {
    serveViewQuery(
      salesView({
        rowDims: [lineItemsDim],
        columnDims: [],
        totalRows: 3,
        totalColumns: 1,
        lineItems: [lineItem("li-a", "Units"), lineItem("li-b", "Price"), lineItem("li-c", "Cost")],
        rowHeader: (row) => header(member(`li-${"abc"[row]}`, ["Units", "Price", "Cost"][row])),
        columnHeader: () => header(),
        cell: (row) => numberCell((row + 1) * 100),
      }),
    )
    renderGrid({ query: { ...salesQuery, rows: [lineItemsDim], columns: [] } })
    const grid = await loadedGrid()

    expect(within(grid).queryAllByRole("columnheader")).toHaveLength(0)
    expect(grid).toHaveAttribute("aria-rowcount", "3")
    expect(grid).toHaveAttribute("aria-colcount", "2")
    expect(cellAt(grid, 1, 0)).toHaveTextContent("200")
    expect(cellAt(grid, 1, 0).closest("[role='row']")).toHaveAttribute("aria-rowindex", "2")
    expect(within(grid).getByRole("rowheader", { name: "Cost" })).toBeInTheDocument()
  })

  it("draws a view with no row dimension as one row without headers", async () => {
    serveViewQuery(
      salesView({
        rowDims: [],
        columnDims: [lineItemsDim],
        totalRows: 1,
        totalColumns: 3,
        lineItems: [lineItem("li-a", "Units"), lineItem("li-b", "Price"), lineItem("li-c", "Cost")],
        rowHeader: () => header(),
        columnHeader: (col) => header(member(`li-${"abc"[col]}`, ["Units", "Price", "Cost"][col])),
        cell: (_, col) => numberCell((col + 1) * 100),
      }),
    )
    renderGrid({ query: { ...salesQuery, rows: [], columns: [lineItemsDim] } })
    const grid = await loadedGrid()

    expect(within(grid).queryAllByRole("rowheader")).toHaveLength(0)
    expect(grid).toHaveAttribute("aria-rowcount", "2")
    expect(grid).toHaveAttribute("aria-colcount", "3")
    expect(cellAt(grid, 0, 2)).toHaveTextContent("300")
    expect(cellAt(grid, 0, 0)).toHaveStyle({ left: "0px" })
    expect(within(grid).getByRole("columnheader", { name: "Price" })).toBeInTheDocument()
  })
})

describe("forced colours", () => {
  it("keeps the selection visible when box shadows are not drawn", async () => {
    serveViewQuery()
    renderGrid()
    const grid = await loadedGrid()
    grid.focus()
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}")

    const active = grid.querySelector('[data-selection="active"]')
    const range = grid.querySelector('[data-selection="range"]')
    expect(active?.className).toContain("forced-colors:outline-2")
    expect(range?.className).toContain("forced-colors:outline")
  })
})
