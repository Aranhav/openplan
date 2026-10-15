import { describe, expect, it } from "vitest"
import { numberFormat } from "@/test/number-format"
import { copyText, editText, formatValue } from "./format-value"
import { parseInput } from "./parse-value"
import type { Format, Value } from "./types"

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

describe("formatValue never throws", () => {
  const unit = (code: string) => ({ type: "currency", code }) as const

  describe("for a currency code Intl does not accept", () => {
    it.each(["US", "USDX", "12A", "€", "dollars"])("puts %s before a plain number", (code) => {
      expect(formatValue(num(1234.5), numberFormat({ unit: unit(code) }))).toBe(`${code} 1,234.50`)
    })

    it("shows a bare number when there is no code at all", () => {
      expect(formatValue(num(1234.5), numberFormat({ unit: unit("") }))).toBe("1,234.50")
    })

    it("keeps the decimals, the separator and the negative style", () => {
      const format = (options: Parameters<typeof numberFormat>[0]) =>
        numberFormat({ unit: unit("US"), ...options })
      const bare = format({ decimals: 0, thousands_sep: false })
      expect(formatValue(num(1234.5), bare)).toBe("US 1235")
      expect(formatValue(num(-1234.5), format({}))).toBe("-US 1,234.50")
      expect(formatValue(num(-1234.5), format({ negative: "parens" }))).toBe("(US 1,234.50)")
      expect(formatValue(num(-0.001), format({}))).toBe("US 0.00")
    })

    it("is read back by parseInput", () => {
      const format = numberFormat({ unit: unit("US") })
      const ctx = { itemsByName: new Map(), itemsByCode: new Map(), periodsByLabel: new Map() }
      for (const v of [1234.5, -1234.5, 0]) {
        const shown = formatValue(num(v), format)
        expect(parseInput(shown, format, ctx)).toEqual({ ok: true, value: num(v) })
      }
    })
  })

  describe("for decimals outside 0 to 10", () => {
    it("clamps to ten", () => {
      expect(formatValue(num(1.5), numberFormat({ decimals: 11 }))).toBe("1.5000000000")
      expect(formatValue(num(1.5), numberFormat({ decimals: 101 }))).toBe("1.5000000000")
      expect(formatValue(num(1.5), numberFormat({ decimals: Infinity }))).toBe("1.5000000000")
    })

    it("clamps to none below zero and for something that is not a number", () => {
      expect(formatValue(num(1234.5), numberFormat({ decimals: -3 }))).toBe("1,235")
      expect(formatValue(num(1234.5), numberFormat({ decimals: -Infinity }))).toBe("1,235")
      expect(formatValue(num(1234.5), numberFormat({ decimals: NaN }))).toBe("1,235")
    })

    it("drops a fraction of a decimal place", () => {
      expect(formatValue(num(1.23456), numberFormat({ decimals: 2.9 }))).toBe("1.23")
    })

    it("clamps for percentages and currencies too", () => {
      const percent = numberFormat({ unit: { type: "percent" }, decimals: 99 })
      expect(formatValue(num(0.5), percent)).toBe("50.0000000000%")
      const usd = numberFormat({ unit: unit("USD"), decimals: 99 })
      expect(formatValue(num(1), usd)).toBe("$1.0000000000")
    })
  })

  it("does not throw for any function with any format of the number kinds", () => {
    const ctx = { itemsByName: new Map(), itemsByCode: new Map(), periodsByLabel: new Map() }
    const decimals = [-1, 0, 2, 10, 101, NaN, Infinity]
    const units = [
      { type: "none" },
      { type: "percent" },
      unit("USD"),
      unit("US"),
      unit(""),
    ] as const
    const values = [0, -0, 1, -1.5, 1e21, 1e-300, 123456.789, Infinity, NaN]
    for (const d of decimals) {
      for (const u of units) {
        for (const negative of ["minus", "parens"] as const) {
          const format = numberFormat({ decimals: d, unit: u, negative })
          for (const v of values) {
            expect(() => formatValue(num(v), format)).not.toThrow()
            expect(() => editText(num(v), format)).not.toThrow()
            expect(() => copyText(num(v), format)).not.toThrow()
          }
          expect(() => parseInput("1,234.50", format, ctx)).not.toThrow()
          expect(() => parseInput("", format, ctx)).not.toThrow()
        }
      }
    }
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

describe("editText", () => {
  const usd = numberFormat({ unit: { type: "currency", code: "USD" }, negative: "parens" })
  const percent = (options?: Parameters<typeof numberFormat>[0]) =>
    numberFormat({ unit: { type: "percent" }, decimals: 0, ...options })

  describe("numbers", () => {
    it("writes the number in full, with no separators, symbol or rounding", () => {
      expect(editText(num(1234.5), numberFormat({ decimals: 0 }))).toBe("1234.5")
      expect(editText(num(1234567.891), numberFormat())).toBe("1234567.891")
      expect(editText(num(1.23456789), numberFormat({ decimals: 2 }))).toBe("1.23456789")
      expect(editText(num(1234.5), usd)).toBe("1234.5")
    })

    it("writes a negative number with a minus sign even when the cell shows parentheses", () => {
      expect(editText(num(-1234.5), numberFormat({ negative: "parens" }))).toBe("-1234.5")
      expect(editText(num(-1234.5), usd)).toBe("-1234.5")
    })

    it("writes zero as 0, never as negative zero", () => {
      expect(editText(num(0), numberFormat())).toBe("0")
      expect(editText(num(-0), numberFormat())).toBe("0")
    })

    it("never writes an exponent", () => {
      expect(editText(num(1e21), numberFormat())).toBe("1000000000000000000000")
      expect(editText(num(1e-7), numberFormat())).toBe("0.0000001")
      expect(editText(num(0.1 + 0.2), numberFormat())).toBe("0.30000000000000004")
    })
  })

  describe("percentages", () => {
    it("writes percent points without the sign", () => {
      expect(editText(num(0.25), percent())).toBe("25")
      expect(editText(num(1.5), percent())).toBe("150")
      expect(editText(num(-0.25), percent())).toBe("-25")
      expect(editText(num(0), percent())).toBe("0")
    })

    it("does not show floating point noise from multiplying by one hundred", () => {
      expect(editText(num(0.07), percent())).toBe("7")
      expect(editText(num(0.29), percent())).toBe("29")
      expect(editText(num(0.075), percent())).toBe("7.5")
    })

    it("keeps every digit of the value", () => {
      expect(editText(num(1 / 3), percent())).toBe("33.33333333333333")
      expect(editText(num(0.1 + 0.2), percent())).toBe("30.000000000000004")
      expect(editText(num(1e-7), percent())).toBe("0.00001")
      expect(editText(num(1e21), percent())).toBe("100000000000000000000000")
    })

    it("ignores the decimals the cell displays", () => {
      expect(editText(num(0.123456), percent({ decimals: 1 }))).toBe("12.3456")
    })
  })

  describe("other types", () => {
    it("writes a boolean as TRUE or FALSE", () => {
      expect(editText({ t: "boolean", v: true }, { type: "boolean" })).toBe("TRUE")
      expect(editText({ t: "boolean", v: false }, { type: "boolean" })).toBe("FALSE")
    })

    it("writes text as it is", () => {
      expect(editText({ t: "text", v: " Hello, world " }, { type: "text" })).toBe(" Hello, world ")
    })

    it("writes a date as yyyy-mm-dd, whatever the locale", () => {
      expect(editText({ t: "date", v: "2026-10-15" }, { type: "date" })).toBe("2026-10-15")
      expect(editText({ t: "date", v: null }, { type: "date" })).toBe("")
    })

    it("writes the item name or period label the server sent", () => {
      const list: Format = { type: "list", list: "list-id" }
      const period: Format = { type: "time_period", level: "month" }
      expect(editText({ t: "item", v: "item-id" }, list, "North")).toBe("North")
      expect(editText({ t: "item", v: null }, list)).toBe("")
      expect(editText({ t: "period", v: ["month", 3] }, period, "Apr 26")).toBe("Apr 26")
    })

    it("writes nothing for a value that does not fit the format", () => {
      expect(editText({ t: "text", v: "x" }, numberFormat())).toBe("")
      expect(editText(num(1), { type: "boolean" })).toBe("")
      expect(editText(num(1), { type: "date" })).toBe("")
    })
  })
})

describe("copyText", () => {
  it("writes the same text as an editor opens with", () => {
    expect(copyText(num(-1234.5), numberFormat({ negative: "parens" }))).toBe("-1234.5")
    expect(copyText({ t: "boolean", v: true }, { type: "boolean" })).toBe("TRUE")
    expect(copyText({ t: "date", v: "2026-10-15" }, { type: "date" })).toBe("2026-10-15")
    expect(copyText({ t: "item", v: "item-id" }, { type: "list", list: "list-id" }, "North")).toBe(
      "North",
    )
  })

  it("keeps the percent sign on a percentage, as percent points times one hundred", () => {
    const percent = numberFormat({ unit: { type: "percent" }, decimals: 1 })
    expect(copyText(num(0.25), percent)).toBe("25%")
    expect(copyText(num(0.07), percent)).toBe("7%")
    expect(copyText(num(-0.075), percent)).toBe("-7.5%")
    expect(copyText(num(1 / 3), percent)).toBe("33.33333333333333%")
    expect(copyText(num(0), percent)).toBe("0%")
  })

  it("writes nothing for a value that does not fit a percentage", () => {
    const percent = numberFormat({ unit: { type: "percent" } })
    expect(copyText({ t: "text", v: "x" }, percent)).toBe("")
  })
})
