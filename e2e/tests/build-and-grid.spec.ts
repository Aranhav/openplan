import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  type User,
  createMemberViaApi,
  createModelViaApi,
  deleteAllModels,
  login,
  screenshot,
  toastWith,
} from "./helpers"

const MODEL_NAME = "Plan FY26"
const MODULE_NAME = "Revenue Plan"
// The accounts of the specs share one database: no other spec uses these addresses.
const BUILDER: User = {
  name: "Bea Builder",
  email: "bea@acme.test",
  password: "builder-password-5",
}
const VIEWER: User = { name: "Vin Viewer", email: "vin@acme.test", password: "viewer-password-5" }

let baseURL: string
let modelId: string
let moduleId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  await createMemberViaApi(baseURL, ADMIN, BUILDER, "builder")
  await createMemberViaApi(baseURL, ADMIN, VIEWER, "viewer")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

const buildNav = (page: Page) => page.getByRole("navigation", { name: "Build" })

/** The card with this heading, to look for its controls within. */
function card(page: Page, title: string) {
  return page
    .getByRole("heading", { name: title, level: 2 })
    .locator("xpath=ancestor::*[@data-slot='card']")
}

async function newList(page: Page, name: string, options: { parent?: string; top?: string } = {}) {
  await page.getByRole("button", { name: "New list" }).first().click()
  const dialog = page.getByRole("dialog", { name: "New list" })
  await dialog.getByLabel("Name", { exact: true }).fill(name)
  if (options.parent) {
    await dialog.getByRole("combobox", { name: "Parent list" }).click()
    await page.getByRole("option", { name: options.parent }).click()
  }
  if (options.top) {
    await dialog.getByLabel("Top level name").fill(options.top)
  }
  await dialog.getByRole("button", { name: "Create list" }).click()
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
}

async function bulkAdd(page: Page, lines: string[], added: string) {
  await page.getByRole("button", { name: "Bulk add" }).click()
  const dialog = page.getByRole("dialog", { name: "Bulk add items" })
  await dialog.getByRole("textbox", { name: "Items" }).fill(lines.join("\n"))
  await dialog.getByRole("button", { name: "Add items" }).click()
  await expect(toastWith(page, added)).toBeVisible()
  await expect(dialog).toBeHidden()
}

test("a builder makes the lists", async ({ page }) => {
  await login(page, BUILDER)
  await page.goto(`/m/${modelId}/lists`)
  await expect(page.getByRole("heading", { name: "No lists yet" })).toBeVisible()

  // Regions has a top level that sums them all; Countries hangs under it and has one of its own.
  await newList(page, "Regions", { top: "All Regions" })
  await bulkAdd(page, ["North America", "Europe"], "Added 2 items")
  await page.goto(`/m/${modelId}/lists`)
  await newList(page, "Countries", { parent: "Regions", top: "All Countries" })
  await bulkAdd(
    page,
    ["US, North America", "Canada, North America", "France, Europe", "Germany, Europe"],
    "Added 4 items",
  )
  const items = page.getByRole("table", { name: "Items of Countries" })
  await expect(items.getByRole("button", { name: "North America, 2 items" })).toBeVisible()
  await expect(items.getByRole("button", { name: "Europe, 2 items" })).toBeVisible()
  await screenshot(page, "m3-list-items", { ready: items })

  await buildNav(page).getByRole("link", { name: "Lists" }).click()
  const lists = page.getByRole("table", { name: "Lists" })
  await expect(lists.getByRole("row", { name: /^Regions/ })).toContainText("All Regions")
  await expect(lists.getByRole("row", { name: /^Countries/ })).toContainText("Regions")
  await expect(lists.getByRole("row", { name: /^Countries/ })).toContainText("All Countries")
  await screenshot(page, "m3-lists", { ready: lists })
})

