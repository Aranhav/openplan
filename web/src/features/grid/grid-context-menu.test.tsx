import { QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QUERY_STALE_TIME } from "@/lib/query-client"
import {
  BUDGET,
  CALCULATED,
  NOTES,
  REGION,
  cellAt,
  editQuery,
  editView,
  expectActive,
  number,
  reference,
  select,
  serveCells,
  setup,
  written,
} from "@/test/edit-view"
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
  serveViewQueryBy,
} from "@/test/view-query"
import type { ViewFixture } from "@/test/view-query"
import { mockViewport } from "@/test/viewport"
import { Grid } from "./grid"
import type { GridQuery, MemberRef, ViewDim } from "./view-types"

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

function openMenu(cell: HTMLElement) {
  fireEvent.contextMenu(cell)
  return screen.findByRole("menu")
}

const item = (name: string | RegExp) => screen.getByRole("menuitem", { name })

function stubClipboard(clipboard: Partial<Clipboard>) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true })
}

describe("opening the menu", () => {
  it("opens on a right click with Copy, Paste and Fill down and their keys", async () => {
    const { grid } = await setup()

    await openMenu(cellAt(grid, 2, BUDGET))

    expect(item(/^Copy/)).toHaveTextContent("Ctrl+C")
    expect(item(/^Paste/)).toHaveTextContent("Ctrl+V")
    expect(item(/^Fill down/)).toHaveTextContent("Ctrl+D")
  })

  it("names the keys for a Mac", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
    const { grid } = await setup()

    await openMenu(cellAt(grid, 2, BUDGET))

    expect(item(/^Copy/)).toHaveTextContent("⌘C")
    expect(item(/^Paste/)).toHaveTextContent("⌘V")
    expect(item(/^Fill down/)).toHaveTextContent("⌘D")
  })

  it("selects the cell that is clicked when it is outside the selection", async () => {
    const { grid } = await setup()
    await select(grid, 0, BUDGET)

    await openMenu(cellAt(grid, 3, NOTES))

    expectActive(grid, 3, NOTES)
  })

  it("keeps a selection that holds the cell that is clicked", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}")

    await openMenu(cellAt(grid, 2, BUDGET))

    expect(cellAt(grid, 1, BUDGET)).toHaveAttribute("aria-selected", "true")
    expect(cellAt(grid, 3, BUDGET)).toHaveAttribute("aria-selected", "true")
    expectActive(grid, 1, BUDGET)
  })

  it.each([
    ["Shift+F10", "{Shift>}{F10}{/Shift}"],
    ["the Menu key", "{ContextMenu}"],
  ])("opens with %s, at the active cell", async (_name, keys) => {
    const { grid } = await setup()
    await select(grid, 2, REGION)
    const seen: { x: number; y: number }[] = []
    grid.addEventListener("contextmenu", (event) => {
      seen.push({ x: event.clientX, y: event.clientY })
    })

    await userEvent.keyboard(keys)

    expect(await screen.findByRole("menu")).toBeInTheDocument()
    // The active cell is the third row, after one header row, and the second column, after the row headers.
    const left = 240 + REGION * 120
    expect(seen).toHaveLength(1)
    expect(seen[0].x).toBeGreaterThanOrEqual(left)
    expect(seen[0].x).toBeLessThanOrEqual(left + 120)
    expect(seen[0].y).toBeGreaterThanOrEqual(32 + 2 * 32)
    expect(seen[0].y).toBeLessThanOrEqual(32 + 3 * 32)
  })

  it("closes with Escape and gives the focus back to the grid", async () => {
    const { grid } = await setup()
    await select(grid, 2, NOTES)
    await userEvent.keyboard("{Shift>}{F10}{/Shift}")
    await screen.findByRole("menu")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    expect(grid).toHaveFocus()
    expectActive(grid, 2, NOTES)
  })

  it("is not opened by the keys while an editor is open", async () => {
    const { grid } = await setup()
    await select(grid, 2, NOTES)
    await userEvent.keyboard("{F2}")

    await userEvent.keyboard("{Shift>}{F10}{/Shift}")

    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })
})

