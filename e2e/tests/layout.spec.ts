import { type Page, expect, test } from "@playwright/test"
import { ADMIN, createModelViaApi, createModuleViaApi, deleteAllModels, login } from "./helpers"

// One unbroken word, longer than a phone is wide at the size of a page title.
const LONG_MODEL_NAME = "Revenue_Forecast_FY27_Scenario_Planning_Baseline_v2"
const LONG_MODULE_NAME = "Regional revenue forecast by product line"
// The longest a name may be is 80 characters.
const LONGEST_MODULE_NAME =
  "Quarterly regional revenue forecast by product line and customer segment, EMEA"
const AREA_NAME = "Finance and treasury operations"

let modelId: string
let moduleId: string
let areaModuleId: string

test.beforeAll(async ({}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, LONG_MODEL_NAME)
  moduleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: LONG_MODULE_NAME,
    functional_area: "",
    axes: [],
  })
  areaModuleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: LONGEST_MODULE_NAME,
    functional_area: AREA_NAME,
    axes: [{ kind: "time", level: "month" }],
  })
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

/**
 * What is wrong with the breadcrumb as drawn: a crumb with no width, crumbs that overlap each other
 * or the search button, and a separator without a crumb on each side of it. jsdom has no layout,
 * so only a real browser can tell.
 */
async function breadcrumbProblems(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav[aria-label=breadcrumb]")
    const search = [...document.querySelectorAll("header button")].find((button) =>
      button.textContent?.includes("Search"),
    )
    if (!nav || !search) {
      return ["there is no breadcrumb or no search button"]
    }
    const drawn = [...nav.querySelectorAll("li")]
      .filter((li) => getComputedStyle(li).display !== "none")
      .map((li) => ({
        kind: li.getAttribute("data-slot"),
        text: li.textContent?.trim() ?? "",
        box: li.getBoundingClientRect(),
      }))
    const problems: string[] = []
    drawn.forEach(({ kind, text, box }, index) => {
      const expected = index % 2 === 0 ? "breadcrumb-item" : "breadcrumb-separator"
      if (kind !== expected) {
        problems.push(`"${text}" is a ${kind}, where a ${expected} belongs`)
      }
      if (kind === "breadcrumb-item" && box.width < 16) {
        problems.push(`"${text}" is ${box.width}px wide`)
      }
      const next = drawn[index + 1]
      if (next && next.box.left < box.right - 0.5) {
        problems.push(`"${text}" runs into "${next.text}"`)
      }
    })
    if (drawn.at(-1)?.kind !== "breadcrumb-item") {
      problems.push("the last crumb is a separator")
    }
    const last = drawn.at(-1)
    if (last && last.box.right > search.getBoundingClientRect().left + 0.5) {
      problems.push("the breadcrumb runs into the search button")
    }
    return problems
  })
}

for (const width of [375, 800, 1024, 1280]) {
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
        ready: page.getByRole("link", { name: LONG_MODULE_NAME }).first(),
      },
      {
        path: `/m/${modelId}/modules/${moduleId}`,
        h1: LONG_MODULE_NAME,
        ready: page.getByRole("heading", { name: "No line items yet", level: 2 }),
      },
      {
        path: `/m/${modelId}/modules/${areaModuleId}`,
        h1: LONGEST_MODULE_NAME,
        ready: page.getByRole("heading", { name: "No line items yet", level: 2 }),
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
      if (path.startsWith("/m/")) {
        expect.soft(await breadcrumbProblems(page), `the breadcrumb of ${path}`).toEqual([])
      }
      if (path === `/m/${modelId}/modules`) {
        const cut = await page
          .locator("table td:first-child")
          .evaluateAll((cells) =>
            cells
              .filter((cell) => cell.scrollWidth > cell.clientWidth)
              .map((cell) => cell.textContent),
          )
        expect.soft(cut, `module names cut short on ${path}`).toEqual([])
      }
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
