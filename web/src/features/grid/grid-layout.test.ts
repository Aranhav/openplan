import { describe, expect, it } from "vitest"
import { header, member } from "@/test/view-query"
import {
  columnAt,
  columnKey,
  columnSpans,
  defaultRowHeaderWidth,
  lineItemIdAt,
  lineItemSource,
  prefixSums,
  revealOffset,
  startsRowGroup,
  without,
} from "./grid-layout"
import type { Header, PageMember, ViewDim } from "./view-types"

const lineItems: ViewDim = { kind: "line_items" }
const time: ViewDim = { kind: "time" }
const versions: ViewDim = { kind: "versions" }

describe("columnKey", () => {
  it("joins the member keys of the header", () => {
    expect(columnKey(header(member("v1", "Actual"), member("Jan 26", "Jan 26")))).toBe("v1|Jan 26")
  })
})

describe("defaultRowHeaderWidth", () => {
  it.each([
    [0, 0],
    [1, 240],
    [2, 160],
    [3, 106],
  ])("gives each of %s row dimensions %s px", (count, width) => {
    expect(defaultRowHeaderWidth(count)).toBe(width)
  })
})

describe("without", () => {
  it("copies a record without one key and leaves the original alone", () => {
    const widths = { a: 100, b: 200 }

    expect(without(widths, "a")).toEqual({ b: 200 })
    expect(without({ 0: 50, 1: 60 }, 1)).toEqual({ 0: 50 })
    expect(without(widths, "missing")).toEqual(widths)
    expect(widths).toEqual({ a: 100, b: 200 })
  })
})

describe("prefixSums", () => {
  it("lists where each size starts, with the total last", () => {
    expect(prefixSums([120, 80, 100])).toEqual([0, 120, 200, 300])
    expect(prefixSums([])).toEqual([0])
  })
})

describe("columnAt", () => {
  const starts = prefixSums([120, 80, 100])

  it("finds the column that holds a position", () => {
    expect(columnAt(starts, 0)).toBe(0)
    expect(columnAt(starts, 119)).toBe(0)
    expect(columnAt(starts, 120)).toBe(1)
    expect(columnAt(starts, 199)).toBe(1)
    expect(columnAt(starts, 200)).toBe(2)
    expect(columnAt(starts, 299)).toBe(2)
  })

  it("clamps a position outside the columns to the first or last", () => {
    expect(columnAt(starts, -50)).toBe(0)
    expect(columnAt(starts, 5000)).toBe(2)
  })

  it("answers the first column when there are none", () => {
    expect(columnAt([0], 40)).toBe(0)
  })
})

describe("columnSpans", () => {
  const columns: Header[] = [
    header(member("v1", "Actual"), member("Jan", "Jan")),
    header(member("v1", "Actual"), member("Feb", "Feb")),
    header(member("v2", "Budget"), member("Jan", "Jan")),
    header(member("v2", "Budget"), member("Feb", "Feb")),
  ]
  const at = (j: number) => columns[j]

  it("merges adjacent columns that share a member under the same parents", () => {
    const spans = columnSpans([0, 1, 2, 3], at, 0)

    expect(spans.map((s) => [s.start, s.end, s.member?.label])).toEqual([
      [0, 1, "Actual"],
      [2, 3, "Budget"],
    ])
  })

  it("does not merge the same member under different parents", () => {
    const spans = columnSpans([0, 1, 2, 3], at, 1)

    expect(spans.map((s) => [s.start, s.end, s.member?.label])).toEqual([
      [0, 0, "Jan"],
      [1, 1, "Feb"],
      [2, 2, "Jan"],
      [3, 3, "Feb"],
    ])
  })

  it("covers only the columns it is given and splits at a gap", () => {
    const spans = columnSpans([1, 2, 3], at, 0)

    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [1, 1],
      [2, 3],
    ])
    expect(columnSpans([0, 1, 3], at, 0).map((s) => [s.start, s.end])).toEqual([
      [0, 1],
      [3, 3],
    ])
  })

  it("gives a column whose header is not loaded a span of its own, without a member", () => {
    const spans = columnSpans([0, 1, 2], (j) => (j === 1 ? undefined : columns[j]), 0)

    expect(spans.map((s) => [s.start, s.end, s.member?.label])).toEqual([
      [0, 0, "Actual"],
      [1, 1, undefined],
      [2, 2, "Budget"],
    ])
  })

  it("is empty for no columns", () => {
    expect(columnSpans([], at, 0)).toEqual([])
  })
})

describe("startsRowGroup", () => {
  const apac = header(member("apac", "APAC"), member("p1", "Widgets"))
  const apacTwo = header(member("apac", "APAC"), member("p2", "Gadgets"))
  const emea = header(member("emea", "EMEA"), member("p1", "Widgets"))

  it("is true for the first row", () => {
    expect(startsRowGroup(undefined, apac, 0)).toBe(true)
  })

  it("is false while the members up to the level repeat", () => {
    expect(startsRowGroup(apac, apacTwo, 0)).toBe(false)
  })

  it("is true once a member up to the level changes", () => {
    expect(startsRowGroup(apac, emea, 0)).toBe(true)
    expect(startsRowGroup(apac, apacTwo, 1)).toBe(true)
  })

  it("is true for the same member under a different parent", () => {
    expect(startsRowGroup(apac, emea, 1)).toBe(true)
  })
})

describe("lineItemIdAt", () => {
  const rowHeader = header(member("li-1", "Revenue"), member("p1", "Widgets"))
  const colHeader = header(member("v1", "Actual"), member("Jan", "Jan"))

  it("reads the line item from the row header when line items are on the rows", () => {
    const source = lineItemSource([lineItems, time], [versions], [])

    expect(lineItemIdAt(source, rowHeader, colHeader)).toBe("li-1")
  })

  it("reads it from the column header when line items are on the columns", () => {
    const source = lineItemSource([versions], [time, lineItems], [])

    expect(
      lineItemIdAt(
        source,
        header(member("v1", "Actual")),
        header(member("Jan", "Jan"), member("li-2", "Costs")),
      ),
    ).toBe("li-2")
  })

  it("reads it from the page when line items are a page dimension", () => {
    const pages: PageMember[] = [{ dim: lineItems, member: member("li-3", "Margin") }]
    const source = lineItemSource([versions], [time], pages)

    expect(lineItemIdAt(source, header(member("v1", "Actual")), header(member("Jan", "Jan")))).toBe(
      "li-3",
    )
  })

  it("is undefined while the header is not loaded", () => {
    const source = lineItemSource([lineItems], [time], [])

    expect(lineItemIdAt(source, undefined, colHeader)).toBeUndefined()
  })
})

describe("revealOffset", () => {
  it("stays put when the range is in view", () => {
    expect(revealOffset({ start: 300, end: 400 }, 200, 400, 100)).toBe(200)
  })

  it("scrolls back until the range clears the sticky headers", () => {
    expect(revealOffset({ start: 250, end: 350 }, 200, 400, 100)).toBe(150)
  })

  it("scrolls forward until the range end is in view", () => {
    expect(revealOffset({ start: 550, end: 650 }, 200, 400, 100)).toBe(250)
  })

  it("lines a range wider than the viewport up with its start", () => {
    expect(revealOffset({ start: 500, end: 1500 }, 0, 400, 100)).toBe(400)
  })

  it("never scrolls before the start", () => {
    expect(revealOffset({ start: 100, end: 200 }, 300, 400, 100)).toBe(0)
  })
})
