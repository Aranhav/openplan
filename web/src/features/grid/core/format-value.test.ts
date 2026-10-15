import { describe, expect, it } from "vitest"
import { formatValue } from "./format-value"
import type { Format, NumberUnit, Value } from "./types"

function numberFormat(
  options: {
    decimals?: number
    thousands_sep?: boolean
    unit?: NumberUnit
    negative?: "minus" | "parens"
  } = {},
): Format {
  return {
    type: "number",
    decimals: 2,
    thousands_sep: true,
    unit: { type: "none" },
    negative: "minus",
    ...options,
  }
}

const num = (v: number): Value => ({ t: "number", v })

describe("formatValue numbers", () => {
  it("shows the format's decimals", () => {
    expect(formatValue(num(1234.5), numberFormat({ decimals: 2 }))).toBe("1,234.50")
    expect(formatValue(num(1234.5), numberFormat({ decimals: 0 }))).toBe("1,235")
    expect(formatValue(num(1.23456), numberFormat({ decimals: 4 }))).toBe("1.2346")
  })

  it("groups thousands only when the format asks for it", () => {
    expect(formatValue(num(1234567.891), numberFormat({ thousands_sep: true }))).toBe(
      "1,234,567.89",
    )
    expect(formatValue(num(1234567.891), numberFormat({ thousands_sep: false }))).toBe(
      "1234567.89",
    )
  })

  it("shows a blank number as zero at the format's decimals", () => {
    expect(formatValue(num(0), numberFormat({ decimals: 2 }))).toBe("0.00")
    expect(formatValue(num(0), numberFormat({ decimals: 0 }))).toBe("0")
  })

  it("writes a negative number with a minus sign", () => {
    expect(formatValue(num(-1234.5), numberFormat())).toBe("-1,234.50")
  })

  it("writes a negative number in parentheses when the format says so", () => {
    expect(formatValue(num(-1234.5), numberFormat({ negative: "parens" }))).toBe("(1,234.50)")
    expect(formatValue(num(1234.5), numberFormat({ negative: "parens" }))).toBe("1,234.50")
  })

  it("does not show a sign for a negative number that rounds to zero", () => {
    expect(formatValue(num(-0.001), numberFormat({ decimals: 2 }))).toBe("0.00")
    expect(formatValue(num(-0.001), numberFormat({ decimals: 2, negative: "parens" }))).toBe(
      "0.00",
    )
    expect(formatValue(num(-0), numberFormat({ decimals: 0 }))).toBe("0")
  })
})

describe("formatValue currency", () => {
  const usd = (options?: Parameters<typeof numberFormat>[0]) =>
    numberFormat({ unit: { type: "currency", code: "USD" }, ...options })

  it("puts the currency symbol in front, with the format's decimals", () => {
    expect(formatValue(num(1234.5), usd())).toBe("$1,234.50")
    expect(formatValue(num(1234.5), usd({ decimals: 0 }))).toBe("$1,235")
    expect(formatValue(num(12), numberFormat({ unit: { type: "currency", code: "EUR" } }))).toBe(
      "€12.00",
    )
  })

  it("shows a blank currency cell as zero", () => {
    expect(formatValue(num(0), usd())).toBe("$0.00")
  })

  it("puts the minus sign before the symbol", () => {
    expect(formatValue(num(-1234.5), usd())).toBe("-$1,234.50")
  })

  it("puts the parentheses around the symbol", () => {
    expect(formatValue(num(-1234.5), usd({ negative: "parens" }))).toBe("($1,234.50)")
  })

  it("honours the separator setting", () => {
    expect(formatValue(num(1234.5), usd({ thousands_sep: false }))).toBe("$1234.50")
  })
})

