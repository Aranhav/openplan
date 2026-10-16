import { describe, expect, it } from "vitest"
import { countLines, parseBulkAdd } from "./bulk-add"
import type { ItemDto } from "./types"

const regions: ItemDto[] = [
  { id: "emea", name: "EMEA", code: "R1" },
  { id: "apac", name: "APAC", code: "R2" },
]
const plain = { existing: [] as ItemDto[], numbered: false }

describe("adding items in bulk to a list without a parent list", () => {
  it("makes one item of each line, trimmed, and skips the blank lines", () => {
    const result = parseBulkAdd("  Widgets \n\n\r\nGadgets\n", plain)

    expect(result.errors).toEqual([])
    expect(result.items).toEqual([{ name: "Widgets" }, { name: "Gadgets" }])
    expect(result.lines).toEqual([1, 4])
  })

  it("keeps a comma in the name", () => {
    expect(parseBulkAdd("Acme, Inc", plain).items).toEqual([{ name: "Acme, Inc" }])
  })

  it("refuses a name that is too long, counting characters", () => {
    const long = "é".repeat(81)

    expect(parseBulkAdd(`${"é".repeat(80)}\n${long}`, plain).errors).toEqual([
      { line: 2, message: "Name must be at most 80 characters." },
    ])
  })

  it("refuses a name used before, in the list or on an earlier line, ignoring the case", () => {
    const result = parseBulkAdd("widgets\nGadgets\nGADGETS", {
      existing: [{ id: "1", name: "Widgets" }],
      numbered: false,
    })

    expect(result.errors).toEqual([
      { line: 1, message: "widgets is already in the list." },
      { line: 3, message: "GADGETS is already on line 2." },
    ])
  })

  it("lets a numbered list repeat a name", () => {
    const result = parseBulkAdd("Widgets\nWidgets", {
      existing: [{ id: "1", name: "Widgets" }],
      numbered: true,
    })

    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(2)
  })

  it("has nothing to add, and no error, for an empty text", () => {
    expect(parseBulkAdd(" \n\n", plain)).toEqual({ items: [], lines: [], errors: [] })
  })
})

describe("adding items in bulk to a list with a parent list", () => {
  const options = { ...plain, parents: regions, parentList: "Regions" }

  it("takes the parent from after the last comma, by name or by code", () => {
    const result = parseBulkAdd("France, EMEA\nJapan, apac\nChile, R2\nAcme, Inc, apac", options)

    expect(result.errors).toEqual([])
    expect(result.items).toEqual([
      { name: "France", parent_id: "emea" },
      { name: "Japan", parent_id: "apac" },
      { name: "Chile", parent_id: "apac" },
      { name: "Acme, Inc", parent_id: "apac" },
    ])
  })

  it("matches a code exactly, but a name in any case", () => {
    const result = parseBulkAdd("Chile, r2", options)

    expect(result.errors).toEqual([{ line: 1, message: "r2 is not an item of Regions." }])
  })

  it("prefers a name to a code when a parent item has both", () => {
    const result = parseBulkAdd("X, R1", {
      ...options,
      parents: [
        { id: "a", name: "R1" },
        { id: "b", name: "Other", code: "R1" },
      ],
    })

    expect(result.items).toEqual([{ name: "X", parent_id: "a" }])
  })

  it("says what is wrong with each line that is, and still reads the others", () => {
    const result = parseBulkAdd("France, EMEA\nGermany\nSpain,\n, EMEA\nJapan, Asia", options)

    expect(result.errors).toEqual([
      { line: 2, message: "Add a parent after a comma, as in “Name, Parent”." },
      { line: 3, message: "Add a parent after a comma, as in “Name, Parent”." },
      { line: 4, message: "Name is required." },
      { line: 5, message: "Asia is not an item of Regions." },
    ])
    expect(result.items).toEqual([{ name: "France", parent_id: "emea" }])
  })
})

describe("counting the lines of a text", () => {
  it("skips the blank ones", () => {
    expect(countLines("a\n\n  \nb\r\nc")).toBe(3)
    expect(countLines("")).toBe(0)
  })
})
