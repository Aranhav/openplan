import { expect, test } from "@playwright/test"
import { ADMIN, WORKSPACE_NAME, login, screenshot, toastWith } from "./helpers"

const PAT = { name: "Pat Planner", email: "pat@acme.test", password: "planner-password-1" }

test.describe.configure({ mode: "serial" })

test("an admin creates a user and adds them to the workspace as a planner", async ({ page }) => {
  await login(page, ADMIN)

  await page.getByRole("link", { name: "Users" }).click()
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "New user" }).click()
  const create = page.getByRole("dialog", { name: "Create user" })
  await create.getByLabel("Name", { exact: true }).fill(PAT.name)
  await create.getByLabel("Email", { exact: true }).fill(PAT.email)
  await create.getByLabel("Temporary password").fill(PAT.password)
  await create.getByRole("button", { name: "Create user" }).click()
  await expect(toastWith(page, `${PAT.name} created`)).toBeVisible()
  await expect(page.getByRole("row", { name: new RegExp(PAT.email) })).toBeVisible()
  await screenshot(page, "users")

  await page.getByRole("link", { name: "Members" }).click()
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Add member" }).click()
  const add = page.getByRole("dialog", { name: "Add member" })
  await add.getByLabel("Email").fill(PAT.email)
  await add.getByRole("combobox", { name: "Role" }).click()
  await page.getByRole("option", { name: "Planner" }).click()
  await add.getByRole("button", { name: "Add member" }).click()
  await expect(toastWith(page, `${PAT.name} added`)).toBeVisible()

  const row = page.getByRole("row", { name: new RegExp(PAT.email) })
  await expect(row.getByRole("combobox", { name: `Role for ${PAT.name}` })).toHaveText("Planner")
  await screenshot(page, "members")
})

test("the last admin of a workspace cannot demote themselves", async ({ page }) => {
  await login(page, ADMIN)
  await page.getByRole("link", { name: "Members" }).click()

  const role = page.getByRole("combobox", { name: `Role for ${ADMIN.name}` })
  await expect(role).toHaveText("Admin")
  await role.click()
  await page.getByRole("option", { name: "Planner" }).click()
  await page
    .getByRole("alertdialog", { name: "Change your own role?" })
    .getByRole("button", { name: "Change role" })
    .click()

  await expect(toastWith(page, "A workspace needs at least one admin.")).toBeVisible()
  await expect(role).toHaveText("Admin")
})

test("a planner sees the workspace but none of the admin controls", async ({ page }) => {
  await login(page, PAT)

  await expect(page.getByRole("button", { name: new RegExp(WORKSPACE_NAME) })).toBeVisible()
  await expect(page.getByRole("status", { name: "Loading models" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "New model" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Members" })).toBeVisible()
})
