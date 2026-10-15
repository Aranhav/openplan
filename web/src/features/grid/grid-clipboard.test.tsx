import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ACTIVE,
  BUDGET,
  CALCULATED,
  GROWTH,
  NOTES,
  START,
  SWITCHOVER,
  type Body,
  cellAt,
  editCell,
  editView,
  expectActive,
  holdCells,
  number,
  select,
  setup,
  written,
} from "@/test/edit-view"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { answer, numberCell, salesView } from "@/test/view-query"
import type { ViewQuery } from "@/features/grid/view-types"
import { mockViewport } from "@/test/viewport"

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

/** Pastes `text` into the grid the way the browser does for Ctrl+V. */
function paste(grid: HTMLElement, text: string) {
  return fireEvent.paste(grid, { clipboardData: { getData: () => text } })
}

function copy(grid: HTMLElement) {
  const setData = vi.fn()
  const notPrevented = fireEvent.copy(grid, { clipboardData: { setData } })
  return { setData, prevented: !notPrevented }
}

/** Selects from one cell to another with the keyboard. */
async function selectRange(grid: HTMLElement, from: [number, number], to: [number, number]) {
  await select(grid, from[0], from[1])
  const down = to[0] - from[0]
  const right = to[1] - from[1]
  await userEvent.keyboard(
    `{Shift>}${"{ArrowDown}".repeat(down)}${"{ArrowRight}".repeat(right)}{/Shift}`,
  )
}

describe("copy", () => {
  it("puts the selection on the clipboard as tab-separated text of raw values", async () => {
    const { grid } = await setup()
    await selectRange(grid, [0, BUDGET], [1, ACTIVE])

    const { setData, prevented } = copy(grid)

    expect(setData).toHaveBeenCalledExactlyOnceWith(
      "text/plain",
      "0\tEMEA\t2026-03-15\tTRUE\n10\tEMEA\t2026-03-15\tFALSE\n",
    )
    expect(prevented).toBe(true)
  })

  it("writes numbers without their format and percentages with a sign", async () => {
    const { grid } = await setup()
    await selectRange(grid, [0, CALCULATED], [0, GROWTH])

    const { setData } = copy(grid)

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "5\t7\t25%\n")
  })

  it("quotes a cell that holds a tab or a line break", async () => {
    const fixture = editView({
      cell: (row, col) =>
        col === NOTES
          ? { value: { t: "text", v: "a\tb\nc" }, flags: ["input"] }
          : editCell(row, col),
    })
    const { grid } = await setup({}, fixture)
    await select(grid, 0, NOTES)

    const { setData } = copy(grid)

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", '"a\tb\nc"\n')
  })

  it("copies the cell that is active when a single cell is selected", async () => {
    const { grid } = await setup()
    await select(grid, 2, NOTES)

    expect(copy(grid).setData).toHaveBeenCalledExactlyOnceWith("text/plain", "Note 2\n")
  })

  it("writes a cell that does not apply as empty", async () => {
    const fixture = editView({
      cell: (row, col) =>
        col === NOTES
          ? { value: { t: "text", v: "" }, flags: ["na", "readonly"] }
          : editCell(row, col),
    })
    const { grid } = await setup({}, fixture)
    await selectRange(grid, [0, ACTIVE], [0, NOTES])

    expect(copy(grid).setData).toHaveBeenCalledExactlyOnceWith("text/plain", "TRUE\t\n")
  })

  it("copies the value that is being written, not the one it replaces", async () => {
    const { grid } = await setup()
    server.use(http.post("/api/v1/models/:id/cells", () => new Promise(() => undefined)))
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await select(grid, 1, BUDGET)

    expect(copy(grid).setData).toHaveBeenCalledExactlyOnceWith("text/plain", "42\n")
  })

  it("copies when the browser sends the event to where the page's selection is, not to the grid", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{F2}{Escape}")
    const setData = vi.fn()

    // Once an editor has closed, the selection of the page is where its input was.
    fireEvent.copy(document.body, { clipboardData: { setData } })

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "10\n")
  })

  it("leaves a copy alone while something else has the focus", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    const outside = document.createElement("input")
    document.body.append(outside)
    outside.focus()
    const setData = vi.fn()

    fireEvent.copy(outside, { clipboardData: { setData } })

    expect(setData).not.toHaveBeenCalled()
    outside.remove()
  })

  it("copies the cells on show while they are being read again after an edit", async () => {
    const { grid, served } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/models/:id/query", async ({ request }) => {
        await gate
        return HttpResponse.json(answer(served.fixture, (await request.json()) as ViewQuery))
      }),
    )
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("42{Enter}")
    await waitFor(() => expect(toast.error).not.toHaveBeenCalled())
    await select(grid, 1, BUDGET)

    const { setData } = copy(grid)

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "42\n")
    release()
  })

  it("leaves a copy made inside the editor to the editor", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{F2}")
    const setData = vi.fn()

    fireEvent.copy(screen.getByRole("textbox"), { clipboardData: { setData } })

    expect(setData).not.toHaveBeenCalled()
  })

  it("asks to scroll when part of the selection has not loaded, and loads it", async () => {
    const { grid } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}")

    const first = copy(grid)

    expect(first.setData).not.toHaveBeenCalled()
    expect(first.prevented).toBe(true)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Some of the selected cells haven't loaded yet. Try copying again in a moment.",
    )
    await waitFor(() => {
      const again = copy(grid)
      expect(again.setData).toHaveBeenCalledOnce()
      expect(String(again.setData.mock.calls[0][1]).split("\n")).toHaveLength(1001)
    })
  })

  it("refuses more than 10,000 cells", async () => {
    const { grid } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}a{/Control}")

    const { setData } = copy(grid)

    expect(setData).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Select at most 10,000 cells to copy.")
  })
})