test("a builder sets two years from January and the forecast switchover", async ({ page }) => {
  await login(page, BUILDER)
  await page.goto(`/m/${modelId}/time`)
  const calendar = card(page, "Calendar")
  await expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toHaveText("January")
  await calendar.getByLabel("First fiscal year").fill("2026")
  await calendar.getByLabel("Years", { exact: true }).fill("2")
  await calendar.getByRole("button", { name: "Save changes" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Change the timeline?" })
  await confirm.getByRole("button", { name: "Change timeline" }).click()
  await expect(toastWith(page, "Calendar saved")).toBeVisible()
  const preview = page.getByRole("table", { name: "Timeline preview" })
  await expect(preview.getByRole("row", { name: /^FY26/ })).toContainText("Jan 26 – Dec 26")
  await expect(preview.getByRole("row", { name: /^FY27/ })).toContainText("Jan 27 – Dec 27")
  await expect(preview.getByRole("row")).toHaveCount(3)
  await screenshot(page, "m3-time", { ready: preview })

  await buildNav(page).getByRole("link", { name: "Versions" }).click()
  const versions = page.getByRole("table", { name: "Versions" })
  await versions.getByRole("combobox", { name: "Switchover for Forecast" }).click()
  await page.getByRole("option", { name: "Apr 26" }).click()
  await expect(toastWith(page, "Switchover updated")).toBeVisible()
  await page.reload()
  await expect(versions.getByRole("combobox", { name: "Switchover for Forecast" })).toHaveText(
    "Apr 26",
  )
  await screenshot(page, "m3-versions", { ready: versions })
})

const formulaBar = (page: Page) => page.getByRole("group", { name: "Formula bar" })

function blueprintRow(page: Page, name: string) {
  return page
    .getByRole("grid", { name: "Line items" })
    .locator("tbody tr")
    .filter({ has: page.getByText(name, { exact: true }) })
}

async function addLineItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Add line item" }).click()
  const dialog = page.getByRole("dialog", { name: "Add line item" })
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByRole("button", { name: "Add line item" }).click()
  await expect(dialog).toBeHidden()
  await expect(blueprintRow(page, name)).toBeVisible()
}

/**
 * Saves the formula in the bar, and waits for the bar to have nothing left to save (the toast of
 * a save before it may still be on screen). An input line item that becomes a calculated one loses
 * its values, which is confirmed first.
 */
async function saveFormula(page: Page) {
  const save = formulaBar(page).getByRole("button", { name: "Save" })
  await save.click()
  await page
    .getByRole("alertdialog", { name: "Clear input values?" })
    .getByRole("button", { name: "Save and clear values" })
    .click()
  await expect(save).toHaveCount(0)
}

test("a builder makes a module of countries, months and versions, and writes its formulas in the bar", async ({
  page,
}) => {
  await login(page, BUILDER)
  await page.goto(`/m/${modelId}/modules`)
  await expect(page.getByRole("heading", { name: "No modules yet", level: 2 })).toBeVisible()
  await page.getByRole("button", { name: "New module" }).click()
  const dialog = page.getByRole("dialog", { name: "New module" })
  await dialog.getByLabel("Name").fill(MODULE_NAME)
  await dialog.getByLabel("Functional area").fill("Finance")
  await dialog.getByRole("checkbox", { name: /Countries/ }).check()
  await dialog.getByRole("switch", { name: "Time" }).click()
  await dialog.getByRole("combobox", { name: "Time level" }).click()
  await page.getByRole("option", { name: "Month" }).click()
  await dialog.getByRole("switch", { name: "Versions" }).click()
  await dialog.getByRole("button", { name: "Create module" }).click()
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}\?tab=blueprint$/)
  moduleId = /\/modules\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
  await expect(page.getByRole("heading", { name: MODULE_NAME, level: 1 })).toBeVisible()

  for (const name of ["Units", "Price", "Revenue", "Cost", "Margin %"]) {
    await addLineItem(page, name)
  }

  // Revenue is Units times Price: the name of Units is picked from what the model offers.
  await blueprintRow(page, "Revenue").getByText("Revenue", { exact: true }).click()
  const bar = formulaBar(page)
  const revenue = bar.getByRole("textbox", { name: "Formula of Revenue" })
  await revenue.click()
  await page.keyboard.type("Un")
  const completions = page.getByRole("listbox")
  await expect(completions.getByRole("option", { name: /Units/ })).toBeVisible()
  await screenshot(page, "m3-formula-completions", {
    ready: page.getByRole("listbox").getByRole("option", { name: /Units/ }),
    reopen: async () => {
      await revenue.click()
      await page.keyboard.type("Un")
    },
  })
  await completions.getByRole("option", { name: /Units/ }).click()
  await expect(revenue).toHaveText("Units")
  await page.keyboard.type(" * Price")
  await expect(revenue).toHaveText("Units * Price")
  await saveFormula(page)
  await expect(blueprintRow(page, "Revenue")).toContainText("Units * Price")

  // A name that is not there is marked with the server's suggestion, until it is put right.
  await blueprintRow(page, "Margin %").getByText("Margin %", { exact: true }).click()
  const margin = bar.getByRole("textbox", { name: "Formula of Margin %" })
  await margin.click()
  await page.keyboard.type("IF Revenue > 0 THEN (Revenue - Cst) / Revenue ELSE 0")
  await expect(bar.getByText("The formula has a problem.")).toBeVisible()
  await expect(bar).toContainText("Unknown name 'Cst'")
  await expect(bar).toContainText("Did you mean 'Cost'?")
  await expect(margin).toHaveAttribute("aria-invalid", "true")
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("IF Revenue > 0 THEN (Revenue - Cost) / Revenue ELSE 0")
  await expect(bar.getByText(/The formula has/)).toBeHidden()
  await expect(margin).not.toHaveAttribute("aria-invalid", "true")
  await saveFormula(page)
  await expect(blueprintRow(page, "Margin %")).toContainText("IF Revenue > 0 THEN")

  // The settings of a line item open beside the Blueprint.
  await blueprintRow(page, "Units").getByText("Units", { exact: true }).click()
  await page.getByRole("grid", { name: "Line items" }).press("Enter")
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  await expect(sheet.getByLabel("Name")).toHaveValue("Units")
  await screenshot(page, "m3-blueprint-settings", {
    ready: sheet,
    reopen: async () => {
      await page.getByRole("grid", { name: "Line items" }).press("Enter")
    },
  })
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()

  await page.goto(`/m/${modelId}/modules`)
  const modules = page.getByRole("link", { name: new RegExp(MODULE_NAME) })
  await expect(modules.first()).toBeVisible()
  await screenshot(page, "m3-modules", { ready: modules.first() })
})

