import { describe, expect, it } from "vitest"
import type { MemberRef, RowFilter, ViewDefinition, ViewDim } from "../view-types"
import { type ViewAction, dimKey, fitsModule, isModified, queryOf, reduceView } from "./view-state"

const lineItems: ViewDim = { kind: "line_items" }
const regions: ViewDim = { kind: "list", list: "regions" }
const products: ViewDim = { kind: "list", list: "products" }
const channels: ViewDim = { kind: "subset", subset: "channels" }
const time: ViewDim = { kind: "time" }
const versions: ViewDim = { kind: "versions" }

/** Line items down the rows, Time across, the other dimensions on pages. */
const base: ViewDefinition = {
  rows: [lineItems],
  columns: [time],
  pages: [
    { dim: regions, key: null },
    { dim: products, key: "p1" },
    { dim: versions, key: null },
  ],
}

const emea: MemberRef = { dim: regions, key: "emea" }
const apac: MemberRef = { dim: regions, key: "apac" }
const q1: MemberRef = { dim: time, key: "Q1 FY26" }

describe("moving a dimension", () => {
  it("takes it from its zone and puts it in another, at the end by default", () => {
    const next = reduceView(base, { type: "move", dim: regions, to: "rows" })

    expect(next.rows).toEqual([lineItems, regions])
    expect(next.columns).toEqual([time])
    expect(next.pages?.map((page) => page.dim)).toEqual([products, versions])
  })

  it("puts it at a position, in a zone with other dimensions", () => {
    const wide = reduceView(base, { type: "move", dim: regions, to: "rows" })

    expect(reduceView(wide, { type: "move", dim: products, to: "rows", index: 0 }).rows).toEqual([
      products,
      lineItems,
      regions,
    ])
    expect(reduceView(wide, { type: "move", dim: time, to: "rows", index: 1 }).rows).toEqual([
      lineItems,
      time,
      regions,
    ])
  })

  it("reorders a zone: the position is where the dimension ends up", () => {
    const two = reduceView(base, { type: "move", dim: regions, to: "columns" })
    expect(two.columns).toEqual([time, regions])

    expect(reduceView(two, { type: "move", dim: regions, to: "columns", index: 0 }).columns).toEqual(
      [regions, time],
    )
    expect(reduceView(two, { type: "move", dim: time, to: "columns", index: 1 }).columns).toEqual([
      regions,
      time,
    ])
  })

  it("reorders the pages and keeps the member each shows", () => {
    const next = reduceView(base, { type: "move", dim: products, to: "pages", index: 0 })

    expect(next.pages).toEqual([
      { dim: products, key: "p1" },
      { dim: regions, key: null },
      { dim: versions, key: null },
    ])
  })

  it("puts a dimension that goes to the pages at its default member", () => {
    const next = reduceView(base, { type: "move", dim: time, to: "pages" })

    expect(next.columns).toEqual([])
    expect(next.pages?.at(-1)).toEqual({ dim: time, key: null })
  })

  it("forgets the member of a page that goes to the columns", () => {
    const next = reduceView(base, { type: "move", dim: products, to: "columns" })

    expect(next.columns).toEqual([time, products])
    expect(next.pages?.some((page) => dimKey(page.dim) === dimKey(products))).toBe(false)
  })

  it("can move the line items out of the rows when another dimension is there to stay", () => {
    const next = reduceView(reduceView(base, { type: "move", dim: regions, to: "rows" }), {
      type: "move",
      dim: lineItems,
      to: "pages",
    })

    expect(next.rows).toEqual([regions])
    expect(next.pages?.at(-1)).toEqual({ dim: lineItems, key: null })
  })

  it("keeps the last dimension of the rows where it is", () => {
    expect(reduceView(base, { type: "move", dim: lineItems, to: "columns" })).toBe(base)
    expect(reduceView(base, { type: "move", dim: lineItems, to: "pages" })).toBe(base)
  })

  it("is unchanged when the dimension stays where it is", () => {
    expect(reduceView(base, { type: "move", dim: time, to: "columns" })).toBe(base)
    expect(reduceView(base, { type: "move", dim: time, to: "columns", index: 0 })).toBe(base)
  })

  it("is unchanged for a dimension the view does not have", () => {
    expect(reduceView(base, { type: "move", dim: channels, to: "rows" })).toBe(base)
  })

  it("leaves the filters, hidden and collapsed members, and formats alone", () => {
    const full: ViewDefinition = {
      ...base,
      filters: [{ line_item: "li-1", op: "is_blank" }],
      hidden: [emea],
      collapsed: [q1],
      column_widths: { Jan: 90 },
    }

    expect(reduceView(full, { type: "move", dim: regions, to: "columns" })).toMatchObject({
      filters: full.filters,
      hidden: full.hidden,
      collapsed: full.collapsed,
      column_widths: full.column_widths,
    })
  })
})

