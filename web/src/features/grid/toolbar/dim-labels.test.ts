import { describe, expect, it } from "vitest"
import { makeModule, makeStructure, productsId, regionsId } from "@/test/structure"
import { cornerLabel, dimLabel } from "./dim-labels"

const structure = makeStructure({
  lists: [
    { id: regionsId, name: "Regions", numbered: false, production_data: false, selective_access: false, items: [] },
    { id: productsId, name: "Products", numbered: false, production_data: false, selective_access: false, items: [] },
  ],
  subsets: [{ id: "s1", name: "Key accounts", list: productsId, items: [] }],
})
const module = makeModule({
  axes: [
    { kind: "list", list: regionsId },
    { kind: "subset", subset: "s1" },
    { kind: "time", level: "month" },
    { kind: "versions" },
  ],
})

describe("dimLabel", () => {
  it("names a dimension the way the module's header does", () => {
    expect(dimLabel({ kind: "line_items" }, module, structure)).toBe("Line items")
    expect(dimLabel({ kind: "list", list: regionsId }, module, structure)).toBe("Regions")
    expect(dimLabel({ kind: "subset", subset: "s1" }, module, structure)).toBe("Key accounts")
    expect(dimLabel({ kind: "time" }, module, structure)).toBe("Time (Month)")
    expect(dimLabel({ kind: "versions" }, module, structure)).toBe("Versions")
  })
})

describe("cornerLabel", () => {
  it("is the rows, a slash and the columns, with the periods of Time named in the plural", () => {
    expect(
      cornerLabel(
        { rows: [{ kind: "list", list: regionsId }], columns: [{ kind: "time" }] },
        module,
        structure,
      ),
    ).toBe("Regions / Months")
  })

  it("lists several dimensions of a side with commas", () => {
    expect(
      cornerLabel(
        {
          rows: [{ kind: "list", list: regionsId }, { kind: "subset", subset: "s1" }],
          columns: [{ kind: "versions" }, { kind: "line_items" }],
        },
        module,
        structure,
      ),
    ).toBe("Regions, Key accounts / Versions, Line items")
  })

  it("has no slash without columns", () => {
    expect(cornerLabel({ rows: [{ kind: "line_items" }], columns: [] }, module, structure)).toBe(
      "Line items",
    )
  })
})
