import { type BoundFunctions, type queries, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel } from "@/test/app"
import {
  apac,
  chooseOption,
  countriesList,
  emea,
  france,
  japan,
  listsStructure,
  openListsApp,
  productsList,
  regionsList,
} from "@/test/lists"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { makeStructure } from "@/test/structure"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel()
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

type Typist = ReturnType<typeof userEvent.setup>

function openList(listId = countriesList, options: Parameters<typeof openListsApp>[1] = {}) {
  return openListsApp(`/lists/${listId}`, options)
}

async function findTable(list = "Countries") {
  return within(await screen.findByRole("table", { name: `Items of ${list}` }))
}

/** The rows of the body, top to bottom: a group by its label, an item by its name. */
function outline(table: BoundFunctions<typeof queries>) {
  return table
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const group = within(row).queryByRole("button", { expanded: true })
      const collapsed = within(row).queryByRole("button", { expanded: false })
      return (
        (group ?? collapsed)?.getAttribute("aria-label") ??
        within(row).getByRole("button", { name: /^Rename/ }).textContent
      )
    })
}

describe("the items of a list with a parent list", () => {
  it("are grouped under the items of the parent list, which fold away", async () => {
    const typist = userEvent.setup()
    openList()

    const table = await findTable()
    expect(outline(table)).toEqual(["EMEA, 2 items", "France", "Germany", "APAC, 1 item", "Japan"])
    const emeaGroup = table.getByRole("button", { name: "EMEA, 2 items" })
    expect(emeaGroup).toHaveAttribute("aria-expanded", "true")
    await typist.click(emeaGroup)

    expect(emeaGroup).toHaveAttribute("aria-expanded", "false")
    expect(table.queryByRole("button", { name: "Rename France" })).not.toBeInTheDocument()
    expect(table.getByRole("button", { name: "Rename Japan" })).toBeVisible()
    await typist.click(emeaGroup)

    expect(table.getByRole("button", { name: "Rename France" })).toBeVisible()
  })

  it("have a header whose name holds the words it shows", async () => {
    openList()

    const table = await findTable()
    const group = table.getByRole("button", { name: "EMEA, 2 items" })
    // WCAG 2.5.3: what is read out starts with what is on the button (axe's label-content-name-mismatch).
    expect(group.textContent).toBe("EMEA 2")
    expect(group.getAttribute("aria-label")?.replace(/[^\w ]/g, "")).toContain(group.textContent)
  })

  it("name their parent in a column", async () => {
    openList()

    const table = await findTable()
    expect(table.getByRole("combobox", { name: "Parent of France: EMEA" })).toBeVisible()
    expect(table.getByRole("combobox", { name: "Parent of Japan: APAC" })).toBeVisible()
  })

  it("show the header with the list's parent and settings", async () => {
    openList()

    expect(await screen.findByRole("heading", { level: 1, name: "Countries" })).toBeVisible()
    expect(document.title).toBe("Countries · OpenPlan")
    expect(screen.getByRole("link", { name: "Parent list: Regions" })).toHaveAttribute(
      "href",
      `/m/${model.id}/lists/${regionsList}`,
    )
    expect(screen.getByRole("button", { name: "List settings" })).toBeVisible()
    const crumbs = within(screen.getByRole("navigation", { name: "breadcrumb" }))
    expect(await crumbs.findByText("Countries")).toHaveAttribute("aria-current", "page")
  })

  it("count themselves in a line under the table", async () => {
    openList()

    await findTable()
    expect(screen.getByText("3 items")).toBeVisible()
  })
})

