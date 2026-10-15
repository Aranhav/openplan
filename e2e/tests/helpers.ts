import { fileURLToPath } from "node:url"
import { type Locator, type Page, expect, request } from "@playwright/test"

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

interface ScreenshotOptions {
  /** What shows the page has finished loading; it is waited for after every reload. */
  ready: Locator
  /** Brings back what a reload closes (a palette, a dialog) before the picture is taken. */
  reopen?: () => Promise<void>
}

/**
 * Saves `screenshots/<name>-light.png` and `-dark.png`. Each theme is stored where the app reads
 * it and the page is reloaded, so this also checks that the choice survives a load. The page is
 * left in the light theme.
 */
export async function screenshot(page: Page, name: string, { ready, reopen }: ScreenshotOptions) {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => localStorage.setItem("openplan-theme", value), theme)
    await page.reload()
    await reopen?.()
    await expect(ready).toBeVisible()
    const html = page.locator("html")
    if (theme === "dark") {
      await expect(html).toHaveClass(/\bdark\b/)
    } else {
      await expect(html).not.toHaveClass(/\bdark\b/)
    }
    await page.screenshot({
      path: `${SCREENSHOT_DIR}${name}-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    })
  }
}

/** Deletes every model in the user's workspaces through the API, so a spec can start from none. */
export async function deleteAllModels(baseURL: string, user: Pick<User, "email" | "password">) {
  const api = await request.newContext({ baseURL })
  try {
    const login = await api.post("/api/v1/auth/login", { data: user })
    expect(login.ok()).toBe(true)
    const csrf = (await api.storageState()).cookies.find(({ name }) => name === "op_csrf")?.value
    expect(csrf).toBeTruthy()

    const me = await (await api.get("/api/v1/auth/me")).json()
    for (const workspace of me.workspaces as { id: string }[]) {
      const models = await (await api.get(`/api/v1/workspaces/${workspace.id}/models`)).json()
      for (const model of models as { id: string }[]) {
        const deleted = await api.delete(`/api/v1/models/${model.id}`, {
          headers: { "x-openplan-csrf": csrf as string },
        })
        expect(deleted.ok()).toBe(true)
      }
    }
  } finally {
    await api.dispose()
  }
}