describe("swapping rows and columns", () => {
  it("exchanges the two zones", () => {
    const next = reduceView(base, { type: "swap" })

    expect(next.rows).toEqual([time])
    expect(next.columns).toEqual([lineItems])
    expect(next.pages).toEqual(base.pages)
  })

  it("twice is the view that began", () => {
    const back = reduceView(reduceView(base, { type: "swap" }), { type: "swap" })

    expect(back).toEqual(base)
  })

  it("is unchanged when there are no columns to bring to the rows", () => {
    const rowsOnly: ViewDefinition = { ...base, columns: [] }

    expect(reduceView(rowsOnly, { type: "swap" })).toBe(rowsOnly)
  })
})

describe("setting the member of a page", () => {
  it("sets the key of that page only", () => {
    const next = reduceView(base, { type: "set_page", dim: regions, key: "emea" })

    expect(next.pages).toEqual([
      { dim: regions, key: "emea" },
      { dim: products, key: "p1" },
      { dim: versions, key: null },
    ])
  })

  it("goes back to the default member with a null key", () => {
    expect(reduceView(base, { type: "set_page", dim: products, key: null }).pages?.[1]).toEqual({
      dim: products,
      key: null,
    })
  })

  it("is unchanged when the key is the same or the dimension is not a page", () => {
    expect(reduceView(base, { type: "set_page", dim: products, key: "p1" })).toBe(base)
    expect(reduceView(base, { type: "set_page", dim: time, key: "Jan 26" })).toBe(base)
  })
})

describe("summaries", () => {
  it("toggles whether the totals are shown, which is on when the view does not say", () => {
    const off = reduceView(base, { type: "toggle_summaries" })
    expect(off.show_summaries).toBe(false)

    expect(reduceView(off, { type: "toggle_summaries" }).show_summaries).toBe(true)
  })
})

describe("collapsing", () => {
  it("collapses a member and expands it again", () => {
    const collapsed = reduceView(base, { type: "toggle_collapse", member: q1 })
    expect(collapsed.collapsed).toEqual([q1])

    expect(reduceView(collapsed, { type: "toggle_collapse", member: q1 }).collapsed).toEqual([])
  })

  it("tells the same key in another dimension apart", () => {
    const first = reduceView(base, { type: "toggle_collapse", member: { dim: regions, key: "x" } })
    const both = reduceView(first, { type: "toggle_collapse", member: { dim: products, key: "x" } })

    expect(both.collapsed).toHaveLength(2)
  })
})

describe("hiding members", () => {
  it("hides a member and shows it again", () => {
    const hidden = reduceView(base, { type: "hide", member: emea })
    expect(hidden.hidden).toEqual([emea])

    expect(reduceView(hidden, { type: "show", member: emea }).hidden).toEqual([])
  })

  it("hides a member once", () => {
    const hidden = reduceView(base, { type: "hide", member: emea })

    expect(reduceView(hidden, { type: "hide", member: emea })).toBe(hidden)
  })

  it("shows every member of a dimension, or of all of them", () => {
    let hidden = reduceView(base, { type: "hide", member: emea })
    hidden = reduceView(hidden, { type: "hide", member: apac })
    hidden = reduceView(hidden, { type: "hide", member: { dim: products, key: "p2" } })

    expect(reduceView(hidden, { type: "show_all", dim: regions }).hidden).toEqual([
      { dim: products, key: "p2" },
    ])
    expect(reduceView(hidden, { type: "show_all" }).hidden).toEqual([])
  })

  it("is unchanged when there is nothing to show", () => {
    expect(reduceView(base, { type: "show_all" })).toBe(base)
    expect(reduceView(base, { type: "show", member: emea })).toBe(base)
  })
})

describe("filters, formats and widths", () => {
  it("replaces the filters", () => {
    const filters: RowFilter[] = [{ line_item: "li-1", op: "gt", value: { t: "number", v: 5 } }]

    expect(reduceView(base, { type: "set_filters", filters }).filters).toEqual(filters)
    expect(
      reduceView(reduceView(base, { type: "set_filters", filters }), {
        type: "set_filters",
        filters: [],
      }).filters,
    ).toEqual([])
  })

  it("replaces the conditional formats", () => {
    const formats = [
      {
        name: "Losses",
        line_item_ids: [],
        op: "negative" as const,
        style: { color: "red" as const, bold: true },
      },
    ]

    expect(reduceView(base, { type: "set_conditional_formats", formats }).conditional_formats).toEqual(
      formats,
    )
  })

  it("replaces the column widths", () => {
    expect(reduceView(base, { type: "set_column_widths", widths: { Jan: 90 } }).column_widths).toEqual({
      Jan: 90,
    })
  })

  it("replaces the whole view", () => {
    const other: ViewDefinition = { rows: [regions], columns: [], pages: [] }

    expect(reduceView(base, { type: "replace", definition: other })).toBe(other)
  })
})

