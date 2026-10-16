import { describe, expect, it } from "vitest"
import { completionRange, quoteName } from "./completion"

describe("quoteName", () => {
  it("leaves a name of letters, digits, spaces and _ % # ? as it is", () => {
    expect(quoteName("Margin %")).toBe("Margin %")
    expect(quoteName("Unit count")).toBe("Unit count")
    expect(quoteName("Umsätze")).toBe("Umsätze")
    expect(quoteName("Qty_2? #1")).toBe("Qty_2? #1")
    expect(quoteName("2024 Plan")).toBe("2024 Plan")
  })

  it("quotes a name with any other character", () => {
    expect(quoteName("Profit & Loss")).toBe("'Profit & Loss'")
    expect(quoteName("Q1.Sales")).toBe("'Q1.Sales'")
    expect(quoteName("Cost (net)")).toBe("'Cost (net)'")
  })

  it("quotes a name with a keyword in it, since the keyword would end the name", () => {
    expect(quoteName("IF Flag")).toBe("'IF Flag'")
    expect(quoteName("Profit and Loss")).toBe("'Profit and Loss'")
    expect(quoteName("True")).toBe("'True'")
    expect(quoteName("Android")).toBe("Android")
  })

  it("doubles a quote inside a name", () => {
    expect(quoteName("O'Brien")).toBe("'O''Brien'")
  })

  it("quotes a name the engine would not read back as one name", () => {
    expect(quoteName("2024")).toBe("'2024'")
    expect(quoteName("1e6")).toBe("'1e6'")
    expect(quoteName("Two  spaces")).toBe("'Two  spaces'")
    expect(quoteName(" Padded")).toBe("' Padded'")
    expect(quoteName("")).toBe("''")
  })
})

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
