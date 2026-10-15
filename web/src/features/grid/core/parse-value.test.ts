import { describe, expect, it } from "vitest"
import { numberFormat } from "@/test/number-format"
import { copyText, editText } from "./format-value"
import { parseInput, type ParseContext } from "./parse-value"
import type { Format, PeriodLevel, Value } from "./types"

const NORTH = "0198f0aa-0000-7000-8000-00000000000a"
const SOUTH = "0198f0aa-0000-7000-8000-00000000000b"

const ctx: ParseContext = {
  itemsByName: new Map([
    ["north america", NORTH],
    ["south america", SOUTH],
  ]),
  itemsByCode: new Map([
    ["na", NORTH],
    ["sa", SOUTH],
  ]),
  periodsByLabel: new Map<string, [PeriodLevel, number]>([
    ["jan 26", ["month", 0]],
    ["feb 26", ["month", 1]],
    ["q1 fy26", ["quarter", 0]],
    ["fy26", ["year", 0]],
    ["total", ["all", 0]],
  ]),
}

const plain = numberFormat()
const eur = numberFormat({ unit: { type: "currency", code: "EUR" } })
const usd = numberFormat({ unit: { type: "currency", code: "USD" } })
const percent = numberFormat({ unit: { type: "percent" } })

function numberOf(raw: string, format: Format = plain) {
  const result = parseInput(raw, format, ctx)
  if (!result.ok) {
    throw new Error(`expected a number from '${raw}' but got: ${result.message}`)
  }
  return result.value
}

function messageOf(raw: string, format: Format) {
  const result = parseInput(raw, format, ctx)
  if (result.ok) {
    throw new Error(`expected '${raw}' to be refused but got: ${JSON.stringify(result.value)}`)
  }
  return result.message
}

