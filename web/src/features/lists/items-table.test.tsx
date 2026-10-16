import { fireEvent, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  countriesList,
  listsStructure,
  openListsApp,
  productsList,
  regionsList,
} from "@/test/lists"
import { mockViewport } from "@/test/viewport"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Products with `count` items named "Product 1" to "Product <count>". */
function openProducts(count: number) {
  mockViewport(900, 400)
  const structure = listsStructure()
  structure.lists[2] = {
    ...structure.lists[2],
    items: Array.from({ length: count }, (_, index) => ({
      id: `0192f3a0-0000-7000-8000-${String(100000000000 + index)}`,
      name: `Product ${index + 1}`,
    })),
  }
  structure.subsets = []
  openListsApp(`/lists/${productsList}`, { structure })
}

async function findTable() {
  return screen.findByRole("table", { name: "Items of Products" })
}

describe("a long list of items", () => {
  it("is drawn in full up to 500 rows", async () => {
    openProducts(500)

    const table = await findTable()
    await within(table).findByRole("button", { name: "Rename Product 1" })
    expect(table.querySelectorAll("tbody tr")).toHaveLength(500)
    expect(table).not.toHaveAttribute("aria-rowcount")
    // A table of 500 rows takes jsdom a while to draw.
  }, 20_000)

  it("is drawn a screenful at a time above that, with its size told to assistive technology", async () => {
    openProducts(800)

    const table = within(await findTable())
    expect(await table.findByRole("button", { name: "Rename Product 1" })).toBeVisible()
    const drawn = (await findTable()).querySelectorAll("tbody tr").length
    expect(drawn).toBeGreaterThan(10)
    expect(drawn).toBeLessThan(80)
    expect(await findTable()).toHaveAttribute("aria-rowcount", "801")
    const first = table.getByRole("button", { name: "Rename Product 1" }).closest("tr")
    expect(first).toHaveAttribute("aria-rowindex", "2")
    expect(table.queryByRole("button", { name: "Rename Product 800" })).not.toBeInTheDocument()
  })

  it("brings the rows further down into view as it is scrolled", async () => {
    openProducts(800)
    const table = within(await findTable())
    await table.findByRole("button", { name: "Rename Product 1" })

    const scroller = document.querySelector("[data-slot='table-container']") as HTMLElement
    scroller.scrollTop = 41 * 790
    fireEvent.scroll(scroller)

    expect(await table.findByRole("button", { name: "Rename Product 800" })).toBeVisible()
    expect(table.queryByRole("button", { name: "Rename Product 1" })).not.toBeInTheDocument()
  })

  it("keeps the header and the select-all box when scrolled", async () => {
    openProducts(800)
    const table = within(await findTable())

    expect(await table.findByRole("checkbox", { name: "Select all items" })).toBeVisible()
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "",
      "Name",
      "Code",
    ])
  })
})

describe("the groups of a list with a parent list", () => {
  it("count as rows towards the point where drawing is windowed", async () => {
    mockViewport(900, 400)
    const structure = listsStructure()
    // 250 parents with one child each is 500 rows; one more child makes 501.
    const parents = Array.from({ length: 250 }, (_, index) => ({
      id: `0192f3a0-0000-7000-8000-${String(200000000000 + index)}`,
      name: `Region ${index + 1}`,
    }))
    structure.lists[0] = { ...structure.lists[0], items: parents }
    structure.lists[1] = {
      ...structure.lists[1],
      items: [...parents, parents[0]].map((parent, index) => ({
        id: `0192f3a0-0000-7000-8000-${String(300000000000 + index)}`,
        name: `Country ${index + 1}`,
        parent: parent.id,
      })),
    }
    openListsApp(`/lists/${countriesList}`, { structure })

    const table = await screen.findByRole("table", { name: "Items of Countries" })
    expect(table).toHaveAttribute("aria-rowcount", "502")
    expect(
      within(table).queryByRole("button", { name: "Region 250, 1 item" }),
    ).not.toBeInTheDocument()
  })

  it("leave a short list alone", async () => {
    mockViewport(900, 400)
    openListsApp(`/lists/${regionsList}`)

    expect(await screen.findByRole("table", { name: "Items of Regions" })).not.toHaveAttribute(
      "aria-rowcount",
    )
  })
})
