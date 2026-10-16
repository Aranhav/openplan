/**
 * Reads what was typed or pasted into a cell. Numbers use the English notation that
 * `formatValue` writes (1,234.50, (1,234.50), 25%), whatever the browser's locale, and also
 * scientific notation (1.23E+15), which Excel writes for large numbers. Nothing here throws:
 * an entry that cannot be read is refused with a message.
 */
import type { Format, PeriodLevel, Value } from "./types"

/**
 * What entries can name. Item ids are by lower-cased name and by lower-cased code, for a list
 * format's list; periods are by lower-cased label ("jan 26", "q1 fy26", "total") for every
 * level of the timeline, and a time period format takes the labels of its own level.
 */
export type ParseContext = {
  itemsByName: Map<string, string>
  itemsByCode: Map<string, string>
  periodsByLabel: Map<string, [PeriodLevel, number]>
}

export type ParseResult = { ok: true; value: Value } | { ok: false; message: string }

type NumberFormat = Extract<Format, { type: "number" }>

// Digits with optional thousands groups (1,234,567) and an optional fraction, or scientific
// notation (1.23E+15), which has no groups.
const NUMBER_CORE = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/
const SCIENTIFIC = /^(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/
const SIGN = /^[-−+]/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_FIRST_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const TRUE_WORDS = new Set(["true", "1", "yes"])
const FALSE_WORDS = new Set(["false", "0", "no"])
const MAX_QUOTED_LENGTH = 40

const currencyTokens = new Map<string, string[]>()

/**
 * Reads one entry as a value of `format`. An empty entry gives the format's blank value. A
 * currency format also accepts its symbol in front or its code behind (€12, 12 EUR), with
 * parentheses around the whole entry or just the number ($ (1,234.50)). In a percent format a
 * number is in percent points: 25 and 25% are both 0.25. Anywhere else a percent sign divides
 * by 100 and a bare number is taken as it is.
 */
export function parseInput(raw: string, format: Format, ctx: ParseContext): ParseResult {
  switch (format.type) {
    case "number":
      return parseNumber(raw, format)
    case "boolean":
      return parseBoolean(raw)
    case "text":
      return ok({ t: "text", v: raw })
    case "date":
      return parseDate(raw)
    case "list":
      return parseItem(raw, ctx)
    case "time_period":
      return parsePeriod(raw, format.level, ctx)
  }
}

function ok(value: Value): ParseResult {
  return { ok: true, value }
}

function refuse(message: string): ParseResult {
  return { ok: false, message }
}

function quoted(text: string): string {
  const chars = Array.from(text)
  return chars.length > MAX_QUOTED_LENGTH
    ? `'${chars.slice(0, MAX_QUOTED_LENGTH).join("")}…'`
    : `'${text}'`
}

function parseNumber(raw: string, format: NumberFormat): ParseResult {
  const entry = raw.trim()
  if (entry === "") {
    return ok({ t: "number", v: 0 })
  }
  const tokens = format.unit.type === "currency" ? tokensOfCurrency(format.unit.code) : []
  const value = readNumber(entry, tokens, format.unit.type === "percent")
  if (value === undefined) {
    return refuse(`${quoted(entry)} isn't a number.`)
  }
  return ok({ t: "number", v: value })
}

/** The number in `entry`, or undefined when the entry is not one. */
function readNumber(
  entry: string,
  currencies: string[],
  percentPoints: boolean,
): number | undefined {
  let text = entry
  let negative = false
  let signed = false
  let currency = false
  let percent = false

  const inParentheses = /^\(([\s\S]*)\)$/.exec(text)
  if (inParentheses) {
    text = inParentheses[1].trim()
    negative = true
    signed = true
  }

  // In front there is room for a sign and a currency marker, in either order: -€5 and €-5.
  for (let pass = 0; pass < 2; pass++) {
    const sign = SIGN.exec(text)
    const token = currency ? undefined : currencies.find((candidate) => startsWith(text, candidate))
    if (sign) {
      if (signed) {
        return undefined
      }
      signed = true
      negative = sign[0] !== "+"
      text = text.slice(1).trimStart()
    } else if (token) {
      currency = true
      text = text.slice(token.length).trimStart()
    }
  }

  // Behind there is room for a percent sign and a currency code, in either order.
  for (let pass = 0; pass < 2; pass++) {
    const token = currency ? undefined : currencies.find((candidate) => endsWith(text, candidate))
    if (!percent && text.endsWith("%")) {
      percent = true
      text = text.slice(0, -1).trimEnd()
    } else if (token) {
      currency = true
      text = text.slice(0, -token.length).trimEnd()
    }
  }

  // Parentheses may also close in on just the number, after the symbol: $ (1,234.50).
  const accounting = /^\(([\s\S]*)\)$/.exec(text)
  if (accounting && !signed) {
    text = accounting[1].trim()
    negative = true
  }

  if (!NUMBER_CORE.test(text) && !SCIENTIFIC.test(text)) {
    return undefined
  }
  const [mantissa, exponent = "0"] = text.replaceAll(",", "").split(/e/i)
  // Shifting the decimal point in the text keeps 33.3% exactly 0.333; dividing by 100 would not.
  // The exponent is counted in whole numbers of any length: as a float, one of 21 digits or more
  // would print as 1e+21 and break the number, while a shorter one would not.
  const shift = percent || percentPoints ? 2n : 0n
  const magnitude = Number(`${mantissa}e${BigInt(exponent) - shift}`)
  if (!Number.isFinite(magnitude)) {
    return undefined
  }
  return negative && magnitude !== 0 ? -magnitude : magnitude
}

function startsWith(text: string, token: string): boolean {
  return text.slice(0, token.length).toLowerCase() === token.toLowerCase()
}

function endsWith(text: string, token: string): boolean {
  return text.length >= token.length && startsWith(text.slice(-token.length), token)
}

/** What people type for a currency: its symbol, its narrow symbol and its code, longest first. */
function tokensOfCurrency(code: string): string[] {
  let tokens = currencyTokens.get(code)
  if (!tokens) {
    const names = [currencySymbol(code, "symbol"), currencySymbol(code, "narrowSymbol"), code]
    tokens = [...new Set(names)].filter((name) => name !== "").sort((a, b) => b.length - a.length)
    currencyTokens.set(code, tokens)
  }
  return tokens
}

function currencySymbol(code: string, currencyDisplay: "symbol" | "narrowSymbol"): string {
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay,
    }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? code
  } catch {
    // Not a code Intl accepts, so the code is the only marker to read.
    return code
  }
}

