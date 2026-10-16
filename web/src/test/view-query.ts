import { HttpResponse, http } from "msw"
import type { Format } from "@/features/grid/core/types"
import type {
  Cell,
  GridQuery,
  Header,
  LineItemInfo,
  Member,
  PageMember,
  QueryResult,
  ViewDim,
  ViewQuery,
} from "@/features/grid/view-types"
import { numberFormat } from "./number-format"
import { problem } from "./problem"
import { server } from "./server"

export const MODEL_ID = "0192f3a0-0000-7000-8000-000000000010"
export const MODULE_ID = "0192f3a0-0000-7000-8000-000000000020"

export const productsList: ViewDim = { kind: "list", list: "list-products" }
export const lineItemsDim: ViewDim = { kind: "line_items" }
export const versionsDim: ViewDim = { kind: "versions" }

export function member(key: string, label: string, overrides: Partial<Member> = {}): Member {
  return {
    key,
    label,
    depth: 0,
    is_summary: false,
    has_children: false,
    collapsed: false,
    ...overrides,
  }
}

export function header(...members: Member[]): Header {
  return { members }
}

export function lineItem(
  id: string,
  name: string,
  overrides: Partial<LineItemInfo> = {},
): LineItemInfo {
  return {
    id,
    name,
    format: numberFormat({ decimals: 0 }),
    is_input: true,
    dims: [],
    errors: [],
    ...overrides,
  }
}

export function numberCell(value: number, flags: Cell["flags"] = ["input"]): Cell {
  return { value: { t: "number", v: value }, flags }
}

/** Everything the query endpoint needs to answer any window of one pivot. */
export interface ViewFixture {
  rowDims: ViewDim[]
  columnDims: ViewDim[]
  pages: PageMember[]
  totalRows: number
  totalColumns: number
  rowHeader(row: number): Header
  columnHeader(col: number): Header
  cell(row: number, col: number): Cell
  lineItems: LineItemInfo[]
}

/** The 25 line items of the sales fixture: one format of each kind, repeating. */
export const SALES_LINE_ITEMS = 25

const salesFormats: Format[] = [
  numberFormat({ decimals: 0 }),
  numberFormat({ decimals: 2, unit: { type: "currency", code: "USD" } }),
  numberFormat({ decimals: 1, unit: { type: "percent" } }),
  { type: "boolean" },
  { type: "text" },
]

export function salesLineItemId(index: number): string {
  return `li-${index}`
}

/**
 * 1,000 products down the rows and, across the columns, two versions each holding the 25 line
 * items: 50 columns under two merged version headers. Line item 5 is a calculated formula.
 */
export function salesView(overrides: Partial<ViewFixture> = {}): ViewFixture {
  const lineItems = Array.from({ length: SALES_LINE_ITEMS }, (_, index) =>
    lineItem(salesLineItemId(index), `Line item ${index}`, {
      format: salesFormats[index % salesFormats.length],
      is_input: index !== 5,
      dims: [productsList],
    }),
  )
  return {
    rowDims: [productsList],
    columnDims: [versionsDim, lineItemsDim],
    pages: [],
    totalRows: 1000,
    totalColumns: 2 * SALES_LINE_ITEMS,
    lineItems,
    rowHeader: (row) => header(member(`p${row}`, `Product ${row + 1}`)),
    columnHeader: (col) => {
      const version = Math.floor(col / SALES_LINE_ITEMS)
      const index = col % SALES_LINE_ITEMS
      return header(
        member(`v${version}`, version === 0 ? "Actual" : "Budget"),
        member(salesLineItemId(index), `Line item ${index}`),
      )
    },
    cell: (row, col) => {
      const index = col % SALES_LINE_ITEMS
      const flags: Cell["flags"] = index === 5 ? ["calculated", "readonly"] : ["input"]
      switch (index % salesFormats.length) {
        case 3:
          return { value: { t: "boolean", v: row % 2 === 0 }, flags }
        case 4:
          return { value: { t: "text", v: `Note ${row}` }, flags }
        default:
          return { value: { t: "number", v: row * 1000 + col }, flags }
      }
    },
    ...overrides,
  }
}

/** The part of `fixture` a query window covers, as the endpoint would answer it. */
export function answer(fixture: ViewFixture, query: ViewQuery, seq = 1): QueryResult {
  const { row_offset, row_limit, col_offset, col_limit } = query.window
  const rowEnd = Math.min(row_offset + row_limit, fixture.totalRows)
  const colEnd = Math.min(col_offset + col_limit, fixture.totalColumns)
  const rows = range(row_offset, rowEnd)
  const columns = range(col_offset, colEnd)
  return {
    row_dims: fixture.rowDims,
    column_dims: fixture.columnDims,
    pages: fixture.pages,
    rows: rows.map(fixture.rowHeader),
    columns: columns.map(fixture.columnHeader),
    total_rows: fixture.totalRows,
    total_columns: fixture.totalColumns,
    cells: rows.map((row) => columns.map((col) => fixture.cell(row, col))),
    line_items: fixture.lineItems,
    seq,
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(end - start, 0) }, (_, index) => start + index)
}

export interface ServedView {
  /** Every query body the endpoint received, in order. */
  requests: ViewQuery[]
  /** What the endpoint answers from now on. */
  fixture: ViewFixture
  /** The `seq` the endpoint reports. */
  seq: number
}

/** Answers `POST /models/{id}/query` from `fixture`, and records what it was asked. */
export function serveViewQuery(fixture: ViewFixture = salesView()): ServedView {
  const served: ServedView = { requests: [], fixture, seq: 1 }
  server.use(
    http.post("/api/v1/models/:id/query", async ({ request }) => {
      const query = (await request.json()) as ViewQuery
      served.requests.push(query)
      return HttpResponse.json(answer(served.fixture, query, served.seq))
    }),
  )
  return served
}

/**
 * Like `serveViewQuery`, for a view that depends on the query: `fixtureFor` builds the fixture
 * of each query it is asked, so a test can collapse or hide members and see the answer change.
 */
export function serveViewQueryBy(fixtureFor: (query: ViewQuery) => ViewFixture) {
  const requests: ViewQuery[] = []
  server.use(
    http.post("/api/v1/models/:id/query", async ({ request }) => {
      const query = (await request.json()) as ViewQuery
      requests.push(query)
      return HttpResponse.json(answer(fixtureFor(query), query))
    }),
  )
  return { requests }
}

/** Makes the query endpoint refuse every request. */
export function failViewQuery(detail = "The query is not valid.") {
  server.use(http.post("/api/v1/models/:id/query", () => problem(422, "structure.invalid", detail)))
}

/** A pivot of the sales fixture's shape, as a caller of the grid would build it. */
export const salesQuery: GridQuery = {
  module: MODULE_ID,
  rows: [productsList],
  columns: [versionsDim, lineItemsDim],
}
