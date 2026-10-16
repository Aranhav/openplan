import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { expect } from "vitest"
import { Grid } from "@/features/grid/grid"
import type { CellWrite } from "@/features/grid/cells-api"
import type { Format, Value } from "@/features/grid/core/types"
import type { GridReference } from "@/features/grid/edit-reference"
import type { Cell, GridQuery } from "@/features/grid/view-types"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import { numberFormat } from "./number-format"
import { createTestQueryClient } from "./render"
import { server } from "./server"
import {
  MODEL_ID,
  MODULE_ID,
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  productsList,
  salesView,
  serveViewQuery,
} from "./view-query"
import type { ViewFixture } from "./view-query"

// A view for the tests of editing: six products down the rows and, across, one line item of
// each kind of cell that is edited, with a calculated line item and a switchover one among them.

const percent: Format = {
  type: "number",
  decimals: 0,
  thousands_sep: true,
  unit: { type: "percent" },
  negative: "minus",
}

export const reference: GridReference = {
  lists: {
    regions: [
      { id: "r-emea", name: "EMEA", code: "EU" },
      { id: "r-apac", name: "Asia Pacific", code: "AP" },
      { id: "r-na", name: "North America", code: "NA" },
    ],
  },
  periods: [],
}

// The columns of the editing view, left to right.
export const BUDGET = 0
export const REGION = 1
export const START = 2
export const ACTIVE = 3
export const NOTES = 4
export const CALCULATED = 5
export const SWITCHOVER = 6
export const GROWTH = 7

export const lineItems = [
  lineItem("li-budget", "Budget", { dims: [productsList], format: numberFormat({ decimals: 2 }) }),
  lineItem("li-region", "Region", {
    dims: [productsList],
    format: { type: "list", list: "regions" },
  }),
  lineItem("li-start", "Start", { dims: [productsList], format: { type: "date" } }),
  lineItem("li-active", "Active", { dims: [productsList], format: { type: "boolean" } }),
  lineItem("li-notes", "Notes", { dims: [productsList], format: { type: "text" } }),
  lineItem("li-calc", "Calculated", {
    dims: [productsList],
    format: numberFormat({ decimals: 0 }),
  }),
  lineItem("li-switch", "Switchover", {
    dims: [productsList],
    format: numberFormat({ decimals: 0 }),
  }),
  lineItem("li-growth", "Growth", { dims: [productsList], format: percent }),
]

export function editCell(row: number, col: number): Cell {
  switch (col) {
    case BUDGET:
      return numberCell(row * 10)
    case REGION:
      return { value: { t: "item", v: "r-emea" }, text: "EMEA", flags: ["input"] }
    case START:
      return { value: { t: "date", v: "2026-03-15" }, flags: ["input"] }
    case ACTIVE:
      return { value: { t: "boolean", v: row % 2 === 0 }, flags: ["input"] }
    case NOTES:
      return { value: { t: "text", v: `Note ${row}` }, flags: ["input"] }
    case CALCULATED:
      return numberCell(5, ["calculated", "readonly"])
    case SWITCHOVER:
      return numberCell(7, ["switchover", "readonly"])
    default:
      return numberCell(0.25)
  }
}

export function editView(overrides: Partial<ViewFixture> = {}): ViewFixture {
  return salesView({
    rowDims: [productsList],
    columnDims: [lineItemsDim],
    pages: [],
    totalRows: 6,
    totalColumns: lineItems.length,
    lineItems,
    rowHeader: (row) => header(member(`p${row}`, `Product ${row}`)),
    columnHeader: (col) => header(member(lineItems[col].id, lineItems[col].name)),
    cell: editCell,
    ...overrides,
  })
}

export const editQuery: GridQuery = {
  module: MODULE_ID,
  rows: [productsList],
  columns: [lineItemsDim],
}

export type Body = { edits: CellWrite[] }

/** Answers `POST /models/{id}/cells` and records what it was sent. */
export function serveCells(answer?: () => Response | Promise<Response>) {
  const bodies: Body[] = []
  server.use(
    http.post("/api/v1/models/:id/cells", async ({ request }) => {
      bodies.push((await request.json()) as Body)
      return answer?.() ?? HttpResponse.json({ seq: bodies.length, changed_line_item_ids: [] })
    }),
  )
  return bodies
}

/** Makes `POST /models/{id}/cells` wait until the returned function is called before it answers. */
export function holdCells(bodies: Body[]): () => void {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  server.use(
    http.post("/api/v1/models/:id/cells", async ({ request }) => {
      bodies.push((await request.json()) as Body)
      await gate
      return HttpResponse.json({ seq: bodies.length, changed_line_item_ids: [] })
    }),
  )
  return release
}

export type GridProps = Parameters<typeof Grid>[0]

export function renderGrid(props: Partial<GridProps> = {}) {
  const queryClient = createTestQueryClient({ staleTime: QUERY_STALE_TIME })
  render(
    <QueryClientProvider client={queryClient}>
      <Grid modelId={MODEL_ID} query={editQuery} reference={reference} {...props} />
    </QueryClientProvider>,
  )
  return queryClient
}

export function cellAt(grid: HTMLElement, row: number, col: number): HTMLElement {
  const cell = grid.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)
  if (!cell) {
    throw new Error(`No cell rendered at row ${row}, column ${col}`)
  }
  return cell
}

/** The grid with the edit view served, its cells endpoint answering, and its first cells loaded. */
export async function setup(props: Partial<GridProps> = {}, fixture: ViewFixture = editView()) {
  const served = serveViewQuery(fixture)
  const bodies = serveCells()
  const queryClient = renderGrid(props)
  const grid = await screen.findByRole("grid")
  await waitFor(() => expect(cellAt(grid, 0, 0).textContent).not.toBe(""))
  return { grid, bodies, served, queryClient }
}

export async function select(grid: HTMLElement, row: number, col: number) {
  await userEvent.click(cellAt(grid, row, col))
  expect(grid).toHaveFocus()
}

export const written = (lineItemId: string, row: number, value: Value): CellWrite => ({
  line_item_id: lineItemId,
  coords: [`p${row}`],
  value,
})

export const number = (v: number): Value => ({ t: "number", v })

export function expectActive(grid: HTMLElement, row: number, col: number) {
  expect(grid).toHaveAttribute("aria-activedescendant", cellAt(grid, row, col).id)
}
