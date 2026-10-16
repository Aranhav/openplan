import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  createLineItemViaApi,
  createListViaApi,
  createMemberViaApi,
  createModelViaApi,
  createModuleViaApi,
  deleteAllModels,
  login,
  screenshot,
  structureViaApi,
  toastWith,
  writeCellsViaApi,
} from "./helpers"

const MODEL_NAME = "Plan FY28"
const PLANNER = { name: "Pia Planner", email: "pia@acme.test", password: "planner-password-4" }

let baseURL: string
let modelId: string
let moduleId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  const regions = await createListViaApi(baseURL, ADMIN, modelId, "Regions", [
    "North",
    "South",
    "West",
  ])
  const products = await createListViaApi(baseURL, ADMIN, modelId, "Products", [
    "Widgets",
    "Gadgets",
  ])
  moduleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Revenue",
    functional_area: "Finance",
    axes: [
      { kind: "list", list: regions },
      { kind: "list", list: products },
      { kind: "time", level: "quarter" },
    ],
  })
  const unitsSold = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Units sold",
  })
  const unitPrice = await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Unit price",
  })
  await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Revenue",
    formula: "Units sold * Unit price",
  })
  const structure = await structureViaApi(baseURL, ADMIN, modelId)
  const north = structure.lists.find((list) => list.name === "Regions")?.items[0].id as string
  const south = structure.lists.find((list) => list.name === "Regions")?.items[1].id as string
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
      { line_item_id: unitsSold, coords: [north, widgets, quarter], value: 100 + index * 15 },
      { line_item_id: unitPrice, coords: [north, widgets, quarter], value: 5 + index * 0.25 },
      { line_item_id: unitsSold, coords: [south, widgets, quarter], value: 40 + index * 5 },
    ]),
  )
  await createMemberViaApi(baseURL, ADMIN, PLANNER, "planner")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

const revenuePath = () => `/m/${modelId}/modules/${moduleId}`

function grid(page: Page) {
  return page.getByRole("grid", { name: "Revenue grid" })
}

function controls(page: Page) {
  return page.getByRole("group", { name: "Grid controls" })
}

function gridCell(page: Page, row: number, col: number) {
  return grid(page).locator(`[data-row='${row}'][data-col='${col}']`)
}

/** The header of a row of the grid by its label. */
function rowHeader(page: Page, name: string) {
  return grid(page).getByRole("rowheader", { name, exact: true })
}

async function openGrid(page: Page) {
  await page.goto(revenuePath())
  await expect(grid(page)).toBeVisible()
  await expect(gridCell(page, 0, 0)).toHaveText("100")
}

async function swapRowsAndColumns(page: Page) {
  await controls(page).getByRole("button", { name: "Pivot" }).click()
  await page.getByRole("button", { name: "Swap rows and columns" }).click()
  await page.keyboard.press("Escape")
}

