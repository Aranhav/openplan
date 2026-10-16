import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  createLineItemViaApi,
  createListViaApi,
  createModelViaApi,
  createModuleViaApi,
  deleteAllModels,
  login,
  screenshot,
  structureViaApi,
  toastWith,
  writeCellsViaApi,
} from "./helpers"

let baseURL: string
let modelId: string
let moduleId: string
let revenueId: string
let averageId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, "Formula plan")
  const regionsId = await createListViaApi(baseURL, ADMIN, modelId, "Regions", ["North", "South"])
  moduleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Sales",
    functional_area: "Finance",
    axes: [{ kind: "list", list: regionsId }],
  })
  const unitsId = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Units" })
  const priceId = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Price" })
  revenueId = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Revenue" })
  // A formula that uses every kind of token, for the colours.
  averageId = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Average price",
    formula: "IF Units > 0 THEN ROUND(Revenue / Units, 2) ELSE 0 // per unit",
  })
  const regions = (await structureViaApi(baseURL, ADMIN, modelId)).lists[0].items
  await writeCellsViaApi(baseURL, ADMIN, modelId, [
    { line_item_id: unitsId, coords: [regions[0].id], value: 10 },
    { line_item_id: unitsId, coords: [regions[1].id], value: 20 },
    { line_item_id: priceId, coords: [regions[0].id], value: 2 },
    { line_item_id: priceId, coords: [regions[1].id], value: 3 },
  ])
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

function gridCell(page: Page, row: number, col: number) {
  return page
    .getByRole("grid", { name: "Sales grid" })
    .locator(`[data-row='${row}'][data-col='${col}']`)
}

function formulaBar(page: Page) {
  return page.getByRole("group", { name: "Formula bar" })
}

/** Selects a cell of Revenue in the grid, which puts its formula in the bar, and clicks into the formula. */
async function editRevenueFormula(page: Page) {
  await page.goto(`/m/${modelId}/modules/${moduleId}`)
  await gridCell(page, 2, 0).click()
  const formula = formulaBar(page).getByRole("textbox", { name: "Formula of Revenue" })
  await formula.click()
  return formula
}

