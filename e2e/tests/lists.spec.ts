import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  createListViaApi,
  createMemberViaApi,
  createModelViaApi,
  deleteAllModels,
  login,
  screenshot,
  toastWith,
} from "./helpers"

const MODEL_NAME = "Plan FY27"
const VIEWER = { name: "Lena Lists", email: "lena@acme.test", password: "viewer-password-4" }

let baseURL: string
let modelId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  await createMemberViaApi(baseURL, ADMIN, VIEWER, "viewer")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

/** Whether the page is wider than the screen, which no page may be. */
async function scrollsSideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
}

function itemsTable(page: Page, list: string) {
  return page.getByRole("table", { name: `Items of ${list}` })
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

/** Types an item into the open row, choosing its parent first if it is given. */
async function typeItem(page: Page, name: string, parent?: string) {
  if (parent) {
    await page.getByRole("combobox", { name: /^Parent of the new item/ }).click()
    await page.getByRole("option", { name: new RegExp(`^${parent}`) }).click()
  }
  await page.getByRole("textbox", { name: "New item name" }).fill(name)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: `Rename ${name}` })).toBeVisible()
}

test("a builder makes lists, adds items one by one and in bulk, edits them in place and groups them in subsets", async ({
  page,
}) => {
  // A dozen screenshots, each in two themes and each after a reload, take their time.
  test.setTimeout(90_000)
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/lists`)
  const build = page.getByRole("navigation", { name: "Build" })
  await expect(page.getByRole("heading", { name: "Lists", level: 1 })).toBeVisible()
  await expect(build.getByRole("link", { name: "Lists" })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("heading", { name: "No lists yet" })).toBeVisible()

  // A list without a parent, with a top level.
  await page.getByRole("button", { name: "New list" }).click()
  const dialog = page.getByRole("dialog", { name: "New list" })
  await expect(dialog.getByText("Leave empty for no top level")).toBeVisible()
  await screenshot(page, "w4-new-list", {
    ready: dialog,
    reopen: async () => {
      await page.getByRole("button", { name: "New list" }).click()
    },
  })
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await newList(page, "Regions", { top: "All regions" })
  await expect(page.getByRole("heading", { name: "No items yet" })).toBeVisible()
  await screenshot(page, "w4-items-empty", {
    ready: page.getByRole("heading", { name: "No items yet" }),
  })

  // Items are typed into a row; Enter adds one and opens the next, Escape stops.
  await page.getByRole("button", { name: "Add item" }).click()
  await expect(page.getByRole("textbox", { name: "New item name" })).toBeFocused()
  await typeItem(page, "EMEA")
  await expect(page.getByRole("textbox", { name: "New item name" })).toBeFocused()
  await typeItem(page, "APAC")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("textbox", { name: "New item name" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Add item" })).toBeFocused()
  await expect(itemsTable(page, "Regions").getByRole("row")).toHaveCount(3)

  // A list with a parent list groups its items under the parent's.
  await page.goto(`/m/${modelId}/lists`)
  await newList(page, "Countries", { parent: "Regions" })
  await expect(page.getByRole("link", { name: "Parent list: Regions" })).toBeVisible()
  await page.getByRole("button", { name: "Add item" }).click()
  await typeItem(page, "France", "EMEA")
  await typeItem(page, "Germany")
  // The next item belongs to the same parent until another is chosen.
  await expect(page.getByRole("combobox", { name: "Parent of the new item: EMEA" })).toBeVisible()
  await typeItem(page, "Japan", "APAC")
  const typeNext = async () => {
    await page.getByRole("button", { name: "Add item" }).click()
    await page.getByRole("combobox", { name: /^Parent of the new item/ }).click()
    await page.getByRole("option", { name: /^EMEA/ }).click()
    await page.getByRole("textbox", { name: "New item name" }).fill("Spain")
    await page.getByRole("textbox", { name: "New item code" }).fill("ES")
  }
  await page.keyboard.press("Escape")
  await typeNext()
  await screenshot(page, "w4-add-item-row", {
    ready: page.getByRole("textbox", { name: "New item name" }),
    reopen: typeNext,
  })
  await page.keyboard.press("Escape")
  const table = itemsTable(page, "Countries")
  await expect(table.getByRole("button", { name: "EMEA, 2 items" })).toBeVisible()
  await expect(table.getByRole("button", { name: "APAC, 1 item" })).toBeVisible()

  // Many at once: a line that is wrong fails them all, and says which.
  const typeLines = async (lines: string) => {
    await page.getByRole("button", { name: "Bulk add" }).click()
    const bulk = page.getByRole("dialog", { name: "Bulk add items" })
    await bulk.getByRole("textbox", { name: "Items" }).fill(lines)
    return bulk
  }
  const wrong = "Italy, EMEA\nChina, Asia\nKorea"
  let bulk = await typeLines(wrong)
  await bulk.getByRole("button", { name: "Add items" }).click()
  await expect(bulk.getByText("Line 2: Asia is not an item of Regions.")).toBeVisible()
  await expect(
    bulk.getByText("Line 3: Add a parent after a comma, as in “Name, Parent”."),
  ).toBeVisible()
  await expect(table.getByRole("button", { name: "Rename Italy" })).toHaveCount(0)
  await screenshot(page, "w4-bulk-add-errors", {
    ready: bulk.getByText("Line 2: Asia is not an item of Regions."),
    reopen: async () => {
      bulk = await typeLines(wrong)
      await bulk.getByRole("button", { name: "Add items" }).click()
    },
  })
  await bulk.getByRole("textbox", { name: "Items" }).fill("Italy, EMEA\nChina, APAC")
  await bulk.getByRole("button", { name: "Add items" }).click()
  await expect(toastWith(page, "Added 2 items")).toBeVisible()
  await expect(table.getByRole("button", { name: "Rename Italy" })).toBeVisible()
  await expect(table.getByRole("button", { name: "APAC, 2 items" })).toBeVisible()

  // Names and codes change where they are; Escape leaves them be.
  await table.getByRole("button", { name: "Rename Germany" }).click()
  const input = table.getByRole("textbox", { name: "Name of Germany" })
  await expect(input).toBeFocused()
  await screenshot(page, "w4-inline-edit", {
    ready: input,
    reopen: async () => {
      await table.getByRole("button", { name: "Rename Germany" }).click()
    },
  })
  await input.fill("Deutschland")
  await input.press("Enter")
  await expect(table.getByRole("button", { name: "Rename Deutschland" })).toBeFocused()
  await table.getByRole("button", { name: "Edit the code of Deutschland" }).click()
  await table.getByRole("textbox", { name: "Code of Deutschland" }).fill("DE")
  await page.keyboard.press("Enter")
  await expect(table.getByRole("button", { name: "Edit the code of Deutschland" })).toHaveText("DE")
  // A name that is taken stays in the input with the server's words under it.
  await table.getByRole("button", { name: "Rename Italy" }).click()
  await table.getByRole("textbox", { name: "Name of Italy" }).fill("France")
  await page.keyboard.press("Enter")
  await expect(table.getByRole("textbox", { name: "Name of Italy" })).toHaveAttribute(
    "aria-invalid",
    "true",
  )
  await page.keyboard.press("Escape")
  await expect(table.getByRole("button", { name: "Rename Italy" })).toBeVisible()
  // An item moves to another parent from its Parent column.
  await table.getByRole("combobox", { name: "Parent of Japan: APAC" }).click()
  await page.getByRole("option", { name: /^EMEA/ }).click()
  await expect(table.getByRole("button", { name: "EMEA, 4 items" })).toBeVisible()
  await table.getByRole("combobox", { name: "Parent of Japan: EMEA" }).click()
  await page.getByRole("option", { name: /^APAC/ }).click()
  await expect(table.getByRole("button", { name: "APAC, 2 items" })).toBeVisible()
  await screenshot(page, "w4-items-tree", { ready: table })

  // Subsets: a name, then the items it holds.
  await page.getByRole("button", { name: "Subsets" }).click()
  const sheet = page.getByRole("dialog", { name: "Subsets of Countries" })
  await sheet.getByRole("textbox", { name: "New subset" }).fill("Euro area")
  await sheet.getByRole("button", { name: "Add subset" }).click()
  await expect(sheet.getByRole("heading", { name: "Euro area" })).toBeFocused()
  const members = sheet.getByRole("list", { name: "Items in Euro area" })
  await members.getByRole("checkbox", { name: "France" }).click()
  await members.getByRole("checkbox", { name: "Italy" }).click()
  await sheet.getByRole("searchbox", { name: "Filter items" }).fill("deut")
  await expect(members.getByRole("checkbox")).toHaveCount(1)
  await members.getByRole("checkbox", { name: "Deutschland" }).click()
  await sheet.getByRole("searchbox", { name: "Filter items" }).fill("")
  await expect(sheet.getByText("3 of 5 items selected")).toBeVisible()
  await screenshot(page, "w4-subset-members", {
    ready: sheet.getByText("3 of 5 items selected"),
    reopen: async () => {
      // Unsaved ticks do not survive a reload; the subset itself does.
      await page.getByRole("button", { name: "Subsets" }).click()
      await sheet.getByRole("button", { name: "Choose the items of Euro area" }).click()
      for (const name of ["France", "Italy", "Deutschland"]) {
        await sheet.getByRole("checkbox", { name }).click()
      }
    },
  })
  await sheet.getByRole("button", { name: "Save members" }).click()
  await expect(toastWith(page, "Subset saved")).toBeVisible()
  await expect(sheet.getByRole("button", { name: "Choose the items of Euro area" })).toHaveText(
    "3 items",
  )
  await sheet.getByRole("button", { name: "Rename Euro area" }).click()
  await sheet.getByRole("textbox", { name: "Name of Euro area" }).fill("Eurozone")
  await page.keyboard.press("Enter")
  await expect(sheet.getByRole("button", { name: "Rename Eurozone" })).toBeVisible()
  await screenshot(page, "w4-subsets", {
    ready: sheet.getByRole("list", { name: "Subsets" }),
    reopen: async () => {
      await page.getByRole("button", { name: "Subsets" }).click()
    },
  })
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()
  await expect(page.getByRole("button", { name: "Subsets" })).toBeFocused()

  // Deleting asks first. An item that others hang from has to wait for them.
  await table.getByRole("checkbox", { name: "Select China" }).click()
  await table.getByRole("checkbox", { name: "Select Japan" }).click()
  await screenshot(page, "w4-items-selected", {
    ready: page.getByText("2 items selected"),
    reopen: async () => {
      await table.getByRole("checkbox", { name: "Select China" }).click()
      await table.getByRole("checkbox", { name: "Select Japan" }).click()
    },
  })
  await table.getByRole("checkbox", { name: "Select Japan" }).click()
  await page.getByRole("button", { name: "Delete selected" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Delete China?" })
  await expect(confirm).toBeVisible()
  await confirm.getByRole("button", { name: "Delete item" }).click()
  await expect(toastWith(page, "Item deleted")).toBeVisible()
  await expect(table.getByRole("button", { name: "Rename China" })).toHaveCount(0)

  await page.goto(`/m/${modelId}/lists`)
  await page
    .getByRole("table", { name: "Lists" })
    .getByRole("link", { name: "Regions" })
    .first()
    .click()
  const regions = itemsTable(page, "Regions")
  await regions.getByRole("checkbox", { name: "Select EMEA" }).click()
  await expect(page.getByRole("button", { name: "Delete selected" })).toBeDisabled()
  await expect(
    page.getByText("EMEA still has 3 child items in Countries. Delete those first."),
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear selection" }).click()

  // The lists page counts it all.
  await page.goto(`/m/${modelId}/lists`)
  const lists = page.getByRole("table", { name: "Lists" })
  await expect(lists.getByRole("row", { name: /^Countries/ })).toContainText("Regions")
  await expect(lists.getByRole("row", { name: /^Countries/ })).toContainText("4")
  await expect(lists.getByRole("row", { name: /^Regions/ })).toContainText("All regions")
  await screenshot(page, "w4-lists-index", { ready: lists })
})

test("the properties of a list are values for its items in a grid", async ({ page }) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/lists`)
  await page
    .getByRole("table", { name: "Lists" })
    .getByRole("link", { name: "Regions" })
    .first()
    .click()
  await page.getByRole("tab", { name: "Properties" }).click()
  await expect(page).toHaveURL(/tab=properties/)
  await expect(page.getByRole("heading", { name: "No properties yet" })).toBeVisible()
  await screenshot(page, "w4-properties-empty", {
    ready: page.getByRole("heading", { name: "No properties yet" }),
  })

  await page.getByRole("button", { name: "Add property" }).click()
  const dialog = page.getByRole("dialog", { name: "Add property" })
  await dialog.getByLabel("Name").fill("Currency")
  await dialog.getByRole("combobox", { name: "Format type" }).click()
  await page.getByRole("option", { name: "Text" }).click()
  await dialog.getByRole("button", { name: "Add property" }).click()
  const grid = page.getByRole("grid", { name: "Regions properties grid" })
  await expect(grid).toBeVisible()
  await expect(grid.getByRole("columnheader", { name: "Currency" })).toBeVisible()
  await expect(grid.getByRole("rowheader", { name: "EMEA" })).toBeVisible()

  await grid.locator("[data-row='1'][data-col='0']").click()
  await page.keyboard.type("EUR")
  await page.keyboard.press("Enter")
  await expect(grid.locator("[data-row='1'][data-col='0']")).toHaveText("EUR")
  await page.reload()
  await expect(grid.locator("[data-row='1'][data-col='0']")).toHaveText("EUR")
  await screenshot(page, "w4-properties-grid", { ready: grid })

  await page.getByRole("link", { name: "Open Blueprint" }).click()
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}\?tab=blueprint/)
  await expect(page.getByRole("heading", { name: "Regions Properties", level: 1 })).toBeVisible()
})

