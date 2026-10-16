import { type Browser, type Page, type WebSocketRoute, expect, test } from "@playwright/test"
import {
  ADMIN,
  type User,
  createLineItemViaApi,
  createListViaApi,
  createMemberViaApi,
  createModelViaApi,
  createModuleViaApi,
  deleteAllModels,
  login,
  screenshot,
} from "./helpers"

const MODEL_NAME = "Live plan"
// The accounts of the specs share one database: no other spec uses this address.
const PLANNER: User = {
  name: "Lou Live",
  email: "lou@acme.test",
  password: "planner-password-4",
}
const LIVE_SOCKET = /\/api\/v1\/models\/[0-9a-f-]{36}\/live/

let baseURL: string
let modelId: string
let moduleId: string

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({}, testInfo) => {
  baseURL = testInfo.project.use.baseURL as string
  await deleteAllModels(baseURL, ADMIN)
  modelId = await createModelViaApi(baseURL, ADMIN, MODEL_NAME)
  const regions = await createListViaApi(baseURL, ADMIN, modelId, "Regions", ["North", "South"])
  moduleId = await createModuleViaApi(baseURL, ADMIN, modelId, {
    name: "Sales",
    functional_area: "Finance",
    axes: [{ kind: "list", list: regions }],
  })
  await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Units" })
  await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, {
    name: "Double",
    formula: "Units * 2",
  })
  await createMemberViaApi(baseURL, ADMIN, PLANNER, "planner")
})

// What this spec adds is gone again, so the specs that follow start from an empty workspace.
test.afterAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

/** Signs `user` in, in a browser of their own, and opens the grid of the module. */
async function openGrid(browser: Browser, user: Pick<User, "email" | "password">) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await login(page, user)
  await page.goto(`/m/${modelId}/modules/${moduleId}?tab=grid`)
  await expect(page.getByRole("grid", { name: "Sales grid" })).toBeVisible()
  return { context, page }
}

function gridCell(page: Page, row: number, col: number) {
  return page
    .getByRole("grid", { name: "Sales grid" })
    .locator(`[data-row='${row}'][data-col='${col}']`)
}

async function enter(page: Page, row: number, col: number, value: string) {
  await gridCell(page, row, col).click()
  await page.keyboard.type(value)
  await page.keyboard.press("Enter")
  await expect(gridCell(page, row, col)).toHaveText(value)
}

const indicator = (page: Page, label: string) => page.getByRole("img", { name: label })

/**
 * Stands between the page and the live socket. Its `mode` says what a socket the page opens
 * meets: `open` goes through to the server, `blocked` is closed at once, the way a server that is
 * gone refuses, and `silent` is accepted and never greeted.
 */
async function guardSocket(page: Page) {
  const state: { mode: "open" | "blocked" | "silent"; current?: WebSocketRoute } = { mode: "open" }
  await page.routeWebSocket(LIVE_SOCKET, (socket) => {
    if (state.mode === "blocked") {
      void socket.close({ code: 1013, reason: "Try again later." })
    } else if (state.mode === "open") {
      socket.connectToServer()
      state.current = socket
    }
  })
  return state
}

test("an edit in one browser shows in the other without a reload", async ({ browser }) => {
  const admin = await openGrid(browser, ADMIN)
  const planner = await openGrid(browser, PLANNER)
  await expect(indicator(admin.page, "Live updates on")).toBeVisible()
  await expect(indicator(planner.page, "Live updates on")).toBeVisible()
  // A reload would clear this.
  await admin.page.evaluate(() => {
    ;(window as unknown as { openedBefore: boolean }).openedBefore = true
  })

  // The planner enters Units; the admin sees it, and Double, which is calculated from it.
  await enter(planner.page, 0, 0, "42")
  await expect(gridCell(admin.page, 0, 0)).toHaveText("42")
  await expect(gridCell(admin.page, 1, 0)).toHaveText("84")

  // And the other way round.
  await enter(admin.page, 0, 1, "7")
  await expect(gridCell(planner.page, 0, 1)).toHaveText("7")
  await expect(gridCell(planner.page, 1, 1)).toHaveText("14")

  // A change to the structure shows too: a line item added through the API appears in both.
  await createLineItemViaApi(baseURL, ADMIN, modelId, moduleId, { name: "Tax" })
  for (const { page } of [admin, planner]) {
    await expect(page.getByRole("grid", { name: "Sales grid" }).getByText("Tax")).toBeVisible()
  }

  expect(
    await admin.page.evaluate(() => (window as unknown as { openedBefore?: boolean }).openedBefore),
  ).toBe(true)
  await admin.context.close()
  await planner.context.close()
})

test("a page that lost its connection catches up on what it missed when it is back", async ({
  browser,
}) => {
  const admin = await openGrid(browser, ADMIN)
  const planner = await openGrid(browser, PLANNER)
  const socket = await guardSocket(admin.page)
  await admin.page.reload()
  await expect(gridCell(admin.page, 0, 0)).toHaveText("42")
  await expect(indicator(admin.page, "Live updates on")).toBeVisible()

  // The connection of the admin goes, and the server turns the next ones away.
  socket.mode = "blocked"
  await socket.current?.close({ code: 4000, reason: "Gone." })
  await expect(indicator(admin.page, "Reconnecting…")).toBeVisible()
  await enter(planner.page, 0, 0, "50")
  await expect(gridCell(admin.page, 0, 0)).toHaveText("42")

  // Back at last, the page reads what it missed, and says it is live again.
  socket.mode = "open"
  await expect(indicator(admin.page, "Live updates on")).toBeVisible({ timeout: 40_000 })
  await expect(gridCell(admin.page, 0, 0)).toHaveText("50")
  await expect(gridCell(admin.page, 1, 0)).toHaveText("100")

  await admin.context.close()
  await planner.context.close()
})

test("the indicator shows whether the page is connecting, live, reconnecting or off", async ({
  browser,
}) => {
  const { context, page } = await openGrid(browser, ADMIN)
  const socket = await guardSocket(page)
  const hover = (label: string) => async () => {
    await indicator(page, label).hover()
    await expect(page.getByRole("tooltip")).toHaveText(label)
  }

  await page.reload()
  await expect(indicator(page, "Live updates on")).toBeVisible()
  await screenshot(page, "l1-live", {
    ready: indicator(page, "Live updates on"),
    reopen: hover("Live updates on"),
  })

  // A socket that is never greeted is a first connection that is still being made.
  socket.mode = "silent"
  await page.reload()
  await expect(indicator(page, "Connecting…")).toBeVisible()
  await screenshot(page, "l1-connecting", {
    ready: indicator(page, "Connecting…"),
    reopen: hover("Connecting…"),
  })

  socket.mode = "blocked"
  await page.reload()
  await expect(indicator(page, "Reconnecting…")).toBeVisible()
  await screenshot(page, "l1-reconnecting", {
    ready: indicator(page, "Reconnecting…"),
    reopen: hover("Reconnecting…"),
  })

  // A ticket that is refused for good ends the attempts: nothing a new one would change.
  await page.route("**/api/v1/models/*/live/ticket", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        code: "auth.csrf",
        detail: "The request was refused.",
      }),
    }),
  )
  await page.reload()
  await expect(indicator(page, "Live updates off")).toBeVisible()
  await screenshot(page, "l1-off", {
    ready: indicator(page, "Live updates off"),
    reopen: hover("Live updates off"),
  })
  await expect(page.getByRole("grid", { name: "Sales grid" })).toBeVisible()

  await context.close()
})
