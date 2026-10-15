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

/** What the API-backed helpers below use: JSON in and out, and the CSRF header on writes. */
interface ApiClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, data: unknown): Promise<T>
  delete(path: string): Promise<void>
}

/** Runs `run` with an API client signed in as `user`, so a spec can arrange data without the UI. */
async function withApi<T>(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  run: (api: ApiClient) => Promise<T>,
): Promise<T> {
  const context = await request.newContext({ baseURL })
  try {
    const login = await context.post("/api/v1/auth/login", { data: user })
    expect(login.ok()).toBe(true)
    const csrf = (await context.storageState()).cookies.find(
      ({ name }) => name === "op_csrf",
    )?.value
    expect(csrf).toBeTruthy()
    const headers = { "x-openplan-csrf": csrf as string }
    return await run({
      async get<R>(path: string) {
        const response = await context.get(path)
        expect(response.ok()).toBe(true)
        return (await response.json()) as R
      },
      async post<R>(path: string, data: unknown) {
        const response = await context.post(path, { data, headers })
        expect(response.ok()).toBe(true)
        return (await response.json()) as R
      },
      async delete(path: string) {
        const response = await context.delete(path, { headers })
        expect(response.ok()).toBe(true)
      },
    })
  } finally {
    await context.dispose()
  }
}

interface Me {
  workspaces: { id: string }[]
}

/** Deletes every model in the user's workspaces through the API, so a spec can start from none. */
export async function deleteAllModels(baseURL: string, user: Pick<User, "email" | "password">) {
  await withApi(baseURL, user, async (api) => {
    const me = await api.get<Me>("/api/v1/auth/me")
    for (const workspace of me.workspaces) {
      const models = await api.get<{ id: string }[]>(`/api/v1/workspaces/${workspace.id}/models`)
      for (const model of models) {
        await api.delete(`/api/v1/models/${model.id}`)
      }
    }
  })
}

/** Creates a model in the user's first workspace through the API and returns its id. */
export async function createModelViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  name: string,
) {
  return withApi(baseURL, user, async (api) => {
    const me = await api.get<Me>("/api/v1/auth/me")
    const model = await api.post<{ id: string }>(
      `/api/v1/workspaces/${me.workspaces[0].id}/models`,
      { name },
    )
    return model.id
  })
}

/** Creates an account through the API (as `admin`) and adds it to the admin's first workspace. */
export async function createMemberViaApi(
  baseURL: string,
  admin: Pick<User, "email" | "password">,
  user: User,
  role: "admin" | "builder" | "planner" | "viewer",
) {
  await withApi(baseURL, admin, async (api) => {
    await api.post("/api/v1/users", { ...user, is_instance_admin: false })
    const me = await api.get<Me>("/api/v1/auth/me")
    await api.post(`/api/v1/workspaces/${me.workspaces[0].id}/members`, {
      email: user.email,
      role,
    })
  })
}
