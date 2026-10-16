import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  axeViolations,
  createLineItemViaApi,
  createModelViaApi,
  createModuleViaApi,
  deleteAllModels,
  login,
  structureViaApi,
  withApi,
  writeCellsViaApi,
} from "./helpers"

const MODEL_NAME = "Accessibility plan"
const MODULE_NAME = "Revenue Plan"
let baseURL: string
let modelId: string
let moduleId: string
let countriesId: string

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  const lists = `/api/v1/models/${modelId}/lists`
  await withApi(baseURL, ADMIN, async (api) => {
    const regions = await api.post<{ id: string }>(lists, {
      name: "Regions",
      top_level_name: "All Regions",
    })
    await api.post(`${lists}/${regions.id}/items`, {
      items: [{ name: "North America" }, { name: "Europe" }],
    })
    const structure = await structureViaApi(baseURL, ADMIN, modelId)
    const [northAmerica, europe] = structure.lists.find((list) => list.name === "Regions")
      ?.items as { id: string }[]
    const countries = await api.post<{ id: string }>(lists, {
      name: "Countries",
      parent_list_id: regions.id,
      top_level_name: "All Countries",
    })
    countriesId = countries.id
    await api.post(`${lists}/${countries.id}/items`, {
      items: [
        { name: "US", parent_id: northAmerica.id },
        { name: "Canada", parent_id: northAmerica.id },
        { name: "France", parent_id: europe.id },
        { name: "Germany", parent_id: europe.id },
      ],
    })
  })
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const countries = structure.lists.find((list) => list.name === "Countries")?.items as {
    id: string
    name: string
  }[]
  await withApi(baseURL, ADMIN, (api) =>
    api.post(`/api/v1/models/${modelId}/subsets`, {
      list_id: countriesId,
      name: "Euro area",
      item_ids: countries.filter((item) => ["France", "Germany"].includes(item.name)).map((i) => i.id),
    }),
  )
  moduleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: MODULE_NAME,
    functional_area: "Finance",
    axes: [{ kind: "list", list: countriesId }, { kind: "time", level: "quarter" }],
  })
  const units = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Units" })
  const price = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Price" })
  await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Revenue",
    formula: "Units * Price",
  })
  const year = structure.calendar.first_year
  const quarter = (n: number) => `Q${n} FY${String(year % 100).padStart(2, "0")}`
  const us = countries.find((item) => item.name === "US") as { id: string }
  await writeCellsViaApi(
    baseURL,
    ADMIN,
    modelId,
    [1, 2, 3, 4].flatMap((n) => [
      { line_item_id: units, coords: [us.id, quarter(n)], value: 100 + n * 20 },
      { line_item_id: price, coords: [us.id, quarter(n)], value: 5 + n },
    ]),
  )
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

const grid = (page: Page) => page.getByRole("grid", { name: `${MODULE_NAME} grid` })
const controls = (page: Page) => page.getByRole("group", { name: "Grid controls" })
const formulaBar = (page: Page) => page.getByRole("group", { name: "Formula bar" })

/**
 * Walks the screens of the build and the grid with axe, in one theme. Every screen that is
 * checked goes into `found` with what axe says; the test fails at the end with all of them, so
 * one run shows everything there is to fix.
 */
