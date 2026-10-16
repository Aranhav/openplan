import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { countriesList, listsStructure, productsList, regionsList, serveLists } from "@/test/lists"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel()

type Typist = ReturnType<typeof userEvent.setup>

async function openSettings(
  typist: Typist,
  listId = regionsList,
  { mode = "dev" }: { mode?: "dev" | "prod" } = {},
) {
  mockSession({
    me: {
      ...me,
      workspaces: [{ ...workspace, role: "admin" as components["schemas"]["WorkspaceRole"] }],
    },
  })
  serveModels([{ ...model, mode }])
  const store = serveLists(listsStructure())
  const app = renderApp(`/m/${model.id}/lists/${listId}`)
  await typist.click(await screen.findByRole("button", { name: "List settings" }))
  const sheet = within(await screen.findByRole("dialog", { name: "List settings" }))
  return { sheet, store, ...app }
}

describe("the settings of a list", () => {
  it("show its name, top level and production data, and whether it is numbered", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)

    expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Regions")
    expect(sheet.getByRole("textbox", { name: "Top level name" })).toHaveValue("All regions")
    expect(sheet.getByText("Leave empty for no top level")).toBeVisible()
    expect(sheet.getByRole("switch", { name: "Production data" })).not.toBeChecked()
    expect(sheet.getByText("Numbered: No")).toBeVisible()
    expect(sheet.getByText(/can't be changed\.$/)).toBeVisible()
    expect(sheet.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("say a numbered list repeats its names", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    const structure = listsStructure()
    structure.lists[2] = { ...structure.lists[2], numbered: true }
    serveLists(structure)
    renderApp(`/m/${model.id}/lists/${productsList}`)
    await typist.click(await screen.findByRole("button", { name: "List settings" }))

    const sheet = within(await screen.findByRole("dialog", { name: "List settings" }))
    expect(sheet.getByText("Numbered: Yes")).toBeVisible()
    expect(sheet.getByText(/names may repeat/)).toBeVisible()
    expect(sheet.getByRole("switch", { name: "Production data" })).toBeChecked()
  })

  it("save only what changed, and close", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSettings(typist)
    const name = sheet.getByRole("textbox", { name: "Name" })
    await typist.clear(name)
    await typist.type(name, "  Areas ")
    await typist.click(sheet.getByRole("switch", { name: "Production data" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(store.writes).toEqual([
      {
        method: "PATCH",
        path: `lists/${regionsList}`,
        body: { name: "Areas", production_data: true },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("List saved")
    expect(await screen.findByRole("heading", { level: 1, name: "Areas" })).toBeVisible()
    expect(screen.getByRole("button", { name: "List settings" })).toHaveFocus()
  })

  it("clear the top level when it is emptied", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSettings(typist)
    await typist.clear(sheet.getByRole("textbox", { name: "Top level name" }))
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({ top_level_name: null })
  })

  it("need a name", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSettings(typist)
    const name = sheet.getByRole("textbox", { name: "Name" })
    await typist.clear(name)
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    expect(await sheet.findByText("Name is required.")).toBeVisible()
    expect(store.writes).toEqual([])
  })

  it("show a name that is taken under the name", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist)
    server.use(
      http.patch("/api/v1/models/:id/lists/:listId", () =>
        problem(409, "structure.name_taken", "A list named Products already exists."),
      ),
    )
    const name = sheet.getByRole("textbox", { name: "Name" })
    await typist.clear(name)
    await typist.type(name, "Products")
    await typist.click(sheet.getByRole("button", { name: "Save changes" }))

    expect(await sheet.findByText("A list named Products already exists.")).toBeVisible()
    expect(name).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "List settings" })).toBeVisible()
  })

  it("close without saving on Cancel", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSettings(typist)
    await typist.type(sheet.getByRole("textbox", { name: "Name" }), "!")
    await typist.click(sheet.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(store.writes).toEqual([])
  })
})

describe("deleting a list", () => {
  it("asks first, then goes back to the lists", async () => {
    const typist = userEvent.setup()
    const { sheet, store, router } = await openSettings(typist, countriesList)
    await typist.click(sheet.getByRole("button", { name: "Delete list" }))
    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Countries?" }))
    expect(dialog.getByText(/uses it\.$/)).toBeVisible()
    await typist.click(dialog.getByRole("button", { name: "Delete list" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${model.id}/lists`))
    expect(store.writes).toEqual([{ method: "DELETE", path: `lists/${countriesList}` }])
    expect(toast.success).toHaveBeenCalledWith("List deleted")
  })

  it("stays when something uses the list", async () => {
    const typist = userEvent.setup()
    const { sheet, router } = await openSettings(typist, regionsList)
    await typist.click(sheet.getByRole("button", { name: "Delete list" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete list" }),
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The list is used by a subset or another list."),
    )
    expect(router.state.location.pathname).toBe(`/m/${model.id}/lists/${regionsList}`)
    expect(screen.getByRole("alertdialog")).toBeVisible()
  })

  it("gives focus back to Delete list when the question is dismissed", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSettings(typist, countriesList)
    await typist.click(sheet.getByRole("button", { name: "Delete list" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    )

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(sheet.getByRole("button", { name: "Delete list" })).toHaveFocus()
  })
})
