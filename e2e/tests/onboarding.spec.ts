import { expect, test } from "@playwright/test"
import { ADMIN, WORKSPACE_NAME, login, screenshot, signOut } from "./helpers"

test.describe.configure({ mode: "serial" })

test("a fresh instance sends visitors to setup, and setup creates the first admin", async ({
  page,
}) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole("heading", { name: "Set up OpenPlan", level: 1 })).toBeVisible()
  await screenshot(page, "setup")

  await page.getByLabel("Your name").fill(ADMIN.name)
  await page.getByLabel("Work email").fill(ADMIN.email)
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password)
  await page.getByLabel("Confirm password").fill("not-the-same-password")
  await page.getByLabel("Workspace name").fill(WORKSPACE_NAME)
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByText("Passwords don't match.")).toBeVisible()
  await expect(page).toHaveURL(/\/setup$/)

  await page.getByLabel("Confirm password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/)
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models yet" })).toBeVisible()
  await expect(page.getByRole("button", { name: new RegExp(WORKSPACE_NAME) })).toBeVisible()
  await screenshot(page, "models-empty")
})

test("a user can sign out and back in, and a wrong password is refused", async ({ page }) => {
  await login(page, ADMIN)
  await signOut(page, ADMIN)

  await page.getByLabel("Email").fill(ADMIN.email)
  await page.getByLabel("Password").fill("wrong-password-entirely")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models yet" })).toBeVisible()
})
