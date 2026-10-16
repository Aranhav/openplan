import { type Page, expect, test } from "@playwright/test"
import { ADMIN, createModelViaApi, deleteAllModels, login } from "./helpers"

// One unbroken word, longer than a phone is wide at the size of a page title.
const LONG_MODEL_NAME = "Revenue_Forecast_FY27_Scenario_Planning_Baseline_v2"

let modelId: string

test.beforeAll(async ({}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, LONG_MODEL_NAME)
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

async function firstHeading(page: Page) {
  return page
    .getByRole("heading")
    .first()
    .evaluate((heading) => ({
      level: heading.tagName,
      text: heading.textContent,
    }))
}

// jsdom has no layout, so the unit tests cannot see a page that is wider than the screen.
for (const width of [375, 800]) {
  test(`every signed-in page fits a ${width}px screen and starts with its own h1`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await login(page, ADMIN)
    const models = new URL(page.url()).pathname
    const pages = [
      {
        path: models,
        h1: "Models",
        ready: page.getByRole("link", { name: new RegExp(LONG_MODEL_NAME) }),
      },
      {
        path: `/m/${modelId}/modules`,
        h1: "Modules",
        ready: page.getByRole("heading", { name: "No modules yet", level: 2 }),
      },
      {
        path: `/m/${modelId}/settings`,
        h1: LONG_MODEL_NAME,
        ready: page.getByRole("heading", { name: "Model settings", level: 2 }),
      },
      {
        path: `${models}/members`,
        h1: "Members",
        ready: page.getByRole("row", { name: new RegExp(ADMIN.email) }),
      },
      {
        path: "/admin/users",
        h1: "Users",
        ready: page.getByRole("row", { name: new RegExp(ADMIN.email) }),
      },
      {
        path: "/profile",
        h1: "Profile",
        ready: page.getByRole("button", { name: "Change password" }),
      },
    ]

    for (const { path, h1, ready } of pages) {
      await page.goto(path)
      await expect(ready, `${path} has loaded`).toBeVisible()

      expect.soft(await firstHeading(page), `the first heading of ${path}`).toEqual({
        level: "H1",
        text: h1,
      })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect.soft(overflow, `${path} is wider than the ${width}px screen`).toBeLessThanOrEqual(0)
    }
  })
}

test("the skip link shows itself on focus and moves focus past the navigation and the header", async ({
  page,
}) => {
  await login(page, ADMIN)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible()

  await page.keyboard.press("Tab")
  const skip = page.getByRole("link", { name: "Skip to content" })
  await expect(skip).toBeFocused()
  // Hidden it is a pixel wide; focused it is a link to read and click.
  const box = await skip.boundingBox()
  expect(box?.width).toBeGreaterThan(50)
  await page.keyboard.press("Enter")

  // The page's own container, not <main>, which also holds the header with the search button.
  await expect(page.locator("#content")).toBeFocused()
  await expect(page.locator("#content").getByRole("button", { name: /^Search/ })).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe("")
})
