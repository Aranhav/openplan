import { describe, expect, it } from "vitest"
import { makeStructure } from "@/test/structure"
import { blockedByChildren, blockedMessage } from "./hierarchy"

const structure = makeStructure({
  lists: [
    {
      id: "regions",
      name: "Regions",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [
        { id: "emea", name: "EMEA" },
        { id: "apac", name: "APAC" },
      ],
    },
    {
      id: "countries",
      name: "Countries",
      parent: "regions",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [
        { id: "fr", name: "France", parent: "emea" },
        { id: "de", name: "Germany", parent: "emea" },
        { id: "jp", name: "Japan", parent: "apac" },
      ],
    },
    {
      id: "offices",
      name: "Offices",
      parent: "regions",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [{ id: "lon", name: "London", parent: "emea" }],
    },
    {
      id: "products",
      name: "Products",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [],
    },
  ],
})

describe("the items that cannot be deleted yet", () => {
  it("are the ones with items of a child list under them, counted for each child list", () => {
    expect(blockedByChildren(structure, "regions", new Set(["emea"]))).toEqual([
      { itemId: "emea", list: "Countries", count: 2 },
      { itemId: "emea", list: "Offices", count: 1 },
    ])
  })

  it("leave out the items nothing hangs from", () => {
    expect(blockedByChildren(structure, "countries", new Set(["fr"]))).toEqual([])
    expect(blockedByChildren(structure, "products", new Set(["x"]))).toEqual([])
  })
})

describe("the words about them", () => {
  const names = new Map([
    ["emea", "EMEA"],
    ["apac", "APAC"],
  ])

  it("name the first item and say how many more there are", () => {
    const blockers = [
      { itemId: "emea", list: "Countries", count: 2 },
      { itemId: "apac", list: "Countries", count: 1 },
    ]

    expect(blockedMessage(blockers.slice(0, 1), names)).toBe(
      "EMEA still has 2 child items in Countries. Delete those first.",
    )
    expect(blockedMessage(blockers, names)).toBe(
      "EMEA still has 2 child items in Countries, and 1 more selected item has child items. Delete those first.",
    )
  })
})

describe("the items that cannot be deleted yet, among many", () => {
  it("are found in one pass, in the order they were chosen", () => {
    const many = makeStructure({
      lists: [
        {
          ...structure.lists[0],
          items: Array.from({ length: 20_000 }, (_, i) => ({ id: `r${i}`, name: `R${i}` })),
        },
        {
          ...structure.lists[1],
          items: Array.from({ length: 20_000 }, (_, i) => ({
            id: `c${i}`,
            name: `C${i}`,
            parent: `r${i}`,
          })),
        },
      ],
    })
    const ids = new Set(Array.from({ length: 20_000 }, (_, i) => `r${19_999 - i}`))
    const started = performance.now()
    const blockers = blockedByChildren(many, "regions", ids)

    expect(blockers).toHaveLength(20_000)
    expect(blockers[0].itemId).toBe("r19999")
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
