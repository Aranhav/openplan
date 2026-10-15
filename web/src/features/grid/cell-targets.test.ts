import { describe, expect, it } from "vitest"
import {
  header,
  lineItem,
  lineItemsDim,
  member,
  numberCell,
  productsList,
  versionsDim,
} from "@/test/view-query"
import { type CellReader, cellKey, cellLabel, cellTarget } from "./cell-targets"
import type { Cell, Header, LineItemInfo, PageMember, ViewDim } from "./view-types"

const timeDim: ViewDim = { kind: "time" }
const regionsList: ViewDim = { kind: "list", list: "list-regions" }

type Layout = {
  rowDims: ViewDim[]
  columnDims: ViewDim[]
  pages?: PageMember[]
  lineItems: LineItemInfo[]
  rowHeader: Header
  colHeader: Header
  cell?: Cell | undefined
}

function reader({
  rowDims,
  columnDims,
  pages = [],
  lineItems,
  rowHeader,
  colHeader,
  cell,
}: Layout) {
  return {
    rowDims,
    columnDims,
    pages,
    lineItems: new Map(lineItems.map((item) => [item.id, item])),
    rowHeaders: (row: number) => (row === 0 ? rowHeader : undefined),
    colHeaders: (col: number) => (col === 0 ? colHeader : undefined),
    cell: (row: number, col: number) => (row === 0 && col === 0 ? cell : undefined),
  } satisfies CellReader
}

const sales = lineItem("li-sales", "Sales", { dims: [productsList, timeDim, versionsDim] })

describe("cellTarget", () => {
  it("takes the coordinates from the row, column and page members, in the line item's axis order", () => {
    const view = reader({
      rowDims: [productsList, lineItemsDim],
      columnDims: [timeDim],
      pages: [{ dim: versionsDim, member: member("v-budget", "Budget") }],
      lineItems: [sales],
      rowHeader: header(member("p-1", "Widget"), member("li-sales", "Sales")),
      colHeader: header(member("Jan 26", "Jan 26")),
      cell: numberCell(5),
    })

    const target = cellTarget(view, 0, 0)

    expect(target).toMatchObject({ coords: ["p-1", "Jan 26", "v-budget"], editable: true })
    expect(target?.lineItem).toBe(sales)
  })

  it("follows the line item's axis order, not the view's", () => {
    const reversed = lineItem("li-r", "Reversed", { dims: [versionsDim, productsList] })
    const view = reader({
      rowDims: [productsList],
      columnDims: [versionsDim, lineItemsDim],
      lineItems: [reversed],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("v-actual", "Actual"), member("li-r", "Reversed")),
      cell: numberCell(1),
    })

    expect(cellTarget(view, 0, 0)?.coords).toEqual(["v-actual", "p-1"])
  })

  it("finds the line item on a page", () => {
    const view = reader({
      rowDims: [productsList],
      columnDims: [timeDim],
      pages: [
        { dim: lineItemsDim, member: member("li-sales", "Sales") },
        { dim: versionsDim, member: member("v-actual", "Actual") },
      ],
      lineItems: [sales],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("Feb 26", "Feb 26")),
      cell: numberCell(2),
    })

    expect(cellTarget(view, 0, 0)).toMatchObject({
      coords: ["p-1", "Feb 26", "v-actual"],
      editable: true,
    })
  })

  it("skips dimensions the line item does not have, as the cell broadcasts over them", () => {
    const flat = lineItem("li-flat", "Headcount", { dims: [productsList] })
    const view = reader({
      rowDims: [productsList],
      columnDims: [versionsDim, lineItemsDim],
      lineItems: [flat],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("v-actual", "Actual"), member("li-flat", "Headcount")),
      cell: numberCell(1),
    })

    expect(cellTarget(view, 0, 0)?.coords).toEqual(["p-1"])
  })

  it("has no coordinates for a line item without dimensions, and still edits it", () => {
    const single = lineItem("li-one", "Rate", { dims: [] })
    const view = reader({
      rowDims: [lineItemsDim],
      columnDims: [versionsDim],
      lineItems: [single],
      rowHeader: header(member("li-one", "Rate")),
      colHeader: header(member("v-actual", "Actual")),
      cell: numberCell(1),
    })

    expect(cellTarget(view, 0, 0)).toMatchObject({ coords: [], editable: true })
  })

  it("matches a list by its id and a subset by its id", () => {
    const bySubset = lineItem("li-s", "By subset", { dims: [{ kind: "subset", subset: "s1" }] })
    const view = reader({
      rowDims: [{ kind: "subset", subset: "s1" }, regionsList],
      columnDims: [lineItemsDim],
      lineItems: [bySubset],
      rowHeader: header(member("item-9", "Nine"), member("r-1", "EMEA")),
      colHeader: header(member("li-s", "By subset")),
      cell: numberCell(1),
    })

    expect(cellTarget(view, 0, 0)?.coords).toEqual(["item-9"])
  })

  it("cannot be edited when the view has no dimension of the line item", () => {
    const view = reader({
      rowDims: [regionsList],
      columnDims: [lineItemsDim],
      lineItems: [lineItem("li-x", "By product", { dims: [productsList] })],
      rowHeader: header(member("r-1", "EMEA")),
      colHeader: header(member("li-x", "By product")),
      cell: numberCell(1),
    })

    expect(cellTarget(view, 0, 0)).toMatchObject({ coords: undefined, editable: false })
  })

  it.each([
    ["a calculated cell", ["calculated", "readonly"]],
    ["a summary", ["summary", "readonly"]],
    ["a switchover cell", ["switchover", "readonly"]],
    ["a cell that is not applicable", ["na", "readonly"]],
    ["an error cell", ["error", "readonly"]],
    ["a cell that is only marked read-only", ["readonly"]],
    ["a cell that is only marked not applicable", ["na"]],
  ] as const)("cannot be edited for %s", (_name, flags) => {
    const view = reader({
      rowDims: [productsList],
      columnDims: [lineItemsDim],
      lineItems: [lineItem("li-a", "A", { dims: [productsList] })],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("li-a", "A")),
      cell: numberCell(1, [...flags]),
    })

    expect(cellTarget(view, 0, 0)).toMatchObject({ editable: false })
  })

  it("is absent while the cell, a header or the line item has not loaded", () => {
    const base = {
      rowDims: [productsList],
      columnDims: [lineItemsDim],
      lineItems: [lineItem("li-a", "A", { dims: [productsList] })],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("li-a", "A")),
      cell: numberCell(1),
    }

    expect(cellTarget(reader({ ...base, cell: undefined }), 0, 0)).toBeUndefined()
    expect(cellTarget(reader(base), 0, 1)).toBeUndefined()
    expect(cellTarget(reader(base), 1, 0)).toBeUndefined()
    expect(cellTarget(reader({ ...base, lineItems: [] }), 0, 0)).toBeUndefined()
  })
})