const grid = (page: Page) => page.getByRole("grid", { name: `${MODULE_NAME} grid` })
const controls = (page: Page) => page.getByRole("group", { name: "Grid controls" })
const corner = (page: Page) => grid(page).locator("[data-corner-label]")

// The grid as it first opens: a line item to a row, the months and their quarters across.
const ROW = { Units: 0, Price: 1, Revenue: 2, Cost: 3, "Margin %": 4 }
const COLUMN = { "Jan 26": 0, "Feb 26": 1, "Mar 26": 2, "Q1 FY26": 3, "Apr 26": 4 }

function cellAt(page: Page, lineItem: keyof typeof ROW, month: keyof typeof COLUMN) {
  return grid(page).locator(`[data-row='${ROW[lineItem]}'][data-col='${COLUMN[month]}']`)
}

async function openGrid(page: Page) {
  await page.goto(`/m/${modelId}/modules/${moduleId}`)
  await expect(grid(page)).toBeVisible()
  await expect(cellAt(page, "Units", "Jan 26")).toBeVisible()
}

async function typeInto(
  page: Page,
  lineItem: keyof typeof ROW,
  month: keyof typeof COLUMN,
  text: string,
) {
  await cellAt(page, lineItem, month).click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect(cellAt(page, lineItem, month)).toHaveText(text)
}

async function choosePage(page: Page, dimension: string, member: string) {
  const selector = controls(page).getByRole("combobox", { name: new RegExp(`^${dimension}`) })
  await selector.click()
  await page.getByRole("option", { name: member }).click()
  await expect(selector).toContainText(member)
}

test("a builder types and pastes values in the Budget and reads the totals", async ({ page }) => {
  await login(page, BUILDER)
  await openGrid(page)
  const bar = controls(page)
  await expect(bar.getByRole("combobox", { name: /^Versions/ })).toContainText("Budget")
  // The grid opens on the top level of Countries, which only adds up the cells below it.
  await expect(bar.getByRole("combobox", { name: /^Countries/ })).toContainText("All Countries")
  await expect(cellAt(page, "Units", "Jan 26")).toHaveAttribute("aria-readonly", "true")

  // Units and Price of the first quarter, typed over the cells of the US.
  await choosePage(page, "Countries", "US")
  for (const [month, units, price] of [
    ["Jan 26", "10", "5"],
    ["Feb 26", "12", "5"],
    ["Mar 26", "14", "6"],
  ] as const) {
    await typeInto(page, "Units", month, units)
    await typeInto(page, "Price", month, price)
  }
  await expect(cellAt(page, "Revenue", "Jan 26")).toHaveText("50")
  await expect(cellAt(page, "Revenue", "Feb 26")).toHaveText("60")
  await expect(cellAt(page, "Revenue", "Mar 26")).toHaveText("84")
  await expect(cellAt(page, "Revenue", "Q1 FY26")).toHaveText("194")
  await expect(cellAt(page, "Units", "Q1 FY26")).toHaveText("36")

  // A block of two rows and three columns, as copied from a spreadsheet, pasted over Canada.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await choosePage(page, "Countries", "Canada")
  await page.evaluate(() => navigator.clipboard.writeText("20\t30\t40\n2\t2\t3"))
  await cellAt(page, "Units", "Jan 26").click()
  await page.keyboard.press("ControlOrMeta+v")
  await expect(cellAt(page, "Units", "Mar 26")).toHaveText("40")
  await expect(cellAt(page, "Price", "Mar 26")).toHaveText("3")
  await expect(cellAt(page, "Units", "Jan 26")).toHaveText("20")
  await expect(cellAt(page, "Price", "Feb 26")).toHaveText("2")
  await expect(cellAt(page, "Revenue", "Jan 26")).toHaveText("40")
  await expect(cellAt(page, "Revenue", "Feb 26")).toHaveText("60")
  await expect(cellAt(page, "Revenue", "Mar 26")).toHaveText("120")
  await expect(cellAt(page, "Revenue", "Q1 FY26")).toHaveText("220")

  // The levels above the countries add them up: the region, and the top level of all of them.
  await choosePage(page, "Countries", "North America")
  await expect(cellAt(page, "Units", "Jan 26")).toHaveText("30")
  await expect(cellAt(page, "Revenue", "Q1 FY26")).toHaveText("414")
  await choosePage(page, "Countries", "All Countries")
  await expect(cellAt(page, "Units", "Q1 FY26")).toHaveText("126")
  await expect(cellAt(page, "Revenue", "Jan 26")).toHaveText("90")
  await expect(cellAt(page, "Revenue", "Q1 FY26")).toHaveText("414")
  await choosePage(page, "Countries", "Europe")
  await expect(cellAt(page, "Revenue", "Q1 FY26")).toHaveText("0")
})

