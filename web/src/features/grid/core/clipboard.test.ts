import { describe, expect, it } from "vitest"
import { parseTsv, pasteArea, planFillDown, planPaste, toTsv } from "./clipboard"
import type { Selection } from "./selection"

const bounds = { rows: 10, cols: 5 }

function cell(row: number, col: number): Selection {
  return { anchor: { row, col }, focus: { row, col } }
}

function range(from: [number, number], to: [number, number]): Selection {
  return { anchor: { row: from[0], col: from[1] }, focus: { row: to[0], col: to[1] } }
}

describe("toTsv", () => {
  it("joins cells with tabs and ends every row with a newline, as Excel does", () => {
    expect(
      toTsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a\tb\nc\td\n")
  })

  it("writes a single cell as plain text and a newline", () => {
    expect(toTsv([["1234.5"]])).toBe("1234.5\n")
  })

  it("keeps empty cells so columns stay aligned", () => {
    expect(toTsv([["a", "", "c"]])).toBe("a\t\tc\n")
  })

  it("writes a blank cell as a lone newline, so it is not an empty clipboard", () => {
    expect(toTsv([[""]])).toBe("\n")
    expect(toTsv([[""], [""]])).toBe("\n\n")
  })

  it("quotes a cell that holds a tab, a newline or a quote", () => {
    expect(toTsv([["a\tb"]])).toBe('"a\tb"\n')
    expect(toTsv([["line 1\nline 2"]])).toBe('"line 1\nline 2"\n')
    expect(toTsv([["line 1\r\nline 2"]])).toBe('"line 1\r\nline 2"\n')
    expect(toTsv([['say "hi"']])).toBe('"say ""hi"""\n')
  })

  it("leaves a cell with spaces or commas unquoted", () => {
    expect(toTsv([["North America", "1,234.50"]])).toBe("North America\t1,234.50\n")
  })

  it("is empty for no rows", () => {
    expect(toTsv([])).toBe("")
  })
})

describe("parseTsv", () => {
  it("splits rows on newlines and cells on tabs", () => {
    expect(parseTsv("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
  })

  it("reads a single value as one cell", () => {
    expect(parseTsv("42")).toEqual([["42"]])
  })

  it("accepts Windows line endings, which Excel writes", () => {
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
  })

  it("accepts a lone carriage return as a line ending", () => {
    expect(parseTsv("a\rb")).toEqual([["a"], ["b"]])
  })

  it("ignores one trailing newline", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]])
    expect(parseTsv("a\tb\r\n")).toEqual([["a", "b"]])
  })

  it("keeps a blank line before the trailing newline as an empty row", () => {
    expect(parseTsv("a\n\n")).toEqual([["a"], [""]])
  })

  it("reads a lone newline as one empty cell, which is what copying a blank cell leaves", () => {
    expect(parseTsv("\n")).toEqual([[""]])
  })

  it("reads empty text as no rows", () => {
    expect(parseTsv("")).toEqual([])
  })

  it("keeps empty cells in the middle and at the ends", () => {
    expect(parseTsv("a\t\tc")).toEqual([["a", "", "c"]])
    expect(parseTsv("\ta\t")).toEqual([["", "a", ""]])
  })

  it("keeps rows of different lengths as they are", () => {
    expect(parseTsv("a\tb\tc\nd")).toEqual([["a", "b", "c"], ["d"]])
  })

  it("reads a quoted cell with a newline in it as one cell", () => {
    expect(parseTsv('"line 1\nline 2"\tb\nc\td')).toEqual([
      ["line 1\nline 2", "b"],
      ["c", "d"],
    ])
  })

  it("reads a quoted cell with a tab in it as one cell", () => {
    expect(parseTsv('"a\tb"\tc')).toEqual([["a\tb", "c"]])
  })

  it("reads doubled quotes in a quoted cell as one quote", () => {
    expect(parseTsv('"say ""hi"""')).toEqual([['say "hi"']])
  })

  it("reads a quoted cell that ends the text with a trailing newline", () => {
    expect(parseTsv('"a\nb"\n')).toEqual([["a\nb"]])
  })

  it("reads a quoted empty cell", () => {
    expect(parseTsv('""\tb')).toEqual([["", "b"]])
  })

  it("keeps a quote in the middle of an unquoted cell", () => {
    expect(parseTsv('5" pipe\tb')).toEqual([['5" pipe', "b"]])
  })

  it("keeps text after a closing quote instead of dropping it", () => {
    expect(parseTsv('"abc"def\tb')).toEqual([["abcdef", "b"]])
  })

  it("takes the rest as one cell when a quote is never closed", () => {
    expect(parseTsv('"abc\tdef\nghi')).toEqual([["abc\tdef\nghi"]])
  })

  it("reads back what toTsv wrote", () => {
    const rows = [
      ["plain", 'has "quotes"', "tab\there"],
      ["multi\nline", "", "end"],
    ]
    expect(parseTsv(toTsv(rows))).toEqual(rows)
  })

  it.each([
    [[["a"], [""]]],
    [[[""]]],
    [[[""], [""]]],
    [[["", ""]]],
    [[["a", ""], ["", "b"], ["", ""]]],
    [[["", "x"], [""]]],
    [[["tail"], ["\n"], [""]]],
  ])("reads back blank cells in %j", (rows) => {
    expect(parseTsv(toTsv(rows))).toEqual(rows)
  })
})

