import { type Page, expect, test } from "@playwright/test"
import {
  ADMIN,
  createMemberViaApi,
  createModelViaApi,
  deleteAllModels,
  login,
  screenshot,
  toastWith,
} from "./helpers"

const MODEL_NAME = "Plan FY27"
const VIEWER = { name: "Vera Viewer", email: "vera@acme.test", password: "viewer-password-1" }
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

let modelId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  await createMemberViaApi(baseURL, ADMIN, VIEWER, "viewer")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

/** The card with this heading, to look for its controls within. */
function card(page: Page, title: string) {
  return page
    .getByRole("heading", { name: title, level: 2 })
    .locator("xpath=ancestor::*[@data-slot='card']")
}

/** Whether the page is wider than the screen, which no page may be. */
async function scrollsSideways(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
}

/** How many pixels a table is wider than the box that holds it, which hides a column behind a scrollbar. */
async function tableOverflow(page: Page, name: string) {
  return page.getByRole("table", { name }).evaluate((table) => {
    const box = table.parentElement as HTMLElement
    return box.scrollWidth - box.clientWidth
  })
}

test("a builder sets the calendar, confirming a change of timeline, and the time ranges", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/modules`)
  const build = page.getByRole("navigation", { name: "Build" })
  await build.getByRole("link", { name: "Time" }).click()
  await expect(page.getByRole("heading", { name: "Time", level: 1 })).toBeVisible()
  await expect(build.getByRole("link", { name: "Time" })).toHaveAttribute("aria-current", "page")

  const calendar = card(page, "Calendar")
  const preview = page.getByRole("table", { name: "Timeline preview" })
  async function editCalendar() {
    await calendar.getByRole("combobox", { name: "Fiscal year starts" }).click()
    await page.getByRole("option", { name: "April" }).click()
    await calendar.getByLabel("First fiscal year").fill("2027")
    await calendar.getByLabel("Years", { exact: true }).fill("2")
  }

  // The preview follows the form before anything is saved.
  await editCalendar()
  await expect(calendar.getByText(/Shown as FY27\./)).toBeVisible()
  await expect(preview.getByRole("row")).toHaveCount(3)
  await expect(preview.getByRole("row", { name: /^FY27/ })).toContainText("Apr 26 – Mar 27")
  await expect(preview.getByRole("row", { name: /^FY28/ })).toContainText("Apr 27 – Mar 28")
  await expect(card(page, "Timeline preview")).toContainText("Follows the form; save to keep it.")
  await screenshot(page, "w2-time-preview-edit", {
    ready: preview.getByRole("row", { name: /^FY28/ }),
    reopen: editCalendar,
  })

  await calendar.getByLabel("Years", { exact: true }).fill("21")
  await calendar.getByRole("button", { name: "Save changes" }).click()
  await expect(calendar.getByText("Years must be between 1 and 20.")).toBeVisible()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)

  await calendar.getByLabel("Years", { exact: true }).fill("2")
  await calendar.getByRole("button", { name: "Save changes" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Change the timeline?" })
  await expect(confirm).toContainText(
    "Changing the timeline clears input values on line items that use Time.",
  )
  await confirm.getByRole("button", { name: "Change timeline" }).click()
  await expect(toastWith(page, "Calendar saved").last()).toBeVisible()
  await expect(confirm).toBeHidden()

  // Saved, the preview is what the server says, which is what the form showed before.
  await expect(card(page, "Timeline preview")).toContainText(
    "The timeline, one row per fiscal year.",
  )
  await expect(preview.getByRole("row", { name: /^FY27/ })).toContainText("Apr 26 – Mar 27")
  await expect(preview.getByRole("row", { name: /^FY28/ })).toContainText("Apr 27 – Mar 28")
  await expect(preview.getByRole("row", { name: /^FY28/ })).toContainText("Q4 FY28")
  await expect(preview.getByRole("row")).toHaveCount(3)

  // A new current period needs no confirmation: the timeline stays as it is.
  await calendar.getByRole("combobox", { name: "Current period" }).click()
  await page.getByRole("option", { name: "Sep 26" }).click()
  await calendar.getByRole("button", { name: "Save changes" }).click()
  await expect(toastWith(page, "Calendar saved").last()).toBeVisible()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await page.reload()
  await expect(card(page, "Calendar").getByRole("combobox", { name: "Current period" })).toHaveText(
    "Sep 26",
  )

  const ranges = card(page, "Time ranges")
  await expect(ranges.getByRole("heading", { name: "No time ranges yet", level: 3 })).toBeVisible()
  await screenshot(page, "w2-time-empty", {
    ready: ranges.getByRole("heading", { name: "No time ranges yet", level: 3 }),
  })
  await ranges.getByRole("button", { name: "Add time range" }).click()
  const add = page.getByRole("dialog", { name: "Add time range" })
  await expect(add.getByLabel("First year")).toHaveValue("2027")
  await add.getByLabel("Name").fill("Forecast years")
  await add.getByLabel("Years", { exact: true }).fill("1")
  await add.getByRole("button", { name: "Add time range" }).click()
  await expect(toastWith(page, "Time range added")).toBeVisible()
  await expect(ranges.getByRole("row", { name: /Forecast years/ })).toContainText("2027")

  await ranges.getByRole("button", { name: "Add time range" }).click()
  await add.getByLabel("Name").fill("Forecast years")
  await add.getByRole("button", { name: "Add time range" }).click()
  await expect(add.getByText(/already in use/)).toBeVisible()
  await add.getByLabel("Name").fill("Scratch")
  await add.getByRole("button", { name: "Add time range" }).click()
  await expect(ranges.getByRole("row", { name: /Scratch/ })).toBeVisible()
  await ranges.getByRole("button", { name: "Delete Scratch" }).click()
  await page
    .getByRole("alertdialog", { name: "Delete Scratch?" })
    .getByRole("button", { name: "Delete time range" })
    .click()
  await expect(toastWith(page, "Time range deleted")).toBeVisible()
  await expect(ranges.getByRole("row", { name: /Scratch/ })).toHaveCount(0)
  await expect(ranges.getByRole("button", { name: "Delete Forecast years" })).toBeFocused()

  await screenshot(page, "w2-time", { ready: preview })

  await screenshot(page, "w2-time-confirm", {
    ready: confirm,
    reopen: async () => {
      await calendar.getByRole("combobox", { name: "Fiscal year starts" }).click()
      await page.getByRole("option", { name: "May" }).click()
      await calendar.getByRole("button", { name: "Save changes" }).click()
    },
  })
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toBeHidden()
  await expect(calendar.getByRole("button", { name: "Save changes" })).toBeFocused()
})

test("a builder adds, renames and changes versions, and the choices survive a reload", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/time`)
  const build = page.getByRole("navigation", { name: "Build" })
  await build.getByRole("link", { name: "Versions" }).click()
  await expect(page.getByRole("heading", { name: "Versions", level: 1 })).toBeVisible()
  await expect(build.getByRole("link", { name: "Versions" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  const table = page.getByRole("table", { name: "Versions" })
  await expect(table.getByRole("row")).toHaveCount(4)
  await expect(table.getByRole("radio", { name: "Actual, actual version" })).toBeChecked()
  await expect(table.getByRole("radio", { name: "Budget, current version" })).toBeChecked()
  await expect(page.getByText("The actual and current versions can't be deleted.")).toBeVisible()

  await page.getByRole("button", { name: "Add version" }).click()
  const add = page.getByRole("dialog", { name: "Add version" })
  await add.getByLabel("Name").fill("Budget")
  await add.getByRole("button", { name: "Add version" }).click()
  await expect(add.getByText(/already in use/)).toBeVisible()
  await add.getByLabel("Name").fill("Downside")
  await add.getByRole("button", { name: "Add version" }).click()
  await expect(toastWith(page, "Version added")).toBeVisible()
  await expect(page.getByRole("button", { name: "Add version" })).toBeFocused()

  // Turning a name into an input moves none of the columns.
  const columns = async () => {
    const xs: Record<string, number> = {}
    for (const name of ["Actual", "Current", "Switchover"]) {
      const box = await table.locator("th", { hasText: new RegExp(`^${name}$`) }).boundingBox()
      xs[name] = Math.round(box?.x ?? -1)
    }
    return xs
  }
  const columnsBefore = await columns()
  await table.getByRole("button", { name: "Rename Downside" }).click()
  const rename = table.getByRole("textbox", { name: "Name of Downside" })
  await expect(rename).toBeFocused()
  expect(await columns()).toEqual(columnsBefore)
  await rename.fill("Downside case")
  await rename.press("Enter")
  await expect(toastWith(page, "Version renamed")).toBeVisible()
  await expect(table.getByRole("button", { name: "Rename Downside case" })).toBeFocused()
  expect(await columns()).toEqual(columnsBefore)

  await table.getByRole("button", { name: "Rename Forecast" }).click()
  await table.getByRole("textbox", { name: "Name of Forecast" }).fill("Nope")
  await page.keyboard.press("Escape")
  await expect(table.getByRole("button", { name: "Rename Forecast" })).toBeFocused()

  await table.getByRole("combobox", { name: "Switchover for Forecast" }).click()
  await page.getByRole("option", { name: "Oct 26" }).click()
  await expect(toastWith(page, "Switchover updated").last()).toBeVisible()
  await table.getByRole("radio", { name: "Forecast, current version" }).click()
  await expect(toastWith(page, "Current version updated").last()).toBeVisible()
  await expect(table.getByRole("radio", { name: "Forecast, current version" })).toBeChecked()
  await expect(table.getByRole("radio", { name: "Budget, current version" })).not.toBeChecked()

  await page.reload()
  await expect(table.getByRole("radio", { name: "Forecast, current version" })).toBeChecked()
  await expect(table.getByRole("combobox", { name: "Switchover for Forecast" })).toHaveText(
    "Oct 26",
  )
  await expect(table.getByText("Not applicable")).toHaveCount(1)

  // The actual version can never be deleted; the button says why when it is hovered.
  const keepActual = table.getByRole("button", { name: "Delete Actual" })
  await expect(keepActual).toBeDisabled()
  await keepActual.locator("xpath=..").hover()
  await expect(page.getByRole("tooltip")).toHaveText("The actual version can't be deleted.")

  await screenshot(page, "w2-versions", { ready: table })
  await screenshot(page, "w2-versions-rename", {
    ready: page.getByRole("textbox", { name: "Name of Downside case" }),
    reopen: async () => {
      await page.getByRole("button", { name: "Rename Downside case" }).click()
    },
  })
  await page.keyboard.press("Escape")

  await table.getByRole("button", { name: "Delete Downside case" }).click()
  await page
    .getByRole("alertdialog", { name: "Delete Downside case?" })
    .getByRole("button", { name: "Delete version" })
    .click()
  await expect(toastWith(page, "Version deleted")).toBeVisible()
  await expect(table.getByRole("row")).toHaveCount(4)
})

test("a viewer sees the calendar and the versions as text", async ({ page }) => {
  await login(page, VIEWER)
  await page.goto(`/m/${modelId}/time`)

  const calendar = card(page, "Calendar")
  await expect(
    calendar.getByText("Only workspace admins and builders can change the calendar."),
  ).toBeVisible()
  await expect(calendar.getByText("FY27 (2027)")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Save changes|Add time range|Delete/ }),
  ).toHaveCount(0)
  await expect(page.getByRole("combobox")).toHaveCount(0)
  await screenshot(page, "w2-time-viewer", {
    ready: page.getByRole("table", { name: "Timeline preview" }),
  })

  await page.goto(`/m/${modelId}/versions`)
  const table = page.getByRole("table", { name: "Versions" })
  await expect(page.getByText(/Only workspace admins and builders can change them\./)).toBeVisible()
  await expect(table.getByRole("row", { name: /^Forecast/ })).toContainText("Oct 26")
  await expect(page.getByRole("radio")).toHaveCount(0)
  await expect(page.getByRole("combobox")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Add version|Delete|Rename/ })).toHaveCount(0)
  await screenshot(page, "w2-versions-viewer", { ready: table })
})

