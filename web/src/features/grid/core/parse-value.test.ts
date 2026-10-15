import { describe, expect, it } from "vitest"
import { parseInput, type ParseContext } from "./parse-value"
import type { Format, NumberUnit } from "./types"

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
}

function numberFormat(unit: NumberUnit = { type: "none" }): Format {
  return { type: "number", decimals: 2, thousands_sep: true, unit, negative: "minus" }
}

const plain = numberFormat()
const eur = numberFormat({ type: "currency", code: "EUR" })
const usd = numberFormat({ type: "currency", code: "USD" })
const percent = numberFormat({ type: "percent" })

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

    it("takes a number without a percent sign as typed, even in a percent format", () => {
      expect(numberOf("25", percent)).toEqual({ t: "number", v: 25 })
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

  it("takes an empty entry as the blank period", () => {
    expect(parseInput("", format, ctx)).toEqual({ ok: true, value: { t: "period", v: null } })
  })

  it("refuses typed periods, which the client cannot resolve", () => {
    expect(messageOf("Jan 26", format)).toBe("Time period values can't be typed in.")
  })
})
