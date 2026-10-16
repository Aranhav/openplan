import { describe, expect, it } from "vitest"
import { header, member } from "@/test/view-query"
import {
  collapsibleMembers,
  columnAt,
  columnKey,
  columnSpans,
  defaultRowHeaderWidth,
  lineItemIdAt,
  lineItemSource,
  prefixSums,
  revealOffset,
  rowHeaderWidthsFor,
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

describe("rowHeaderWidthsFor", () => {
  const plain = { maxDepth: 0, collapsible: false }

  it("gives each dimension what its widest label needs, with the padding of a header", () => {
    expect(rowHeaderWidthsFor([{ ...plain, labelWidth: 100 }])).toEqual([120])
  })

  it("adds the steps of a hierarchy and the room of a chevron", () => {
    expect(
      rowHeaderWidthsFor([{ maxDepth: 2, collapsible: true, labelWidth: 100 }]),
    ).toEqual([100 + 16 + 2 * 16 + 26 + 4])
  })

  it("keeps a dimension between the least and the most a header is given", () => {
    expect(rowHeaderWidthsFor([{ ...plain, labelWidth: 10 }, { ...plain, labelWidth: 900 }])).toEqual([
      96, 320,
    ])
  })

  it("gives the last dimension what the name in the corner needs besides", () => {
    const dims = [
      { ...plain, labelWidth: 10 },
      { ...plain, labelWidth: 10 },
    ]

    expect(rowHeaderWidthsFor(dims, 300)).toEqual([96, 204])
    expect(rowHeaderWidthsFor(dims, 100)).toEqual([96, 96])
  })

  it("fits 'United Kingdom' under a chevron where the shared budget of two dimensions did not", () => {
    // 107 px of label under one step and a chevron: 16 + 16 + 26 + 107 + 4.
    const [width] = rowHeaderWidthsFor([{ maxDepth: 1, collapsible: true, labelWidth: 107 }])

    expect(width).toBeGreaterThan(defaultRowHeaderWidth(2))
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

describe("collapsibleMembers", () => {
  const regions: ViewDim = { kind: "list", list: "regions" }
  const products: ViewDim = { kind: "list", list: "products" }

  const top = member("top", "All Regions", { depth: 0, is_summary: true, has_children: true })
  const emea = member("emea", "EMEA", { depth: 1, has_children: true })
  const uk = member("uk", "United Kingdom", { depth: 2 })
  const fr = member("fr", "France", { depth: 2 })
  const apac = member("apac", "APAC", { depth: 1, has_children: true })
  const jp = member("jp", "Japan", { depth: 2 })
  // Parent first, as the server lists a list with its summaries.
  const tree = [top, emea, uk, fr, apac, jp]
  const treeAt = (index: number) => (tree[index] ? header(tree[index]) : undefined)

  const labels = (found: ReturnType<typeof collapsibleMembers>) =>
    found.map((entry) => `${entry.level}:${entry.member.key}:${entry.own ? "own" : "above"}`)

  it("finds the members above a leaf of a list, nearest first", () => {
    expect(labels(collapsibleMembers([regions], 2, tree.length, treeAt))).toEqual([
      "0:emea:above",
      "0:top:above",
    ])
  })

  it("does not take the parents of another branch", () => {
    expect(labels(collapsibleMembers([regions], 5, tree.length, treeAt))).toEqual([
      "0:apac:above",
      "0:top:above",
    ])
  })

  it("puts the member of the header itself first, when it has children", () => {
    expect(labels(collapsibleMembers([regions], 1, tree.length, treeAt))).toEqual([
      "0:emea:own",
      "0:top:above",
    ])
    expect(labels(collapsibleMembers([regions], 0, tree.length, treeAt))).toEqual(["0:top:own"])
  })

  const jan = member("Jan 26", "Jan 26", { depth: 0 })
  const feb = member("Feb 26", "Feb 26", { depth: 0 })
  const q1 = member("Q1 FY26", "Q1 FY26", { depth: 1, is_summary: true, has_children: true })
  const apr = member("Apr 26", "Apr 26", { depth: 0 })
  const q2 = member("Q2 FY26", "Q2 FY26", { depth: 1, is_summary: true, has_children: true })
  const h1 = member("H1 FY26", "H1 FY26", { depth: 2, is_summary: true, has_children: true })
  // Summary after its children, as the server lists time with its summaries.
  const months = [jan, feb, q1, apr, q2, h1]
  const monthAt = (index: number) => (months[index] ? header(months[index]) : undefined)

  it("finds the summaries that come after a period of time", () => {
    expect(labels(collapsibleMembers([time], 0, months.length, monthAt))).toEqual([
      "0:Q1 FY26:above",
      "0:H1 FY26:above",
    ])
    expect(labels(collapsibleMembers([time], 3, months.length, monthAt))).toEqual([
      "0:Q2 FY26:above",
      "0:H1 FY26:above",
    ])
  })

  it("finds the member of a summary itself and the summaries above it", () => {
    expect(labels(collapsibleMembers([time], 2, months.length, monthAt))).toEqual([
      "0:Q1 FY26:own",
      "0:H1 FY26:above",
    ])
  })

  it("looks at every dimension of the header, the innermost first", () => {
    const rows = tree.flatMap((region) => [header(region, member("p1", "Widget"))])
    const found = collapsibleMembers([regions, products], 2, rows.length, (i) => rows[i])

    expect(labels(found)).toEqual(["0:emea:above", "0:top:above"])
    const own = collapsibleMembers([regions, products], 1, rows.length, (i) => rows[i])
    expect(labels(own)[0]).toBe("0:emea:own")
  })

  it("stays within the members of the outer dimensions", () => {
    const rows = [
      header(member("a", "A"), top),
      header(member("a", "A"), emea),
      header(member("a", "A"), uk),
      header(member("b", "B"), top),
      header(member("b", "B"), emea),
      header(member("b", "B"), uk),
    ]
    const flat: ViewDim = { kind: "list", list: "flat" }

    const found = collapsibleMembers([flat, regions], 3, rows.length, (i) => rows[i])

    expect(labels(found)).toEqual(["1:top:own"])
    expect(labels(collapsibleMembers([flat, regions], 5, rows.length, (i) => rows[i]))).toEqual([
      "1:emea:above",
      "1:top:above",
    ])
  })

  it("offers nothing for a dimension with no hierarchy", () => {
    const flat = [header(member("v1", "Actual")), header(member("v2", "Budget"))]

    expect(collapsibleMembers([versions], 1, 2, (i) => flat[i])).toEqual([])
    expect(collapsibleMembers([lineItems], 0, 2, (i) => flat[i])).toEqual([])
  })

  it("stops at a header that has not loaded", () => {
    const loaded = (index: number) => (index >= 2 ? treeAt(index) : undefined)

    expect(labels(collapsibleMembers([regions], 2, tree.length, loaded))).toEqual([])
  })

  it("offers nothing for a header that has not loaded", () => {
    expect(collapsibleMembers([regions], 2, tree.length, () => undefined)).toEqual([])
  })

  it("lists a collapsed member as it is, to expand", () => {
    const collapsed = member("emea", "EMEA", { depth: 1, has_children: true, collapsed: true })
    const rows = [top, collapsed]

    const found = collapsibleMembers([regions], 1, rows.length, (i) => header(rows[i]))

    expect(found[0].member.collapsed).toBe(true)
  })
})
