import { describe, expect, it } from "vitest"
import { completionRange } from "./completion"

describe("completionRange", () => {
  /** The range for the text before a cursor marked `|`. */
  function at(marked: string, explicit = false) {
    const pos = marked.indexOf("|")
    return completionRange(marked.replace("|", ""), pos, explicit)
  }

  it("is the name being typed", () => {
    expect(at("Rev|")).toEqual({ from: 0, prefix: "Rev" })
    expect(at("Revenue * Un|")).toEqual({ from: 10, prefix: "Un" })
    expect(at("Revenue * (Un|")).toEqual({ from: 11, prefix: "Un" })
  })

  it("reads only what comes before the cursor", () => {
    expect(at("Rev|enue + 1")).toEqual({ from: 0, prefix: "Rev" })
  })

  it("joins the words of a name with several", () => {
    expect(at("Revenue * Unit c|")).toEqual({ from: 10, prefix: "Unit c" })
  })

  it("stops at a keyword", () => {
    expect(at("IF Flag|")).toEqual({ from: 3, prefix: "Flag" })
    expect(at("a AND b|")).toEqual({ from: 6, prefix: "b" })
  })

  it("takes the name before a dot with it", () => {
    expect(at("Plan.Un|")).toEqual({ from: 0, prefix: "Plan.Un" })
    expect(at("x + Plan.|")).toEqual({ from: 4, prefix: "Plan." })
    expect(at("Years.20|")).toEqual({ from: 0, prefix: "Years.20" })
  })

  it("takes a quoted name, finished or not", () => {
    expect(at("'Profit & Loss'.|")).toEqual({ from: 0, prefix: "'Profit & Loss'." })
    expect(at("1 + 'Profit & Lo|")).toEqual({ from: 4, prefix: "'Profit & Lo" })
    expect(at("Plan.'Profit & |")).toEqual({ from: 0, prefix: "Plan.'Profit & " })
  })

  it("offers nothing where no name is being typed, unless asked", () => {
    expect(at("Revenue *|")).toBeNull()
    expect(at("Revenue * |")).toBeNull()
    expect(at("(|")).toBeNull()
    expect(at("")).toBeNull()
    expect(at("Revenue * |", true)).toEqual({ from: 10, prefix: "" })
    expect(at("|", true)).toEqual({ from: 0, prefix: "" })
  })

  it("offers nothing after a space that ends a name, unless asked", () => {
    expect(at("Unit |")).toBeNull()
    expect(at("Unit |", true)).toEqual({ from: 0, prefix: "Unit " })
  })

  it("offers nothing while a number is typed", () => {
    expect(at("100|")).toBeNull()
    expect(at("Revenue * 2.5|")).toBeNull()
  })

  it("offers nothing inside text or a comment, even when asked", () => {
    expect(at('"some te|', true)).toBeNull()
    expect(at("Revenue // note|", true)).toBeNull()
  })

  it("offers names again once text is closed", () => {
    expect(at('"text" & Re|')).toEqual({ from: 9, prefix: "Re" })
  })
})