describe("Copy, Paste and Fill down", () => {
  it("Copy puts the selection on the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubClipboard({ writeText })
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}")
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item(/^Copy/))

    expect(writeText).toHaveBeenCalledExactlyOnceWith("10\n20\n")
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    expect(grid).toHaveFocus()
  })

  it("Copy says so when the browser will not copy", async () => {
    stubClipboard({ writeText: vi.fn(() => Promise.reject(new Error("blocked"))) })
    const { grid } = await setup()
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item(/^Copy/))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "Your browser blocked copying. Press Ctrl+C instead.",
      ),
    )
  })

  it("Paste writes what is on the clipboard at the selection", async () => {
    stubClipboard({ readText: vi.fn(() => Promise.resolve("77")) })
    const { grid, bodies } = await setup()
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item(/^Paste/))

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 1, number(77))] }]))
  })

  it("Paste says so when the browser will not give the clipboard", async () => {
    stubClipboard({ readText: vi.fn(() => Promise.reject(new Error("blocked"))) })
    const { grid, bodies } = await setup()
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item(/^Paste/))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "Your browser blocked reading the clipboard. Press Ctrl+V instead.",
      ),
    )
    expect(bodies).toEqual([])
  })

  it("Fill down copies the cell above", async () => {
    const { grid, bodies } = await setup()
    await openMenu(cellAt(grid, 2, NOTES))

    await userEvent.click(item(/^Fill down/))

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-notes", 2, { t: "text", v: "Note 1" })] }]),
    )
  })

  it("disables Fill down on the first row, where there is nothing above", async () => {
    const { grid } = await setup()

    await openMenu(cellAt(grid, 0, NOTES))

    expect(item(/^Fill down/)).toHaveAttribute("aria-disabled", "true")
    expect(item(/^Copy/)).not.toHaveAttribute("aria-disabled")
  })

  it("disables Paste on a cell that cannot be changed", async () => {
    const { grid } = await setup()

    await openMenu(cellAt(grid, 2, CALCULATED))

    expect(item(/^Paste/)).toHaveAttribute("aria-disabled", "true")
    expect(item(/^Fill down/)).not.toHaveAttribute("aria-disabled")
  })

  it("disables Paste and Fill down in a read-only grid, but not Copy", async () => {
    const { grid } = await setup({ readOnly: true })

    await openMenu(cellAt(grid, 2, NOTES))

    expect(item(/^Paste/)).toHaveAttribute("aria-disabled", "true")
    expect(item(/^Fill down/)).toHaveAttribute("aria-disabled", "true")
    expect(item(/^Copy/)).not.toHaveAttribute("aria-disabled")
  })
})