describe("parseInput numbers", () => {
  it("reads plain and decimal numbers", () => {
    expect(numberOf("42")).toEqual({ t: "number", v: 42 })
    expect(numberOf("1234.5")).toEqual({ t: "number", v: 1234.5 })
    expect(numberOf(".5")).toEqual({ t: "number", v: 0.5 })
    expect(numberOf("5.")).toEqual({ t: "number", v: 5 })
  })

  it("ignores spaces around the number", () => {
    expect(numberOf("  42  ")).toEqual({ t: "number", v: 42 })
  })

  it("treats non-breaking spaces like spaces, as Excel and web pages put them", () => {
    const nbsp = "\u00a0"
    expect(numberOf(`${nbsp}12${nbsp}`)).toEqual({ t: "number", v: 12 })
    expect(numberOf(`€${nbsp}12`, eur)).toEqual({ t: "number", v: 12 })
    expect(numberOf(`12${nbsp}EUR`, eur)).toEqual({ t: "number", v: 12 })
    expect(numberOf(`12${nbsp}%`)).toEqual({ t: "number", v: 0.12 })
    expect(numberOf(`(${nbsp}12${nbsp})`)).toEqual({ t: "number", v: -12 })
  })

  it("refuses a space or a non-breaking space inside the number", () => {
    expect(messageOf("1 234", plain)).toBe("'1 234' isn't a number.")
    expect(messageOf("1\u00a0234", plain)).toBe("'1\u00a0234' isn't a number.")
  })

  it("accepts thousands separators", () => {
    expect(numberOf("1,234")).toEqual({ t: "number", v: 1234 })
    expect(numberOf("1,234.50")).toEqual({ t: "number", v: 1234.5 })
    expect(numberOf("12,345,678.9")).toEqual({ t: "number", v: 12345678.9 })
  })

  it("reads a sign", () => {
    expect(numberOf("-12")).toEqual({ t: "number", v: -12 })
    expect(numberOf("+12")).toEqual({ t: "number", v: 12 })
    expect(numberOf("−12")).toEqual({ t: "number", v: -12 })
  })

  it("reads parentheses as a negative number", () => {
    expect(numberOf("(1,234.50)")).toEqual({ t: "number", v: -1234.5 })
    expect(numberOf("(12)")).toEqual({ t: "number", v: -12 })
    expect(numberOf(" ( 12 ) ")).toEqual({ t: "number", v: -12 })
  })

  it("reads a negative zero as zero", () => {
    expect(numberOf("-0")).toEqual({ t: "number", v: 0 })
    expect(numberOf("(0)")).toEqual({ t: "number", v: 0 })
  })

  it("takes an empty entry as the blank, zero", () => {
    expect(numberOf("")).toEqual({ t: "number", v: 0 })
    expect(numberOf("   ")).toEqual({ t: "number", v: 0 })
  })

  describe("percent", () => {
    it("divides by one hundred", () => {
      expect(numberOf("25%")).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("-25%")).toEqual({ t: "number", v: -0.25 })
      expect(numberOf("(25%)")).toEqual({ t: "number", v: -0.25 })
      expect(numberOf("12.5 %")).toEqual({ t: "number", v: 0.125 })
    })

    it("does so for any number format", () => {
      expect(numberOf("25%", plain)).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("25%", eur)).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("25%", percent)).toEqual({ t: "number", v: 0.25 })
    })

    it("does not add floating point noise", () => {
      expect(numberOf("33.3%")).toEqual({ t: "number", v: 0.333 })
      expect(numberOf("7%")).toEqual({ t: "number", v: 0.07 })
    })

    it("takes a bare number as typed in a format that is not a percentage", () => {
      expect(numberOf("25", plain)).toEqual({ t: "number", v: 25 })
      expect(numberOf("25", eur)).toEqual({ t: "number", v: 25 })
    })
  })

  describe("in a percent format, where numbers are percent points", () => {
    it("reads a bare number as percent points", () => {
      expect(numberOf("25", percent)).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("12.5", percent)).toEqual({ t: "number", v: 0.125 })
      expect(numberOf("1,250", percent)).toEqual({ t: "number", v: 12.5 })
      expect(numberOf("33.3", percent)).toEqual({ t: "number", v: 0.333 })
      expect(numberOf("7", percent)).toEqual({ t: "number", v: 0.07 })
    })

    it("reads negative percent points", () => {
      expect(numberOf("-25", percent)).toEqual({ t: "number", v: -0.25 })
      expect(numberOf("(25)", percent)).toEqual({ t: "number", v: -0.25 })
    })

    it("reads a number with a percent sign the same way, dividing only once", () => {
      expect(numberOf("25%", percent)).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("25 %", percent)).toEqual({ t: "number", v: 0.25 })
      expect(numberOf("-25%", percent)).toEqual({ t: "number", v: -0.25 })
      expect(numberOf("(25%)", percent)).toEqual({ t: "number", v: -0.25 })
    })

    it("reads zero and an empty entry as zero", () => {
      expect(numberOf("0", percent)).toEqual({ t: "number", v: 0 })
      expect(numberOf("", percent)).toEqual({ t: "number", v: 0 })
    })

    it("refuses a percent sign given twice", () => {
      expect(messageOf("25%%", percent)).toBe("'25%%' isn't a number.")
    })
  })

  describe("currency", () => {
    it("accepts the currency symbol in front", () => {
      expect(numberOf("€12", eur)).toEqual({ t: "number", v: 12 })
      expect(numberOf("€ 1,234.50", eur)).toEqual({ t: "number", v: 1234.5 })
      expect(numberOf("$12", usd)).toEqual({ t: "number", v: 12 })
    })

    it("accepts the currency code after the number, in any case", () => {
      expect(numberOf("12 EUR", eur)).toEqual({ t: "number", v: 12 })
      expect(numberOf("12EUR", eur)).toEqual({ t: "number", v: 12 })
      expect(numberOf("1,234.50 eur", eur)).toEqual({ t: "number", v: 1234.5 })
    })

    it("accepts the code in front and the symbol behind, which people also type", () => {
      expect(numberOf("EUR 12", eur)).toEqual({ t: "number", v: 12 })
      expect(numberOf("12€", eur)).toEqual({ t: "number", v: 12 })
    })

    it("accepts a sign on either side of the symbol", () => {
      expect(numberOf("-€1,234.50", eur)).toEqual({ t: "number", v: -1234.5 })
      expect(numberOf("€-1,234.50", eur)).toEqual({ t: "number", v: -1234.5 })
      expect(numberOf("-12 EUR", eur)).toEqual({ t: "number", v: -12 })
    })

    it("accepts parentheses around the symbol", () => {
      expect(numberOf("(€1,234.50)", eur)).toEqual({ t: "number", v: -1234.5 })
      expect(numberOf("(12 EUR)", eur)).toEqual({ t: "number", v: -12 })
    })

    it("accepts a percentage in a currency format", () => {
      expect(numberOf("10%", usd)).toEqual({ t: "number", v: 0.1 })
    })

    it("accepts a plain number too", () => {
      expect(numberOf("1,234.50", eur)).toEqual({ t: "number", v: 1234.5 })
    })

    it("refuses another currency's symbol or code", () => {
      expect(messageOf("$12", eur)).toBe("'$12' isn't a number.")
      expect(messageOf("12 USD", eur)).toBe("'12 USD' isn't a number.")
    })

    it("refuses a currency symbol in a format without a currency", () => {
      expect(messageOf("€12", plain)).toBe("'€12' isn't a number.")
      expect(messageOf("12 EUR", percent)).toBe("'12 EUR' isn't a number.")
    })

    it("refuses a currency marker given twice", () => {
      expect(messageOf("€12 EUR", eur)).toBe("'€12 EUR' isn't a number.")
    })
  })

  describe("refusals", () => {
    it("names the text that is not a number", () => {
      expect(messageOf("abc", plain)).toBe("'abc' isn't a number.")
      expect(messageOf("12abc", plain)).toBe("'12abc' isn't a number.")
    })

    it("quotes the entry without its surrounding spaces", () => {
      expect(messageOf("  abc  ", plain)).toBe("'abc' isn't a number.")
    })

    it.each([
      "1,23",
      "1,2345",
      ",5",
      "1,,234",
      "1.2.3",
      "--5",
      "+-5",
      "(5",
      "5)",
      "((5))",
      "(-5)",
      "-(5)",
      "-",
      "%",
      "()",
      "1e3",
      "NaN",
      "Infinity",
      "0x10",
      "1 000",
    ])("refuses '%s'", (raw) => {
      expect(parseInput(raw, plain, ctx).ok).toBe(false)
    })

    it("refuses a number too large to store", () => {
      expect(messageOf("9".repeat(400), plain)).toMatch(/isn't a number\.$/)
    })

    it("shortens a very long entry in the message", () => {
      const message = messageOf("x".repeat(200), plain)
      expect(message.length).toBeLessThan(80)
      expect(message).toBe(`'${"x".repeat(40)}…' isn't a number.`)
    })
  })
})

