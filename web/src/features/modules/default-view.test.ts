import { describe, expect, it } from "vitest"
import { makeModule, productsId, regionsId } from "@/test/structure"
import { defaultPivot } from "./default-view"

const lineItems = { kind: "line_items" }

describe("defaultPivot", () => {
  it("puts the line items on the rows and Time on the columns", () => {
    const module = makeModule({
      axes: [
        { kind: "list", list: regionsId },
        { kind: "time", level: "month" },
      ],
    })

    expect(defaultPivot(module)).toEqual({
      module: module.id,
      rows: [lineItems],
      columns: [{ kind: "time" }],
      pages: [{ dim: { kind: "list", list: regionsId }, key: null }],
    })
  })

  it("puts everything else on a page at its default member", () => {
    const module = makeModule({
      axes: [
        { kind: "list", list: regionsId },
        { kind: "list", list: productsId },
        { kind: "time", level: "quarter", range: null },
        { kind: "versions" },
      ],
    })

    expect(defaultPivot(module).pages).toEqual([
      { dim: { kind: "list", list: regionsId }, key: null },
      { dim: { kind: "list", list: productsId }, key: null },
      { dim: { kind: "versions" }, key: null },
    ])
  })

  it("puts the first list on the columns of a module without Time", () => {
    const module = makeModule({
      axes: [
        { kind: "subset", subset: "s1" },
        { kind: "list", list: productsId },
      ],
    })

    expect(defaultPivot(module)).toMatchObject({
      columns: [{ kind: "subset", subset: "s1" }],
      pages: [{ dim: { kind: "list", list: productsId }, key: null }],
    })
  })

  it("has no column or page for a module without dimensions", () => {
    expect(defaultPivot(makeModule({ axes: [] }))).toMatchObject({
      rows: [lineItems],
      columns: [],
      pages: [],
    })
  })
})
