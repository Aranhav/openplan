import { describe, expect, it } from "vitest"
import { enclosingCall } from "./signature"

/** The call around a cursor marked `|`. */
function at(marked: string) {
  return enclosingCall(marked.replace("|", ""), marked.indexOf("|"))
}

describe("enclosingCall", () => {
  it("is the function whose parentheses the cursor is in, with the argument it is at", () => {
    expect(at("ROUND(|")).toEqual({ name: "ROUND", from: 0, argument: 0 })
    expect(at("ROUND(a|")).toEqual({ name: "ROUND", from: 0, argument: 0 })
    expect(at("1 + ROUND(a, |")).toEqual({ name: "ROUND", from: 4, argument: 1 })
    expect(at("ROUND(a, b, |")).toEqual({ name: "ROUND", from: 0, argument: 2 })
  })

  it("is the innermost call", () => {
    expect(at("MAX(x, SUM(a|")).toMatchObject({ name: "SUM", argument: 0 })
    expect(at("MAX(x, SUM(a), |")).toMatchObject({ name: "MAX", argument: 2 })
  })

  it("looks through parentheses that only group", () => {
    expect(at("ROUND(a, (b + c|")).toMatchObject({ name: "ROUND", argument: 1 })
    expect(at("ROUND((a, b), |")).toMatchObject({ name: "ROUND", argument: 1 })
  })

  it("does not count commas in text, quoted names, comments or modifiers", () => {
    expect(at('ROUND("a,b", |')).toMatchObject({ argument: 1 })
    expect(at("ROUND('a,b', |")).toMatchObject({ argument: 1 })
    expect(at("ROUND(X[SUM: A, LOOKUP: B], |")).toMatchObject({ argument: 1 })
  })

  it("is none outside a call", () => {
    expect(at("ROUND(a)|")).toBeNull()
    expect(at("ROUND(a), |")).toBeNull()
    expect(at("(a + |")).toBeNull()
    expect(at("Revenue|")).toBeNull()
  })

  it("is none for a keyword or a name apart from its parenthesis", () => {
    expect(at("IF(a|")).toBeNull()
    expect(at("Total (1|")).toBeNull()
  })
})
