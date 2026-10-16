import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  createLineItemViaApi,
  createListViaApi,
  createMemberViaApi,
  createModelViaApi,
  createModuleViaApi,
  deleteAllModels,
  deleteLineItemViaApi,
  login,
  screenshot,
  structureViaApi,
  toastWith,
  writeCellsViaApi,
} from "./helpers"

const MODEL_NAME = "Plan FY27"
const VIEWER = { name: "Vic Viewer", email: "vic@acme.test", password: "viewer-password-3" }
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

let baseURL: string
let modelId: string
let regionsId: string
let productsId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  regionsId = await createListViaApi(baseURL, ADMIN, modelId, "Regions", ["North", "South", "West"])
  productsId = await createListViaApi(baseURL, ADMIN, modelId, "Products", ["Widgets", "Gadgets"])
  await createMemberViaApi(baseURL, ADMIN, VIEWER, "viewer")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

/** The line items of the Blueprint in the order it lists them. */
async function lineItemNames(page: Page) {
  return page
    .getByRole("grid", { name: "Line items" })
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => row.querySelector("[title]")?.getAttribute("title")))
}

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

/** Whether the page is wider than the screen, which no page may be. */
async function scrollsSideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
}

function gridCell(page: Page, row: number, col: number) {
  return page
    .getByRole("grid", { name: "Revenue grid" })
    .locator(`[data-row='${row}'][data-col='${col}']`)
}

/** Opens the dialog for a new module and fills it for the module of the main test. */
async function fillNewModule(page: Page) {
  await page.getByRole("button", { name: "New module" }).click()
  const dialog = page.getByRole("dialog", { name: "New module" })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Name").fill("Revenue")
  await dialog.getByLabel("Functional area").fill("Finance")
  // The dimensions are ordered as they are ticked, and moved up and down.
  await dialog.getByRole("checkbox", { name: /Regions/ }).check()
  await dialog.getByRole("checkbox", { name: /Products/ }).check()
  await dialog.getByRole("button", { name: "Move Products up" }).click()
  await dialog.getByRole("switch", { name: "Time" }).click()
  await dialog.getByRole("combobox", { name: "Time level" }).click()
  await page.getByRole("option", { name: "Quarter" }).click()
  return dialog
}

