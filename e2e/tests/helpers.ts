import { fileURLToPath } from "node:url"
import { type Page, expect } from "@playwright/test"

export interface User {
  name: string
  email: string
  password: string
}

/** The instance admin that `onboarding.spec.ts` creates; every other spec signs in as them. */
export const ADMIN: User = {
  name: "Ada Admin",
  email: "ada@acme.test",
  password: "correct-horse-battery",
}

export const WORKSPACE_NAME = "Acme Corp"

const SCREENSHOT_DIR = fileURLToPath(new URL("../screenshots/", import.meta.url))

export async function login(page: Page, user: Pick<User, "email" | "password">) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(user.email)
  await page.getByLabel("Password").fill(user.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible()
}

/** Signs out through the user menu at the foot of the sidebar. */
export async function signOut(page: Page, user: Pick<User, "email">) {
  await page.getByRole("button", { name: user.email }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/login$/)
}

/** Creates a model from the models page and waits for its page to open. */
export async function createModel(page: Page, name: string) {
  await page.getByRole("button", { name: "New model" }).click()
  const dialog = page.getByRole("dialog", { name: "Create model" })
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByRole("button", { name: "Create model" }).click()
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}$/)
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
}

/** A toast with this text; sonner renders each one as a list item. */
export function toastWith(page: Page, text: string) {
  return page.locator("[data-sonner-toast]", { hasText: text })
}

/**
 * Saves `screenshots/<name>-light.png` and `-dark.png`. Each theme is stored where the app reads
 * it and the page is reloaded, so this also checks that the choice survives a load. A reload drops
 * anything open on the page; `reopen` brings it back before the picture is taken. The page is
 * left in the light theme.
 */
export async function screenshot(page: Page, name: string, reopen?: () => Promise<void>) {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => localStorage.setItem("openplan-theme", value), theme)
    await page.reload()
    await reopen?.()
    const html = page.locator("html")
    if (theme === "dark") {
      await expect(html).toHaveClass(/\bdark\b/)
    } else {
      await expect(html).not.toHaveClass(/\bdark\b/)
    }
    await page.waitForLoadState("networkidle")
    await page.screenshot({
      path: `${SCREENSHOT_DIR}${name}-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    })
  }
}