describe("parseInput booleans", () => {
  const format: Format = { type: "boolean" }

  it.each(["TRUE", "true", "True", "1", "yes", "YES", "Yes", " true "])(
    "reads '%s' as true",
    (raw) => {
      expect(parseInput(raw, format, ctx)).toEqual({ ok: true, value: { t: "boolean", v: true } })
    },
  )

  it.each(["FALSE", "false", "False", "0", "no", "NO", "No", " false "])(
    "reads '%s' as false",
    (raw) => {
      expect(parseInput(raw, format, ctx)).toEqual({ ok: true, value: { t: "boolean", v: false } })
    },
  )

  it("takes an empty entry as the blank, false", () => {
    expect(parseInput("", format, ctx)).toEqual({ ok: true, value: { t: "boolean", v: false } })
    expect(parseInput("  ", format, ctx)).toEqual({ ok: true, value: { t: "boolean", v: false } })
  })

  it("refuses anything else", () => {
    expect(messageOf("maybe", format)).toBe("'maybe' isn't TRUE or FALSE.")
    expect(messageOf("2", format)).toBe("'2' isn't TRUE or FALSE.")
    expect(messageOf("tru", format)).toBe("'tru' isn't TRUE or FALSE.")
  })
})

describe("parseInput text", () => {
  const format: Format = { type: "text" }

  it("keeps the entry exactly as typed", () => {
    expect(parseInput("Hello, world", format, ctx)).toEqual({
      ok: true,
      value: { t: "text", v: "Hello, world" },
    })
    expect(parseInput("  padded  ", format, ctx)).toEqual({
      ok: true,
      value: { t: "text", v: "  padded  " },
    })
  })

  it("keeps text that looks like another type", () => {
    expect(parseInput("1,234", format, ctx)).toEqual({ ok: true, value: { t: "text", v: "1,234" } })
  })

  it("takes an empty entry as the blank, empty text", () => {
    expect(parseInput("", format, ctx)).toEqual({ ok: true, value: { t: "text", v: "" } })
  })
})

