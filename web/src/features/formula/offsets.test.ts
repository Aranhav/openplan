import { describe, expect, it } from "vitest"
import { byteToUtf16, formulaSpan, utf16ToByte } from "./offsets"

describe("byteToUtf16", () => {
  it("is the identity on ASCII", () => {
    expect(byteToUtf16("Revenue * 2", 0)).toBe(0)
    expect(byteToUtf16("Revenue * 2", 7)).toBe(7)
    expect(byteToUtf16("Revenue * 2", 11)).toBe(11)
  })

  it("counts a two-byte letter once", () => {
    // "Umsätze" is 8 bytes (ä takes two) and 7 UTF-16 units.
    expect(byteToUtf16("Umsätze + Foo", 8)).toBe(7)
    expect(byteToUtf16("Umsätze + Foo", 11)).toBe(10)
  })

  it("counts an emoji as two UTF-16 units and four bytes", () => {
    const text = '"🙂" & Foo'
    expect(byteToUtf16(text, 1)).toBe(1)
    expect(byteToUtf16(text, 5)).toBe(3)
    expect(byteToUtf16(text, 6)).toBe(4)
    expect(byteToUtf16(text, 12)).toBe(text.length)
  })

  it("stops at the end of the text for an offset past it", () => {
    expect(byteToUtf16("ab", 99)).toBe(2)
  })

  it("rounds an offset inside a character up to its end", () => {
    expect(byteToUtf16("ä", 1)).toBe(1)
  })
})

describe("utf16ToByte", () => {
  it("is the inverse of byteToUtf16 at character boundaries", () => {
    const text = 'Umsätze + "🙂" & x'
    let index = 0
    for (const character of text) {
      expect(byteToUtf16(text, utf16ToByte(text, index))).toBe(index)
      index += character.length
    }
    expect(byteToUtf16(text, utf16ToByte(text, text.length))).toBe(text.length)
  })

  it("measures bytes", () => {
    expect(utf16ToByte("Umsätze", 7)).toBe(8)
    expect(utf16ToByte("🙂x", 2)).toBe(4)
    expect(utf16ToByte("abc", 99)).toBe(3)
  })

  it("counts a character that the index falls inside as a whole", () => {
    expect(utf16ToByte("🙂", 1)).toBe(4)
  })
})

describe("formulaSpan", () => {
  it("is the text between two byte offsets", () => {
    expect(formulaSpan("Umsätze + Revnue", 11, 17)).toBe("Revnue")
  })
})
