import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"

export const regionsId = "0192f3a0-0000-7000-8000-000000000101"
export const productsId = "0192f3a0-0000-7000-8000-000000000102"
export const actualId = "0192f3a0-0000-7000-8000-000000000201"
export const forecastId = "0192f3a0-0000-7000-8000-000000000202"

/** A module with the dimensions of a regional plan; override any field to describe another. */
export function makeModule(overrides: Partial<ModuleDto> = {}): ModuleDto {
  return {
    id: "0192f3a0-0000-7000-8000-000000000301",
    name: "Pricing",
    functional_area: "",
    axes: [{ kind: "list", list: productsId }],
    ...overrides,
  }
}

/** An input line item holding plain numbers. */
export function makeLineItem(overrides: Partial<LineItemDto> = {}): LineItemDto {
  return {
    id: "0192f3a0-0000-7000-8000-000000000401",
    module: "0192f3a0-0000-7000-8000-000000000301",
    name: "Unit price",
    notes: "",
    ordinal: 0,
    format: {
      type: "number",
      decimals: 2,
      thousands_sep: true,
      unit: { type: "none" },
      negative: "minus",
    },
    summary: { method: "sum" },
    time_scale: "module",
    versions: "module",
    ...overrides,
  }
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/** The labels of the three calendar years from January 2026, as the server words them. */
const monthLabels = Array.from(
  { length: 36 },
  (_, index) => `${MONTH_NAMES[index % 12]} ${26 + Math.floor(index / 12)}`,
)

/** A structure with no lists, versions, modules or line items, on a calendar of three years from January 2026. */
export function makeStructure(overrides: Partial<StructureDto> = {}): StructureDto {
  return {
    format_version: 1,
    calendar: { first_year: 2026, fiscal_year_start_month: 1, years: 3 },
    month_labels: monthLabels,
    lists: [],
    subsets: [],
    versions: [],
    time_ranges: [],
    modules: [],
    line_items: [],
    ...overrides,
  }
}

export const pricingModule = makeModule()
export const headcountModule = makeModule({
  id: "0192f3a0-0000-7000-8000-000000000302",
  name: "Headcount",
  axes: [{ kind: "list", list: regionsId }],
})
export const revenueModule = makeModule({
  id: "0192f3a0-0000-7000-8000-000000000303",
  name: "Revenue",
  functional_area: "Finance",
  axes: [
    { kind: "list", list: regionsId },
    { kind: "list", list: productsId },
    { kind: "time", level: "month" },
    { kind: "versions" },
  ],
})
export const costsModule = makeModule({
  id: "0192f3a0-0000-7000-8000-000000000304",
  name: "Costs",
  functional_area: "Finance",
  axes: [
    { kind: "list", list: regionsId },
    { kind: "time", level: "quarter" },
  ],
})
export const hiringModule = makeModule({
  id: "0192f3a0-0000-7000-8000-000000000305",
  name: "Hiring plan",
  functional_area: "People",
  axes: [{ kind: "list", list: regionsId }],
})

export const unitPrice = makeLineItem({ module: pricingModule.id })
export const unitsSold = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000402",
  module: revenueModule.id,
  name: "Units sold",
  ordinal: 0,
  format: {
    type: "number",
    decimals: 0,
    thousands_sep: true,
    unit: { type: "none" },
    negative: "minus",
  },
})
export const revenueAmount = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000403",
  module: revenueModule.id,
  name: "Revenue amount",
  ordinal: 1,
  formula: "Units sold * Pricing.Unit price",
  format: {
    type: "number",
    decimals: 2,
    thousands_sep: true,
    unit: { type: "currency", code: "USD" },
    negative: "parens",
  },
})

/** A model with two lists, two versions and modules in two functional areas besides some outside any. */
export const structure = makeStructure({
  lists: [
    {
      id: regionsId,
      name: "Regions",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [],
    },
    {
      id: productsId,
      name: "Products",
      numbered: false,
      production_data: false,
      selective_access: false,
      items: [],
    },
  ],
  versions: [
    { id: actualId, name: "Actual", is_actual: true, is_current: false },
    { id: forecastId, name: "Forecast", is_actual: false, is_current: true },
  ],
  modules: [revenueModule, pricingModule, hiringModule, costsModule, headcountModule],
  line_items: [unitPrice, unitsSold, revenueAmount],
})

/** A percentage of Revenue with every setting of its own: a summary, a time scale, versions, lists and notes. */
export const revenueMargin = makeLineItem({
  id: "0192f3a0-0000-7000-8000-000000000404",
  module: revenueModule.id,
  name: "Margin",
  ordinal: 2,
  notes: "Before tax",
  format: {
    type: "number",
    decimals: 1,
    thousands_sep: true,
    unit: { type: "percent" },
    negative: "minus",
  },
  summary: { method: "average" },
  time_scale: { level: "year" },
  versions: { only: [forecastId] },
  applies_to: [{ kind: "list", list: regionsId }],
})

/** `structure` with the three line items of Revenue in it. */
export const revenuePlan = makeStructure({
  ...structure,
  line_items: [unitsSold, revenueAmount, revenueMargin],
})