describe("parseTsv with a limit", () => {
  const text = "a\tb\tc\nd\te\tf\ng\th\ti\n"

  it("reads only the rows and columns that can land", () => {
    expect(parseTsv(text, { rows: 2, cols: 2, cells: 100 })).toEqual([
      ["a", "b"],
      ["d", "e"],
    ])
  })

  it("reads everything when the limit is larger", () => {
    expect(parseTsv(text, { rows: 10, cols: 10, cells: 100 })).toEqual(parseTsv(text))
  })

  it("stops after the last row, however long the text goes on", () => {
    const long = "x\n".repeat(100_000)

    expect(parseTsv(long, { rows: 3, cols: 1, cells: 100 })).toEqual([["x"], ["x"], ["x"]])
  })

  it("keeps a quoted cell that holds line breaks whole", () => {
    expect(parseTsv('"a\nb"\tc\nd\te\n', { rows: 2, cols: 1, cells: 100 })).toEqual([
      ["a\nb"],
      ["d"],
    ])
  })

  it("does not limit when there is no limit", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]])
  })

  describe("by cells", () => {
    it("stops at the row where the rows times the widest row come to more than the limit", () => {
      const rows = parseTsv("a\tb\tc\n".repeat(1_000), { rows: 1_000, cols: 3, cells: 10 })

      // Three rows of three are nine cells, four are twelve.
      expect(rows).toHaveLength(4)
    })

    it("reads a block of exactly the limit whole", () => {
      const rows = parseTsv("a\tb\tc\n".repeat(3), { rows: 1_000, cols: 3, cells: 9 })

      expect(rows).toHaveLength(3)
    })

    it("counts every row as wide as the widest, since a ragged block is a rectangle", () => {
      const ragged = "a\nb\nc\td\te\nf\ng\nh\n".repeat(100)

      // After the third row the widest is 3: four rows of three come to 12.
      expect(parseTsv(ragged, { rows: 1_000, cols: 5, cells: 10 })).toHaveLength(4)
    })

    it("counts the cells that are kept, not the ones past the column limit", () => {
      const wide = "a\tb\tc\td\te\tf\n".repeat(1_000)

      expect(parseTsv(wide, { rows: 1_000, cols: 2, cells: 10 })).toHaveLength(6)
    })

    it("stops in a text with a million rows without reading on", () => {
      const huge = "x\ty\n".repeat(1_000_000)

      expect(parseTsv(huge, { rows: 2_000_000, cols: 2, cells: 10_000 })).toHaveLength(5_001)
    })

    it("keeps the last row of a text that has no final line break", () => {
      expect(parseTsv("a\tb\nc\td", { rows: 10, cols: 2, cells: 100 })).toEqual([
        ["a", "b"],
        ["c", "d"],
      ])
    })
  })
})