describe("the items of a list without a parent list", () => {
  it("are a flat table of names and codes, and the list's top level", async () => {
    openList(regionsList)

    const table = await findTable("Regions")
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "",
      "Name",
      "Code",
    ])
    expect(table.getByRole("button", { name: "Rename EMEA" })).toBeVisible()
    expect(table.getByRole("button", { name: "Edit the code of EMEA, R1" })).toHaveTextContent("R1")
    expect(screen.getByText("2 items · Top level: All regions")).toBeVisible()
  })

  it("can be filtered by name or code", async () => {
    const typist = userEvent.setup()
    openList(countriesList)
    const table = await findTable()
    await typist.type(screen.getByRole("searchbox", { name: "Filter items" }), "ger")

    expect(table.getByRole("button", { name: "Rename Germany" })).toBeVisible()
    expect(table.queryByRole("button", { name: "Rename France" })).not.toBeInTheDocument()
    expect(table.queryByRole("button", { name: "APAC, 1 item" })).not.toBeInTheDocument()
    expect(screen.getByText("3 items, 1 shown")).toBeVisible()
    await typist.clear(screen.getByRole("searchbox", { name: "Filter items" }))
    await typist.type(screen.getByRole("searchbox", { name: "Filter items" }), "jp")

    expect(table.getByRole("button", { name: "Rename Japan" })).toBeVisible()
    await typist.type(screen.getByRole("searchbox", { name: "Filter items" }), "zzz")

    expect(await screen.findByText("No item matches “jpzzz”.")).toBeVisible()
  })
})