test("a builder pivots, picks a page member, filters, saves a default view, and the module opens on it again", async ({
  page,
}) => {
  await login(page, ADMIN)
  await openGrid(page)
  const bar = controls(page)
  // The toolbar is one row at 1280 px, with everything in it.
  for (const name of ["Pivot", "Filter", "Show/hide", "Summaries", "Conditional formatting"]) {
    await expect(bar.getByRole("button", { name })).toBeVisible()
  }
  await expect(bar.getByRole("button", { name: "More" })).toHaveCount(0)
  const box = await bar.boundingBox()
  expect(box?.height).toBeLessThan(48)
  await expect(bar.getByRole("combobox", { name: "Saved view" })).toHaveText("Default")
  await expect(grid(page).locator("[data-corner-label]")).toHaveText("Line items / Quarters")
  await screenshot(page, "g4-toolbar", { ready: gridCell(page, 0, 0).filter({ hasText: "100" }) })

  // Swapping the rows and the columns puts the quarters down the rows.
  await swapRowsAndColumns(page)
  await expect(rowHeader(page, "Q1 FY26")).toBeVisible()
  await expect(bar.getByText("Modified")).toBeVisible()
  await expect(grid(page).locator("[data-corner-label]")).toHaveText("Quarters / Line items")

  // A page selector changes the member the grid shows.
  await bar.getByRole("combobox", { name: /^Regions/ }).click()
  await page.getByRole("option", { name: "South" }).click()
  await expect(gridCell(page, 0, 0)).toHaveText("40")
  await bar.getByRole("combobox", { name: /^Regions/ }).click()
  await page.getByRole("option", { name: "North" }).click()
  await expect(gridCell(page, 0, 0)).toHaveText("100")

  // A filter keeps the rows that pass it.
  await bar.getByRole("button", { name: "Filter" }).click()
  const filter = page.getByRole("dialog", { name: "Filter rows" })
  await filter.getByRole("button", { name: "Add filter" }).click()
  await filter.getByRole("combobox", { name: /Line item of filter 1/ }).click()
  await page.getByRole("option", { name: "Units sold" }).click()
  await filter.getByRole("combobox", { name: /Condition of filter 1/ }).click()
  await page.getByRole("option", { name: "is greater than" }).click()
  await filter.getByRole("textbox", { name: "Value of filter 1" }).fill("120")
  await screenshot(page, "g4-filter", {
    ready: page.getByRole("dialog", { name: "Filter rows" }),
    reopen: async () => {
      await bar.getByRole("button", { name: "Filter" }).click()
      const reopened = page.getByRole("dialog", { name: "Filter rows" })
      await reopened.getByRole("button", { name: "Add filter" }).click()
      await reopened.getByRole("combobox", { name: /Line item of filter 1/ }).click()
      await page.getByRole("option", { name: "Units sold" }).click()
      await reopened.getByRole("combobox", { name: /Condition of filter 1/ }).click()
      await page.getByRole("option", { name: "is greater than" }).click()
      await reopened.getByRole("textbox", { name: "Value of filter 1" }).fill("120")
    },
  })
  await filter.getByRole("button", { name: "Apply" }).click()
  await expect(bar.getByRole("button", { name: "Filter, 1 active" })).toBeVisible()
  await expect(rowHeader(page, "Q3 FY26")).toBeVisible()
  await expect(rowHeader(page, "Q1 FY26")).toHaveCount(0)

  // Save it as the default view.
  await bar.getByRole("button", { name: "View actions" }).click()
  await page.getByRole("menuitem", { name: "Save as…" }).click()
  const dialog = page.getByRole("dialog", { name: "Save as a new view" })
  await dialog.getByLabel("Name").fill("Quarters down")
  await dialog.getByRole("checkbox", { name: "Set as default" }).click()
  await dialog.getByRole("button", { name: "Save view" }).click()
  await expect(toastWith(page, "View saved")).toBeVisible()
  await expect(bar.getByText("Modified")).toHaveCount(0)
  await expect(bar.getByRole("combobox", { name: "Saved view" })).toContainText("Quarters down")

  // Reopening the module shows the default view: the quarters are down the rows, filtered.
  await page.goto(revenuePath())
  await expect(grid(page)).toBeVisible()
  await expect(rowHeader(page, "Q3 FY26")).toBeVisible()
  await expect(rowHeader(page, "Q1 FY26")).toHaveCount(0)
  await expect(controls(page).getByRole("button", { name: "Filter, 1 active" })).toBeVisible()
  await expect(controls(page).getByText("Modified")).toHaveCount(0)
  await expect(controls(page).getByRole("combobox", { name: "Saved view" })).toContainText(
    "Quarters down",
  )
})

test("the views menu, unsaved changes that survive a reload, and the default pivot to come back to", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.goto(revenuePath())
  await expect(grid(page)).toBeVisible()
  const bar = controls(page)
  await expect(rowHeader(page, "Q3 FY26")).toBeVisible()

  // A change that is not saved is kept for the session.
  await bar.getByRole("button", { name: "Summaries" }).click()
  await expect(bar.getByText("Modified")).toBeVisible()
  await expect(rowHeader(page, "FY26")).toHaveCount(0)
  await page.reload()
  await expect(grid(page)).toBeVisible()
  await expect(bar.getByText("Modified")).toBeVisible()
  await expect(rowHeader(page, "FY26")).toHaveCount(0)

  await bar.getByRole("button", { name: "View actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Save", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Save as…" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Discard changes" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Delete view…" })).toBeVisible()
  await screenshot(page, "g4-saved-views", {
    ready: page.getByRole("menuitem", { name: "Delete view…" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: "View actions" }).click()
    },
  })
  await page.getByRole("menuitem", { name: "Discard changes" }).click()
  await expect(bar.getByText("Modified")).toHaveCount(0)
  await expect(rowHeader(page, "FY26")).toBeVisible()

  // Deleting the view brings the default pivot back.
  await bar.getByRole("button", { name: "View actions" }).click()
  await page.getByRole("menuitem", { name: "Delete view…" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete view" }).click()
  await expect(toastWith(page, "View deleted")).toBeVisible()
  await expect(bar.getByRole("combobox", { name: "Saved view" })).toHaveText("Default")
  await expect(gridCell(page, 0, 0)).toHaveText("100")
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}$/)
})