async function audit(page: Page) {
  const found: Record<string, string[]> = {}
  async function check(screen: string, options: Parameters<typeof axeViolations>[1] = {}) {
    const violations = await axeViolations(page, options)
    if (violations.length > 0) {
      found[screen] = violations
    }
  }
  const path = (rest: string) => `/m/${modelId}/${rest}`

  await page.goto(path("lists"))
  await expect(page.getByRole("table", { name: "Lists" })).toBeVisible()
  await check("Lists")

  await page.goto(path(`lists/${countriesId}`))
  await expect(page.getByRole("table", { name: "Items of Countries" })).toBeVisible()
  await check("List items")

  await page.getByRole("button", { name: "Subsets" }).click()
  const subsets = page.getByRole("dialog", { name: "Subsets of Countries" })
  await subsets.getByRole("button", { name: "Choose the items of Euro area" }).click()
  await expect(subsets.getByRole("list", { name: "Items in Euro area" })).toBeVisible()
  await check("Subsets sheet")
  await page.keyboard.press("Escape")
  await expect(subsets).toBeHidden()

  await page.goto(path("time"))
  await expect(page.getByRole("table", { name: "Timeline preview" })).toBeVisible()
  await check("Time")

  await page.goto(path("versions"))
  await expect(page.getByRole("table", { name: "Versions" })).toBeVisible()
  await check("Versions")

  await page.goto(path("modules"))
  await expect(page.getByRole("link", { name: new RegExp(MODULE_NAME) }).first()).toBeVisible()
  await check("Modules")

  await page.goto(path(`modules/${moduleId}?tab=blueprint`))
  const lineItems = page.getByRole("grid", { name: "Line items" })
  await expect(lineItems).toBeVisible()
  await check("Blueprint")
  await lineItems.getByText("Units", { exact: true }).click()
  await lineItems.press("Enter")
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  await expect(sheet.getByLabel("Name")).toHaveValue("Units")
  await check("Line item sheet")
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()

  await page.goto(path(`modules/${moduleId}`))
  await expect(grid(page)).toBeVisible()
  await expect(grid(page).locator("[data-row='0'][data-col='0']")).toHaveText("120")
  await check("Grid with the toolbar")

  const bar = controls(page)
  await bar.getByRole("button", { name: "Pivot" }).click()
  await expect(page.getByRole("dialog", { name: "Pivot" })).toBeVisible()
  await check("Pivot popover")
  await page.keyboard.press("Escape")

  await bar.getByRole("button", { name: "Filter" }).click()
  const filter = page.getByRole("dialog", { name: "Filter rows" })
  await filter.getByRole("button", { name: "Add filter" }).click()
  await filter.getByRole("textbox", { name: "Value of filter 1" }).fill("110")
  await check("Filter popover")
  await page.keyboard.press("Escape")

  await bar.getByRole("button", { name: "Show/hide" }).click()
  await expect(page.getByRole("dialog", { name: "Show or hide members" })).toBeVisible()
  await check("Show/hide popover")
  await page.keyboard.press("Escape")

  await bar.getByRole("button", { name: "Conditional formatting" }).click()
  const rules = page.getByRole("dialog", { name: "Conditional formatting" })
  await rules.getByRole("button", { name: "Add rule" }).click()
  await rules.getByRole("textbox", { name: "Name of rule 1" }).fill("Over 120")
  await rules.getByRole("combobox", { name: /Condition of rule 1/ }).click()
  await page.getByRole("option", { name: "is greater than" }).click()
  await rules.getByRole("textbox", { name: "Value of rule 1" }).fill("120")
  await rules
    .getByRole("radiogroup", { name: "Colour of rule 1" })
    .getByRole("radio", { name: "Green" })
    .click()
  await check("Conditional formatting sheet")
  await rules.getByRole("button", { name: "Apply rules" }).click()
  await expect(grid(page).locator("[data-row='0'][data-col='1']")).toHaveClass(/bg-green-500/)
  // The focus is back on the button that opened the sheet, which has a tooltip of its name.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await check("Grid with a conditional format")

  await bar.getByRole("combobox", { name: "Saved view" }).click()
  await expect(page.getByRole("listbox").getByRole("option", { name: "Default" })).toBeVisible()
  await check("Saved views list", { within: "[role=listbox]" })
  await page.keyboard.press("Escape")
  await bar.getByRole("button", { name: "View actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Save as…" })).toBeVisible()
  await check("Saved views menu", { within: "[role=menu]" })
  await page.keyboard.press("Escape")

  // The cells of Revenue are calculated, so the bar has a formula for the cell that is active.
  await grid(page).locator("[data-row='2'][data-col='0']").click()
  const formula = formulaBar(page).getByRole("textbox", { name: "Formula of Revenue" })
  await formula.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("Un")
  await expect(page.getByRole("listbox").getByRole("option", { name: /Units/ })).toBeVisible()
  await check("Formula bar with completions")
  await page.keyboard.press("Escape")
  await page.keyboard.type("its * Prce")
  await expect(formulaBar(page).getByText("The formula has a problem.")).toBeVisible()
  await check("Formula bar with a problem")

  return found
}

for (const theme of ["light", "dark"] as const) {
  test(`the screens of the build and the grid have no accessibility violations in the ${theme} theme`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await login(page, ADMIN)
    await page.evaluate((value) => localStorage.setItem("openplan-theme", value), theme)
    await page.reload()
    if (theme === "dark") {
      await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    } else {
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
    }

    expect(await audit(page)).toEqual({})
  })
}
