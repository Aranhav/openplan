import { type Page, expect, test } from "@playwright/test"
import { ADMIN, createModel, login, screenshot } from "./helpers"

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" })

async function openPalette(page: Page) {
  // The shortcut is only listened for once the app shell has rendered, e.g. after a reload.
  await expect(page.getByRole("button", { name: /^Search/ })).toBeVisible()
  await page.keyboard.press("Control+K")
  await expect(palette(page)).toBeVisible()
}

test("Control+K opens the command palette, and choosing a model opens it", async ({ page }) => {
  await login(page, ADMIN)
  await createModel(page, "Quarterly Forecast")
  await page.getByRole("link", { name: "Models", exact: true }).click()
  await createModel(page, "Headcount Plan")
  await page.getByRole("link", { name: "Models", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible()

  await openPalette(page)
  await expect(palette(page).getByRole("option", { name: "Quarterly Forecast" })).toBeVisible()
  await screenshot(page, "command-palette", {
    ready: palette(page).getByRole("option", { name: "Headcount Plan" }),
    reopen: () => openPalette(page),
  })

  await palette(page).getByPlaceholder(/Search pages/).fill("Headcount")
  await expect(palette(page).getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")

  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}$/)
  await expect(page.getByRole("heading", { name: "Headcount Plan", level: 1 })).toBeVisible()
  await expect(palette(page)).toBeHidden()
})

test("the sidebar collapses and the theme can be switched to dark", async ({ page }) => {
  await login(page, ADMIN)

  const sidebar = page.locator("[data-slot='sidebar']")
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await page.locator("[data-slot='sidebar-trigger']").click()
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")
  await page.locator("[data-slot='sidebar-trigger']").click()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")

  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
  // The browser draws native scrollbars and form controls in the scheme the page declares.
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light")
  await page.getByRole("button", { name: ADMIN.email }).click()
  await page.getByRole("menuitem", { name: "Theme" }).click()
  await page.getByRole("menuitemradio", { name: "Dark" }).click()
  await expect(page.locator("html")).toHaveClass(/\bdark\b/)
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark")
})