test("a view of the address that is gone falls back to the default", async ({ page }) => {
  await login(page, ADMIN)
  await page.goto(`${revenuePath()}?view=0192f3a0-0000-7000-8000-00000000dead`)

  await expect(grid(page)).toBeVisible()
  await expect(toastWith(page, "That view no longer exists.")).toBeVisible()
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}$/)
})

test("every control of the toolbar is reached with the keyboard, and the panels open from it", async ({
  page,
}) => {
  await login(page, ADMIN)
  await openGrid(page)
  const bar = controls(page)

  await bar.getByRole("button", { name: "Pivot" }).focus()
  const reached: string[] = []
  for (let step = 0; step < 8; step += 1) {
    reached.push(
      await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null
        return (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim()
      }),
    )
    await page.keyboard.press("Tab")
  }
  expect(reached).toEqual([
    "Pivot",
    expect.stringMatching(/^Regions/),
    expect.stringMatching(/^Products/),
    "Filter",
    "Show/hide",
    "Summaries",
    "Conditional formatting",
    expect.stringMatching(/^Saved view/),
  ])

  // The show/hide list takes the keyboard: a member is unchecked with the space bar.
  await bar.getByRole("button", { name: "Show/hide" }).focus()
  await page.keyboard.press("Enter")
  const list = page.getByRole("dialog", { name: "Show or hide members" })
  await expect(list).toBeVisible()
  await list.getByRole("combobox", { name: "Dimension" }).click()
  await page.getByRole("option", { name: "Time (Quarter)" }).click()
  await list.getByRole("checkbox", { name: "Q4 FY26" }).focus()
  await page.keyboard.press("Space")
  await expect(list.getByText("1 member hidden")).toBeVisible()
  await screenshot(page, "g4-show-hide", {
    ready: page.getByRole("dialog", { name: "Show or hide members" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: /^Show\/hide/ }).click()
      const reopened = page.getByRole("dialog", { name: "Show or hide members" })
      await reopened.getByRole("combobox", { name: "Dimension" }).click()
      await page.getByRole("option", { name: "Time (Quarter)" }).click()
      await reopened.getByRole("checkbox", { name: "Q4 FY26" }).click()
    },
  })
  await page.keyboard.press("Escape")
  await expect(rowHeader(page, "Q4 FY26")).toHaveCount(0)
  await expect(bar.getByRole("button", { name: "Show/hide, 1 hidden" })).toBeFocused()

  // The pivot takes the keyboard too: a dimension is moved from the menu of its chip.
  await bar.getByRole("button", { name: "Pivot" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "Pivot" })).toBeVisible()
  await screenshot(page, "g4-pivot", {
    ready: page.getByRole("dialog", { name: "Pivot" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: "Pivot" }).click()
    },
  })
  await page.getByRole("button", { name: "Move Products" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Move to Rows" }).click()
  await expect(grid(page).locator("[data-corner-label]")).toHaveText("Line items, Products / Quarters")
  await page.keyboard.press("Escape")
})