describe("a list without items", () => {
  const empty = () => {
    const structure = listsStructure()
    structure.lists[2] = { ...structure.lists[2], items: [] }
    structure.subsets = []
    return structure
  }

  it("invites a builder to add the first one, or paste many", async () => {
    openList(productsList, { structure: empty() })

    expect(await screen.findByRole("heading", { name: "No items yet" })).toBeVisible()
    expect(screen.getAllByRole("button", { name: "Add item" })).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Bulk add" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Subsets" })).not.toBeInTheDocument()
    expect(screen.queryByRole("searchbox", { name: "Filter items" })).not.toBeInTheDocument()
  })

  it("shows a viewer no controls", async () => {
    openList(productsList, { structure: empty(), role: "viewer" })

    expect(await screen.findByRole("heading", { name: "No items yet" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Add item" })).not.toBeInTheDocument()
  })

  it("opens the row for the first item", async () => {
    const typist = userEvent.setup()
    openList(productsList, { structure: empty() })
    await typist.click(await screen.findByRole("button", { name: "Add item" }))

    expect(await screen.findByRole("textbox", { name: "New item name" })).toHaveFocus()
    expect(screen.queryByRole("heading", { name: "No items yet" })).not.toBeInTheDocument()
    await typist.keyboard("{Escape}")

    expect(await screen.findByRole("heading", { name: "No items yet" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Add item" })).toHaveFocus()
  })
})

describe("loading the items", () => {
  it("shows a placeholder, then a retry when the read fails", async () => {
    const typist = userEvent.setup()
    openList()
    let failing = true
    server.use(
      http.get("/api/v1/models/:id/lists/:listId/items", () =>
        failing ? problem(500, "internal", "Something went wrong.") : HttpResponse.json([]),
      ),
    )

    const main = within(await screen.findByRole("main"))
    expect(await main.findByText("Something went wrong.")).toBeVisible()
    failing = false
    await typist.click(main.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("heading", { name: "No items yet" })).toBeVisible()
  })

  it("keeps the table on screen when a refresh fails, and says so", async () => {
    const { queryClient } = openList()
    const table = await findTable()
    server.use(
      http.get("/api/v1/models/:id/lists/:listId/items", () =>
        problem(500, "internal", "The server is busy."),
      ),
    )
    await queryClient.invalidateQueries({ queryKey: ["models", model.id, "structure"] })

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The server is busy.", {
        id: `items-refresh-failed-${countriesList}`,
      }),
    )
    expect(table.getByRole("button", { name: "Rename France" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  it("shows a placeholder for the table while the items arrive", async () => {
    openList()
    server.use(
      http.get("/api/v1/models/:id/lists/:listId/items", async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return HttpResponse.json([])
      }),
    )

    expect(await screen.findByRole("status", { name: "Loading items" })).toBeVisible()
  })
})

describe("going from one list to another", () => {
  it("does not take what was typed on the first along", async () => {
    const typist = userEvent.setup()
    const { router } = openList()
    const table = await findTable()
    await typist.type(screen.getByRole("searchbox", { name: "Filter items" }), "ger")
    await typist.click(table.getByRole("checkbox", { name: "Select all items" }))
    await typist.click(screen.getByRole("link", { name: "Parent list: Regions" }))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/m/${model.id}/lists/${regionsList}`),
    )
    const regions = await findTable("Regions")
    expect(regions.getByRole("button", { name: "Rename EMEA" })).toBeVisible()
    expect(screen.getByRole("searchbox", { name: "Filter items" })).toHaveValue("")
    expect(screen.queryByText(/items selected/)).not.toBeInTheDocument()
  })
})

describe("renaming an item in place", () => {
  it("saves the new name on Enter and puts focus back on it", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    const input = table.getByRole("textbox", { name: "Name of France" })
    expect(input).toHaveFocus()
    await typist.clear(input)
    await typist.type(input, "République française{Enter}")

    const renamed = await table.findByRole("button", { name: "Rename République française" })
    expect(renamed).toHaveFocus()
    expect(store.writes).toEqual([
      {
        method: "PATCH",
        path: `lists/${countriesList}/items/${france}`,
        body: { name: "République française" },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Item renamed")
  })

  it("starts with Enter on the focused name", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    table.getByRole("button", { name: "Rename Germany" }).focus()
    await typist.keyboard("{Enter}")

    expect(table.getByRole("textbox", { name: "Name of Germany" })).toHaveFocus()
  })

  it("starts with a double click", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await typist.dblClick(table.getByRole("button", { name: "Rename Germany" }))

    expect(table.getByRole("textbox", { name: "Name of Germany" })).toBeVisible()
  })

  it("puts the old name back on Escape without a request", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    await typist.type(table.getByRole("textbox", { name: "Name of France" }), " is nice{Escape}")

    expect(table.getByRole("button", { name: "Rename France" })).toHaveFocus()
    expect(store.writes).toEqual([])
  })

  it("makes no request when the name did not change", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    await typist.keyboard("{Enter}")

    expect(table.getByRole("button", { name: "Rename France" })).toBeVisible()
    expect(store.writes).toEqual([])
  })

  it("saves when the user moves on to something else", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    await typist.type(table.getByRole("textbox", { name: "Name of France" }), "!")
    await typist.click(table.getByRole("button", { name: "Rename Japan" }))

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({ name: "France!" })
  })

  it("needs a name", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    await typist.clear(table.getByRole("textbox", { name: "Name of France" }))
    await typist.keyboard("{Enter}")

    expect(await table.findByText("Name is required.")).toBeVisible()
    expect(store.writes).toEqual([])
  })

  it("shows a name that is taken under the name and keeps it open", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Rename France" }))
    const input = table.getByRole("textbox", { name: "Name of France" })
    await typist.clear(input)
    await typist.type(input, "germany{Enter}")

    expect(await table.findByText("The name germany is taken.")).toBeVisible()
    expect(input).toBeInvalid()
    expect(input).toHaveFocus()
  })
})

describe("the code and the parent of an item", () => {
  it("sets a code, and clears it again", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("button", { name: "Edit the code of France, FR" }))
    const input = table.getByRole("textbox", { name: "Code of France" })
    await typist.clear(input)
    await typist.type(input, "FRA{Enter}")

    await table.findByRole("button", { name: "Edit the code of France, FRA" })
    expect(toast.success).toHaveBeenCalledWith("Code saved")
    await typist.click(table.getByRole("button", { name: "Edit the code of France, FRA" }))
    await typist.clear(table.getByRole("textbox", { name: "Code of France" }))
    await typist.keyboard("{Enter}")

    // With no code the button names what it shows.
    expect(await table.findByRole("button", { name: "Add code for France" })).toHaveTextContent(
      "Add code",
    )

    await waitFor(() => expect(store.writes).toHaveLength(2))
    expect(store.writes.map((write) => write.body)).toEqual([{ code: "FRA" }, { code: null }])
  })

  it("moves an item to another parent, found by searching", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    await typist.click(table.getByRole("combobox", { name: "Parent of France: EMEA" }))
    await typist.type(await screen.findByRole("combobox", { name: "Items of Regions" }), "apa")

    expect(screen.queryByRole("option", { name: /EMEA/ })).not.toBeInTheDocument()
    await typist.click(screen.getByRole("option", { name: /APAC/ }))

    await waitFor(() =>
      expect(table.getByRole("combobox", { name: "Parent of France: APAC" })).toBeVisible(),
    )
    expect(store.writes).toEqual([
      {
        method: "PATCH",
        path: `lists/${countriesList}/items/${france}`,
        body: { parent_id: apac },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Moved France to APAC")
  })
})

describe("adding items one after another", () => {
  async function startAdding(typist: Typist) {
    await typist.click(await screen.findByRole("button", { name: "Add item" }))
    return screen.findByRole("textbox", { name: "New item name" })
  }

  it("focuses the new row's name, and Enter adds the item and opens the next row", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    const name = await startAdding(typist)
    expect(name).toHaveFocus()
    await chooseOption(
      typist,
      table.getByRole("combobox", { name: /Parent of the new item/ }),
      "EMEA",
    )
    await typist.type(name, "Italy")
    await typist.type(table.getByRole("textbox", { name: "New item code" }), "IT")
    await typist.type(name, "{Enter}")

    expect(await table.findByRole("button", { name: "Rename Italy" })).toBeVisible()
    expect(store.writes).toEqual([
      {
        method: "POST",
        path: `lists/${countriesList}/items`,
        body: { items: [{ name: "Italy", code: "IT", parent_id: emea }] },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Added Italy", { id: "item-added" })
    // The next row: empty, with the parent kept, and ready to type in.
    expect(name).toHaveValue("")
    expect(name).toHaveFocus()
    expect(table.getByRole("textbox", { name: "New item code" })).toHaveValue("")
    expect(table.getByRole("combobox", { name: "Parent of the new item: EMEA" })).toBeVisible()
    await typist.type(name, "Spain{Enter}")

    expect(await table.findByRole("button", { name: "Rename Spain" })).toBeVisible()
    expect(store.writes[1].body).toEqual({ items: [{ name: "Spain", parent_id: emea }] })
  })

  it("stops on Escape and gives focus back to Add item", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await startAdding(typist)
    await typist.keyboard("{Escape}")

    expect(table.queryByRole("textbox", { name: "New item name" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add item" })).toHaveFocus()
  })

  it("stops from the button beside the row", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await startAdding(typist)
    await typist.click(table.getByRole("button", { name: "Stop adding items" }))

    expect(table.queryByRole("textbox", { name: "New item name" })).not.toBeInTheDocument()
  })

  it("adds with the Add button", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    const name = await startAdding(typist)
    await chooseOption(
      typist,
      table.getByRole("combobox", { name: /Parent of the new item/ }),
      "APAC",
    )
    await typist.type(name, "China")
    await typist.click(table.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({ items: [{ name: "China", parent_id: apac }] })
  })

  it("wants a parent, and a name", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    const name = await startAdding(typist)
    await typist.type(name, "{Enter}")

    expect(await table.findByText("Name is required.")).toBeVisible()
    expect(await table.findByText("Choose a parent.")).toBeVisible()
    await typist.type(name, "Italy{Enter}")

    expect(table.getByText("Choose a parent.")).toBeVisible()
    expect(table.getByRole("combobox", { name: /Parent of the new item/ })).toBeInvalid()
    expect(store.writes).toEqual([])
  })

  it("shows a name that is taken under the name and keeps what was typed", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    const name = await startAdding(typist)
    await chooseOption(
      typist,
      table.getByRole("combobox", { name: /Parent of the new item/ }),
      "EMEA",
    )
    await typist.type(name, "France{Enter}")

    expect(await table.findByText("The name France is taken.")).toBeVisible()
    expect(name).toHaveValue("France")
    expect(name).toBeInvalid()
  })

  it("needs no parent in a list that has no parent list", async () => {
    const typist = userEvent.setup()
    const { store } = openList(regionsList)
    const table = await findTable("Regions")
    const name = await startAdding(typist)
    expect(table.queryByRole("combobox")).not.toBeInTheDocument()
    await typist.type(name, "Americas{Enter}")

    expect(await table.findByRole("button", { name: "Rename Americas" })).toBeVisible()
    expect(store.writes[0].body).toEqual({ items: [{ name: "Americas" }] })
  })

  it("moves focus to the open row when Add item is pressed again", async () => {
    const typist = userEvent.setup()
    openList(regionsList)
    const name = await startAdding(typist)
    await typist.click(screen.getByRole("searchbox", { name: "Filter items" }))
    await typist.click(screen.getByRole("button", { name: "Add item" }))

    expect(name).toHaveFocus()
  })

  it("lets Escape in the parent list close only the list", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    const name = await startAdding(typist)
    await typist.type(name, "Italy")
    await typist.click(table.getByRole("combobox", { name: /Parent of the new item/ }))
    await screen.findByRole("combobox", { name: "Items of Regions" })
    await typist.keyboard("{Escape}")

    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Items of Regions" })).not.toBeInTheDocument(),
    )
    expect(table.getByRole("textbox", { name: "New item name" })).toHaveValue("Italy")
  })

  it("lets Enter in the parent list choose the parent and add nothing", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    const name = await startAdding(typist)
    await typist.type(name, "Italy")
    await typist.click(table.getByRole("combobox", { name: /Parent of the new item/ }))
    await typist.type(await screen.findByRole("combobox", { name: "Items of Regions" }), "emea")
    await typist.keyboard("{Enter}")

    expect(
      await table.findByRole("combobox", { name: "Parent of the new item: EMEA" }),
    ).toBeVisible()
    expect(store.writes).toEqual([])
    expect(name).toHaveValue("Italy")
    // The code can still be typed before the item is added.
    await typist.type(table.getByRole("textbox", { name: "New item code" }), "IT{Enter}")

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({
      items: [{ name: "Italy", code: "IT", parent_id: emea }],
    })
  })

  it("adds an item once when Enter is pressed twice", async () => {
    const typist = userEvent.setup()
    openList(regionsList)
    let posts = 0
    server.use(
      http.post("/api/v1/models/:id/lists/:listId/items", async () => {
        posts += 1
        await new Promise((resolve) => setTimeout(resolve, 200))
        return HttpResponse.json([{ id: "added", name: "Americas" }], { status: 201 })
      }),
    )
    const name = await startAdding(typist)
    await typist.type(name, "Americas{Enter}{Enter}")

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Added Americas", expect.anything()),
    )
    expect(posts).toBe(1)
  })
})

describe("moving an item to another parent", () => {
  it("shows the move as pending and keeps the button focusable", async () => {
    const typist = userEvent.setup()
    openList()
    server.use(
      http.patch("/api/v1/models/:id/lists/:listId/items/:itemId", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return HttpResponse.json({ id: france, name: "France", parent_id: apac })
      }),
    )
    const table = await findTable()
    await chooseOption(
      typist,
      table.getByRole("combobox", { name: "Parent of France: EMEA" }),
      "APAC",
    )

    const picker = table.getByRole("combobox", { name: /^Parent of France/ })
    expect(picker).toHaveAttribute("aria-busy", "true")
    expect(picker).toHaveAttribute("aria-disabled", "true")
    // Another click does not open the list while the move is saved.
    await typist.click(picker)
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    await waitFor(() => expect(picker).not.toHaveAttribute("aria-busy"))
  })
})

describe("adding many items at once", () => {
  async function openBulk(typist: Typist) {
    await typist.click(await screen.findByRole("button", { name: "Bulk add" }))
    return within(await screen.findByRole("dialog", { name: "Bulk add items" }))
  }

  it("makes one item of each line, with its parent by name or code", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const dialog = await openBulk(typist)
    expect(dialog.getByText(/“Name, Parent”/)).toBeVisible()
    await typist.type(
      dialog.getByRole("textbox", { name: "Items" }),
      "Italy, EMEA{Enter}{Enter}China, R2",
    )
    expect(dialog.getByText("2 lines")).toBeVisible()
    await typist.click(dialog.getByRole("button", { name: "Add items" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(store.writes).toEqual([
      {
        method: "POST",
        path: `lists/${countriesList}/items`,
        body: {
          items: [
            { name: "Italy", parent_id: emea },
            { name: "China", parent_id: apac },
          ],
        },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Added 2 items")
    expect(await (await findTable()).findByRole("button", { name: "Rename China" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Bulk add" })).toHaveFocus()
  })

  it("lists what is wrong with each line, and adds nothing", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const dialog = await openBulk(typist)
    await typist.type(
      dialog.getByRole("textbox", { name: "Items" }),
      "Italy, EMEA{Enter}Spain, Iberia{Enter}Chile{Enter}France, EMEA",
    )
    await typist.click(dialog.getByRole("button", { name: "Add items" }))

    expect(
      await dialog.findByText("Nothing was added. Fix these lines and try again."),
    ).toBeVisible()
    const problems = within(dialog.getByRole("alert"))
    expect(problems.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Line 2: Iberia is not an item of Regions.",
      "Line 3: Add a parent after a comma, as in “Name, Parent”.",
      "Line 4: France is already in the list.",
    ])
    expect(store.writes).toEqual([])
    expect(screen.getByRole("dialog", { name: "Bulk add items" })).toBeVisible()
  })

  it("clears the problems as the text changes", async () => {
    const typist = userEvent.setup()
    openList()
    const dialog = await openBulk(typist)
    const text = dialog.getByRole("textbox", { name: "Items" })
    await typist.type(text, "Chile")
    await typist.click(dialog.getByRole("button", { name: "Add items" }))
    await dialog.findByText("Line 1: Add a parent after a comma, as in “Name, Parent”.")
    await typist.type(text, ", EMEA")

    expect(dialog.queryByText(/Line 1/)).not.toBeInTheDocument()
  })

  it("needs something to add", async () => {
    const typist = userEvent.setup()
    openList()
    const dialog = await openBulk(typist)
    await typist.click(dialog.getByRole("button", { name: "Add items" }))

    expect(await dialog.findByText("Enter at least one item.")).toBeVisible()
  })

  it("shows the lines the server refused", async () => {
    const typist = userEvent.setup()
    openList(regionsList)
    server.use(
      http.post("/api/v1/models/:id/lists/:listId/items", () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "items[1].name", message: "Name must be at most 80 characters." }],
        }),
      ),
    )
    const dialog = await openBulk(typist)
    expect(dialog.queryByText(/“Name, Parent”/)).not.toBeInTheDocument()
    await typist.type(
      dialog.getByRole("textbox", { name: "Items" }),
      "Americas{Enter}{Enter}Africa",
    )
    await typist.click(dialog.getByRole("button", { name: "Add items" }))

    expect(await dialog.findByText("Line 3: Name must be at most 80 characters.")).toBeVisible()
  })

  it("shows a refusal of the whole request as a problem of its own", async () => {
    const typist = userEvent.setup()
    openList(regionsList)
    server.use(
      http.post("/api/v1/models/:id/lists/:listId/items", () =>
        problem(409, "structure.name_taken", "The name Africa is taken."),
      ),
    )
    const dialog = await openBulk(typist)
    await typist.type(dialog.getByRole("textbox", { name: "Items" }), "Africa")
    await typist.click(dialog.getByRole("button", { name: "Add items" }))

    expect(await dialog.findByText("The name Africa is taken.")).toBeVisible()
    expect(dialog.getByText("1 problem")).toBeVisible()
  })
})

describe("deleting items", () => {
  it("asks first, names the items and then deletes the chosen ones", async () => {
    const typist = userEvent.setup()
    const { store } = openList()
    const table = await findTable()
    expect(table.getByRole("checkbox", { name: "Select all items" })).not.toBeChecked()
    await typist.click(table.getByRole("checkbox", { name: "Select France" }))
    await typist.click(table.getByRole("checkbox", { name: "Select Japan" }))

    expect(screen.getByText("2 items selected")).toBeVisible()
    expect(table.getByRole("checkbox", { name: "Select all items" })).toBePartiallyChecked()
    await typist.click(screen.getByRole("button", { name: "Delete selected" }))

    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete 2 items?" }))
    expect(
      dialog.getByText(
        "France and Japan are removed from the list and from its subsets, and the values entered for them in modules are cleared.",
      ),
    ).toBeVisible()
    await typist.click(dialog.getByRole("button", { name: "Delete items" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(store.writes).toEqual([
      {
        method: "POST",
        path: `lists/${countriesList}/items/delete`,
        body: { ids: [france, japan] },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Items deleted")
    await waitFor(() =>
      expect(table.queryByRole("button", { name: "Rename France" })).not.toBeInTheDocument(),
    )
    expect(screen.queryByText("2 items selected")).not.toBeInTheDocument()
    expect(table.getByRole("checkbox", { name: "Select all items" })).toHaveFocus()
  })

  it("names the one item", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await typist.click(table.getByRole("checkbox", { name: "Select Germany" }))
    await typist.click(screen.getByRole("button", { name: "Delete selected" }))

    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Germany?" }))
    expect(dialog.getByRole("button", { name: "Delete item" })).toBeVisible()
  })

  it("selects everything shown from the header, and clears the choice", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await typist.click(table.getByRole("checkbox", { name: "Select all items" }))

    expect(screen.getByText("3 items selected")).toBeVisible()
    expect(table.getByRole("checkbox", { name: "Select all items" })).toBeChecked()
    await typist.click(screen.getByRole("button", { name: "Clear selection" }))

    expect(screen.queryByText("3 items selected")).not.toBeInTheDocument()
  })

  it("selects only the items a filter shows", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await typist.type(screen.getByRole("searchbox", { name: "Filter items" }), "ger")
    await typist.click(table.getByRole("checkbox", { name: "Select all items" }))

    expect(screen.getByText("1 item selected")).toBeVisible()
  })

  it("keeps the dialog and the choice when the server refuses", async () => {
    const typist = userEvent.setup()
    openList()
    server.use(
      http.post("/api/v1/models/:id/lists/:listId/items/delete", () =>
        problem(409, "model.production_locked", "The model is in production mode."),
      ),
    )
    const table = await findTable()
    await typist.click(table.getByRole("checkbox", { name: "Select France" }))
    await typist.click(screen.getByRole("button", { name: "Delete selected" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete item" }),
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The model is in production mode."),
    )
    expect(screen.getByRole("alertdialog")).toBeVisible()
  })

  it("will not delete an item that has child items, and says which", async () => {
    const typist = userEvent.setup()
    const { store } = openList(regionsList)
    const table = await findTable("Regions")
    await typist.click(table.getByRole("checkbox", { name: "Select EMEA" }))

    const button = screen.getByRole("button", { name: "Delete selected" })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      "EMEA still has 2 child items in Countries. Delete those first.",
    )
    expect(store.writes).toEqual([])
  })

  it("deletes the last items and shows the empty state", async () => {
    const typist = userEvent.setup()
    const structure = listsStructure()
    structure.subsets = []
    openList(productsList, { structure })
    const table = await findTable("Products")
    await typist.click(table.getByRole("checkbox", { name: "Select all items" }))
    await typist.click(screen.getByRole("button", { name: "Delete selected" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete items" }),
    )

    expect(await screen.findByRole("heading", { name: "No items yet" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Add item" })).toHaveFocus()
  })
})

describe("for someone who cannot change the structure", () => {
  it.each(["viewer", "planner"] as const)("shows a %s the items and no controls", async (role) => {
    openList(countriesList, { role })

    const table = await findTable()
    expect(table.getByText("France")).toBeVisible()
    expect(table.getByText("EMEA", { selector: "span" })).toBeVisible()
    for (const name of ["Add item", "Bulk add", "List settings"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument()
    }
    expect(table.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(table.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument()
    expect(table.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Subsets" })).toBeVisible()
  })
})

describe("in production mode", () => {
  it("shows the items, says why they are locked and switches the controls off", async () => {
    openList(countriesList, { mode: "prod" })

    const table = await findTable()
    expect(await screen.findByText(PRODUCTION_MESSAGE)).toBeVisible()
    expect(screen.getByRole("button", { name: "Add item" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Bulk add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "List settings" })).toBeDisabled()
    expect(table.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument()
    expect(table.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Subsets" })).toBeEnabled()
  })
})

describe("a list that is not there", () => {
  it("says so, and links back to the lists", async () => {
    openList("0192f3a0-0000-7000-8000-00000000dead")

    expect(await screen.findByRole("heading", { level: 1, name: "List not found" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Back to lists" })).toHaveAttribute(
      "href",
      `/m/${model.id}/lists`,
    )
  })

  it("is what a deleted list leaves behind", async () => {
    openListsApp(`/lists/${countriesList}`, { structure: makeStructure() })

    expect(await screen.findByRole("heading", { name: "List not found" })).toBeVisible()
  })
})

describe("the items under their parents", () => {
  it("move to another group as soon as the parent changes", async () => {
    const typist = userEvent.setup()
    openList()
    const table = await findTable()
    await chooseOption(
      typist,
      table.getByRole("combobox", { name: "Parent of Germany: EMEA" }),
      "APAC",
    )

    expect(await table.findByRole("button", { name: "APAC, 2 items" })).toBeVisible()
    expect(outline(table)).toEqual(["EMEA, 1 item", "France", "APAC, 2 items", "Germany", "Japan"])
  })
})