test("the Forecast shows the Actual before its switchover, where the cells are read-only", async ({
  page,
}) => {
  await login(page, BUILDER)
  await openGrid(page)
  await choosePage(page, "Countries", "US")

  // The Actual of January, typed in the Actual version.
  await choosePage(page, "Versions", "Actual")
  await typeInto(page, "Units", "Jan 26", "7")

  // The Forecast shows it for January, and takes values of its own from April.
  await choosePage(page, "Versions", "Forecast")
  const january = cellAt(page, "Units", "Jan 26")
  await expect(january).toHaveText("7")
  await expect(january).toHaveAttribute("aria-readonly", "true")
  await expect(january).toHaveAttribute("data-note", "switchover")
  await january.hover()
  await expect(page.getByRole("tooltip")).toHaveText("Before the switchover: showing Actual.")
  // Typing over it opens no editor, and the value stays.
  await january.click()
  await page.keyboard.type("9")
  await expect(grid(page).getByRole("textbox")).toHaveCount(0)
  await page.keyboard.press("Enter")
  await expect(january).toHaveText("7")
  await expect(cellAt(page, "Units", "Apr 26")).not.toHaveAttribute("aria-readonly", "true")
  await typeInto(page, "Units", "Apr 26", "8")

  // The Budget has neither: January is its own, April is empty.
  await choosePage(page, "Versions", "Budget")
  await expect(cellAt(page, "Units", "Jan 26")).toHaveText("10")
  await expect(cellAt(page, "Units", "Apr 26")).toHaveText("0")
})

// The grid with the versions across: each month has the Actual, the Budget and the Forecast.
const VERSION_COLUMN = { Actual: 0, Budget: 1, Forecast: 2 }
const PIVOTED_COLUMN = { "Jan 26": 0, "Feb 26": 3 }

function pivotedCell(
  page: Page,
  lineItem: keyof typeof ROW,
  month: keyof typeof PIVOTED_COLUMN,
  version: keyof typeof VERSION_COLUMN,
) {
  const col = PIVOTED_COLUMN[month] + VERSION_COLUMN[version]
  return grid(page).locator(`[data-row='${ROW[lineItem]}'][data-col='${col}']`)
}

