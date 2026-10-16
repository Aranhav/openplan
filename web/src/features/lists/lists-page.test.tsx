import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel, mockSession, renderApp, serveModels } from "@/test/app"
import {
  chooseOption,
  countriesList,
  listsStructure,
  openListsApp,
  regionsList,
} from "@/test/lists"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { makeStructure } from "@/test/structure"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel()
const listsUrl = `/m/${model.id}/lists`
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

function openLists(options: Parameters<typeof openListsApp>[1] & { path?: string } = {}) {
  return openListsApp(options.path ?? "/lists", options)
}

async function findTable() {
  return within(await screen.findByRole("table", { name: "Lists" }))
}

describe("the lists page", () => {
  it("titles the page and sits first in the Build navigation", async () => {
    openLists()

    expect(await screen.findByRole("heading", { level: 1, name: "Lists" })).toBeVisible()
    expect(document.title).toBe("Lists · OpenPlan")
    const nav = within(await screen.findByRole("navigation", { name: "Build" }))
    expect(nav.getAllByRole("link")[0]).toHaveAccessibleName("Lists")
    expect(nav.getByRole("link", { name: "Lists" })).toHaveAttribute("aria-current", "page")
    const crumbs = within(screen.getByRole("navigation", { name: "breadcrumb" }))
    expect(await crumbs.findByText("Lists")).toHaveAttribute("aria-current", "page")
  })

  it("lists each list with its parent list, items, top level and settings", async () => {
    openLists()

    const table = await findTable()
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Parent list",
      "Items",
      "Top level",
      "Settings",
    ])
    const regions = within(table.getByRole("row", { name: /^Regions/ }))
    expect(regions.getByRole("link", { name: "Regions" })).toHaveAttribute(
      "href",
      `${listsUrl}/${regionsList}`,
    )
    expect(regions.getAllByText("All regions").length).toBeGreaterThan(0)
    const countries = within(table.getByRole("row", { name: /^Countries/ }))
    expect(countries.getAllByRole("link", { name: "Regions" })[0]).toHaveAttribute(
      "href",
      `${listsUrl}/${regionsList}`,
    )
    expect(countries.getByRole("cell", { name: "3" })).toBeVisible()
    const products = within(table.getByRole("row", { name: /^Products/ }))
    expect(products.getAllByText("Production data").length).toBeGreaterThan(0)
    expect(products.queryByText("Numbered")).not.toBeInTheDocument()
  })

  it("marks a numbered list", async () => {
    const structure = listsStructure()
    structure.lists[2] = { ...structure.lists[2], numbered: true }
    openLists({ structure })

    const table = await findTable()
    expect(
      within(table.getByRole("row", { name: /^Products/ })).getAllByText("Numbered"),
    ).not.toHaveLength(0)
  })

  it("opens a list from its name", async () => {
    const typist = userEvent.setup()
    const { router } = openLists()
    const table = await findTable()
    await typist.click(table.getByRole("link", { name: "Countries" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`${listsUrl}/${countriesList}`))
  })

  it("shows a placeholder while the lists load and a retry when they fail", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    let failing = true
    server.use(
      http.get("/api/v1/models/:id/structure", () =>
        failing
          ? problem(500, "internal", "Something went wrong.")
          : HttpResponse.json(listsStructure()),
      ),
    )
    renderApp(listsUrl)

    expect(await screen.findByRole("status", { name: "Loading lists" })).toBeVisible()
    const main = within(await screen.findByRole("main"))
    expect(await main.findByText("Something went wrong.")).toBeVisible()
    failing = false
    await typist.click(main.getByRole("button", { name: "Retry" }))

    expect(await findTable()).toBeDefined()
  })

  describe("without lists", () => {
    it("says so and offers a first list to a builder", async () => {
      openLists({ structure: makeStructure() })

      expect(await screen.findByRole("heading", { name: "No lists yet" })).toBeVisible()
      expect(screen.getAllByRole("button", { name: "New list" })).toHaveLength(1)
    })

    it("offers a viewer no list to make", async () => {
      openLists({ structure: makeStructure(), role: "viewer" })

      expect(await screen.findByRole("heading", { name: "No lists yet" })).toBeVisible()
      expect(screen.queryByRole("button", { name: "New list" })).not.toBeInTheDocument()
    })
  })

  describe("for someone who cannot change the structure", () => {
    it.each(["viewer", "planner"] as const)(
      "shows a %s the lists and no controls",
      async (role) => {
        openLists({ role })

        await findTable()
        expect(screen.queryByRole("button", { name: "New list" })).not.toBeInTheDocument()
      },
    )
  })

  describe("in production mode", () => {
    it("says the structure is locked and switches New list off", async () => {
      openLists({ mode: "prod" })

      expect(await screen.findByText(PRODUCTION_MESSAGE)).toBeVisible()
      expect(await screen.findByRole("button", { name: "New list" })).toBeDisabled()
    })
  })
})

