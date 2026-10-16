import { StringStream } from "@codemirror/language"
import { describe, expect, it } from "vitest"
import { formulaParser } from "./language"

/** The tokens of `text` with the class the tokenizer gives each, without the unstyled ones. */
function tokens(text: string): [string, string][] {
  const state = formulaParser.startState?.(2)
  if (!state) {
    throw new Error("the tokenizer has no state")
  }
  const found: [string, string][] = []
  for (const line of text.split("\n")) {
    const stream = new StringStream(line, 2, 2)
    while (!stream.eol()) {
      const style = formulaParser.token(stream, state)
      if (style) {
        found.push([stream.current(), style])
      }
      stream.start = stream.pos
    }
  }
  return found
}

describe("the formula tokenizer", () => {
  it("styles a comment to the end of the line", () => {
    expect(tokens("1 // twelve months")).toEqual([
      ["1", "number"],
      ["// twelve months", "comment"],
    ])
  })

  it("styles text, with a doubled quote inside it", () => {
    expect(tokens('"a ""quoted"" word" & x')).toEqual([
      ['"a ""quoted"" word"', "string"],
      ["&", "operator"],
      ["x", "name"],
    ])
  })

  it("keeps text going over a line break until it is closed", () => {
    expect(tokens('"one\ntwo" + 1')).toEqual([
      ['"one', "string"],
      ['two"', "string"],
      ["+", "operator"],
      ["1", "number"],
    ])
  })

  it("styles a quoted name, with a doubled quote inside it", () => {
    expect(tokens("'Profit & Loss' * 'O''Brien'")).toEqual([
      ["'Profit & Loss'", "quotedName"],
      ["*", "operator"],
      ["'O''Brien'", "quotedName"],
    ])
  })

  it("styles numbers with a fraction or an exponent", () => {
    expect(tokens("12 3.5 1e6 2.5E-3 7e+2")).toEqual([
      ["12", "number"],
      ["3.5", "number"],
      ["1e6", "number"],
      ["2.5E-3", "number"],
      ["7e+2", "number"],
    ])
  })

  it("styles the keywords whatever their case", () => {
    expect(tokens("IF a THEN true ELSE blank")).toEqual([
      ["IF", "keyword"],
      ["a", "name"],
      ["THEN", "keyword"],
      ["true", "keyword"],
      ["ELSE", "keyword"],
      ["blank", "keyword"],
    ])
    expect(tokens("NOT a AND b OR FALSE").map(([, style]) => style)).toEqual([
      "keyword",
      "name",
      "keyword",
      "name",
      "keyword",
      "keyword",
    ])
  })

  it("styles a modifier inside brackets, and the same word elsewhere as a name", () => {
    expect(tokens("Cost[SUM: Map] + Sum")).toEqual([
      ["Cost", "name"],
      ["[", "bracket"],
      ["SUM", "modifier"],
      [":", "punctuation"],
      ["Map", "name"],
      ["]", "bracket"],
      ["+", "operator"],
      ["Sum", "name"],
    ])
    expect(tokens("X[lookup : Y, SELECT: Z.A]").filter(([, style]) => style === "modifier")).toEqual([
      ["lookup", "modifier"],
      ["SELECT", "modifier"],
    ])
  })

  it("styles every modifier kind", () => {
    const kinds = "SUM LOOKUP SELECT AVERAGE MIN MAX ANY ALL FIRSTNONBLANK LASTNONBLANK TEXTLIST"
    for (const kind of kinds.split(" ")) {
      expect(tokens(`X[${kind}: Y]`)[2]).toEqual([kind, "modifier"])
    }
  })

  it("styles a word right before a parenthesis as a function", () => {
    expect(tokens("ROUND(x, 2) + Total (1)")).toEqual([
      ["ROUND", "function"],
      ["(", "bracket"],
      ["x", "name"],
      [",", "punctuation"],
      ["2", "number"],
      [")", "bracket"],
      ["+", "operator"],
      ["Total", "name"],
      ["(", "bracket"],
      ["1", "number"],
      [")", "bracket"],
    ])
  })

  it("keeps IF a keyword before a parenthesis", () => {
    expect(tokens("IF(a)")[0]).toEqual(["IF", "keyword"])
  })

  it("styles the operators", () => {
    const operators = ["+", "-", "*", "/", "&", "=", "<>", "<=", ">=", "<", ">"]
    expect(tokens(operators.join(" "))).toEqual(operators.map((text) => [text, "operator"]))
  })

  it("reads a dotted reference as names, even when a part is a number", () => {
    expect(tokens("Plan.Units + Years.2024 + Time.2024")).toEqual([
      ["Plan", "name"],
      [".", "punctuation"],
      ["Units", "name"],
      ["+", "operator"],
      ["Years", "name"],
      [".", "punctuation"],
      ["2024", "name"],
      ["+", "operator"],
      ["Time", "name"],
      [".", "punctuation"],
      ["2024", "name"],
    ])
  })

  it("reads letters with accents and the characters allowed in a name as part of a name", () => {
    expect(tokens("Umsätze + Margin % + Qty? + Row#")).toEqual([
      ["Umsätze", "name"],
      ["+", "operator"],
      ["Margin", "name"],
      ["%", "name"],
      ["+", "operator"],
      ["Qty?", "name"],
      ["+", "operator"],
      ["Row#", "name"],
    ])
  })

  it("leaves a character the language does not have unstyled", () => {
    expect(tokens("a ^ 2")).toEqual([
      ["a", "name"],
      ["2", "number"],
    ])
  })

  it("starts each parse afresh", () => {
    expect(formulaParser.startState?.(2)).toEqual({ quote: null, brackets: 0, afterDot: false })
  })
})
