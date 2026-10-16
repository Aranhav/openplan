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

/** Creates a model from the models page and waits for its modules to open. */
export async function createModel(page: Page, name: string) {
  await page.getByRole("button", { name: "New model" }).click()
  const dialog = page.getByRole("dialog", { name: "Create model" })
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByRole("button", { name: "Create model" }).click()
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}\/modules$/)
  await expect(page.getByRole("heading", { name: "Modules", level: 1 })).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name }),
  ).toBeVisible()
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
  /**
   * Whether the whole page is taken, not what the window shows (the default). A whole-page picture
   * resizes the window while it is taken, which closes a menu that is laid out by the window's width.
   */
  fullPage?: boolean
}

/**
 * Saves `screenshots/<name>-light.png` and `-dark.png`. Each theme is stored where the app reads
 * it and the page is reloaded, so this also checks that the choice survives a load. The page is
 * left in the light theme.
 */
export async function screenshot(
  page: Page,
  name: string,
  { ready, reopen, fullPage = true }: ScreenshotOptions,
) {
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
      fullPage,
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

/** Creates a module in a model through the API and returns its id. */
export async function createModuleViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
  module: { name: string; functional_area: string; axes: unknown[] },
) {
  return withApi(baseURL, user, async (api) => {
    const created = await api.post<{ id: string }>(`/api/v1/models/${modelId}/modules`, module)
    return created.id
  })
}

/** Creates a list with these items in a model through the API and returns its id. */
export async function createListViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
  name: string,
  items: string[],
) {
  return withApi(baseURL, user, async (api) => {
    const list = await api.post<{ id: string }>(`/api/v1/models/${modelId}/lists`, { name })
    await api.post(`/api/v1/models/${modelId}/lists/${list.id}/items`, {
      items: items.map((item) => ({ name: item })),
    })
    return list.id
  })
}

/** Creates a line item in a module through the API and returns its id. */
export async function createLineItemViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
  moduleId: string,
  lineItem: { name: string; formula?: string; format?: unknown },
) {
  return withApi(baseURL, user, async (api) => {
    const created = await api.post<{ id: string }>(
      `/api/v1/models/${modelId}/modules/${moduleId}/line-items`,
      lineItem,
    )
    return created.id
  })
}

/** Deletes a line item through the API, so that the formulas that used it have errors. */
export async function deleteLineItemViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
  lineItemId: string,
) {
  await withApi(baseURL, user, (api) =>
    api.delete(`/api/v1/models/${modelId}/line-items/${lineItemId}`),
  )
}

/** Writes numbers into cells through the API: one token for each dimension of the line item. */
export async function writeCellsViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
  edits: { line_item_id: string; coords: string[]; value: number }[],
) {
  await withApi(baseURL, user, (api) =>
    api.post(`/api/v1/models/${modelId}/cells`, {
      edits: edits.map(({ value, ...edit }) => ({ ...edit, value: { t: "number", v: value } })),
    }),
  )
}

/** The structure of a model through the API. */
export async function structureViaApi(
  baseURL: string,
  user: Pick<User, "email" | "password">,
  modelId: string,
) {
  return withApi(baseURL, user, (api) =>
    api.get<{
      calendar: { first_year: number; years: number }
      month_labels: string[]
      lists: { id: string; name: string; items: { id: string; name: string }[] }[]
      modules: { id: string; name: string }[]
      line_items: { id: string; name: string; module: string; ordinal: number }[]
    }>(`/api/v1/models/${modelId}/structure`),
  )
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