test("a builder creates a module, adds line items, reorders them and enters a value", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules`)
  await expect(page.getByRole("heading", { name: "No modules yet", level: 2 })).toBeVisible()

  const dialog = await fillNewModule(page)
  const order = dialog.getByRole("list", { name: "Order of dimensions" })
  await expect(order.getByRole("listitem")).toHaveText(["1Products", "2Regions"])
  await screenshot(page, "w3-new-module", {
    ready: page.getByRole("dialog", { name: "New module" }),
    reopen: async () => {
      await fillNewModule(page)
    },
  })
  // The dialog is open again, as filled, after the last reload.
  await dialog.getByRole("button", { name: "Create module" }).click()

  // It opens on its Blueprint, empty.
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}\?tab=blueprint$/)
  await expect(page.getByRole("heading", { name: "Revenue", level: 1 })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Blueprint" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.getByRole("heading", { name: "Add your first line item" })).toBeVisible()

  await addLineItem(page, "Units sold")
  await addLineItem(page, "Unit price")
  await addLineItem(page, "Revenue")
  expect(await lineItemNames(page)).toEqual(["Units sold", "Unit price", "Revenue"])

  // A new line item goes below the selected one.
  await blueprintRow(page, "Units sold").getByText("Units sold", { exact: true }).click()
  await expect(page).toHaveURL(/li=/)
  await addLineItem(page, "Discount")
  expect(await lineItemNames(page)).toEqual(["Units sold", "Discount", "Unit price", "Revenue"])

  // The keyboard picks it up with space, moves it with the arrows and drops it with space.
  const table = page.getByRole("grid", { name: "Line items" })
  await blueprintRow(page, "Discount").getByText("Discount", { exact: true }).click()
  const handle = table.getByRole("button", { name: "Reorder Discount" })
  await handle.focus()
  // Each step is announced, which is also how the test knows it can take the next.
  await page.keyboard.press("Space")
  await expect(page.getByText("Discount is over position 2 of 4.")).toBeAttached()
  await page.keyboard.press("ArrowDown")
  await expect(page.getByText("Discount is over position 3 of 4.")).toBeAttached()
  await page.keyboard.press("ArrowDown")
  await expect(page.getByText("Discount is over position 4 of 4.")).toBeAttached()
  await page.keyboard.press("Space")
  await expect(page.getByText("Dropped Discount at position 4 of 4.")).toBeAttached()
  await expect
    .poll(() => lineItemNames(page))
    .toEqual(["Units sold", "Unit price", "Revenue", "Discount"])
  await page.reload()
  await expect
    .poll(() => lineItemNames(page))
    .toEqual(["Units sold", "Unit price", "Revenue", "Discount"])

  // A pointer drags the handle too: Discount goes back above Revenue.
  const grip = await table.getByRole("button", { name: "Reorder Discount" }).boundingBox()
  const above = await blueprintRow(page, "Revenue").boundingBox()
  expect(grip && above).toBeTruthy()
  const x = (grip?.x ?? 0) + (grip?.width ?? 0) / 2
  const y = (grip?.y ?? 0) + (grip?.height ?? 0) / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 12, { steps: 3 })
  await page.mouse.move(x, (above?.y ?? 0) + 8, { steps: 10 })
  await page.mouse.up()
  await expect
    .poll(() => lineItemNames(page))
    .toEqual(["Units sold", "Unit price", "Discount", "Revenue"])

  // The formula of Revenue is set in the settings of the line item.
  await blueprintRow(page, "Revenue").dblclick()
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  await expect(sheet.getByLabel("Name")).toHaveValue("Revenue")
  await sheet.getByLabel("Formula").fill("Units sold * Unit price")
  await sheet.getByRole("button", { name: "Save changes" }).click()
  // An input line item that becomes a calculated one loses the values typed into it.
  const confirm = page.getByRole("alertdialog", { name: "Clear input values?" })
  await expect(confirm).toContainText("This clears the line item's input values.")
  await confirm.getByRole("button", { name: "Save and clear values" }).click()
  await expect(toastWith(page, "Line item saved")).toBeVisible()
  await expect(sheet).toBeHidden()
  await expect(blueprintRow(page, "Revenue")).toContainText("Units sold * Unit price")

  // And the grid takes values: typing over a cell enters one, and Revenue follows.
  await page.getByRole("tab", { name: "Grid" }).click()
  await expect(page).toHaveURL(/tab=grid/)
  await expect(page.getByRole("grid", { name: "Revenue grid" })).toBeVisible()
  await gridCell(page, 0, 0).click()
  await page.keyboard.type("120")
  await page.keyboard.press("Enter")
  await expect(gridCell(page, 0, 0)).toHaveText("120")
  await gridCell(page, 1, 0).click()
  await page.keyboard.type("5")
  await page.keyboard.press("Enter")
  await expect(gridCell(page, 1, 0)).toHaveText("5")
  await expect(gridCell(page, 3, 0)).toHaveText("600")
  await page.reload()
  await expect(gridCell(page, 0, 0)).toHaveText("120")
  await expect(gridCell(page, 3, 0)).toHaveText("600")
})

test("the model shows its modules by functional area and the grid shows its data", async ({
  page,
}) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const revenue = structure.modules.find((module) => module.name === "Revenue")
  expect(revenue).toBeDefined()
  const byName = Object.fromEntries(
    structure.line_items
      .filter((item) => item.module === revenue?.id)
      .map((item) => [item.name, item.id]),
  )
  // Revenue is by Products, then Regions, then quarters: a cell is named by an item of each and a period.
  const north = structure.lists.find((list) => list.name === "Regions")?.items[0].id as string
  const widgets = structure.lists.find((list) => list.name === "Products")?.items[0].id as string
  const year = structure.calendar.first_year
  const quarters = [0, 1, 2, 3].map(
    (quarter) => `Q${quarter + 1} FY${String(year % 100).padStart(2, "0")}`,
  )
  await writeCellsViaApi(
    baseURL,
    ADMIN,
    modelId,
    quarters.flatMap((quarter, index) => [
      {
        line_item_id: byName["Units sold"],
        coords: [widgets, north, quarter],
        value: 100 + index * 15,
      },
      {
        line_item_id: byName["Unit price"],
        coords: [widgets, north, quarter],
        value: 5 + index * 0.25,
      },
    ]),
  )
  await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Headcount",
    functional_area: "People",
    axes: [
      { kind: "list", list: regionsId },
      { kind: "time", level: "quarter" },
    ],
  })
  await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Pricing rules",
    functional_area: "",
    axes: [{ kind: "list", list: productsId }],
  })
  await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Costs",
    functional_area: "Finance",
    axes: [
      { kind: "list", list: regionsId },
      { kind: "time", level: "month" },
      { kind: "versions" },
    ],
  })

  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules`)
  const content = page.getByRole("main")
  await expect(content.getByRole("heading", { name: /^Finance/, level: 2 })).toBeVisible()
  const finance = content.getByRole("table", { name: "Finance" })
  await expect(finance.getByRole("row")).toHaveCount(3)
  await expect(finance.getByRole("row", { name: /^Revenue/ })).toContainText("Products")
  await expect(finance.getByRole("row", { name: /^Revenue/ })).toContainText("Time (Quarter)")
  await screenshot(page, "w3-modules", {
    ready: content.getByRole("table", { name: "Finance" }),
  })

  await content.getByRole("button", { name: /^Finance/ }).click()
  await expect(content.getByRole("table", { name: "Finance" })).toBeHidden()
  await content.getByRole("button", { name: /^Finance/ }).click()
  await expect(content.getByRole("table", { name: "Finance" })).toBeVisible()

  await content.getByRole("link", { name: "Revenue" }).click()
  await expect(page.getByRole("grid", { name: "Revenue grid" })).toBeVisible()
  await expect(gridCell(page, 0, 0)).toHaveText("100")
  await screenshot(page, "w3-grid", {
    ready: gridCell(page, 0, 0).filter({ hasText: "100" }),
  })
})