test("a builder types a formula with completions, sees what is wrong with it and saves it from the formula bar", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules/${moduleId}`)
  const bar = formulaBar(page)

  // The bar follows the active cell: the first one is a cell of Units.
  await expect(bar.getByText("Units", { exact: true })).toBeVisible()
  await expect(bar.getByRole("textbox", { name: "Formula of Units" })).toBeVisible()
  await gridCell(page, 2, 0).click()
  const formula = bar.getByRole("textbox", { name: "Formula of Revenue" })
  await expect(formula).toBeVisible()
  await expect(bar.getByText("Revenue", { exact: true })).toBeVisible()
  // Revenue holds typed values for now, so it has no formula and nothing to save.
  await expect(bar.getByRole("button", { name: "Save" })).toHaveCount(0)

  // Typing a name offers what the model has, and Enter picks the first.
  await formula.click()
  await page.keyboard.type("Un")
  const completions = page.getByRole("listbox")
  await expect(completions.getByRole("option", { name: /Units/ })).toBeVisible()
  await screenshot(page, "w5-completions", {
    ready: page.getByRole("listbox").getByRole("option", { name: /Units/ }),
    reopen: async () => {
      await editRevenueFormula(page)
      await page.keyboard.type("Un")
    },
  })
  await formula.click()
  await page.keyboard.press("End")
  // The list takes no key in the first moments, so that one typed on is not taken for a choice.
  await page.waitForTimeout(150)
  await page.keyboard.press("Enter")
  await expect(formula).toHaveText("Units")

  // A name that is not there is marked where it is, and the suggestion is in the message.
  await page.keyboard.type(" * Prce")
  await expect(bar.getByText("The formula has a problem.")).toBeVisible()
  await expect(bar).toContainText("Unknown name 'Prce'")
  await expect(bar).toContainText("Did you mean 'Price'?")
  await expect(formula).toHaveAttribute("aria-invalid", "true")
  await screenshot(page, "w5-diagnostic", {
    ready: formulaBar(page).getByText("The formula has a problem."),
    reopen: async () => {
      const reopened = await editRevenueFormula(page)
      await page.keyboard.type("Units * Prce")
      await expect(reopened).toHaveText("Units * Prce")
    },
  })

  // Fixing it takes the problem away, and Save puts the formula in the model.
  await formula.click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("Units * Price")
  await expect(bar.getByText(/The formula has/)).toBeHidden()
  await bar.getByRole("button", { name: "Save" }).click()
  // Revenue was an input line item, so what was typed into it goes.
  const confirm = page.getByRole("alertdialog", { name: "Clear input values?" })
  await confirm.getByRole("button", { name: "Save and clear values" }).click()
  await expect(toastWith(page, "Formula saved")).toBeVisible()
  await expect(bar.getByRole("button", { name: "Save" })).toHaveCount(0)

  // The cells of Revenue are calculated from those of Units and Price.
  await expect(gridCell(page, 2, 0)).toHaveText("20")
  await expect(gridCell(page, 2, 1)).toHaveText("60")
  await screenshot(page, "w5-bar-grid", {
    ready: gridCell(page, 2, 1).filter({ hasText: "60" }),
    reopen: async () => {
      await gridCell(page, 2, 0).click()
    },
  })

  // The Blueprint has the bar too, for the line item selected there.
  await page.goto(`/m/${modelId}/modules/${moduleId}?tab=blueprint&li=${revenueId}`)
  const blueprintFormula = formulaBar(page).getByRole("textbox", { name: "Formula of Revenue" })
  await expect(blueprintFormula).toHaveText("Units * Price")
  await page.goto(`/m/${modelId}/modules/${moduleId}?tab=blueprint&li=${averageId}`)
  await expect(
    formulaBar(page).getByRole("textbox", { name: "Formula of Average price" }),
  ).toHaveText("IF Units > 0 THEN ROUND(Revenue / Units, 2) ELSE 0 // per unit")
  await screenshot(page, "w5-bar-blueprint", {
    ready: formulaBar(page).getByRole("textbox", { name: "Formula of Average price" }),
  })
})

/** Opens the settings of Revenue and clicks into its formula. */
async function editRevenueFormulaInSettings(page: Page) {
  await page.goto(`/m/${modelId}/modules/${moduleId}?tab=blueprint&li=${revenueId}`)
  await page.getByRole("grid", { name: "Line items" }).press("Enter")
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  const formula = sheet.getByLabel("Formula")
  await expect(formula).toHaveText("Units * Price")
  await formula.click()
  await page.keyboard.press("ControlOrMeta+a")
  return { sheet, formula }
}

test("the formula is typed in the settings of a line item with the same editor, and a refusal is shown in it", async ({
  page,
}) => {
  await login(page, ADMIN)
  const { sheet, formula } = await editRevenueFormulaInSettings(page)

  // The list of completions opens in the sheet, and Escape closes it before it closes the sheet.
  await page.keyboard.type("Pr")
  const completions = page.getByRole("listbox")
  await expect(completions.getByRole("option", { name: /Price/ })).toBeVisible()
  await screenshot(page, "w5-sheet-completions", {
    ready: page.getByRole("listbox").getByRole("option", { name: /Price/ }),
    reopen: async () => {
      await editRevenueFormulaInSettings(page)
      await page.keyboard.type("Pr")
    },
  })
  await page.waitForTimeout(150)
  await page.keyboard.press("Escape")
  await expect(completions).toBeHidden()
  await expect(sheet).toBeVisible()

  // A formula the server refuses is listed under the editor, and the first problem is selected.
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("Units * Nothing")
  await page.keyboard.press("Enter")
  const problems = sheet.getByRole("alert")
  await expect(problems).toContainText("The formula has a problem.")
  await expect(problems).toContainText("Nothing")
  await expect(formula).toBeFocused()
  await expect(sheet).toBeVisible()
  await screenshot(page, "w5-sheet-problem", {
    ready: page
      .getByRole("dialog", { name: "Line item settings" })
      .getByText("The formula has a problem."),
    reopen: async () => {
      await editRevenueFormulaInSettings(page)
      await page.keyboard.type("Units * Nothing")
      await page.keyboard.press("Enter")
    },
  })
})
