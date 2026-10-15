import type { Format, Value } from "./types"

type NumberFormat = Extract<Format, { type: "number" }>

// Numbers are always written the English way (1,234.50). parseInput reads the same notation,
// so what a cell shows can be typed back in whatever the browser's locale is.
const NUMBER_LOCALE = "en-US"

const numberFormatters = new Map<string, Intl.NumberFormat>()

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" })

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * What a cell shows for `value` in `format`. `text` is the item name or period label the server
 * sends beside item and period values. A boolean shows nothing: its cell draws a check box.
 */
export function formatValue(value: Value, format: Format, text?: string): string {
  switch (format.type) {
    case "number":
      return value.t === "number" ? formatNumber(value.v, format) : ""
    case "boolean":
      return ""
    case "text":
      return value.t === "text" ? value.v : ""
    case "date":
      return value.t === "date" && value.v !== null ? formatDate(value.v) : ""
    case "list":
      return value.t === "item" && value.v !== null ? (text ?? "") : ""
    case "time_period":
      return value.t === "period" && value.v !== null ? (text ?? "") : ""
  }
}

function numberFormatter({ decimals, thousands_sep, unit }: NumberFormat): Intl.NumberFormat {
  const unitKey = unit.type === "currency" ? `currency:${unit.code}` : unit.type
  const key = `${decimals}|${thousands_sep}|${unitKey}`
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(NUMBER_LOCALE, {
      style: unit.type === "none" ? "decimal" : unit.type,
      currency: unit.type === "currency" ? unit.code : undefined,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: thousands_sep,
      // A negative number that rounds to zero is just zero.
      signDisplay: "negative",
    })
    numberFormatters.set(key, formatter)
  }
  return formatter
}

function formatNumber(value: number, format: NumberFormat): string {
  const formatter = numberFormatter(format)
  if (format.negative === "minus") {
    return formatter.format(value)
  }
  // Intl only writes accounting parentheses for currencies, so take the sign out of the parts.
  const parts = formatter.formatToParts(value)
  const negative = parts.some((part) => part.type === "minusSign")
  const digits = parts
    .filter((part) => part.type !== "minusSign")
    .map((part) => part.value)
    .join("")
  return negative ? `(${digits})` : digits
}

function formatDate(iso: string): string {
  const match = ISO_DATE.exec(iso)
  if (!match) {
    return iso
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  // setUTCFullYear, unlike Date.UTC, does not read years 0 to 99 as 1900 to 1999.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  const onCalendar =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return onCalendar ? dateFormatter.format(date) : iso
}