describe("collapsing from a cell", () => {
  const regionsList: ViewDim = { kind: "list", list: "list-regions" }
  const timeDim: ViewDim = { kind: "time" }
  const top = member("top", "All Regions", { is_summary: true, has_children: true })
  const uk = member("uk", "United Kingdom", { depth: 2 })
  const hierarchyQuery: GridQuery = {
    module: MODULE_ID,
    rows: [regionsList],
    columns: [timeDim],
    pages: [{ dim: lineItemsDim, key: "li-0" }],
  }

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
    const columns = collapsed.has("Q1 FY26")
      ? [quarter]
      : [member("Jan 26", "Jan 26"), member("Feb 26", "Feb 26"), quarter]
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

  function Collapsing({ onToggle }: { onToggle: (member: MemberRef) => void }) {
    const [collapsed, setCollapsed] = useState<MemberRef[]>([])
    const toggle = useCallback(
      (target: MemberRef) => {
        onToggle(target)
        setCollapsed((now) =>
          now.some((m) => m.key === target.key)
            ? now.filter((m) => m.key !== target.key)
            : [...now, target],
        )
      },
      [onToggle],
    )
    const current = useMemo(() => ({ ...hierarchyQuery, collapsed }), [collapsed])
    return <Grid modelId={MODEL_ID} query={current} onToggleCollapse={toggle} />
  }

  async function renderHierarchy(onToggle = vi.fn()) {
    serveViewQueryBy(hierarchyFor)
    render(
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
        <Collapsing onToggle={onToggle} />
      </QueryClientProvider>,
    )
    const grid = await screen.findByRole("grid")
    await waitFor(() => expect(cellAt(grid, 0, 0).textContent).not.toBe(""))
    return { grid, onToggle }
  }

  it("offers to collapse every member with children that holds the row, nearest first", async () => {
    const { grid } = await renderHierarchy()

    await openMenu(cellAt(grid, 2, 0))

    const names = screen.getAllByRole("menuitem").map((entry) => entry.textContent)
    expect(names).toContain("Collapse EMEA")
    expect(names).toContain("Collapse All Regions")
    expect(names.indexOf("Collapse EMEA")).toBeLessThan(names.indexOf("Collapse All Regions"))
    expect(names).not.toContain("Collapse United Kingdom")
  })

  it("offers the quarter that holds a month, and the member of the row itself", async () => {
    const { grid } = await renderHierarchy()

    await openMenu(cellAt(grid, 1, 0))

    const names = screen.getAllByRole("menuitem").map((entry) => entry.textContent)
    expect(names).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Collapse EMEA/), "Collapse Q1 FY26"]),
    )
  })

  it("collapses the parent of a leaf row, and moves the active cell to it", async () => {
    const { grid, onToggle } = await renderHierarchy()
    await openMenu(cellAt(grid, 2, 0))

    await userEvent.click(item("Collapse EMEA"))

    expect(onToggle).toHaveBeenCalledExactlyOnceWith({ dim: regionsList, key: "emea" })
    await waitFor(() =>
      expect(
        within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() => expectActive(grid, 1, 0))
    expect(grid).toHaveFocus()
  })

  it("collapses the quarter of a month column", async () => {
    const { grid, onToggle } = await renderHierarchy()
    await openMenu(cellAt(grid, 0, 0))

    await userEvent.click(item("Collapse Q1 FY26"))

    expect(onToggle).toHaveBeenCalledExactlyOnceWith({ dim: timeDim, key: "Q1 FY26" })
    await waitFor(() =>
      expect(within(grid).queryByRole("columnheader", { name: "Jan 26" })).not.toBeInTheDocument(),
    )
  })

  it("offers to expand a member that is collapsed", async () => {
    const { grid, onToggle } = await renderHierarchy()
    await openMenu(cellAt(grid, 2, 0))
    await userEvent.click(item("Collapse EMEA"))
    await waitFor(() =>
      expect(
        within(grid).queryByRole("rowheader", { name: "United Kingdom" }),
      ).not.toBeInTheDocument(),
    )

    await openMenu(cellAt(grid, 1, 0))
    await userEvent.click(item(/^Expand EMEA/))

    expect(onToggle).toHaveBeenLastCalledWith({ dim: regionsList, key: "emea" })
    expect(
      await within(grid).findByRole("rowheader", { name: "United Kingdom" }),
    ).toBeInTheDocument()
  })

  it("shows the keys that collapse and expand the member of the row itself", async () => {
    const { grid } = await renderHierarchy()

    await openMenu(cellAt(grid, 1, 0))

    expect(item(/^Collapse EMEA/)).toHaveTextContent("Alt+Shift+←")
  })

  it("offers nothing to collapse for a grid that cannot collapse", async () => {
    const { grid } = await setup()

    await openMenu(cellAt(grid, 1, BUDGET))

    expect(screen.queryByRole("menuitem", { name: /^(Collapse|Expand)/ })).not.toBeInTheDocument()
  })
})

