import { expect, test } from "@playwright/test"
import { ADMIN, createModel, deleteAllModels, login, screenshot, toastWith } from "./helpers"

test.describe.configure({ mode: "serial" })

// Another spec may have left models behind; this one starts from an empty workspace.
test.beforeAll(async ({}, testInfo) => {
  await deleteAllModels(testInfo.project.use.baseURL as string, ADMIN)
})

test("a model is created, renamed and switched to production mode", async ({ page }) => {
  await login(page, ADMIN)
  await expect(page.getByRole("heading", { name: "No models yet" })).toBeVisible()

  await createModel(page, "FY27 Budget")
  await expect(toastWith(page, "Model created")).toBeVisible()

  await expect(page.getByText("Model settings", { exact: true })).toBeVisible()
  const save = page.getByRole("button", { name: "Save changes" })
  await page.getByLabel("Name", { exact: true }).fill("FY27 Operating Budget")
  await save.click()
  await expect(toastWith(page, "Changes saved")).toBeVisible()
  await expect(page.getByRole("heading", { name: "FY27 Operating Budget", level: 1 })).toBeVisible()
  await expect(save).toBeDisabled()

  await page.getByRole("switch", { name: "Production mode" }).click()
  await save.click()
  await expect(page.getByText("Mode: Production")).toBeVisible()
  await expect(save).toBeDisabled()
  await screenshot(page, "model-settings", {
    ready: page.getByRole("heading", { name: "FY27 Operating Budget", level: 1 }),
  })
})

test("the models page lists the model, refuses a duplicate name and deletes", async ({ page }) => {
  await login(page, ADMIN)

  const card = page.getByRole("link", { name: /FY27 Operating Budget/ })
  await expect(card).toContainText("Production")
  await screenshot(page, "models-grid", { ready: card })

  await page.getByRole("button", { name: "New model" }).click()
  const create = page.getByRole("dialog", { name: "Create model" })
  await create.getByLabel("Name", { exact: true }).fill("FY27 Operating Budget")
  await create.getByRole("button", { name: "Create model" }).click()
  await expect(
    create.getByText("A model with this name already exists in this workspace."),
  ).toBeVisible()
  await create.getByRole("button", { name: "Cancel" }).click()
  await expect(create).toBeHidden()

  await page.getByRole("button", { name: "Actions for FY27 Operating Budget" }).click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const rename = page.getByRole("dialog", { name: "Rename model" })
  await rename.getByLabel("Name", { exact: true }).fill("FY27 Budget v2")
  await rename.getByRole("button", { name: "Rename model" }).click()
  await expect(toastWith(page, "Model renamed")).toBeVisible()
  await expect(page.getByRole("link", { name: /FY27 Budget v2/ })).toBeVisible()

  await page.getByRole("button", { name: "Actions for FY27 Budget v2" }).click()
  await page.getByRole("menuitem", { name: "Delete" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Delete FY27 Budget v2?" })
  await confirm.getByRole("button", { name: "Delete model" }).click()
  await expect(toastWith(page, "Model deleted")).toBeVisible()
  await expect(page.getByRole("heading", { name: "No models yet" })).toBeVisible()
})