describe("isModified", () => {
  it("is false for the same view, and when a field is left out or empty", () => {
    expect(isModified(base, base)).toBe(false)
    expect(isModified({ ...base, filters: [], hidden: [] }, base)).toBe(false)
    expect(isModified({ ...base, show_summaries: true }, base)).toBe(false)
    expect(isModified({ ...base, line_items: null }, base)).toBe(false)
    expect(isModified({ ...base, column_widths: {}, conditional_formats: [] }, base)).toBe(false)
  })

  it("does not mind the order of hidden or collapsed members or of column widths", () => {
    const a: ViewDefinition = {
      ...base,
      hidden: [emea, apac],
      collapsed: [q1, emea],
      column_widths: { a: 1, b: 2 },
    }
    const b: ViewDefinition = {
      ...base,
      hidden: [apac, emea],
      collapsed: [emea, q1],
      column_widths: { b: 2, a: 1 },
    }

    expect(isModified(a, b)).toBe(false)
  })

  it("is true when the order of the rows, the pages or the conditional formats differs", () => {
    const wide = reduceView(base, { type: "move", dim: regions, to: "rows" })

    expect(isModified(reduceView(wide, { type: "move", dim: regions, to: "rows", index: 0 }), wide)).toBe(
      true,
    )
    expect(
      isModified(reduceView(base, { type: "move", dim: versions, to: "pages", index: 0 }), base),
    ).toBe(true)
  })

  it("is true for any change a reducer action makes", () => {
    const actions: ViewAction[] = [
      { type: "swap" },
      { type: "set_page", dim: regions, key: "emea" },
      { type: "toggle_summaries" },
      { type: "toggle_collapse", member: q1 },
      { type: "hide", member: emea },
      { type: "set_filters", filters: [{ line_item: "li-1", op: "is_blank" }] },
      { type: "set_column_widths", widths: { Jan: 90 } },
    ]
    for (const action of actions) {
      expect(isModified(reduceView(base, action), base)).toBe(true)
    }
  })
})

describe("queryOf", () => {
  it("is the pivot of the module without the formats and widths, which do not change the cells", () => {
    const query = queryOf("m1", {
      ...base,
      filters: [{ line_item: "li-1", op: "is_blank" }],
      hidden: [emea],
      collapsed: [q1],
      show_summaries: false,
      line_items: ["li-2", "li-1"],
      column_widths: { Jan: 90 },
      conditional_formats: [
        {
          name: "x",
          line_item_ids: [],
          op: "negative",
          style: { color: "red", bold: false },
        },
      ],
    })

    expect(query).toEqual({
      module: "m1",
      rows: base.rows,
      columns: base.columns,
      pages: base.pages,
      filters: [{ line_item: "li-1", op: "is_blank" }],
      hidden: [emea],
      collapsed: [q1],
      show_summaries: false,
      line_items: ["li-2", "li-1"],
    })
  })
})

describe("fitsModule", () => {
  const module = { axes: [{ kind: "list", list: "regions" }, { kind: "time", level: "month" }] }

  it("holds when every dimension of the module is in the view once", () => {
    expect(
      fitsModule(
        { rows: [lineItems], columns: [time], pages: [{ dim: regions, key: null }] },
        module as never,
      ),
    ).toBe(true)
  })

  it("fails for a missing, a doubled or a foreign dimension", () => {
    expect(fitsModule({ rows: [lineItems], columns: [time], pages: [] }, module as never)).toBe(
      false,
    )
    expect(
      fitsModule(
        { rows: [lineItems, time], columns: [time], pages: [{ dim: regions, key: null }] },
        module as never,
      ),
    ).toBe(false)
    expect(
      fitsModule(
        {
          rows: [lineItems],
          columns: [time],
          pages: [
            { dim: regions, key: null },
            { dim: products, key: null },
          ],
        },
        module as never,
      ),
    ).toBe(false)
  })
})

describe("dimKey", () => {
  it("names a dimension by its kind and id", () => {
    expect(dimKey(lineItems)).toBe("line_items")
    expect(dimKey(regions)).toBe("list:regions")
    expect(dimKey(channels)).toBe("subset:channels")
    expect(dimKey(time)).toBe("time")
    expect(dimKey(versions)).toBe("versions")
  })
})
