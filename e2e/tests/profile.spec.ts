import { type Page, expect, test } from "@playwright/test"
import { ADMIN, createMemberViaApi, login, signOut, toastWith } from "./helpers"

// Its own account: the other specs sign in as the admin, whose password must stay as it is.
const PENNY = { name: "Penny Profile", email: "penny@acme.test", password: "first-password-123" }
const NEW_PASSWORD = "second-password-456"

test.beforeAll(async ({}, testInfo) => {
  await createMemberViaApi(testInfo.project.use.baseURL as string, ADMIN, PENNY, "viewer")
})

async function openProfile(page: Page) {
  await page.getByRole("button", { name: PENNY.email }).click()
  await page.getByRole("menuitem", { name: "Profile" }).click()
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible()
}

test("a user changes their password and signs in with the new one", async ({ page }) => {
  await login(page, PENNY)
  await openProfile(page)

  const current = page.getByLabel("Current password", { exact: true })
  const next = page.getByLabel("New password", { exact: true })
  const confirm = page.getByLabel("Confirm new password", { exact: true })
  const submit = page.getByRole("button", { name: "Change password" })

  await current.fill(PENNY.password)
  await next.fill(NEW_PASSWORD)
  await confirm.fill("not-the-same-password")
  await submit.click()
  await expect(page.getByText("Passwords don't match.")).toBeVisible()

  await current.fill("not-my-current-password")
  await confirm.fill(NEW_PASSWORD)
  await submit.click()
  await expect(page.getByText("Current password is incorrect.")).toBeVisible()

  await current.fill(PENNY.password)
  await submit.click()
  await expect(toastWith(page, "Password changed")).toBeVisible()
  await expect(current).toHaveValue("")
  await expect(next).toHaveValue("")
  await expect(confirm).toHaveValue("")

  await signOut(page, PENNY)
  await page.getByLabel("Email").fill(PENNY.email)
  await page.getByLabel("Password").fill(PENNY.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible()

  await login(page, { email: PENNY.email, password: NEW_PASSWORD })
})
