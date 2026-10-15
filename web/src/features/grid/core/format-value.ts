/**
 * The text a cell value turns into: what the cell shows, what an editor opens with and what
 * is copied.
 *
 * Numbers are always written in the English notation (1,234.50, 25%), whatever the browser's
 * locale, because `parseInput` reads that same notation: anything shown, edited or copied can be
 * typed or pasted back. Dates follow the browser's locale, since they are only ever shown.
 *
 * Nothing here throws, whatever the format holds: decimals are held to 0 to 10, and a currency
 * code Intl does not accept (one that is not three letters) is shown in front of a plain number
 * ("US 1,234.50").
 */
import type { Format, Value } from "./types"

type NumberFormat = Extract<Format, { type: "number" }>

const NUMBER_LOCALE = "en-US"

// The most decimals a number format shows; the line item form allows 0 to 10.
const MAX_DECIMALS = 10

// How to write a number: an Intl formatter and any text to put in front of it.
type NumberWriter = { formatter: Intl.NumberFormat; prefix: string }

const numberWriters = new Map<string, NumberWriter>()

// Every digit of a number and no exponent: the text parseInput reads back to the same number.
const plainFormatter = new Intl.NumberFormat(NUMBER_LOCALE, {
  useGrouping: false,
  maximumFractionDigits: 100,
  signDisplay: "negative",
})

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

/**
 * What an editor opens with: the value written exactly and as plainly as `parseInput` reads it.
 * A percentage is in percent points without the sign (25), the way it is typed. `text` is the
 * item name or period label the server sends beside item and period values.
 */
export function editText(value: Value, format: Format, text?: string): string {
  switch (format.type) {
    case "number":
      if (value.t !== "number") {
        return ""
      }
      return format.unit.type === "percent"
        ? timesHundred(plainFormatter.format(value.v))
        : plainFormatter.format(value.v)
    case "boolean":
      return value.t === "boolean" ? (value.v ? "TRUE" : "FALSE") : ""
    case "date":
      return value.t === "date" ? (value.v ?? "") : ""
    case "text":
    case "list":
    case "time_period":
      return formatValue(value, format, text)
  }
}

/**
 * What the clipboard gets for a cell: `editText`, except that a percentage keeps its sign (25%).
 * Pasted into any number cell, with or without a percent unit, that is the same value.
 */
export function copyText(value: Value, format: Format, text?: string): string {
  const edited = editText(value, format, text)
  const percentage = format.type === "number" && format.unit.type === "percent"
  return percentage && edited !== "" ? `${edited}%` : edited
}

/** A plain decimal times one hundred, by moving the decimal point, which loses no digit. */
function timesHundred(plain: string): string {
  const negative = plain.startsWith("-")
  const [whole, fraction = ""] = (negative ? plain.slice(1) : plain).split(".")
  const padded = fraction.padEnd(2, "0")
  const integer = (whole + padded.slice(0, 2)).replace(/^0+(?=\d)/, "")
  const rest = padded.slice(2).replace(/0+$/, "")
  const times = rest === "" ? integer : `${integer}.${rest}`
  return negative && times !== "0" ? `-${times}` : times
}

function numberWriter({ decimals, thousands_sep, unit }: NumberFormat): NumberWriter {
  // A format from the server is valid, but a cell must show something whatever it holds.
  const digits = clamp(Math.trunc(Number(decimals) || 0), 0, MAX_DECIMALS)
  const unitKey = unit.type === "currency" ? `currency:${unit.code}` : unit.type
  const key = `${digits}|${thousands_sep}|${unitKey}`
  let writer = numberWriters.get(key)
  if (!writer) {
    writer = createNumberWriter(digits, thousands_sep, unit)
    numberWriters.set(key, writer)
  }
  return writer
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function createNumberWriter(
  digits: number,
  grouping: boolean,
  unit: NumberFormat["unit"],
): NumberWriter {
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: grouping,
    // A negative number that rounds to zero is just zero.
    signDisplay: "negative",
  }
  if (unit.type === "currency") {
    try {
      const formatter = new Intl.NumberFormat(NUMBER_LOCALE, {
        ...options,
        style: "currency",
        currency: unit.code,
      })
      return { formatter, prefix: "" }
    } catch {
      // Not a code Intl accepts: put the code itself in front of a plain number.
      const prefix = unit.code ? `${unit.code} ` : ""
      return { formatter: new Intl.NumberFormat(NUMBER_LOCALE, options), prefix }
    }
  }
  const style = unit.type === "percent" ? "percent" : "decimal"
  return { formatter: new Intl.NumberFormat(NUMBER_LOCALE, { ...options, style }), prefix: "" }
}

function formatNumber(value: number, format: NumberFormat): string {
  const { formatter, prefix } = numberWriter(format)
  if (prefix === "" && format.negative === "minus") {
    return formatter.format(value)
  }
  // Take the sign out of the parts, to put it in front of the prefix or inside parentheses
  // (Intl only writes parentheses for currencies).
  const parts = formatter.formatToParts(value)
  const negative = parts.some((part) => part.type === "minusSign")
  const digits = parts
    .filter((part) => part.type !== "minusSign")
    .map((part) => part.value)
    .join("")
  const text = prefix + digits
  if (!negative) {
    return text
  }
  return format.negative === "parens" ? `(${text})` : `-${text}`
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