describe("parseInput dates", () => {
  const format: Format = { type: "date" }
  const dateOf = (raw: string) => parseInput(raw, format, ctx)

  it("reads an ISO date", () => {
    expect(dateOf("2026-10-15")).toEqual({ ok: true, value: { t: "date", v: "2026-10-15" } })
    expect(dateOf(" 2026-10-15 ")).toEqual({ ok: true, value: { t: "date", v: "2026-10-15" } })
  })

  it("reads a day-first date with slashes", () => {
    expect(dateOf("15/10/2026")).toEqual({ ok: true, value: { t: "date", v: "2026-10-15" } })
  })

  it("pads a day-first date typed without leading zeros", () => {
    expect(dateOf("5/3/2026")).toEqual({ ok: true, value: { t: "date", v: "2026-03-05" } })
  })

  it("accepts the last day of a leap year's February", () => {
    expect(dateOf("2024-02-29")).toEqual({ ok: true, value: { t: "date", v: "2024-02-29" } })
    expect(dateOf("29/02/2024")).toEqual({ ok: true, value: { t: "date", v: "2024-02-29" } })
  })

  it("takes an empty entry as the blank date", () => {
    expect(dateOf("")).toEqual({ ok: true, value: { t: "date", v: null } })
    expect(dateOf("  ")).toEqual({ ok: true, value: { t: "date", v: null } })
  })

  it("refuses a date that is not on the calendar and says which formats work", () => {
    const hint = " Use yyyy-mm-dd or dd/mm/yyyy."
    expect(messageOf("2026-02-29", format)).toBe(`'2026-02-29' isn't a valid date.${hint}`)
    expect(messageOf("31/02/2026", format)).toBe(`'31/02/2026' isn't a valid date.${hint}`)
    expect(messageOf("2026-13-01", format)).toBe(`'2026-13-01' isn't a valid date.${hint}`)
    expect(messageOf("2026-00-10", format)).toBe(`'2026-00-10' isn't a valid date.${hint}`)
    expect(messageOf("0/10/2026", format)).toBe(`'0/10/2026' isn't a valid date.${hint}`)
  })

  it("refuses a month-first date whose day is past twelve", () => {
    expect(messageOf("10/15/2026", format)).toBe(
      "'10/15/2026' isn't a valid date. Use yyyy-mm-dd or dd/mm/yyyy.",
    )
  })

  it.each(["yesterday", "2026", "2026-10", "2026-1-5", "15.10.2026", "15/10/26", "2026/10/15"])(
    "refuses '%s'",
    (raw) => {
      expect(dateOf(raw).ok).toBe(false)
    },
  )
})

describe("parseInput list items", () => {
  const format: Format = { type: "list", list: "0198f0aa-0000-7000-8000-000000000001" }

  it("finds an item by name, ignoring case", () => {
    expect(parseInput("North America", format, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: NORTH },
    })
    expect(parseInput("SOUTH AMERICA", format, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: SOUTH },
    })
  })

  it("finds an item by code, ignoring case", () => {
    expect(parseInput("NA", format, ctx)).toEqual({ ok: true, value: { t: "item", v: NORTH } })
    expect(parseInput("sa", format, ctx)).toEqual({ ok: true, value: { t: "item", v: SOUTH } })
  })

  it("ignores spaces around the entry", () => {
    expect(parseInput("  north america ", format, ctx)).toEqual({
      ok: true,
      value: { t: "item", v: NORTH },
    })
  })

  it("prefers the name when a name and a code are the same text", () => {
    const clash: ParseContext = {
      ...ctx,
      itemsByName: new Map([["x", "by-name"]]),
      itemsByCode: new Map([["x", "by-code"]]),
    }
    expect(parseInput("X", format, clash)).toEqual({
      ok: true,
      value: { t: "item", v: "by-name" },
    })
  })

  it("takes an empty entry as the blank item", () => {
    expect(parseInput("", format, ctx)).toEqual({ ok: true, value: { t: "item", v: null } })
  })

  it("refuses an entry that is no item's name or code", () => {
    expect(messageOf("Mars", format)).toBe("'Mars' isn't in this list.")
  })
})