describe("formatValue percent", () => {
  const percent = (options?: Parameters<typeof numberFormat>[0]) =>
    numberFormat({ unit: { type: "percent" }, decimals: 0, ...options })

  it("multiplies by one hundred and adds a percent sign", () => {
    expect(formatValue(num(0.25), percent())).toBe("25%")
    expect(formatValue(num(1.5), percent())).toBe("150%")
  })

  it("applies the decimals to the percentage", () => {
    expect(formatValue(num(0.075), percent({ decimals: 1 }))).toBe("7.5%")
    expect(formatValue(num(0.25), percent({ decimals: 2 }))).toBe("25.00%")
  })

  it("does not show floating point noise", () => {
    expect(formatValue(num(0.07), percent({ decimals: 1 }))).toBe("7.0%")
    expect(formatValue(num(0.29), percent({ decimals: 0 }))).toBe("29%")
  })

  it("shows a blank percentage as zero", () => {
    expect(formatValue(num(0), percent({ decimals: 1 }))).toBe("0.0%")
  })

  it("writes negative percentages with a minus sign or parentheses", () => {
    expect(formatValue(num(-0.25), percent())).toBe("-25%")
    expect(formatValue(num(-0.25), percent({ negative: "parens" }))).toBe("(25%)")
  })
})

describe("formatValue other types", () => {
  it("shows a boolean as nothing, because the cell draws a check box", () => {
    expect(formatValue({ t: "boolean", v: true }, { type: "boolean" })).toBe("")
    expect(formatValue({ t: "boolean", v: false }, { type: "boolean" })).toBe("")
  })

  it("shows text as it is", () => {
    expect(formatValue({ t: "text", v: "Hello, world" }, { type: "text" })).toBe("Hello, world")
    expect(formatValue({ t: "text", v: "" }, { type: "text" })).toBe("")
  })

  describe("dates", () => {
    const medium = (year: number, month: number, day: number) =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, day)),
      )

    it("uses the medium date style of the user's locale", () => {
      expect(formatValue({ t: "date", v: "2026-10-15" }, { type: "date" })).toBe(
        medium(2026, 10, 15),
      )
    })

    it("does not move the day with the time zone", () => {
      const first = formatValue({ t: "date", v: "2026-01-01" }, { type: "date" })
      expect(first).toBe(medium(2026, 1, 1))
      expect(first).not.toContain("2025")
      const last = formatValue({ t: "date", v: "2026-12-31" }, { type: "date" })
      expect(last).toBe(medium(2026, 12, 31))
      expect(last).not.toContain("2027")
    })

    it("shows a blank date as nothing", () => {
      expect(formatValue({ t: "date", v: null }, { type: "date" })).toBe("")
    })

    it("shows a date it cannot read as it was given", () => {
      expect(formatValue({ t: "date", v: "2026-02-30" }, { type: "date" })).toBe("2026-02-30")
      expect(formatValue({ t: "date", v: "soon" }, { type: "date" })).toBe("soon")
    })
  })

  describe("items and periods", () => {
    const list: Format = { type: "list", list: "0198f0aa-0000-7000-8000-000000000001" }
    const period: Format = { type: "time_period", level: "month" }

    it("shows the text the server sent for an item", () => {
      const item: Value = { t: "item", v: "0198f0aa-0000-7000-8000-000000000002" }
      expect(formatValue(item, list, "North")).toBe("North")
    })

    it("shows the text the server sent for a period", () => {
      expect(formatValue({ t: "period", v: ["month", 3] }, period, "Apr 26")).toBe("Apr 26")
    })

    it("shows a blank item or period as nothing", () => {
      expect(formatValue({ t: "item", v: null }, list)).toBe("")
      expect(formatValue({ t: "period", v: null }, period)).toBe("")
      expect(formatValue({ t: "item", v: null }, list, "stale")).toBe("")
    })

    it("shows nothing for a value whose text has not arrived", () => {
      const item: Value = { t: "item", v: "0198f0aa-0000-7000-8000-000000000002" }
      expect(formatValue(item, list)).toBe("")
    })
  })

  it("shows nothing for a value that does not fit the format", () => {
    expect(formatValue({ t: "text", v: "x" }, numberFormat())).toBe("")
    expect(formatValue(num(1), { type: "text" })).toBe("")
    expect(formatValue(num(1), { type: "date" })).toBe("")
    expect(formatValue(num(1), { type: "boolean" })).toBe("")
  })
})
