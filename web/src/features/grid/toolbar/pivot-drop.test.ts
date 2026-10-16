import { describe, expect, it } from "vitest"
import type { ViewDefinition } from "../view-types"
import { dropTarget, movesDim } from "./pivot-drop"

const zones = { rows: ["items", "region"], columns: ["time"], pages: ["version", "product"] }

describe("dropTarget", () => {
  it("puts a dimension dropped on a zone at the end of it", () => {
    expect(dropTarget(zones, "version", "columns")).toEqual({ to: "columns", index: 1 })
    expect(dropTarget(zones, "version", "pages")).toEqual({ to: "pages", index: 1 })
    expect(dropTarget(zones, "time", "pages")).toEqual({ to: "pages", index: 2 })
  })

  it("puts a dimension dropped on another where that one is", () => {
    expect(dropTarget(zones, "time", "region")).toEqual({ to: "rows", index: 1 })
    expect(dropTarget(zones, "product", "version")).toEqual({ to: "pages", index: 0 })
    expect(dropTarget(zones, "items", "region")).toEqual({ to: "rows", index: 1 })
  })

  it("does nothing for a drop on itself or on nothing", () => {
    expect(dropTarget(zones, "time", "time")).toBeUndefined()
    expect(dropTarget(zones, "time", undefined)).toBeUndefined()
    expect(dropTarget(zones, "time", "unknown")).toBeUndefined()
  })
})

describe("movesDim", () => {
  const lineItems = { kind: "line_items" } as const
  const time = { kind: "time" } as const
  const regions = { kind: "list", list: "regions" } as const
  const products = { kind: "list", list: "products" } as const
  const view: ViewDefinition = {
    rows: [lineItems],
    columns: [time],
    pages: [
      { dim: regions, key: null },
      { dim: products, key: null },
    ],
  }

  it("holds for a dimension that ends up in another zone or another place", () => {
    expect(movesDim(view, regions, "columns")).toBe(true)
    expect(movesDim(view, regions, "pages", 1)).toBe(true)
    expect(movesDim(view, products, "pages", 0)).toBe(true)
  })

  it("does not hold for a dimension dropped where it is: the last of its zone, on the zone", () => {
    // The end of the pages is where the last of them is, and dropping it there is no move.
    expect(movesDim(view, products, "pages", 1)).toBe(false)
    expect(movesDim(view, regions, "pages", 0)).toBe(false)
    expect(movesDim(view, time, "columns", 0)).toBe(false)
  })

  it("does not hold for the last dimension of the rows, which stays there", () => {
    expect(movesDim(view, lineItems, "columns")).toBe(false)
    expect(movesDim(view, lineItems, "pages")).toBe(false)
  })
})
