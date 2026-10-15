import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import axe from "axe-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import { numberFormat } from "@/test/number-format"
import { createTestQueryClient } from "@/test/render"
import {
  MODEL_ID,
  MODULE_ID,
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  salesView,
  serveViewQuery,
} from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import { Grid } from "./grid"
import type { Cell, GridQuery, ViewDim } from "./view-types"

vi.mock("./measure-text", () => ({ measureTextWidth: (text: string) => text.length * 8 }))
vi.setConfig({ testTimeout: 20_000 })

const regions: ViewDim = { kind: "list", list: "list-regions" }
const time: ViewDim = { kind: "time" }

const lineItems = [
  lineItem("li-units", "Units"),
  lineItem("li-active", "On promotion", { format: { type: "boolean" } }),
  lineItem("li-notes", "Notes", { format: { type: "text" } }),
  lineItem("li-margin", "Margin", {
    format: numberFormat({ decimals: 1, unit: { type: "percent" } }),
  }),
  lineItem("li-discount", "Discount", {
    errors: [
      {
        code: "formula.unknown_name",
        message: "Unknown name 'Discont'.",
        start: 0,
        end: 7,
        suggestion: "Discount",
      },
    ],
  }),
]
const regionMembers = [
  member("top", "All Regions", { is_summary: true, has_children: true }),
  member("emea", "EMEA", { depth: 1, has_children: true, collapsed: true }),
  member("uk", "United Kingdom", { depth: 2 }),
]
const months = [
  member("Jan 26", "Jan 26"),
  member("Feb 26", "Feb 26"),
  member("Q1 FY26", "Q1 FY26", { depth: 1, is_summary: true, has_children: true }),
]

function cellFor(row: number, col: number): Cell {
  const li = row % lineItems.length
  const summary = Math.floor(row / lineItems.length) === 0 || col === 2
  const flags: Cell["flags"] = summary ? ["summary", "readonly"] : ["input"]
  switch (li) {
    case 1:
      return summary
        ? { value: { t: "boolean", v: false }, flags: ["na", "readonly"] }
        : { value: { t: "boolean", v: col === 0 }, flags }
    case 2:
      return {
        value: { t: "text", v: summary ? "" : "Check" },
        flags: summary ? ["na", "readonly"] : flags,
      }
    case 3:
      return numberCell(0.25, [
        "calculated",
        "readonly",
        ...(col === 0 ? (["switchover"] as const) : []),
      ])
    case 4:
      return { value: { t: "number", v: 0 }, flags: ["error", "readonly"] }
    default:
      return numberCell(1000 + row, flags)
  }
}

const query: GridQuery = { module: MODULE_ID, rows: [regions, lineItemsDim], columns: [time] }

beforeEach(() => {
  mockViewport(800, 600)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("grid accessibility", () => {
  it("has no axe violations with every kind of cell, header and control drawn", async () => {
    serveViewQuery(
      salesView({
        rowDims: [regions, lineItemsDim],
        columnDims: [time],
        totalRows: regionMembers.length * lineItems.length,
        totalColumns: months.length,
        lineItems,
        rowHeader: (row) =>
          header(
            regionMembers[Math.floor(row / lineItems.length)],
            member(lineItems[row % lineItems.length].id, lineItems[row % lineItems.length].name),
          ),
        columnHeader: (col) => header(months[col]),
        cell: cellFor,
      }),
    )
    const { container } = render(
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
        <main>
          <Grid
            modelId={MODEL_ID}
            query={query}
            label="Revenue plan"
            onToggleCollapse={vi.fn()}
            onColumnWidthsChange={vi.fn()}
            onToggleBoolean={vi.fn()}
          />
        </main>
      </QueryClientProvider>,
    )
    const grid = await screen.findByRole("grid")
    await waitFor(() =>
      expect(grid.querySelector("[data-row='0'][data-col='0']")?.textContent).not.toBe(""),
    )

    const results = await axe.run(container, {
      // jsdom has no layout, so contrast and anything that needs a size cannot be judged here.
      rules: { "color-contrast": { enabled: false } },
    })

    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([])
  })
})
