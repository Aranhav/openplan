import { describe, expect, it } from "vitest"
import { dropTarget } from "./pivot-drop"

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