test("both screens show placeholders while they load, and an error that can be retried", async ({
  page,
}) => {
  await login(page, ADMIN)
  const structure = "**/api/v1/models/*/structure"
  const main = page.getByRole("main")
  const screens = [
    {
      name: "time",
      path: `/m/${modelId}/time`,
      loading: "Loading time settings",
      loaded: page.getByRole("table", { name: "Timeline preview" }),
    },
    {
      name: "versions",
      path: `/m/${modelId}/versions`,
      loading: "Loading versions",
      loaded: page.getByRole("table", { name: "Versions" }),
    },
  ]
  for (const { name, path, loading, loaded } of screens) {
    // A request that is never answered leaves the page loading.
    await page.route(structure, () => {})
    await page.goto(path)
    await screenshot(page, `w2-${name}-loading`, {
      ready: main.getByRole("status", { name: loading }),
    })
    await page.unroute(structure)

    // A refusal is not retried by the client, so the error shows at once.
    await page.route(structure, (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "auth.forbidden",
          detail: "You don't have access to this model.",
        },
      }),
    )
    await page.goto(path)
    await expect(main.getByRole("alert")).toContainText("You don't have access to this model.")
    await screenshot(page, `w2-${name}-error`, { ready: main.getByRole("alert") })
    await page.unroute(structure)

    await main.getByRole("button", { name: "Retry" }).click()
    await expect(loaded).toBeVisible()
  }
})

