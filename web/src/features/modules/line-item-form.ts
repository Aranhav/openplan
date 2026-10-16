import { z } from "zod"
import { wholeNumberSchema } from "@/features/time/whole-number"
import type { LineItemDto, ModuleDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { structureNameSchema } from "@/lib/validation"
import { MODULE_TIME_LEVELS, type Axis, ownAxes, ownKeys } from "./axes"

type Schemas = components["schemas"]

type Format = Schemas["FormatDto"]
type SummaryMethod = Schemas["SummaryMethodDto"]
type TimeScale = Schemas["TimeScaleDto"]
type VersionsScope = Schemas["VersionsScopeDto"]
type TimeLevel = Schemas["TimeLevelDto"]
export type UpdateLineItemRequest = Schemas["UpdateLineItemRequest"]

export const FORMAT_TYPES = ["number", "boolean", "text", "date", "list", "time_period"] as const
export type FormatType = (typeof FORMAT_TYPES)[number]

export const FORMAT_TYPE_LABELS: Record<FormatType, string> = {
  number: "Number",
  boolean: "Boolean",
  text: "Text",
  date: "Date",
  list: "List",
  time_period: "Time period",
}

export type SummaryMethodName = SummaryMethod["method"]

const NUMBER_SUMMARIES: SummaryMethodName[] = [
  "sum",
  "average",
  "min",
  "max",
  "none",
  "formula",
  "ratio",
  "first",
  "last",
  "opening",
  "closing",
]
const BOOLEAN_SUMMARIES: SummaryMethodName[] = [
  "any",
  "all",
  "none",
  "first",
  "last",
  "opening",
  "closing",
]

/**
 * The ways a line item of this format can be summarized. Numbers take every method but Any and
 * All, booleans take Any, All and the ones that pick a period; text, dates, lists and periods
 * are blank once rolled up, whatever the method.
 */
export function summaryMethodsFor(format: FormatType): SummaryMethodName[] {
  switch (format) {
    case "number":
      return NUMBER_SUMMARIES
    case "boolean":
      return BOOLEAN_SUMMARIES
    default:
      return ["none"]
  }
}

/** What a new line item of this format is summarized by. */
export function defaultSummaryFor(format: FormatType): "sum" | "none" {
  return format === "number" ? "sum" : "none"
}

/** What a choice of a form holds for "the same as the summary". */
export const SAME_AS_SUMMARY = "same"

export const TIME_SCALE_MODULE = "module"
export const TIME_SCALE_NONE = "none"
const LEVEL_PREFIX = "level:"

/** The time scales a line item can have in a module whose Time dimension is at `level`: its own or coarser. */
export function timeScaleLevels(level: TimeLevel | undefined): TimeLevel[] {
  if (level === undefined) {
    return []
  }
  const coarser: TimeLevel[] = [...MODULE_TIME_LEVELS, "all"]
  return coarser.slice(coarser.indexOf(level))
}

export const APPLIES_TO_MODULE = "module"
export const APPLIES_TO_CHOSEN = "chosen"
export const VERSIONS_MODULE = "module"
export const VERSIONS_NONE = "none"
export const VERSIONS_CHOSEN = "only"

/** The longest code, notes and formula the server keeps, in characters. */
const CODE_MAX = 80
const NOTES_MAX = 2_000
const FORMULA_MAX = 10_000

export const lineItemSchema = z
  .object({
    name: structureNameSchema,
    code: z.string().trim().max(CODE_MAX, `Code must be at most ${CODE_MAX} characters.`),
    notes: z.string().max(NOTES_MAX, `Notes must be at most ${NOTES_MAX} characters.`),
    formula: z.string().max(FORMULA_MAX, `Formula must be at most ${FORMULA_MAX} characters.`),
    format_type: z.enum(FORMAT_TYPES),
    decimals: wholeNumberSchema("Decimals", 0, 10),
    thousands_sep: z.boolean(),
    unit: z.enum(["none", "currency", "percent"]),
    currency_code: z.string().trim(),
    negative: z.enum(["minus", "parens"]),
    list: z.string(),
    period_level: z.enum(MODULE_TIME_LEVELS),
    summary_method: z.string(),
    summary_numerator: z.string(),
    summary_denominator: z.string(),
    time_summary_method: z.string(),
    time_summary_numerator: z.string(),
    time_summary_denominator: z.string(),
    applies_mode: z.enum([APPLIES_TO_MODULE, APPLIES_TO_CHOSEN]),
    applies_to: z.array(z.string()),
    time_scale: z.string(),
    versions_mode: z.enum([VERSIONS_MODULE, VERSIONS_NONE, VERSIONS_CHOSEN]),
    versions_only: z.array(z.string()),
  })
  .superRefine((values, context) => {
    const need = (path: keyof LineItemValues, message: string) =>
      context.addIssue({ code: "custom", path: [path], message })
    if (values.format_type === "number" && values.unit === "currency") {
      if (!/^[A-Z]{3}$/.test(values.currency_code)) {
        need("currency_code", "Currency code must be three uppercase letters, such as USD.")
      }
    }
    if (values.format_type === "list" && values.list === "") {
      need("list", "Choose a list.")
    }
    if (values.summary_method === "ratio") {
      if (values.summary_numerator === "") {
        need("summary_numerator", "Choose the numerator.")
      }
      if (values.summary_denominator === "") {
        need("summary_denominator", "Choose the denominator.")
      }
    }
    if (values.time_summary_method === "ratio") {
      if (values.time_summary_numerator === "") {
        need("time_summary_numerator", "Choose the numerator.")
      }
      if (values.time_summary_denominator === "") {
        need("time_summary_denominator", "Choose the denominator.")
      }
    }
    if (values.versions_mode === VERSIONS_CHOSEN && values.versions_only.length === 0) {
      need("versions_only", "Choose at least one version.")
    }
  })

export type LineItemValues = z.infer<typeof lineItemSchema>

/** What a form holds of a summary method: its name and, for a ratio, its two parts. */
function summaryValues(method: SummaryMethod | null | undefined) {
  return {
    method: method?.method ?? SAME_AS_SUMMARY,
    numerator: method?.method === "ratio" ? method.numerator : "",
    denominator: method?.method === "ratio" ? method.denominator : "",
  }
}

function timeScaleValue(scale: TimeScale): string {
  if (scale === "module" || scale === "none") {
    return scale
  }
  return `${LEVEL_PREFIX}${scale.level}`
}

/** What a form holds of a line item, to start editing it from. */
export function lineItemValues(lineItem: LineItemDto, module: ModuleDto): LineItemValues {
  const format = lineItem.format
  const summary = summaryValues(lineItem.summary)
  const timeSummary = summaryValues(lineItem.time_summary)
  return {
    name: lineItem.name,
    code: lineItem.code ?? "",
    notes: lineItem.notes,
    formula: lineItem.formula ?? "",
    format_type: format.type,
    decimals: String(format.type === "number" ? format.decimals : 0),
    thousands_sep: format.type === "number" ? format.thousands_sep : true,
    unit: format.type === "number" ? format.unit.type : "none",
    currency_code:
      format.type === "number" && format.unit.type === "currency" ? format.unit.code : "",
    negative: format.type === "number" ? format.negative : "minus",
    list: format.type === "list" ? format.list : "",
    period_level:
      format.type === "time_period"
        ? (MODULE_TIME_LEVELS.find((level) => level === format.level) ?? "month")
        : "month",
    summary_method: summary.method,
    summary_numerator: summary.numerator,
    summary_denominator: summary.denominator,
    time_summary_method: timeSummary.method,
    time_summary_numerator: timeSummary.numerator,
    time_summary_denominator: timeSummary.denominator,
    applies_mode: lineItem.applies_to ? APPLIES_TO_CHOSEN : APPLIES_TO_MODULE,
    // Choosing dimensions starts from the module's own.
    applies_to: ownKeys(lineItem.applies_to ?? module.axes),
    time_scale: timeScaleValue(lineItem.time_scale),
    versions_mode:
      lineItem.versions === "module"
        ? VERSIONS_MODULE
        : lineItem.versions === "none"
          ? VERSIONS_NONE
          : VERSIONS_CHOSEN,
    versions_only: typeof lineItem.versions === "object" ? lineItem.versions.only : [],
  }
}

/** What a form holds of a format: its type and the options of each type. */
interface FormatOptions {
  format_type: FormatType
  decimals: string
  thousands_sep: boolean
  unit: "none" | "currency" | "percent"
  currency_code: string
  negative: "minus" | "parens"
  list: string
  period_level: TimeLevel
}

/** The options of a plain number, which a new number line item starts from. */
export const PLAIN_NUMBER = {
  decimals: "0",
  thousands_sep: true,
  unit: "none",
  currency_code: "",
  negative: "minus",
} as const

export function formatOf(options: FormatOptions): Format {
  switch (options.format_type) {
    case "number":
      return {
        type: "number",
        decimals: Number(options.decimals),
        thousands_sep: options.thousands_sep,
        unit:
          options.unit === "currency"
            ? { type: "currency", code: options.currency_code }
            : { type: options.unit },
        negative: options.negative,
      }
    case "list":
      return { type: "list", list: options.list }
    case "time_period":
      return { type: "time_period", level: options.period_level }
    default:
      return { type: options.format_type }
  }
}

function summaryOf(method: string, numerator: string, denominator: string): SummaryMethod {
  return method === "ratio"
    ? { method: "ratio", numerator, denominator }
    : ({ method } as SummaryMethod)
}

function timeScaleOf(value: string): TimeScale {
  if (value === TIME_SCALE_MODULE || value === TIME_SCALE_NONE) {
    return value
  }
  return { level: value.slice(LEVEL_PREFIX.length) as TimeLevel }
}

function versionsOf(values: LineItemValues): VersionsScope {
  switch (values.versions_mode) {
    case VERSIONS_MODULE:
      return "module"
    case VERSIONS_NONE:
      return "none"
    case VERSIONS_CHOSEN:
      return { only: values.versions_only }
  }
}

function appliesToOf(values: LineItemValues): Axis[] | null {
  return values.applies_mode === APPLIES_TO_CHOSEN ? ownAxes(values.applies_to) : null
}

/** Whether two JSON values are the same, whatever order their object keys came in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(item, b[index]))
    )
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every((key) => same(x[key], y[key]))
}

function formulaOf(values: LineItemValues): string | null {
  return values.formula.trim() === "" ? null : values.formula
}

/** Only what `values` changes about `saved`, in the shape the update endpoint takes. */
export function lineItemPatch(saved: LineItemDto, values: LineItemValues): UpdateLineItemRequest {
  const patch: UpdateLineItemRequest = {}
  const name = values.name.trim()
  if (name !== saved.name) {
    patch.name = name
  }
  const code = values.code.trim()
  if (code !== (saved.code ?? "")) {
    patch.code = code === "" ? null : code
  }
  if (values.notes !== saved.notes) {
    patch.notes = values.notes
  }
  const formula = formulaOf(values)
  if (formula !== (saved.formula ?? null)) {
    patch.formula = formula
  }
  const format = formatOf(values)
  if (!same(format, saved.format)) {
    patch.format = format
  }
  const summary = summaryOf(
    values.summary_method,
    values.summary_numerator,
    values.summary_denominator,
  )
  if (!same(summary, saved.summary)) {
    patch.summary = summary
  }
  const timeSummary =
    values.time_summary_method === SAME_AS_SUMMARY
      ? null
      : summaryOf(
          values.time_summary_method,
          values.time_summary_numerator,
          values.time_summary_denominator,
        )
  if (!same(timeSummary, saved.time_summary ?? null)) {
    patch.time_summary = timeSummary
  }
  const appliesTo = appliesToOf(values)
  if (!same(appliesTo, saved.applies_to ?? null)) {
    patch.applies_to = appliesTo
  }
  const timeScale = timeScaleOf(values.time_scale)
  if (!same(timeScale, saved.time_scale)) {
    patch.time_scale = timeScale
  }
  const versions = versionsOf(values)
  if (!same(versions, saved.versions)) {
    patch.versions = versions
  }
  return patch
}

/** Whether cells of the `saved` format cannot be read as cells of the `next` one. */
function reformats(saved: Format, next: Format): boolean {
  if (saved.type !== next.type) {
    return true
  }
  if (saved.type === "list" && next.type === "list") {
    return saved.list !== next.list
  }
  if (saved.type === "time_period" && next.type === "time_period") {
    return saved.level !== next.level
  }
  return false
}

/**
 * Whether saving `values` clears the values typed into an input line item: it changes what kind
 * of value the cells hold or which cells there are, or it becomes a calculated line item.
 */
export function clearsInputValues(saved: LineItemDto, values: LineItemValues): boolean {
  if (saved.formula) {
    return false
  }
  const patch = lineItemPatch(saved, values)
  return (
    reformats(saved.format, formatOf(values)) ||
    patch.applies_to !== undefined ||
    patch.time_scale !== undefined ||
    patch.versions !== undefined ||
    (patch.formula !== undefined && patch.formula !== null)
  )
}