describe("cut", () => {
  it("copies the cells and clears the ones that can be changed", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [2, BUDGET])
    const setData = vi.fn()

    const notPrevented = fireEvent.cut(grid, { clipboardData: { setData } })

    expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "10\n20\n")
    expect(notPrevented).toBe(false)
    await waitFor(() =>
      expect(bodies).toEqual([
        { edits: [written("li-budget", 1, number(0)), written("li-budget", 2, number(0))] },
      ]),
    )
  })
})

describe("paste", () => {
  it("fills the selection with a single value", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [0, BUDGET], [2, BUDGET])

    paste(grid, "7")

    await waitFor(() =>
      expect(bodies).toEqual([
        {
          edits: [
            written("li-budget", 0, number(7)),
            written("li-budget", 1, number(7)),
            written("li-budget", 2, number(7)),
          ],
        },
      ]),
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 3 cells"))
  })

  it("shows the pasted values until the server has answered", async () => {
    const { grid, bodies } = await setup()
    holdCells(bodies)
    await selectRange(grid, [0, BUDGET], [2, BUDGET])

    paste(grid, "7")

    await waitFor(() => expect(cellAt(grid, 2, BUDGET)).toHaveTextContent("7.00"))
    expect(within(cellAt(grid, 2, BUDGET)).getByText("7.00")).toHaveClass("italic")
  })

  it("puts a block of cells where the selection starts", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    paste(grid, "5\tAP\r\n6\tNA\r\n")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits).toEqual([
      written("li-budget", 1, number(5)),
      written("li-region", 1, { t: "item", v: "r-apac" }),
      written("li-budget", 2, number(6)),
      written("li-region", 2, { t: "item", v: "r-na" }),
    ])
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 4 cells"))
  })

  it("says 'Pasted 1 cell' for one", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)

    paste(grid, "7")

    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 1 cell"))
  })

  it("reads percentages, dates and booleans in the cells they go to", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, START)

    paste(grid, "31/12/2026\tyes\tnote")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits.map((edit) => edit.value)).toEqual([
      { t: "date", v: "2026-12-31" },
      { t: "boolean", v: true },
      { t: "text", v: "note" },
    ])
  })

  it("sends nothing when one value is not a value of its cell, and says where it is", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    paste(grid, "5\tAP\n6\tnowhere\n")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "Row 2, column 2: 'nowhere' isn't in this list.",
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(bodies).toEqual([])
  })

  it("counts the position within the pasted block, wherever it is pasted", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 3, BUDGET)

    paste(grid, "5\tAP\nx\tNA\n")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Row 2, column 1: 'x' isn't a number."),
    )
    expect(bodies).toEqual([])
  })

  it("counts the position within the block when one value is repeated over the selection", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [0, BUDGET], [2, BUDGET])

    paste(grid, "x")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Row 1, column 1: 'x' isn't a number."),
    )
    expect(bodies).toEqual([])
  })

  it("skips the cells that cannot be changed and counts them", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, NOTES)

    paste(grid, "a\t2\t3\nb\t5\t6\n")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].edits).toEqual([
      written("li-notes", 1, { t: "text", v: "a" }),
      written("li-notes", 2, { t: "text", v: "b" }),
    ])
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(
        "Pasted 2 cells, skipped 4 read-only cells",
      ),
    )
  })

  it("says 'skipped 1 read-only cell' for one", async () => {
    const { grid } = await setup()
    await select(grid, 1, NOTES)

    paste(grid, "a\t2")

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(
        "Pasted 1 cell, skipped 1 read-only cell",
      ),
    )
  })

  it("does not check the value of a cell that cannot be changed", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, NOTES)

    paste(grid, "a\tnot a number\t3")

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("sends nothing for values the cells already have, and still says what it pasted", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    paste(grid, "10")

    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 1 cell"))
    expect(bodies).toEqual([])
  })

  it("ignores an empty clipboard", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [2, BUDGET])

    paste(grid, "")

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bodies).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("clears a cell for a blank value in the text", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)

    paste(grid, "\n")

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 1, number(0))] }]))
  })

  it("refuses to change more than 10,000 cells", async () => {
    const { grid, bodies } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}a{/Control}")

    paste(grid, "1")

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Select or paste at most 10,000 cells at a time.",
    )
    expect(bodies).toEqual([])
  })

  it("loads the cells of a selection that is not on screen before it changes them", async () => {
    const { grid, bodies } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}")

    paste(grid, "7")

    await waitFor(() => expect(bodies).toHaveLength(1), { timeout: 5000 })
    expect(bodies[0].edits).toHaveLength(1000)
    expect(bodies[0].edits[999]).toEqual({
      line_item_id: "li-0",
      coords: ["p999"],
      value: number(7),
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Pasted 1,000 cells"))
  })

  it("reads cells that an earlier paste changed, even in blocks that are not on show", async () => {
    const stored = new Map<string, number>()
    const fixture = salesView({
      cell: (row) => numberCell(stored.get(`p${row}`) ?? 0),
    })
    const { grid, bodies } = await setup({}, fixture)
    server.use(
      http.post("/api/v1/models/:id/cells", async ({ request }) => {
        const body = (await request.json()) as Body
        bodies.push(body)
        for (const edit of body.edits) {
          stored.set(edit.coords[0], (edit.value as { v: number }).v)
        }
        return HttpResponse.json({ seq: bodies.length, changed_line_item_ids: [] })
      }),
    )
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}")

    paste(grid, "7")
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pasted 1,000 cells"), {
      timeout: 8000,
    })
    paste(grid, "0")

    // The first paste put 7 in every cell, so every cell changes, not only those on show.
    await waitFor(() => expect(bodies).toHaveLength(2), { timeout: 8000 })
    expect(bodies[1].edits).toHaveLength(1000)
    expect(bodies[1].edits.every((edit) => (edit.value as { v: number }).v === 0)).toBe(true)
  })

  it("clips a block at the last row", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 5, BUDGET)

    paste(grid, "1\n2\n3\n")

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 5, number(1))] }]))
  })

  it("does not say it pasted when the server refuses", async () => {
    const { grid, bodies } = await setup()
    server.use(
      http.post("/api/v1/models/:id/cells", async ({ request }) => {
        bodies.push((await request.json()) as Body)
        return problem(403, "auth.forbidden", "You need the Planner role to change cells.")
      }),
    )
    await select(grid, 1, BUDGET)

    paste(grid, "7")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        "You need the Planner role to change cells.",
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
    await waitFor(() => expect(cellAt(grid, 1, BUDGET)).toHaveTextContent("10.00"))
  })

  it("pastes when the browser sends the event to where the page's selection is", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{F2}{Escape}")

    fireEvent.paste(document.body, { clipboardData: { getData: () => "9" } })

    await waitFor(() => expect(bodies).toEqual([{ edits: [written("li-budget", 1, number(9))] }]))
  })

  it("leaves a paste made inside the editor to the editor", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{F2}")

    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { getData: () => "99" } })

    expect(bodies).toEqual([])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("is undone as one step", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [0, BUDGET], [1, BUDGET])
    paste(grid, "7")
    await waitFor(() => expect(bodies).toHaveLength(1))

    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].edits).toEqual([
      written("li-budget", 0, number(0)),
      written("li-budget", 1, number(10)),
    ])
  })

  it("is a copy away from what was copied, cell for cell", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [1, NOTES])
    const { setData } = copy(grid)
    const text = String(setData.mock.calls[0][1])
    await select(grid, 4, BUDGET)

    paste(grid, text)

    await waitFor(() => expect(bodies).toHaveLength(1))
    // The region and the start date are the same in both rows.
    expect(bodies[0].edits.map((edit) => edit.line_item_id)).toEqual([
      "li-budget",
      "li-active",
      "li-notes",
    ])
    expect(bodies[0].edits.map((edit) => edit.value)).toEqual([
      number(10),
      { t: "boolean", v: false },
      { t: "text", v: "Note 1" },
    ])
    expectActive(grid, 4, BUDGET)
  })
})