test("a list of hundreds of items is drawn a screenful at a time and scrolls to its end", async ({
  page,
}) => {
  const items = Array.from({ length: 700 }, (_, index) => `Product ${index + 1}`)
  const listId = await createListViaApi(baseURL, ADMIN, modelId, "Products", items)
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/lists/${listId}`)
  const table = itemsTable(page, "Products")
  await expect(table.getByRole("button", { name: "Rename Product 1", exact: true })).toBeVisible()
  await expect(table).toHaveAttribute("aria-rowcount", "701")
  expect(await table.locator("tbody tr").count()).toBeLessThan(60)
  await expect(page.getByText("700 items")).toBeVisible()

  // The table's own box scrolls; its header stays where it is.
  const scroller = page.locator("[data-slot='table-container']")
  await scroller.evaluate((box) => box.scrollTo({ top: box.scrollHeight / 2 }))
  await expect(table.getByRole("button", { name: /^Rename Product 3\d\d$/ }).first()).toBeVisible()
  await expect(table.getByRole("checkbox", { name: "Select all items" })).toBeInViewport()
  await screenshot(page, "w4-items-long", { ready: table })
  await scroller.evaluate((box) => box.scrollTo({ top: box.scrollHeight }))
  await expect(table.getByRole("button", { name: "Rename Product 700", exact: true })).toBeVisible()
  await expect(table.getByRole("button", { name: "Rename Product 1", exact: true })).toHaveCount(0)

  // Everything in a filter's reach is a click away, wherever it sits.
  await page.getByRole("searchbox", { name: "Filter items" }).fill("Product 456")
  await expect(table.getByRole("button", { name: "Rename Product 456", exact: true })).toBeVisible()
  await expect(page.getByText("700 items, 1 shown")).toBeVisible()
})

test("a viewer reads the lists, their items, subsets and properties, and changes nothing", async ({
  page,
}) => {
  await login(page, VIEWER)
  await page.goto(`/m/${modelId}/lists`)
  const lists = page.getByRole("table", { name: "Lists" })
  await expect(lists).toBeVisible()
  await expect(page.getByRole("button", { name: "New list" })).toHaveCount(0)
  await lists.getByRole("link", { name: "Countries" }).click()
  const table = itemsTable(page, "Countries")
  await expect(table.getByText("Deutschland")).toBeVisible()
  for (const name of ["Add item", "Bulk add", "List settings"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0)
  }
  await expect(table.getByRole("checkbox")).toHaveCount(0)
  await expect(table.getByRole("button", { name: /^Rename/ })).toHaveCount(0)
  await page.getByRole("button", { name: "Subsets" }).click()
  const sheet = page.getByRole("dialog", { name: "Subsets of Countries" })
  await expect(sheet.getByText("Eurozone")).toBeVisible()
  await expect(sheet.getByRole("textbox", { name: "New subset" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page.goto(`/m/${modelId}/lists`)
  await lists.getByRole("link", { name: "Regions" }).first().click()
  await page.getByRole("tab", { name: "Properties" }).click()
  await expect(page.getByRole("grid", { name: "Regions properties grid" })).toHaveAttribute(
    "aria-readonly",
    "true",
  )
  await expect(page.getByRole("button", { name: "Add property" })).toHaveCount(0)
})

test("the lists screens fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/lists`)
  const lists = page.getByRole("table", { name: "Lists" })
  await expect(lists).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w4-phone-lists", { ready: lists })

  await lists.getByRole("link", { name: "Countries" }).click()
  await expect(itemsTable(page, "Countries")).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
  await screenshot(page, "w4-phone-items", { ready: itemsTable(page, "Countries") })

  await page.getByRole("button", { name: "Subsets" }).click()
  const sheet = page.getByRole("dialog", { name: "Subsets of Countries" })
  await expect(sheet).toBeVisible()
  expect(await scrollsSideways(page)).toBe(false)
})
