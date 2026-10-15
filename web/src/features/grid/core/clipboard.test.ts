import { describe, expect, it } from "vitest"
import { parseTsv, planFillDown, planPaste, toTsv } from "./clipboard"
import type { Selection } from "./selection"

const bounds = { rows: 10, cols: 5 }

function cell(row: number, col: number): Selection {
  return { anchor: { row, col }, focus: { row, col } }
}

function range(from: [number, number], to: [number, number]): Selection {
  return { anchor: { row: from[0], col: from[1] }, focus: { row: to[0], col: to[1] } }
}

describe("toTsv", () => {
  it("joins cells with tabs and rows with newlines", () => {
    expect(
      toTsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a\tb\nc\td")
  })

  it("writes a single cell as plain text", () => {
    expect(toTsv([["1234.5"]])).toBe("1234.5")
  })

  it("keeps empty cells so columns stay aligned", () => {
    expect(toTsv([["a", "", "c"]])).toBe("a\t\tc")
  })

  it("quotes a cell that holds a tab, a newline or a quote", () => {
    expect(toTsv([["a\tb"]])).toBe('"a\tb"')
    expect(toTsv([["line 1\nline 2"]])).toBe('"line 1\nline 2"')
    expect(toTsv([["line 1\r\nline 2"]])).toBe('"line 1\r\nline 2"')
    expect(toTsv([['say "hi"']])).toBe('"say ""hi"""')
  })

  it("leaves a cell with spaces or commas unquoted", () => {
    expect(toTsv([["North America", "1,234.50"]])).toBe("North America\t1,234.50")
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

  it("does not tile a block over a larger selection", () => {
    const plan = planPaste([["a", "b"]], range([0, 0], [3, 3]), bounds)
    expect(plan).toHaveLength(2)
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

  it("has nothing to fill in a single row", () => {
    expect(planFillDown(range([3, 0], [3, 4]))).toEqual([])
    expect(planFillDown(cell(3, 3))).toEqual([])
  })
})