describe("planPaste", () => {
  it("anchors a block at the top left of the selection", () => {
    const plan = planPaste(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      cell(2, 1),
      bounds,
    )
    expect(plan).toEqual([
      { pos: { row: 2, col: 1 }, raw: "a" },
      { pos: { row: 2, col: 2 }, raw: "b" },
      { pos: { row: 3, col: 1 }, raw: "c" },
      { pos: { row: 3, col: 2 }, raw: "d" },
    ])
  })

  it("anchors at the top left even when the selection was dragged upward and leftward", () => {
    const plan = planPaste([["a", "b"]], range([4, 3], [2, 1]), bounds)
    expect(plan.map((edit) => edit.pos)).toEqual([
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ])
  })

  describe("when the selection is a whole number of copies of the block", () => {
    it("repeats the block across the selection in both directions", () => {
      const plan = planPaste([["a", "b"]], range([0, 0], [3, 3]), bounds)
      expect(plan).toHaveLength(16)
      expect(plan.slice(0, 4)).toEqual([
        { pos: { row: 0, col: 0 }, raw: "a" },
        { pos: { row: 0, col: 1 }, raw: "b" },
        { pos: { row: 0, col: 2 }, raw: "a" },
        { pos: { row: 0, col: 3 }, raw: "b" },
      ])
      expect(plan[15]).toEqual({ pos: { row: 3, col: 3 }, raw: "b" })
    })

    it("repeats a taller block down a taller selection", () => {
      const grid = [
        ["a", "b"],
        ["c", "d"],
      ]
      const plan = planPaste(grid, range([1, 1], [4, 2]), bounds)
      expect(plan.map((edit) => [edit.pos.row, edit.pos.col, edit.raw])).toEqual([
        [1, 1, "a"],
        [1, 2, "b"],
        [2, 1, "c"],
        [2, 2, "d"],
        [3, 1, "a"],
        [3, 2, "b"],
        [4, 1, "c"],
        [4, 2, "d"],
      ])
    })

    it("pastes once when the selection is exactly the size of the block", () => {
      const plan = planPaste([["a", "b"]], range([2, 1], [2, 2]), bounds)
      expect(plan).toEqual([
        { pos: { row: 2, col: 1 }, raw: "a" },
        { pos: { row: 2, col: 2 }, raw: "b" },
      ])
    })

    it("cuts the repeats off at the grid's last row and column", () => {
      const plan = planPaste([["a", "b"]], range([8, 3], [11, 4]), bounds)
      expect(plan.map((edit) => [edit.pos.row, edit.pos.col, edit.raw])).toEqual([
        [8, 3, "a"],
        [8, 4, "b"],
        [9, 3, "a"],
        [9, 4, "b"],
      ])
    })

    it("skips the cells a short row of a ragged block does not have", () => {
      const plan = planPaste([["a", "b", "c"], ["d"]], range([0, 0], [1, 2]), bounds)
      expect(plan.map((edit) => edit.raw)).toEqual(["a", "b", "c", "d"])
    })
  })

  describe("when the selection is not a whole number of copies of the block", () => {
    it("pastes the block once at the top left", () => {
      expect(planPaste([["a", "b"]], range([0, 0], [0, 2]), bounds)).toEqual([
        { pos: { row: 0, col: 0 }, raw: "a" },
        { pos: { row: 0, col: 1 }, raw: "b" },
      ])
    })

    it("pastes once when only one direction divides evenly", () => {
      const grid = [
        ["a", "b"],
        ["c", "d"],
      ]
      expect(planPaste(grid, range([0, 0], [3, 2]), bounds)).toHaveLength(4)
      expect(planPaste(grid, range([0, 0], [2, 1]), bounds)).toHaveLength(4)
    })
  })

  it("fills a larger selection with a single value", () => {
    const plan = planPaste([["7"]], range([1, 1], [2, 3]), bounds)
    expect(plan).toEqual([
      { pos: { row: 1, col: 1 }, raw: "7" },
      { pos: { row: 1, col: 2 }, raw: "7" },
      { pos: { row: 1, col: 3 }, raw: "7" },
      { pos: { row: 2, col: 1 }, raw: "7" },
      { pos: { row: 2, col: 2 }, raw: "7" },
      { pos: { row: 2, col: 3 }, raw: "7" },
    ])
  })

  it("fills a dragged-backward selection with a single value", () => {
    const plan = planPaste([["7"]], range([2, 2], [1, 1]), bounds)
    expect(plan.map((edit) => edit.pos)).toEqual([
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ])
  })

  it("puts a single value in a single selected cell", () => {
    expect(planPaste([["7"]], cell(3, 3), bounds)).toEqual([{ pos: { row: 3, col: 3 }, raw: "7" }])
  })

  it("clips a block that runs past the last row or column", () => {
    const plan = planPaste(
      [
        ["a", "b", "c"],
        ["d", "e", "f"],
        ["g", "h", "i"],
      ],
      cell(8, 3),
      bounds,
    )
    expect(plan).toEqual([
      { pos: { row: 8, col: 3 }, raw: "a" },
      { pos: { row: 8, col: 4 }, raw: "b" },
      { pos: { row: 9, col: 3 }, raw: "d" },
      { pos: { row: 9, col: 4 }, raw: "e" },
    ])
  })

  it("follows each row's own length when rows are ragged", () => {
    const plan = planPaste([["a", "b", "c"], ["d"]], cell(0, 0), bounds)
    expect(plan.map((edit) => edit.raw)).toEqual(["a", "b", "c", "d"])
  })

  it("plans nothing for an empty clipboard", () => {
    expect(planPaste([], cell(0, 0), bounds)).toEqual([])
  })

  it("plans nothing when the grid has no cells", () => {
    expect(planPaste([["a"]], cell(0, 0), { rows: 0, cols: 0 })).toEqual([])
  })

  it("clips a single-value fill to the grid", () => {
    const plan = planPaste([["7"]], range([8, 3], [12, 8]), bounds)
    expect(plan.map((edit) => edit.pos)).toEqual([
      { row: 8, col: 3 },
      { row: 8, col: 4 },
      { row: 9, col: 3 },
      { row: 9, col: 4 },
    ])
  })
})

