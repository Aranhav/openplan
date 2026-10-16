import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { violations as pageViolations } from "@/test/axe"
import { BUDGET, NOTES, REGION, START, cellAt, editView, select, setup } from "@/test/edit-view"
import { mockViewport } from "@/test/viewport"
import { serveViewQuery } from "@/test/view-query"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("./measure-text", () => ({ measureTextWidth: (text: string) => text.length * 8 }))
vi.setConfig({ testTimeout: 20_000 })

beforeEach(() => {
  mockViewport(800, 400)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** What axe finds wrong with the whole page, portalled popovers and menus included. */
const violations = () => pageViolations({ ignore: ["region"] })

describe("the editors, menus and popovers", () => {
  it("have nothing for axe to find while a text editor is open", async () => {
    const { grid } = await setup()
    await select(grid, 1, BUDGET)
    await userEvent.keyboard("{F2}")
    expect(screen.getByRole("textbox")).toBeInTheDocument()

    expect(await violations()).toEqual([])
  })

  it("have nothing for axe to find while a list editor is open", async () => {
    const { grid } = await setup()
    await select(grid, 1, REGION)
    await userEvent.keyboard("{Enter}")
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Items for Region, Product 1")

    expect(await violations()).toEqual([])
  })

  it("have nothing for axe to find while a date editor is open", async () => {
    const { grid } = await setup()
    await select(grid, 1, START)
    await userEvent.keyboard("{Enter}")
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Calendar for Start, Product 1")

    expect(await violations()).toEqual([])
  })

  it("have nothing for axe to find while the cell menu is open", async () => {
    const { grid } = await setup()
    await select(grid, 1, NOTES)
    fireEvent.contextMenu(cellAt(grid, 1, NOTES))
    await screen.findByRole("menu")

    expect(await violations()).toEqual([])
  })

  it("have nothing for axe to find while the column width popover is open", async () => {
    serveViewQuery(editView())
    const { grid } = await setup({ onColumnWidthsChange: vi.fn() })
    await select(grid, 1, NOTES)
    fireEvent.contextMenu(cellAt(grid, 1, NOTES))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Set column width…" }))
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Column width")
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveFocus())

    expect(await violations()).toEqual([])
  })
})