test("the Blueprint marks a formula that no longer works and the settings sheet shows number options", async ({
  page,
}) => {
  const costs = (await structureViaApi(baseURL, ADMIN, modelId)).modules.find(
    (module) => module.name === "Costs",
  ) as { id: string }
  const rent = await createLineItemViaApi(baseURL, ADMIN, modelId, costs.id, { name: "Rent" })
  await createLineItemViaApi(baseURL, ADMIN, modelId, costs.id, {
    name: "Rent per head",
    formula: "Rent / 12",
    format: {
      type: "number",
      decimals: 2,
      thousands_sep: true,
      unit: { type: "currency", code: "EUR" },
      negative: "parens",
    },
  })
  await createLineItemViaApi(baseURL, ADMIN, modelId, costs.id, { name: "Utilities" })
  await deleteLineItemViaApi(baseURL, ADMIN, modelId, rent)

  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules/${costs.id}?tab=blueprint`)
  const row = blueprintRow(page, "Rent per head")
  await expect(row.getByRole("img", { name: /Formula error/ })).toBeVisible()
  await row.getByText("Rent per head", { exact: true }).click()
  await expect(row).toHaveAttribute("aria-selected", "true")
  await screenshot(page, "w3-blueprint", {
    ready: blueprintRow(page, "Rent per head").getByRole("img", { name: /Formula error/ }),
  })

  await page.getByRole("grid", { name: "Line items" }).press("Enter")
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  await expect(sheet.getByLabel("Currency code")).toHaveValue("EUR")
  await expect(sheet.getByText("Shown as")).toContainText("€1,234.57 and (€1,234.57)")
  await expect(sheet.getByRole("alert")).toHaveCount(0)
  await screenshot(page, "w3-line-item-sheet", {
    ready: page.getByRole("dialog", { name: "Line item settings" }),
    reopen: async () => {
      await page.getByRole("grid", { name: "Line items" }).press("Enter")
    },
  })

  // A formula that does not parse is refused with every problem listed under it.
  await sheet.getByLabel("Formula").fill("Utilities + Rentt")
  await sheet.getByRole("button", { name: "Save changes" }).click()
  const problems = sheet.getByRole("alert")
  await expect(problems).toContainText("The formula has a problem.")
  await expect(problems).toContainText("Rentt")
  await expect(sheet.getByLabel("Formula")).toBeFocused()

  // The lists a line item applies to, and the confirmation that follows.
  await sheet.getByLabel("Formula").fill("")
  await sheet.getByRole("radio", { name: /Chosen lists and subsets/ }).click()
  await sheet.getByRole("checkbox", { name: /Regions/ }).uncheck()
  await sheet.getByRole("button", { name: "Save changes" }).click()
  await expect(sheet.getByRole("alert")).toHaveCount(0)
  // It is a calculated line item, so there is nothing to clear and no question.
  await expect(sheet).toBeHidden()
  await expect(toastWith(page, "Line item saved")).toBeVisible()
})

test("the settings of a line item are kept as the server stores them", async ({ page }) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const costs = structure.modules.find((module) => module.name === "Costs") as { id: string }
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules/${costs.id}?tab=blueprint`)
  await blueprintRow(page, "Utilities").dblclick()
  const sheet = page.getByRole("dialog", { name: "Line item settings" })

  await sheet.getByLabel("Code").fill("UTIL")
  await sheet.getByRole("combobox", { name: "Summary", exact: true }).click()
  await page.getByRole("option", { name: "Average" }).click()
  await sheet.getByRole("combobox", { name: "Time summary" }).click()
  await page.getByRole("option", { name: "Closing balance" }).click()
  await sheet.getByRole("radio", { name: /Chosen lists and subsets/ }).click()
  await sheet.getByRole("checkbox", { name: /Regions/ }).uncheck()
  await sheet.getByRole("combobox", { name: "Time scale" }).click()
  await page.getByRole("option", { name: "Quarter" }).click()
  await sheet.getByRole("radio", { name: "Chosen versions" }).click()
  await sheet.getByRole("button", { name: "Save changes" }).click()
  await expect(sheet.getByText("Choose at least one version.")).toBeVisible()
  await sheet.getByRole("checkbox").last().check()
  await sheet.getByRole("button", { name: "Save changes" }).click()
  // Another set of dimensions and another time scale mean other cells, so the values go.
  const confirm = page.getByRole("alertdialog", { name: "Clear input values?" })
  await expect(confirm).toContainText("This clears the line item's input values.")
  await confirm.getByRole("button", { name: "Save and clear values" }).click()
  await expect(toastWith(page, "Line item saved")).toBeVisible()
  await expect(sheet).toBeHidden()

  const row = blueprintRow(page, "Utilities")
  await expect(row).toContainText("Average")
  await expect(row).toContainText("Quarter")
  await expect(row).toContainText("None")
  await page.reload()
  await blueprintRow(page, "Utilities").dblclick()
  await expect(sheet.getByLabel("Code")).toHaveValue("UTIL")
  await expect(sheet.getByRole("combobox", { name: "Summary", exact: true })).toHaveText("Average")
  await expect(sheet.getByRole("combobox", { name: "Time summary" })).toHaveText("Closing balance")
  await expect(sheet.getByRole("combobox", { name: "Time scale" })).toHaveText("Quarter")
  await expect(sheet.getByRole("radio", { name: /Chosen lists and subsets/ })).toBeChecked()
  await expect(sheet.getByRole("radio", { name: "Chosen versions" })).toBeChecked()

  // A ratio of two other number line items, and the way back to the module's lists.
  await sheet.getByRole("combobox", { name: "Summary", exact: true }).click()
  await page.getByRole("option", { name: "Ratio" }).click()
  await sheet.getByRole("combobox", { name: "Numerator" }).click()
  await page.getByRole("option", { name: "Rent per head" }).click()
  await sheet.getByRole("combobox", { name: "Denominator" }).click()
  await page.getByRole("option", { name: "Rent per head" }).click()
  await sheet.getByRole("radio", { name: "Module default" }).first().click()
  await sheet.getByRole("button", { name: "Save changes" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Save and clear values" }).click()
  await expect(toastWith(page, "Line item saved").last()).toBeVisible()
  await expect(blueprintRow(page, "Utilities")).toContainText("Ratio")
})

test("the module settings rename the module, confirm a change of dimensions and delete it", async ({
  page,
}) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const revenue = structure.modules.find((module) => module.name === "Revenue") as { id: string }
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules/${revenue.id}`)

  await page.getByRole("button", { name: "Module settings" }).click()
  const sheet = page.getByRole("dialog", { name: "Module settings" })
  await expect(sheet.getByLabel("Name")).toHaveValue("Revenue")
  await screenshot(page, "w3-module-settings", {
    ready: page.getByRole("dialog", { name: "Module settings" }),
    reopen: async () => {
      await page.getByRole("button", { name: "Module settings" }).click()
    },
  })

  await sheet.getByRole("switch", { name: "Versions" }).click()
  await sheet.getByRole("button", { name: "Save changes" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Clear input values?" })
  await expect(confirm).toContainText("Changing dimensions clears this module's input values.")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(sheet).toBeVisible()
  await sheet.getByRole("switch", { name: "Versions" }).click()
  await sheet.getByLabel("Name").fill("Sales revenue")
  await sheet.getByRole("button", { name: "Save changes" }).click()
  await expect(toastWith(page, "Module saved")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Sales revenue", level: 1 })).toBeVisible()

  // The title renames in place.
  await page.getByRole("button", { name: "Rename module" }).click()
  const input = page.getByRole("textbox", { name: "Module name" })
  await input.fill("Revenue")
  await input.press("Enter")
  await expect(page.getByRole("heading", { name: "Revenue", level: 1 })).toBeVisible()
  await expect(page.getByRole("button", { name: "Rename module" })).toBeFocused()

  const pricing = structure.modules.find((module) => module.name === "Pricing rules") as {
    id: string
  }
  await page.goto(`/m/${modelId}/modules/${pricing.id}`)
  await page.getByRole("button", { name: "Module settings" }).click()
  await page
    .getByRole("dialog", { name: "Module settings" })
    .getByRole("button", { name: "Delete module" })
    .click()
  await page
    .getByRole("alertdialog", { name: "Delete Pricing rules?" })
    .getByRole("button", { name: "Delete module" })
    .click()
  await expect(page).toHaveURL(`/m/${modelId}/modules`)
  await expect(page.getByRole("main").getByRole("link", { name: "Pricing rules" })).toHaveCount(0)
})

test("a viewer sees the modules, the Blueprint and the grid but no controls that change them", async ({
  page,
}) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const revenue = structure.modules.find((module) => module.name === "Revenue") as { id: string }
  await login(page, VIEWER)
  await page.goto(`/m/${modelId}/modules`)
  const content = page.getByRole("main")
  await expect(content.getByRole("link", { name: "Revenue" })).toBeVisible()
  await expect(content.getByRole("button", { name: "New module" })).toHaveCount(0)

  await page.goto(`/m/${modelId}/modules/${revenue.id}?tab=blueprint`)
  await expect(page.getByRole("grid", { name: "Line items" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add line item" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Module settings" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Rename module" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Reorder/ })).toHaveCount(0)
  await blueprintRow(page, "Units sold").dblclick()
  const sheet = page.getByRole("dialog", { name: "Line item settings" })
  await expect(sheet.getByLabel("Name")).toBeDisabled()
  await expect(sheet.getByRole("button", { name: "Save changes" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page.getByRole("tab", { name: "Grid" }).click()
  await expect(page.getByRole("grid", { name: "Revenue grid" })).toHaveAttribute(
    "aria-readonly",
    "true",
  )
})

test("a model in production mode keeps the controls on screen, switched off", async ({ page }) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const revenue = structure.modules.find((module) => module.name === "Revenue") as { id: string }
  await login(page, ADMIN)
  await page.request.patch(`/api/v1/models/${modelId}`, {
    data: { mode: "prod" },
    headers: {
      "x-openplan-csrf": (await page.context().cookies()).find(
        (cookie) => cookie.name === "op_csrf",
      )?.value as string,
    },
  })
  try {
    await page.goto(`/m/${modelId}/modules/${revenue.id}?tab=blueprint`)
    await expect(page.getByText(PRODUCTION_MESSAGE)).toBeVisible()
    const add = page.getByRole("button", { name: "Add line item" })
    await expect(add).toBeDisabled()
    await expect(page.getByRole("button", { name: "Module settings" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Rename module" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Reorder Units sold" })).toBeDisabled()
    await add.locator("xpath=..").hover()
    await expect(page.getByRole("tooltip")).toContainText(PRODUCTION_MESSAGE)
    await page.goto(`/m/${modelId}/modules`)
    await expect(page.getByRole("button", { name: "New module" })).toBeDisabled()
  } finally {
    await page.request.patch(`/api/v1/models/${modelId}`, {
      data: { mode: "dev" },
      headers: {
        "x-openplan-csrf": (await page.context().cookies()).find(
          (cookie) => cookie.name === "op_csrf",
        )?.value as string,
      },
    })
  }
})

test("nothing is wider than the screen on a phone", async ({ page }) => {
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const revenue = structure.modules.find((module) => module.name === "Revenue") as { id: string }
  await page.setViewportSize({ width: 375, height: 812 })
  await login(page, ADMIN)

  await page.goto(`/m/${modelId}/modules`)
  await expect(page.getByRole("main").getByRole("table", { name: "Finance" })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w3-phone-modules", {
    ready: page.getByRole("main").getByRole("table", { name: "Finance" }),
  })

  await page.goto(
    `/m/${modelId}/modules/${revenue.id}?tab=blueprint&li=${structure.line_items[0].id}`,
  )
  await expect(page.getByRole("grid", { name: "Line items" })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w3-phone-blueprint", {
    ready: page.getByRole("grid", { name: "Line items" }),
  })

  await page.getByRole("tab", { name: "Grid" }).click()
  await expect(page.getByRole("grid", { name: "Revenue grid" })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w3-phone-grid", {
    ready: page.getByRole("grid", { name: "Revenue grid" }),
  })

  await page.goto(`/m/${modelId}/modules/${revenue.id}?tab=blueprint`)
  const openSettings = async () => {
    await page.getByRole("button", { name: "Actions for Units sold" }).click()
    await page.getByRole("menuitem", { name: "Line item settings" }).click()
  }
  await openSettings()
  await expect(page.getByRole("dialog", { name: "Line item settings" })).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w3-phone-line-item-sheet", {
    ready: page.getByRole("dialog", { name: "Line item settings" }),
    reopen: openSettings,
  })
})