for (const width of [375, 800, 1024]) {
  test(`both screens fit a ${width}px screen, tables included`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await login(page, ADMIN)

    await page.goto(`/m/${modelId}/time`)
    await expect(page.getByRole("table", { name: "Timeline preview" })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    expect(await tableOverflow(page, "Timeline preview")).toBe(0)
    expect(await tableOverflow(page, "Time ranges")).toBe(0)
    if (width === 375) {
      await screenshot(page, "w2-time-phone", {
        ready: page.getByRole("table", { name: "Timeline preview" }),
      })
    }

    await page.goto(`/m/${modelId}/versions`)
    await expect(page.getByRole("table", { name: "Versions" })).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    expect(await tableOverflow(page, "Versions")).toBe(0)
    if (width === 375 || width === 800) {
      await screenshot(page, `w2-versions-${width}`, {
        ready: page.getByRole("table", { name: "Versions" }),
      })
    }
  })
}

test("a production model keeps the controls on screen but switches them off", async ({ page }) => {
  await login(page, ADMIN)
  await page.goto(`/m/${modelId}/settings`)
  await page.getByRole("switch", { name: "Production mode" }).click()
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("Mode: Production")).toBeVisible()

  await page.goto(`/m/${modelId}/time`)
  await expect(page.getByText(PRODUCTION_MESSAGE)).toBeVisible()
  const calendar = card(page, "Calendar")
  await expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toBeDisabled()
  await expect(calendar.getByLabel("Years", { exact: true })).toBeDisabled()
  const add = card(page, "Time ranges").getByRole("button", { name: "Add time range" })
  await expect(add).toBeDisabled()
  await add.locator("xpath=..").hover()
  await expect(page.getByRole("tooltip")).toHaveText(PRODUCTION_MESSAGE)
  await screenshot(page, "w2-time-production", {
    ready: page.getByRole("table", { name: "Timeline preview" }),
  })

  await page.goto(`/m/${modelId}/versions`)
  const table = page.getByRole("table", { name: "Versions" })
  await expect(page.getByText(PRODUCTION_MESSAGE)).toBeVisible()
  await expect(page.getByRole("button", { name: "Add version" })).toBeDisabled()
  for (const radio of await table.getByRole("radio").all()) {
    await expect(radio).toBeDisabled()
  }
  await expect(table.getByRole("button", { name: /^Rename/ })).toHaveCount(0)
  await screenshot(page, "w2-versions-production", { ready: table })
})
