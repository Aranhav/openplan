import { describe, expect, it } from "vitest"
import { makeStructure, productsId, regionsId, structure } from "@/test/structure"
import {
  type Axis,
  WHOLE_CALENDAR,
  axesOf,
  axesValues,
  dimensionOptions,
  ownAxes,
  ownKeys,
  sameAxes,
} from "./axes"

const regions: Axis = { kind: "list", list: regionsId }
const products: Axis = { kind: "list", list: productsId }
const month: Axis = { kind: "time", level: "month", range: null }

describe("dimensionOptions", () => {
  it("offers the lists and then the subsets, naming the list a subset belongs to", () => {
    const withSubset = makeStructure({
      lists: structure.lists,
      subsets: [{ id: "s1", name: "Top regions", list: regionsId, items: [] }],
    })

    expect(dimensionOptions(withSubset)).toEqual([
      { key: `list:${regionsId}`, name: "Regions", kind: "List" },
      { key: `list:${productsId}`, name: "Products", kind: "List" },
      { key: "subset:s1", name: "Top regions", kind: "Subset of Regions" },
    ])
  })

  it("is empty for a model without lists", () => {
    expect(dimensionOptions(makeStructure())).toEqual([])
  })
})

describe("keys and axes of lists and subsets", () => {
  it("turns axes into keys and back, keeping the order", () => {
    const axes: Axis[] = [products, { kind: "subset", subset: "s1" }, regions]

    expect(ownKeys(axes)).toEqual([`list:${productsId}`, "subset:s1", `list:${regionsId}`])
    expect(ownAxes(ownKeys(axes))).toEqual(axes)
  })

  it("leaves out Time and Versions", () => {
    expect(ownKeys([regions, month, { kind: "versions" }])).toEqual([`list:${regionsId}`])
  })
})

describe("axesValues and axesOf", () => {
  it("reads the dimensions of a module into form values", () => {
    expect(
      axesValues([regions, { kind: "time", level: "quarter", range: "r1" }, { kind: "versions" }]),
    ).toEqual({
      dimensions: [`list:${regionsId}`],
      time: true,
      time_level: "quarter",
      time_range: "r1",
      versions: true,
    })
  })

  it("starts a module without Time at the month level and the whole calendar", () => {
    expect(axesValues([regions])).toMatchObject({
      time: false,
      time_level: "month",
      time_range: WHOLE_CALENDAR,
      versions: false,
    })
  })

  it("puts lists and subsets first, then Time, then Versions, whatever order they came in", () => {
    const values = axesValues([{ kind: "versions" }, month, products, regions])

    expect(axesOf(values)).toEqual([products, regions, month, { kind: "versions" }])
  })

  it("has no time range for the whole calendar", () => {
    expect(axesOf({ ...axesValues([month]), time_range: WHOLE_CALENDAR })).toEqual([
      { kind: "time", level: "month", range: null },
    ])
  })

  it("has no Time or Versions axis when they are off", () => {
    expect(axesOf({ ...axesValues([regions, month]), time: false })).toEqual([regions])
  })
})

describe("sameAxes", () => {
  it("is true for the same dimensions in the same order", () => {
    expect(sameAxes([regions, products], [regions, products])).toBe(true)
  })

  it("is false when two lists swap places", () => {
    expect(sameAxes([regions, products], [products, regions])).toBe(false)
  })

  it("does not mind where Time and Versions are listed", () => {
    expect(
      sameAxes([month, { kind: "versions" }, regions], [regions, month, { kind: "versions" }]),
    ).toBe(true)
  })

  it("does not tell a missing time range from the whole calendar", () => {
    expect(sameAxes([{ kind: "time", level: "month" }], [month])).toBe(true)
  })

  it("is false when the time level changes", () => {
    expect(sameAxes([month], [{ kind: "time", level: "year", range: null }])).toBe(false)
  })
})