test("conditional formatting colours the cells that match a rule", async ({ page }) => {
  await login(page, ADMIN)
  await openGrid(page)

  await controls(page).getByRole("button", { name: "Conditional formatting" }).click()
  const sheet = page.getByRole("dialog", { name: "Conditional formatting" })
  await sheet.getByRole("button", { name: "Add rule" }).click()
  await sheet.getByRole("textbox", { name: "Name of rule 1" }).fill("Strong sales")
  await sheet.getByRole("combobox", { name: /Condition of rule 1/ }).click()
  await page.getByRole("option", { name: "is greater than" }).click()
  await sheet.getByRole("textbox", { name: "Value of rule 1" }).fill("110")
  await sheet.getByRole("radiogroup", { name: "Colour of rule 1" }).getByRole("radio", { name: "Green" }).click()
  await sheet.getByRole("switch", { name: "Bold for rule 1" }).click()
  await sheet.getByRole("button", { name: "Add rule" }).click()
  await sheet.getByRole("textbox", { name: "Name of rule 2" }).fill("Weak sales")
  await sheet.getByRole("combobox", { name: /Condition of rule 2/ }).click()
  await page.getByRole("option", { name: "is less than" }).click()
  await sheet.getByRole("textbox", { name: "Value of rule 2" }).fill("105")
  await sheet.getByRole("radiogroup", { name: "Colour of rule 2" }).getByRole("radio", { name: "Red" }).click()
  await screenshot(page, "g4-conditional-formatting", {
    ready: page.getByRole("dialog", { name: "Conditional formatting" }),
    reopen: async () => {
      await controls(page).getByRole("button", { name: "Conditional formatting" }).click()
      const reopened = page.getByRole("dialog", { name: "Conditional formatting" })
      await reopened.getByRole("button", { name: "Add rule" }).click()
      await reopened.getByRole("textbox", { name: "Name of rule 1" }).fill("Strong sales")
      await reopened.getByRole("combobox", { name: /Condition of rule 1/ }).click()
      await page.getByRole("option", { name: "is greater than" }).click()
      await reopened.getByRole("textbox", { name: "Value of rule 1" }).fill("110")
      await reopened.getByRole("radiogroup", { name: "Colour of rule 1" }).getByRole("radio", { name: "Green" }).click()
      await reopened.getByRole("switch", { name: "Bold for rule 1" }).click()
      await reopened.getByRole("button", { name: "Add rule" }).click()
      await reopened.getByRole("textbox", { name: "Name of rule 2" }).fill("Weak sales")
      await reopened.getByRole("combobox", { name: /Condition of rule 2/ }).click()
      await page.getByRole("option", { name: "is less than" }).click()
      await reopened.getByRole("textbox", { name: "Value of rule 2" }).fill("105")
      await reopened.getByRole("radiogroup", { name: "Colour of rule 2" }).getByRole("radio", { name: "Red" }).click()
    },
  })
  await sheet.getByRole("button", { name: "Apply rules" }).click()

  await expect(gridCell(page, 0, 0)).toHaveClass(/bg-red-500\/15/)
  await expect(gridCell(page, 0, 2)).toHaveClass(/bg-green-500\/15/)
  await expect(gridCell(page, 0, 2)).toHaveClass(/font-bold/)
  await expect(controls(page).getByText("Modified")).toBeVisible()
})

test("a planner can switch views and change the pivot, but is offered no way to save", async ({
  page,
}) => {
  await login(page, PLANNER)
  await page.goto(revenuePath())
  await expect(grid(page)).toBeVisible()
  const bar = controls(page)

  await expect(bar.getByRole("combobox", { name: "Saved view" })).toBeVisible()
  await expect(bar.getByRole("button", { name: "View actions" })).toHaveCount(0)
  await bar.getByRole("button", { name: "Summaries" }).click()
  await expect(bar.getByText("Modified")).toBeVisible()
  await bar.getByRole("button", { name: "View actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Discard changes" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Save as…" })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Save", exact: true })).toHaveCount(0)
})

test("below 1100 px the secondary controls move into a More menu", async ({ page }) => {
  await login(page, ADMIN)
  await page.setViewportSize({ width: 900, height: 720 })
  await openGrid(page)
  const bar = controls(page)

  await expect(bar.getByRole("button", { name: "Filter" })).toHaveCount(0)
  await expect(bar.getByRole("button", { name: "More" })).toBeVisible()
  await expect(bar.getByRole("button", { name: "Pivot" })).toBeVisible()
  await bar.getByRole("button", { name: "More" }).click()
  await screenshot(page, "g4-more-menu", {
    ready: page.getByRole("menuitem", { name: "Filter…" }),
    fullPage: false,
    reopen: async () => {
      await controls(page).getByRole("button", { name: "More" }).click()
    },
  })
  await page.getByRole("menuitem", { name: "Filter…" }).click()
  await expect(page.getByRole("dialog", { name: "Filter rows" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(bar.getByRole("button", { name: "More" })).toBeFocused()
})