describe("column width", () => {
  /** A grid whose parent keeps the widths, as the module screen will. */
  function Widths({ onChange }: { onChange: (widths: Record<string, number>) => void }) {
    const [widths, setWidths] = useState<Record<string, number>>({ "li-budget": 200 })
    return (
      <Grid
        modelId={MODEL_ID}
        query={editQuery}
        reference={reference}
        columnWidths={widths}
        onColumnWidthsChange={(next) => {
          onChange(next)
          setWidths(next)
        }}
      />
    )
  }

  async function renderWidths(onChange = vi.fn()) {
    const fixture = editView()
    serveViewQueryBy(() => fixture)
    serveCells()
    render(
      <QueryClientProvider client={createTestQueryClient({ staleTime: QUERY_STALE_TIME })}>
        <Widths onChange={onChange} />
      </QueryClientProvider>,
    )
    const grid = await screen.findByRole("grid")
    await waitFor(() => expect(cellAt(grid, 0, 0).textContent).not.toBe(""))
    return { grid, onChange }
  }

  it("opens a popover with the width of the column and sets a new one", async () => {
    const { grid, onChange } = await renderWidths()
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item("Column width…"))
    const input = await screen.findByRole("spinbutton", { name: "Column width (px)" })
    expect(input).toHaveValue(200)
    expect(input).toHaveFocus()
    await userEvent.clear(input)
    await userEvent.type(input, "300")
    await userEvent.click(screen.getByRole("button", { name: "Set width" }))

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ "li-budget": 300 })
    await waitFor(() => expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument())
    expect(grid).toHaveFocus()
  })

  it("starts from the default width for a column that has none", async () => {
    const { grid } = await renderWidths()
    await openMenu(cellAt(grid, 1, NOTES))

    await userEvent.click(item("Column width…"))

    expect(await screen.findByRole("spinbutton")).toHaveValue(120)
  })

  it("sets the width with Enter", async () => {
    const { grid, onChange } = await renderWidths()
    await openMenu(cellAt(grid, 1, NOTES))
    await userEvent.click(item("Column width…"))
    const input = await screen.findByRole("spinbutton")

    await userEvent.clear(input)
    await userEvent.type(input, "64{Enter}")

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ "li-budget": 200, "li-notes": 64 })
  })

  it.each(["47", "641", "", "12.5"])(
    "refuses a width of '%s' and says what is allowed",
    async (typed) => {
      const { grid, onChange } = await renderWidths()
      await openMenu(cellAt(grid, 1, BUDGET))
      await userEvent.click(item("Column width…"))
      const input = await screen.findByRole("spinbutton")

      await userEvent.clear(input)
      if (typed) {
        await userEvent.type(input, typed)
      }
      await userEvent.click(screen.getByRole("button", { name: "Set width" }))

      expect(await screen.findByText("Enter a whole number from 48 to 640.")).toBeInTheDocument()
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it.each(["48", "640"])("accepts a width of %s", async (typed) => {
    const { grid, onChange } = await renderWidths()
    await openMenu(cellAt(grid, 1, BUDGET))
    await userEvent.click(item("Column width…"))
    const input = await screen.findByRole("spinbutton")

    await userEvent.clear(input)
    await userEvent.type(input, `${typed}{Enter}`)

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ "li-budget": Number(typed) })
  })

  it("closes with Escape and gives the focus back to the grid", async () => {
    const { grid, onChange } = await renderWidths()
    await openMenu(cellAt(grid, 1, BUDGET))
    await userEvent.click(item("Column width…"))
    await screen.findByRole("spinbutton")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument())
    expect(grid).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("resets a column to the default width", async () => {
    const { grid, onChange } = await renderWidths()
    await openMenu(cellAt(grid, 1, BUDGET))

    await userEvent.click(item("Reset column width"))

    expect(onChange).toHaveBeenCalledExactlyOnceWith({})
  })

  it("disables Reset column width for a column at the default width", async () => {
    const { grid } = await renderWidths()

    await openMenu(cellAt(grid, 1, NOTES))

    expect(item("Reset column width")).toHaveAttribute("aria-disabled", "true")
    expect(item("Column width…")).not.toHaveAttribute("aria-disabled")
  })

  it("offers no column width when the grid cannot keep one", async () => {
    const { grid } = await setup()

    await openMenu(cellAt(grid, 1, BUDGET))

    expect(screen.queryByRole("menuitem", { name: "Column width…" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Reset column width" })).not.toBeInTheDocument()
  })
})
