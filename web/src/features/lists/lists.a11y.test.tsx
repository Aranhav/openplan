import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { violations } from "@/test/axe"
import { countriesList, listsStructure, productsList, regionsList, serveLists } from "@/test/lists"
import { makeStructure } from "@/test/structure"

const model = makeModel()

function open(
  path: string,
  {
    role = "admin",
    mode = "dev",
    structure = listsStructure(),
  }: {
    role?: components["schemas"]["WorkspaceRole"]
    mode?: "dev" | "prod"
    structure?: ReturnType<typeof listsStructure>
  } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  serveLists(structure)
  renderApp(`/m/${model.id}/lists${path}`)
}

describe("the lists page", () => {
  it.each([
    ["for a builder", { role: "admin" }],
    ["for a viewer", { role: "viewer" }],
    ["of a production model", { mode: "prod" }],
  ] as const)("has no accessibility violations %s", async (_, options) => {
    open("", options)
    await screen.findByRole("table", { name: "Lists" })

    expect(await violations()).toEqual([])
  })

  it("has none when there are no lists", async () => {
    open("", { structure: makeStructure() })
    await screen.findByRole("heading", { name: "No lists yet" })

    expect(await violations()).toEqual([])
  })

  it("has none with the New list dialog open", async () => {
    const typist = userEvent.setup()
    open("")
    await typist.click(await screen.findByRole("button", { name: "New list" }))
    await screen.findByRole("dialog", { name: "New list" })

    expect(await violations()).toEqual([])
  })
})

describe("the list page", () => {
  it.each([
    ["for a builder", { role: "admin" }],
    ["for a viewer", { role: "viewer" }],
    ["of a production model", { mode: "prod" }],
  ] as const)("has no accessibility violations %s", async (_, options) => {
    open(`/${countriesList}`, options)
    await screen.findByRole("table", { name: "Items of Countries" })

    expect(await violations()).toEqual([])
  })

  it("has none with the row for a new item open", async () => {
    const typist = userEvent.setup()
    open(`/${countriesList}`)
    await typist.click(await screen.findByRole("button", { name: "Add item" }))
    await typist.keyboard("{Enter}")
    await screen.findByText("Choose a parent.")

    expect(await violations()).toEqual([])
  })

  it("has none while a name is being edited", async () => {
    const typist = userEvent.setup()
    open(`/${regionsList}`)
    await typist.click(await screen.findByRole("button", { name: "Rename EMEA" }))
    await screen.findByRole("textbox", { name: "Name of EMEA" })

    expect(await violations()).toEqual([])
  })

  it("has none with the parent list open", async () => {
    const typist = userEvent.setup()
    open(`/${countriesList}`)
    await typist.click(await screen.findByRole("combobox", { name: "Parent of France: EMEA" }))
    await screen.findByRole("option", { name: /^APAC/ })

    expect(await violations()).toEqual([])
  })

  it("has none with items chosen", async () => {
    const typist = userEvent.setup()
    open(`/${countriesList}`)
    await typist.click(await screen.findByRole("checkbox", { name: "Select all items" }))

    expect(await violations()).toEqual([])
  })

  it("has none with the empty list", async () => {
    const structure = listsStructure()
    structure.lists[2] = { ...structure.lists[2], items: [] }
    structure.subsets = []
    open(`/${productsList}`, { structure })
    await screen.findByRole("heading", { name: "No items yet" })

    expect(await violations()).toEqual([])
  })

  it("has none for a list that is not there", async () => {
    open("/0192f3a0-0000-7000-8000-00000000dead")
    await screen.findByRole("heading", { name: "List not found" })

    expect(await violations()).toEqual([])
  })
})

describe("the dialogs and sheets of the list page", () => {
  it("have none with the bulk add dialog open and a problem listed", async () => {
    const typist = userEvent.setup()
    open(`/${countriesList}`)
    await typist.click(await screen.findByRole("button", { name: "Bulk add" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Bulk add items" }))
    await typist.type(dialog.getByRole("textbox", { name: "Items" }), "Chile")
    await typist.click(dialog.getByRole("button", { name: "Add items" }))
    await dialog.findByText(/^Line 1:/)

    expect(await violations()).toEqual([])
  })

  it("have none with the question about deleting items open", async () => {
    const typist = userEvent.setup()
    open(`/${countriesList}`)
    await typist.click(await screen.findByRole("checkbox", { name: "Select France" }))
    await typist.click(screen.getByRole("button", { name: "Delete selected" }))
    await screen.findByRole("alertdialog")

    expect(await violations()).toEqual([])
  })

  it("have none with the subsets and the items of one open", async () => {
    const typist = userEvent.setup()
    open(`/${productsList}`)
    await typist.click(await screen.findByRole("button", { name: "Subsets" }))
    const sheet = within(await screen.findByRole("dialog", { name: "Subsets of Products" }))
    await sheet.findByRole("list", { name: "Subsets" })

    expect(await violations()).toEqual([])
    await typist.click(sheet.getByRole("button", { name: /^Choose the items of Core/ }))
    await sheet.findByRole("list", { name: "Items in Core products" })

    expect(await violations()).toEqual([])
  })

  it("have none with the list settings open", async () => {
    const typist = userEvent.setup()
    open(`/${regionsList}`)
    await typist.click(await screen.findByRole("button", { name: "List settings" }))
    await screen.findByRole("dialog", { name: "List settings" })

    expect(await violations()).toEqual([])
  })
})