test("a builder pivots the versions to the columns, saves the view as the default, and adds a rule", async ({
  page,
}) => {
  await login(page, BUILDER)
  await openGrid(page)
  const bar = controls(page)
  await choosePage(page, "Countries", "US")
  await bar.getByRole("button", { name: "Pivot" }).click()
  await expect(page.getByRole("dialog", { name: "Pivot" })).toBeVisible()
  await screenshot(page, "m3-grid-pivot", {
    ready: page.getByRole("dialog", { name: "Pivot" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: "Pivot" }).click()
    },
  })
  await page.getByRole("button", { name: "Move Versions" }).click()
  await page.getByRole("menuitem", { name: "Move to Columns" }).click()
  await page.keyboard.press("Escape")
  await expect(corner(page)).toHaveText("Line items / Months, Versions")
  await expect(bar.getByRole("combobox", { name: /^Versions/ })).toHaveCount(0)
  await expect(bar.getByText("Modified")).toBeVisible()
  await expect(pivotedCell(page, "Units", "Jan 26", "Actual")).toHaveText("7")
  await expect(pivotedCell(page, "Units", "Jan 26", "Budget")).toHaveText("10")
  await expect(pivotedCell(page, "Units", "Jan 26", "Forecast")).toHaveText("7")

  // Saved as the default view of the module, which then opens on it.
  await bar.getByRole("button", { name: "View actions" }).click()
  await page.getByRole("menuitem", { name: "Save as…" }).click()
  const save = page.getByRole("dialog", { name: "Save as a new view" })
  await save.getByLabel("Name").fill("By version")
  await save.getByRole("checkbox", { name: "Set as default" }).click()
  await save.getByRole("button", { name: "Save view" }).click()
  await expect(toastWith(page, "View saved")).toBeVisible()
  await expect(bar.getByText("Modified")).toHaveCount(0)
  await page.reload()
  await expect(grid(page)).toBeVisible()
  await expect(bar.getByRole("combobox", { name: "Saved view" })).toContainText("By version")
  await expect(corner(page)).toHaveText("Line items / Months, Versions")
  await expect(pivotedCell(page, "Units", "Jan 26", "Budget")).toHaveText("10")
  await expect(bar.getByText("Modified")).toHaveCount(0)

  // A rule colours the cells that pass it: the units of February are over 10, January is not.
  await bar.getByRole("button", { name: "Conditional formatting" }).click()
  const rules = page.getByRole("dialog", { name: "Conditional formatting" })
  await rules.getByRole("button", { name: "Add rule" }).click()
  await rules.getByRole("textbox", { name: "Name of rule 1" }).fill("Over 10")
  await rules.getByRole("combobox", { name: /Condition of rule 1/ }).click()
  await page.getByRole("option", { name: "is greater than" }).click()
  await rules.getByRole("textbox", { name: "Value of rule 1" }).fill("10")
  await rules
    .getByRole("radiogroup", { name: "Colour of rule 1" })
    .getByRole("radio", { name: "Green" })
    .click()
  await rules.getByRole("button", { name: "Apply rules" }).click()
  await expect(pivotedCell(page, "Units", "Feb 26", "Budget")).toHaveClass(/bg-green-500\/15/)
  await expect(pivotedCell(page, "Units", "Jan 26", "Budget")).not.toHaveClass(/bg-green-500\/15/)
  await expect(bar.getByText("Modified")).toBeVisible()

  // The last edit is taken back with the keyboard.
  const february = pivotedCell(page, "Units", "Feb 26", "Budget")
  await expect(february).toHaveText("12")
  await february.click()
  await page.keyboard.type("99")
  await page.keyboard.press("Enter")
  await expect(february).toHaveText("99")
  await page.keyboard.press("ControlOrMeta+z")
  await expect(february).toHaveText("12")
})

test("a viewer sees the grid as it was saved, and cannot change it", async ({ page }) => {
  await login(page, VIEWER)
  await openGrid(page)
  const bar = controls(page)
  await expect(grid(page)).toHaveAttribute("aria-readonly", "true")
  await expect(bar.getByRole("combobox", { name: "Saved view" })).toContainText("By version")
  await expect(pivotedCell(page, "Units", "Jan 26", "Budget")).toHaveText("10")

  // Typing over a cell does nothing, and the formula bar only shows the formula.
  const cell = pivotedCell(page, "Units", "Jan 26", "Budget")
  await cell.click()
  await page.keyboard.type("55")
  await expect(grid(page).getByRole("textbox")).toHaveCount(0)
  await page.keyboard.press("Enter")
  await expect(cell).toHaveText("10")
  await expect(formulaBar(page).getByRole("textbox", { name: "Formula of Units" })).toHaveAttribute(
    "aria-readonly",
    "true",
  )
  await expect(bar.getByRole("button", { name: "View actions" })).toHaveCount(0)
})

test("the secondary controls of the toolbar are in a More menu at 900 px", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 })
  await login(page, BUILDER)
  await openGrid(page)
  const bar = controls(page)
  await expect(bar.getByRole("button", { name: "Filter" })).toHaveCount(0)
  await bar.getByRole("button", { name: "More" }).click()
  await expect(page.getByRole("menuitem", { name: "Filter…" })).toBeVisible()
  await screenshot(page, "m3-grid-more-menu-900", {
    ready: page.getByRole("menuitem", { name: "Filter…" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: "More" }).click()
    },
    fullPage: false,
  })
})
