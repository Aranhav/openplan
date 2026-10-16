import { describe, expect, it } from "vitest"
import { scan } from "./scan"

/** The kind and text of each token of `text`. */
function kinds(text: string) {
  return scan(text).map((token) => [token.kind, text.slice(token.from, token.to)])
}

describe("scan", () => {
  it("splits a formula into words, numbers, keywords and symbols", () => {
    expect(kinds("IF Unit count > 2.5 THEN Plan.Units(1, 2)")).toEqual([
      ["keyword", "IF"],
      ["word", "Unit"],
      ["word", "count"],
      ["operator", ">"],
      ["number", "2.5"],
      ["keyword", "THEN"],
      ["word", "Plan"],
      ["dot", "."],
      ["word", "Units"],
      ["open", "("],
      ["number", "1"],
      ["comma", ","],
      ["number", "2"],
      ["close", ")"],
    ])
  })

  it("reads text and quoted names whole, with doubled quotes inside", () => {
    expect(kinds(`"a ""b""" & 'O''Brien'`)).toEqual([
      ["string", `"a ""b"""`],
      ["operator", "&"],
      ["quoted", "'O''Brien'"],
    ])
  })

  it("marks text and a quoted name that never ends as open", () => {
    const [text] = scan('"abc')
    expect(text).toMatchObject({ kind: "string", closed: false })
    const [name] = scan("'Profit & Lo")
    expect(name).toMatchObject({ kind: "quoted", closed: false, from: 0, to: 12 })
  })

  it("reads a comment to the end of its line", () => {
    expect(kinds("1 // note\n2")).toEqual([
      ["number", "1"],
      ["comment", "// note"],
      ["number", "2"],
    ])
  })

  it("treats a number next to a dot as a word", () => {
    expect(kinds("Years.2024 + 2024.X")).toEqual([
      ["word", "Years"],
      ["dot", "."],
      ["word", "2024"],
      ["operator", "+"],
      ["word", "2024"],
      ["dot", "."],
      ["word", "X"],
    ])
  })

  it("keeps a word that starts with digits a word", () => {
    expect(kinds("3D + 1e6")).toEqual([
      ["word", "3D"],
      ["operator", "+"],
      ["number", "1e6"],
    ])
  })

  it("reads brackets, colons and symbols the language does not have", () => {
    expect(kinds("A[SUM: B] ^")).toEqual([
      ["word", "A"],
      ["open", "["],
      ["word", "SUM"],
      ["colon", ":"],
      ["word", "B"],
      ["close", "]"],
      ["other", "^"],
    ])
  })
})