describe("fill down", () => {
  it("copies the top row of the selection into the rows below", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [3, BUDGET])

    await userEvent.keyboard("{Control>}d{/Control}")

    await waitFor(() =>
      expect(bodies).toEqual([
        { edits: [written("li-budget", 2, number(10)), written("li-budget", 3, number(10))] },
      ]),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("copies the cell above into a single selected cell", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, NOTES)

    await userEvent.keyboard("{Control>}d{/Control}")

    await waitFor(() =>
      expect(bodies).toEqual([{ edits: [written("li-notes", 2, { t: "text", v: "Note 1" })] }]),
    )
  })

  it("works with Command on a Mac", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 2, NOTES)

    await userEvent.keyboard("{Meta>}d{/Meta}")

    await waitFor(() => expect(bodies).toHaveLength(1))
  })

  it("has nothing to copy into the first row", async () => {
    const { grid, bodies } = await setup()
    await select(grid, 0, NOTES)

    await userEvent.keyboard("{Control>}d{/Control}")

    expect(bodies).toEqual([])
  })

  it("fills the cells that can be changed and says it skipped the others", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [2, SWITCHOVER])

    await userEvent.keyboard("{Control>}d{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(1))
    // The region and the start date are what the row above has already.
    expect(bodies[0].edits.map((edit) => edit.line_item_id)).toEqual([
      "li-budget",
      "li-active",
      "li-notes",
    ])
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledExactlyOnceWith(
        "Filled 5 cells, skipped 2 read-only cells",
      ),
    )
  })

  it("refuses a selection of more than 10,000 cells", async () => {
    const { grid, bodies } = await setup({}, salesView())
    await select(grid, 0, 0)
    await userEvent.keyboard("{Control>}a{/Control}")

    await userEvent.keyboard("{Control>}d{/Control}")

    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Select at most 10,000 cells to change at once.",
    )
    expect(bodies).toEqual([])
  })

  it("is undone as one step", async () => {
    const { grid, bodies } = await setup()
    await selectRange(grid, [1, BUDGET], [3, BUDGET])
    await userEvent.keyboard("{Control>}d{/Control}")
    await waitFor(() => expect(bodies).toHaveLength(1))

    await userEvent.keyboard("{Control>}z{/Control}")

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].edits).toEqual([
      written("li-budget", 2, number(20)),
      written("li-budget", 3, number(30)),
    ])
  })

  it("does nothing in a read-only grid", async () => {
    const { grid, bodies } = await setup({ readOnly: true })
    await select(grid, 2, NOTES)

    await userEvent.keyboard("{Control>}d{/Control}")

    expect(bodies).toEqual([])
    expect(within(cellAt(grid, 2, NOTES)).getByText("Note 2")).toBeInTheDocument()
  })
})