describe("parseInput time periods", () => {
  const format: Format = { type: "time_period", level: "month" }

  it("finds a period by its label, ignoring case", () => {
    expect(parseInput("Jan 26", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["month", 0] },
    })
    expect(parseInput("FEB 26", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["month", 1] },
    })
  })

  it("finds a period of any level", () => {
    expect(parseInput("Q1 FY26", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["quarter", 0] },
    })
    expect(parseInput("FY26", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["year", 0] },
    })
    expect(parseInput("Total", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["all", 0] },
    })
  })

  it("ignores spaces around the label", () => {
    expect(parseInput("  jan 26 ", format, ctx)).toEqual({
      ok: true,
      value: { t: "period", v: ["month", 0] },
    })
  })

  it("gives a copy of the period, so changing the result leaves the lookup alone", () => {
    const result = parseInput("Jan 26", format, ctx)
    if (!result.ok || result.value.t !== "period" || result.value.v === null) {
      throw new Error("expected a period")
    }
    result.value.v[1] = 99
    expect(ctx.periodsByLabel.get("jan 26")).toEqual(["month", 0])
  })

  it("takes an empty entry as the blank period", () => {
    expect(parseInput("", format, ctx)).toEqual({ ok: true, value: { t: "period", v: null } })
    expect(parseInput("  ", format, ctx)).toEqual({ ok: true, value: { t: "period", v: null } })
  })

  it("refuses a label that is not on the timeline", () => {
    expect(messageOf("Foo", format)).toBe("'Foo' isn't a period of this timeline.")
    expect(messageOf("Mar 26", format)).toBe("'Mar 26' isn't a period of this timeline.")
  })
})

describe("copying a cell and pasting the text back", () => {
  const percentWithParens = numberFormat({ unit: { type: "percent" }, negative: "parens" })
  const numberFormats: [string, Format][] = [
    ["a plain number", plain],
    ["a currency", eur],
    ["a percentage", percent],
    ["a percentage with parentheses", percentWithParens],
  ]
  const numbers = [
    0, 1, -1, 25, 0.25, -0.25, 0.07, 0.29, 0.075, 1 / 3, 0.1 + 0.2, 1234.5, -1234.5, 1e-7, -1e-7,
    1e21, 123456789.12345679, 99.99999999999999,
  ]

  describe.each(numberFormats)("%s", (_name, format) => {
    it.each(numbers)("gives back %s", (v) => {
      const value: Value = { t: "number", v }
      expect(parseInput(copyText(value, format), format, ctx)).toEqual({ ok: true, value })
    })

    it("gives back arbitrary numbers of every size", () => {
      let seed = 20261015
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      for (let index = 0; index < 500; index++) {
        const v = (random() - 0.5) * 10 ** (random() * 24 - 12)
        const value: Value = { t: "number", v }
        expect(parseInput(copyText(value, format), format, ctx)).toEqual({ ok: true, value })
      }
    })
  })

  it("keeps a percentage's value when it is pasted into a cell that is not a percentage", () => {
    const value: Value = { t: "number", v: 0.07 }
    expect(parseInput(copyText(value, percent), plain, ctx)).toEqual({ ok: true, value })
    expect(parseInput(copyText(value, percent), eur, ctx)).toEqual({ ok: true, value })
  })

  it("reads a pasted plain number as percent points in a percentage cell", () => {
    expect(parseInput(copyText({ t: "number", v: 0.07 }, plain), percent, ctx)).toEqual({
      ok: true,
      value: { t: "number", v: 0.0007 },
    })
  })

  it("gives back what an editor opened with", () => {
    for (const [, format] of numberFormats) {
      for (const v of numbers) {
        const value: Value = { t: "number", v }
        expect(parseInput(editText(value, format), format, ctx)).toEqual({ ok: true, value })
      }
    }
  })

  it.each([
    [{ t: "boolean", v: true }, { type: "boolean" }, undefined],
    [{ t: "boolean", v: false }, { type: "boolean" }, undefined],
    [{ t: "text", v: "plain" }, { type: "text" }, undefined],
    [{ t: "text", v: "a\ttab, a \"quote\" and\na line" }, { type: "text" }, undefined],
    [{ t: "date", v: "2026-10-15" }, { type: "date" }, undefined],
    [{ t: "date", v: null }, { type: "date" }, undefined],
    [{ t: "item", v: NORTH }, { type: "list", list: "list-id" }, "North America"],
    [{ t: "item", v: SOUTH }, { type: "list", list: "list-id" }, "South America"],
    [{ t: "item", v: null }, { type: "list", list: "list-id" }, undefined],
    [{ t: "period", v: ["month", 1] }, { type: "time_period", level: "month" }, "Feb 26"],
    [{ t: "period", v: ["all", 0] }, { type: "time_period", level: "all" }, "Total"],
    [{ t: "period", v: null }, { type: "time_period", level: "month" }, undefined],
  ] as [Value, Format, string | undefined][])("gives back %j", (value, format, text) => {
    expect(parseInput(copyText(value, format, text), format, ctx)).toEqual({ ok: true, value })
  })
})