describe("the New list dialog", () => {
  async function openDialog(options?: Parameters<typeof openLists>[0]) {
    const typist = userEvent.setup()
    const opened = openLists(options)
    await typist.click(await screen.findByRole("button", { name: "New list" }))
    const dialog = await screen.findByRole("dialog", { name: "New list" })
    return { typist, dialog: within(dialog), ...opened }
  }

  it("asks for a name, a parent list, a top level name, numbering and production data", async () => {
    const { dialog } = await openDialog()

    expect(dialog.getByRole("textbox", { name: "Name" })).toHaveFocus()
    expect(dialog.getByRole("combobox", { name: "Parent list" })).toHaveTextContent("None")
    expect(dialog.getByRole("textbox", { name: "Top level name" })).toBeVisible()
    expect(dialog.getByText("Leave empty for no top level")).toBeVisible()
    expect(dialog.getByRole("switch", { name: "Numbered" })).not.toBeChecked()
    expect(dialog.getByRole("switch", { name: "Production data" })).not.toBeChecked()
  })

  it("creates a list with a parent and opens it", async () => {
    const { typist, dialog, store, router } = await openDialog()
    await typist.type(dialog.getByRole("textbox", { name: "Name" }), "Cities")
    await chooseOption(typist, dialog.getByRole("combobox", { name: "Parent list" }), "Countries")
    await typist.type(dialog.getByRole("textbox", { name: "Top level name" }), "All cities")
    await typist.click(dialog.getByRole("switch", { name: "Numbered" }))
    await typist.click(dialog.getByRole("button", { name: "Create list" }))

    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/lists\/[^/]+$/))
    expect(store.writes).toEqual([
      {
        method: "POST",
        path: "lists",
        body: {
          name: "Cities",
          parent_list_id: countriesList,
          top_level_name: "All cities",
          numbered: true,
          production_data: false,
        },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("List created")
    expect(await screen.findByRole("heading", { level: 1, name: "Cities" })).toBeVisible()
    expect(screen.queryByRole("dialog", { name: "New list" })).not.toBeInTheDocument()
  })

  it("sends no parent and no top level for a plain list", async () => {
    const { typist, dialog, store } = await openDialog()
    await typist.type(dialog.getByRole("textbox", { name: "Name" }), "  Channels ")
    await typist.click(dialog.getByRole("button", { name: "Create list" }))

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({
      name: "Channels",
      parent_list_id: null,
      top_level_name: null,
      numbered: false,
      production_data: false,
    })
  })

  it("needs a name", async () => {
    const { typist, dialog, store } = await openDialog()
    await typist.click(dialog.getByRole("button", { name: "Create list" }))

    expect(await dialog.findByText("Name is required.")).toBeVisible()
    expect(store.writes).toEqual([])
  })

  it("shows a name that is taken under the name", async () => {
    const { typist, dialog } = await openDialog()
    await typist.type(dialog.getByRole("textbox", { name: "Name" }), "Regions")
    await typist.click(dialog.getByRole("button", { name: "Create list" }))

    const name = dialog.getByRole("textbox", { name: "Name" })
    expect(await dialog.findByText("A list named Regions already exists.")).toBeVisible()
    expect(name).toBeInvalid()
    expect(name).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "New list" })).toBeVisible()
  })

  it("is kept open, and its buttons switched off, while the list is created", async () => {
    const { typist, dialog } = await openDialog()
    server.use(
      http.post("/api/v1/models/:id/lists", async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return HttpResponse.json({ id: regionsList }, { status: 201 })
      }),
    )
    await typist.type(dialog.getByRole("textbox", { name: "Name" }), "Channels")
    await typist.click(dialog.getByRole("button", { name: "Create list" }))

    expect(dialog.getByRole("button", { name: "Create list" })).toBeDisabled()
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "New list" })).toBeVisible()
  })

  it("gives focus back to New list when it is cancelled", async () => {
    const { typist, dialog } = await openDialog()
    await typist.click(dialog.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "New list" })).toHaveFocus()
  })
})