function parseBoolean(raw: string): ParseResult {
  const entry = raw.trim()
  const word = entry.toLowerCase()
  if (entry === "" || FALSE_WORDS.has(word)) {
    return ok({ t: "boolean", v: false })
  }
  if (TRUE_WORDS.has(word)) {
    return ok({ t: "boolean", v: true })
  }
  return refuse(`${quoted(entry)} isn't TRUE or FALSE.`)
}

function parseDate(raw: string): ParseResult {
  const entry = raw.trim()
  if (entry === "") {
    return ok({ t: "date", v: null })
  }
  const date = readDate(entry)
  return date === undefined
    ? refuse(`${quoted(entry)} isn't a valid date. Use yyyy-mm-dd or dd/mm/yyyy.`)
    : ok({ t: "date", v: date })
}

/** The entry as yyyy-mm-dd, or undefined when it is not a day on the calendar. */
function readDate(entry: string): string | undefined {
  const iso = ISO_DATE.exec(entry)
  const dayFirst = DAY_FIRST_DATE.exec(entry)
  const parts = iso
    ? [iso[1], iso[2], iso[3]]
    : dayFirst
      ? [dayFirst[3], dayFirst[2], dayFirst[1]]
      : undefined
  if (!parts) {
    return undefined
  }
  const [year, month, day] = parts.map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined
  }
  const pad = (n: number, width: number) => String(n).padStart(width, "0")
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function parseItem(raw: string, ctx: ParseContext): ParseResult {
  const entry = raw.trim()
  if (entry === "") {
    return ok({ t: "item", v: null })
  }
  const key = entry.toLowerCase()
  const id = ctx.itemsByName.get(key) ?? ctx.itemsByCode.get(key)
  if (id === undefined) {
    return refuse(`${quoted(entry)} isn't in this list.`)
  }
  return ok({ t: "item", v: id })
}

const LEVEL_NAMES: Record<PeriodLevel, string> = {
  month: "month",
  quarter: "quarter",
  half_year: "half year",
  year: "year",
  all: "total",
}

/** A time period cell holds one level only, so a label of another level is refused. */
function parsePeriod(raw: string, level: PeriodLevel, ctx: ParseContext): ParseResult {
  const entry = raw.trim()
  if (entry === "") {
    return ok({ t: "period", v: null })
  }
  const period = ctx.periodsByLabel.get(entry.toLowerCase())
  if (period === undefined) {
    return refuse(`${quoted(entry)} isn't a period of this timeline.`)
  }
  if (period[0] !== level) {
    return refuse(`${quoted(entry)} isn't a ${LEVEL_NAMES[level]}.`)
  }
  return ok({ t: "period", v: [period[0], period[1]] })
}