describe("pasteArea", () => {
  const block = [
    ["a", "b"],
    ["c", "d"],
  ]

  it.each([
    ["a block at a cell", block, cell(2, 1)],
    ["a block tiled over a selection", block, range([0, 0], [3, 3])],
    ["a block that does not tile", block, range([0, 0], [2, 2])],
    ["a block clipped by the grid", block, cell(9, 4)],
    ["a single value over a selection", [["7"]], range([1, 1], [5, 3])],
    ["a single value clipped by the grid", [["7"]], range([8, 3], [12, 8])],
    ["an empty clipboard", [], cell(0, 0)],
  ])("counts the cells of %s as planPaste places them", (_name, grid, selection) => {
    expect(pasteArea(grid, selection, bounds)).toBe(planPaste(grid, selection, bounds).length)
  })

  it("counts without planning, so a selection of millions of cells is cheap to refuse", () => {
    const huge = range([0, 0], [9_999, 399])
    expect(pasteArea([["7"]], huge, { rows: 10_000, cols: 400 })).toBe(4_000_000)
  })

  it("counts the rectangle, whatever the rows of a ragged block hold", () => {
    expect(pasteArea([["a", "b", "c"], ["d"]], cell(0, 0), bounds)).toBe(6)
  })

  it("is zero when the grid has no cells", () => {
    expect(pasteArea([["a"]], cell(0, 0), { rows: 0, cols: 0 })).toBe(0)
  })
})

describe("planFillDown", () => {
  it("copies the top row of each column into the rows below", () => {
    expect(planFillDown(range([2, 1], [4, 2]))).toEqual([
      { from: { row: 2, col: 1 }, to: { row: 3, col: 1 } },
      { from: { row: 2, col: 2 }, to: { row: 3, col: 2 } },
      { from: { row: 2, col: 1 }, to: { row: 4, col: 1 } },
      { from: { row: 2, col: 2 }, to: { row: 4, col: 2 } },
    ])
  })

  it("uses the top of the range when the selection was dragged upward", () => {
    expect(planFillDown(range([4, 1], [2, 1]))).toEqual([
      { from: { row: 2, col: 1 }, to: { row: 3, col: 1 } },
      { from: { row: 2, col: 1 }, to: { row: 4, col: 1 } },
    ])
  })

  it("copies the row above into a single selected row, column by column", () => {
    expect(planFillDown(range([3, 1], [3, 3]))).toEqual([
      { from: { row: 2, col: 1 }, to: { row: 3, col: 1 } },
      { from: { row: 2, col: 2 }, to: { row: 3, col: 2 } },
      { from: { row: 2, col: 3 }, to: { row: 3, col: 3 } },
    ])
  })

  it("copies the cell above into a single selected cell", () => {
    expect(planFillDown(cell(3, 3))).toEqual([
      { from: { row: 2, col: 3 }, to: { row: 3, col: 3 } },
    ])
  })

  it("has nothing to copy from above the first row", () => {
    expect(planFillDown(cell(0, 2))).toEqual([])
    expect(planFillDown(range([0, 0], [0, 4]))).toEqual([])
  })

  it("still copies the top row of a taller selection that starts at the first row", () => {
    expect(planFillDown(range([0, 1], [1, 1]))).toEqual([
      { from: { row: 0, col: 1 }, to: { row: 1, col: 1 } },
    ])
  })
})
