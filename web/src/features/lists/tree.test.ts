import { describe, expect, it } from "vitest"
import { buildRows, matchesQuery } from "./tree"
import type { ItemDto } from "./types"

const emea: ItemDto = { id: "emea", name: "EMEA" }
const apac: ItemDto = { id: "apac", name: "APAC" }
const france: ItemDto = { id: "fr", name: "France", code: "FR", parent_id: "emea" }
const germany: ItemDto = { id: "de", name: "Germany", code: "DE", parent_id: "emea" }
const japan: ItemDto = { id: "jp", name: "Japan", code: "JP", parent_id: "apac" }

describe("the rows of a list", () => {
  it("are the items themselves for a list without a parent list", () => {
    const rows = buildRows({ items: [emea, apac], collapsed: new Set() })

    expect(rows).toEqual([
      { kind: "item", key: "item:emea", item: emea },
      { kind: "item", key: "item:apac", item: apac },
    ])
  })

  it("put the items of each parent item under a row for it, in the order of the parent list", () => {
    const rows = buildRows({
      items: [japan, france, germany],
      parents: [emea, apac],
      collapsed: new Set(),
    })

    expect(
      rows.map((row) => (row.kind === "group" ? `group ${row.parent.name}` : row.item.name)),
    ).toEqual(["group EMEA", "France", "Germany", "group APAC", "Japan"])
    expect(rows[0]).toMatchObject({ kind: "group", key: "group:emea", count: 2, collapsed: false })
  })

  it("keep a parent item without items as a row of its own", () => {
    const rows = buildRows({ items: [france], parents: [emea, apac], collapsed: new Set() })

    expect(rows).toContainEqual(expect.objectContaining({ kind: "group", count: 0 }))
  })

  it("leave out the items of a folded group but still count them", () => {
    const rows = buildRows({
      items: [france, germany, japan],
      parents: [emea, apac],
      collapsed: new Set(["emea"]),
    })

    expect(rows.map((row) => row.key)).toEqual(["group:emea", "group:apac", "item:jp"])
    expect(rows[0]).toMatchObject({ count: 2, collapsed: true })
  })

  it("end with the items whose parent is not in the parent list", () => {
    const stray: ItemDto = { id: "xx", name: "Stray", parent_id: "gone" }
    const rows = buildRows({ items: [stray, france], parents: [emea], collapsed: new Set() })

    expect(rows.map((row) => row.key)).toEqual(["group:emea", "item:fr", "item:xx"])
  })

  describe("when filtered", () => {
    it("keep the items whose name or code holds the text, whatever its case", () => {
      const byName = buildRows({ items: [france, germany], collapsed: new Set(), query: "GERM" })
      const byCode = buildRows({ items: [france, germany], collapsed: new Set(), query: "fr" })

      expect(byName.map((row) => row.key)).toEqual(["item:de"])
      expect(byCode.map((row) => row.key)).toEqual(["item:fr"])
    })

    it("keep only the groups that hold a match, counting just the matches", () => {
      const rows = buildRows({
        items: [france, germany, japan],
        parents: [emea, apac],
        collapsed: new Set(),
        query: "ger",
      })

      expect(rows.map((row) => row.key)).toEqual(["group:emea", "item:de"])
      expect(rows[0]).toMatchObject({ count: 1 })
    })

    it("treat a blank text as no filter", () => {
      const rows = buildRows({ items: [france, germany], collapsed: new Set(), query: "  " })

      expect(rows).toHaveLength(2)
    })
  })
})

describe("matching an item", () => {
  it("ignores the case and looks at the name and the code", () => {
    expect(matchesQuery(france, "ance")).toBe(true)
    expect(matchesQuery(france, "fr")).toBe(true)
    expect(matchesQuery(france, "xyz")).toBe(false)
    expect(matchesQuery(emea, "emea")).toBe(true)
  })
})
