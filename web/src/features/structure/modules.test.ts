import { describe, expect, it } from "vitest"
import { makeLineItem, makeModule, makeStructure } from "@/test/structure"
import { groupModules, lineItemCounts, lineItemsOf } from "./modules"

const a = makeModule({ id: "a", name: "A" })
const b = makeModule({ id: "b", name: "B", functional_area: "Sales" })
const c = makeModule({ id: "c", name: "C", functional_area: "finance" })
const d = makeModule({ id: "d", name: "D", functional_area: "Sales" })
const e = makeModule({ id: "e", name: "E", functional_area: "  " })

describe("groupModules", () => {
  it("puts the modules outside any functional area first, as they were", () => {
    expect(groupModules([e, a]).ungrouped).toEqual([e, a])
  })

  it("makes a group of each functional area, in alphabetical order whatever the case", () => {
    expect(groupModules([b, c, d]).areas.map((area) => area.name)).toEqual(["finance", "Sales"])
  })

  it("keeps the modules of an area in the order they came in", () => {
    expect(groupModules([d, a, b]).areas).toEqual([{ name: "Sales", modules: [d, b] }])
  })

  it("is empty without modules", () => {
    expect(groupModules([])).toEqual({ ungrouped: [], areas: [] })
  })
})

describe("lineItemsOf", () => {
  const first = makeLineItem({ id: "x1", module: "a", ordinal: 0 })
  const second = makeLineItem({ id: "x2", module: "a", ordinal: 1 })
  const other = makeLineItem({ id: "x3", module: "b", ordinal: 0 })

  it("lists the line items of the module by ordinal, whatever order the structure holds", () => {
    const structure = makeStructure({ line_items: [second, other, first] })

    expect(lineItemsOf(structure, "a")).toEqual([first, second])
  })

  it("keeps line items with the same ordinal in the order the structure holds them", () => {
    const twin = makeLineItem({ id: "x4", module: "a", ordinal: 1 })

    expect(lineItemsOf(makeStructure({ line_items: [second, twin] }), "a")).toEqual([second, twin])
  })

  it("is empty for a module without line items", () => {
    expect(lineItemsOf(makeStructure({ line_items: [first] }), "b")).toEqual([])
  })
})

describe("lineItemCounts", () => {
  it("counts the line items of each module", () => {
    const structure = makeStructure({
      line_items: [
        makeLineItem({ id: "x1", module: "a" }),
        makeLineItem({ id: "x2", module: "a" }),
        makeLineItem({ id: "x3", module: "b" }),
      ],
    })

    expect(lineItemCounts(structure)).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
    )
  })
})