describe("cellKey", () => {
  it("names a cell by its line item and coordinates", () => {
    expect(cellKey("li-1", ["p-1", "Jan 26"])).toBe("li-1|p-1|Jan 26")
    expect(cellKey("li-1", [])).toBe("li-1")
  })

  it("tells cells of different line items apart", () => {
    expect(cellKey("li-1", ["p-1"])).not.toBe(cellKey("li-2", ["p-1"]))
  })
})

describe("cellLabel", () => {
  it("names the line item, then the members of the row and of the column", () => {
    const view = reader({
      rowDims: [productsList, regionsList],
      columnDims: [versionsDim, lineItemsDim, timeDim],
      lineItems: [sales],
      rowHeader: header(member("p-1", "Widget"), member("r-1", "EMEA")),
      colHeader: header(
        member("v-1", "Budget"),
        member("li-sales", "Sales"),
        member("Jan 26", "Jan 26"),
      ),
      cell: numberCell(5),
    })

    expect(cellLabel(view, 0, 0)).toBe("Sales, Widget, EMEA, Budget, Jan 26")
  })

  it("takes the line item from a row header", () => {
    const view = reader({
      rowDims: [lineItemsDim],
      columnDims: [timeDim],
      lineItems: [sales],
      rowHeader: header(member("li-sales", "Sales")),
      colHeader: header(member("Jan 26", "Jan 26")),
      cell: numberCell(5),
    })

    expect(cellLabel(view, 0, 0)).toBe("Sales, Jan 26")
  })

  it("has nothing to name a cell that has not loaded", () => {
    const view = reader({
      rowDims: [productsList],
      columnDims: [lineItemsDim],
      lineItems: [sales],
      rowHeader: header(member("p-1", "Widget")),
      colHeader: header(member("li-sales", "Sales")),
    })

    expect(cellLabel(view, 0, 0)).toBeUndefined()
  })
})
