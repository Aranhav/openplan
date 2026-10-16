import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel } from "@/test/app"
import { listsStructure, openListsApp, productsList } from "@/test/lists"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { mockViewport } from "@/test/viewport"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel()
const widgets = "0192f3a0-0000-7000-8000-000000000621"
const gadgets = "0192f3a0-0000-7000-8000-000000000622"
const coreProducts = "0192f3a0-0000-7000-8000-000000000701"

type Typist = ReturnType<typeof userEvent.setup>

function openProducts(options?: Parameters<typeof openListsApp>[1]) {
  return openListsApp(`/lists/${productsList}`, options)
}

async function openSheet(typist: Typist, options?: Parameters<typeof openProducts>[0]) {
  const opened = openProducts(options)
  await typist.click(await screen.findByRole("button", { name: "Subsets" }))
  const sheet = within(await screen.findByRole("dialog", { name: "Subsets of Products" }))
  return { sheet, ...opened }
}

describe("the subsets of a list", () => {
  it("are listed with how many items each holds", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)

    const subsets = within(sheet.getByRole("list", { name: "Subsets" }))
    expect(subsets.getByRole("button", { name: "Rename Core products" })).toBeVisible()
    expect(
      subsets.getByRole("button", { name: "Choose the items of Core products" }),
    ).toHaveTextContent("1 item")
  })

  it("show the subsets of this list and no other", async () => {
    const typist = userEvent.setup()
    const structure = listsStructure()
    structure.subsets.push({ id: "other", name: "Asia", list: "elsewhere", items: [] })
    const { sheet } = await openSheet(typist, { structure })

    expect(sheet.getByText("Core products")).toBeVisible()
    expect(sheet.queryByText("Asia")).not.toBeInTheDocument()
  })

  it("start with none, and say how to make one", async () => {
    const typist = userEvent.setup()
    const structure = listsStructure()
    structure.subsets = []
    const { sheet } = await openSheet(typist, { structure })

    expect(sheet.getByText("No subsets yet. Name one above, then choose its items.")).toBeVisible()
    expect(sheet.queryByRole("list", { name: "Subsets" })).not.toBeInTheDocument()
  })

  it("give focus back to the Subsets button when the sheet closes", async () => {
    const typist = userEvent.setup()
    await openSheet(typist)
    await typist.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Subsets" })).toHaveFocus()
  })

  it("are made by name, and the new subset opens for its items to be chosen", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSheet(typist)
    await typist.type(sheet.getByRole("textbox", { name: "New subset" }), "Best sellers")
    await typist.click(sheet.getByRole("button", { name: "Add subset" }))

    expect(await sheet.findByRole("heading", { name: "Best sellers" })).toHaveFocus()
    expect(store.writes).toEqual([
      {
        method: "POST",
        path: "subsets",
        body: { list_id: productsList, name: "Best sellers", item_ids: [] },
      },
    ])
    expect(toast.success).toHaveBeenCalledWith("Subset created")
    expect(sheet.getByText("0 of 2 items selected")).toBeVisible()
  })

  it("need a name, and a name that is free", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)
    await typist.click(sheet.getByRole("button", { name: "Add subset" }))

    expect(await sheet.findByText("Name is required.")).toBeVisible()
    await typist.type(sheet.getByRole("textbox", { name: "New subset" }), "core products")
    await typist.click(sheet.getByRole("button", { name: "Add subset" }))

    expect(await sheet.findByText("A subset named core products already exists.")).toBeVisible()
    expect(sheet.getByRole("textbox", { name: "New subset" })).toBeInvalid()
  })

  it("are renamed in place", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSheet(typist)
    await typist.click(sheet.getByRole("button", { name: "Rename Core products" }))
    const input = sheet.getByRole("textbox", { name: "Name of Core products" })
    await typist.clear(input)
    await typist.type(input, "Top products{Enter}")

    expect(await sheet.findByRole("button", { name: "Rename Top products" })).toHaveFocus()
    expect(store.writes).toEqual([
      { method: "PATCH", path: `subsets/${coreProducts}`, body: { name: "Top products" } },
    ])
    expect(toast.success).toHaveBeenCalledWith("Subset renamed")
  })

  it("are deleted after asking, and the items stay", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openSheet(typist)
    await typist.click(sheet.getByRole("button", { name: "Delete Core products" }))
    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Core products?" }))
    await typist.click(dialog.getByRole("button", { name: "Delete subset" }))

    expect(await sheet.findByText(/^No subsets yet/)).toBeVisible()
    expect(store.writes).toEqual([{ method: "DELETE", path: `subsets/${coreProducts}` }])
    expect(toast.success).toHaveBeenCalledWith("Subset deleted")
  })

  it("stay when the server says something uses them", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist)
    server.use(
      http.delete("/api/v1/models/:id/subsets/:subsetId", () =>
        problem(409, "structure.in_use", "The subset is used by a module."),
      ),
    )
    await typist.click(sheet.getByRole("button", { name: "Delete Core products" }))
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete subset" }),
    )

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The subset is used by a module."))
    expect(screen.getByRole("alertdialog")).toBeVisible()
  })
})

describe("choosing the items of a subset", () => {
  async function openMembers(typist: Typist, options?: Parameters<typeof openProducts>[0]) {
    const opened = await openSheet(typist, options)
    await typist.click(opened.sheet.getByRole("button", { name: /^Choose the items of Core/ }))
    await opened.sheet.findByRole("heading", { name: "Core products" })
    return opened
  }

  it("shows every item of the list as a checkbox, those in the subset ticked", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openMembers(typist)

    const members = within(sheet.getByRole("list", { name: "Items in Core products" }))
    expect(members.getByRole("checkbox", { name: "Widgets" })).toBeChecked()
    expect(members.getByRole("checkbox", { name: "Gadgets" })).not.toBeChecked()
    expect(sheet.getByText("1 of 2 items selected")).toBeVisible()
    expect(sheet.getByRole("button", { name: "Save members" })).toBeDisabled()
  })

  it("saves the ticked items in the order of the list, and goes back to the subsets", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openMembers(typist)
    await typist.click(sheet.getByRole("checkbox", { name: "Gadgets" }))
    expect(sheet.getByText("2 of 2 items selected")).toBeVisible()
    await typist.click(sheet.getByRole("button", { name: "Save members" }))

    expect(
      await sheet.findByRole("button", { name: "Choose the items of Core products" }),
    ).toHaveTextContent("2 items")
    expect(store.writes).toEqual([
      { method: "PATCH", path: `subsets/${coreProducts}`, body: { item_ids: [widgets, gadgets] } },
    ])
    expect(toast.success).toHaveBeenCalledWith("Subset saved")
    expect(sheet.getByRole("button", { name: "Choose the items of Core products" })).toHaveFocus()
  })

  it("goes back without saving on Cancel or All subsets", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openMembers(typist)
    await typist.click(sheet.getByRole("checkbox", { name: "Gadgets" }))
    await typist.click(sheet.getByRole("button", { name: "Cancel" }))

    expect(await sheet.findByRole("list", { name: "Subsets" })).toBeVisible()
    await typist.click(sheet.getByRole("button", { name: /^Choose the items of Core/ }))
    await typist.click(await sheet.findByRole("button", { name: "All subsets" }))

    expect(await sheet.findByRole("list", { name: "Subsets" })).toBeVisible()
    expect(store.writes).toEqual([])
  })

  it("searches the items, and ticks or clears just the ones shown", async () => {
    const typist = userEvent.setup()
    const { sheet, store } = await openMembers(typist)
    await typist.type(sheet.getByRole("searchbox", { name: "Filter items" }), "gad")

    expect(sheet.queryByRole("checkbox", { name: "Widgets" })).not.toBeInTheDocument()
    expect(sheet.getByText("1 of 2 items selected, 1 item shown")).toBeVisible()
    await typist.click(sheet.getByRole("button", { name: "Select shown" }))
    expect(sheet.getByText("2 of 2 items selected, 1 item shown")).toBeVisible()
    await typist.click(sheet.getByRole("button", { name: "Clear shown" }))
    expect(sheet.getByText("1 of 2 items selected, 1 item shown")).toBeVisible()
    await typist.clear(sheet.getByRole("searchbox", { name: "Filter items" }))
    await typist.click(sheet.getByRole("button", { name: "Clear shown" }))
    await typist.click(sheet.getByRole("button", { name: "Save members" }))

    await waitFor(() => expect(store.writes).toHaveLength(1))
    expect(store.writes[0].body).toEqual({ item_ids: [] })
  })

  it("says when no item matches", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openMembers(typist)
    await typist.type(sheet.getByRole("searchbox", { name: "Filter items" }), "zzz")

    expect(sheet.getByText("No items match.")).toBeVisible()
  })

  it("keeps the sheet and the ticks when the server refuses", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openMembers(typist)
    server.use(
      http.patch("/api/v1/models/:id/subsets/:subsetId", () =>
        problem(409, "model.production_locked", "The model is in production mode."),
      ),
    )
    await typist.click(sheet.getByRole("checkbox", { name: "Gadgets" }))
    await typist.click(sheet.getByRole("button", { name: "Save members" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The model is in production mode."),
    )
    expect(sheet.getByRole("checkbox", { name: "Gadgets" })).toBeChecked()
  })

  it("draws only the rows in view for a long list", async () => {
    mockViewport(400, 360)
    try {
      const typist = userEvent.setup()
      const structure = listsStructure()
      structure.lists[2] = {
        ...structure.lists[2],
        items: Array.from({ length: 800 }, (_, index) => ({
          id: `item-${index}`,
          name: `Product ${index + 1}`,
        })),
      }
      structure.subsets[0] = { ...structure.subsets[0], items: [] }
      const { sheet } = await openMembers(typist, { structure })

      const members = within(sheet.getByRole("list", { name: "Items in Core products" }))
      expect(members.getByRole("checkbox", { name: "Product 1" })).toBeVisible()
      const drawn = members.getAllByRole("checkbox").length
      expect(drawn).toBeGreaterThan(5)
      expect(drawn).toBeLessThan(60)
      expect(members.getAllByRole("listitem")[0]).toHaveAttribute("aria-setsize", "800")
      expect(sheet.getByText("0 of 800 items selected")).toBeVisible()
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe("for someone who cannot change the structure", () => {
  it("shows a viewer the subsets and their items, to read", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, { role: "viewer" })

    expect(sheet.queryByRole("textbox", { name: "New subset" })).not.toBeInTheDocument()
    expect(sheet.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument()
    expect(sheet.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument()
    expect(sheet.getByText("Core products")).toBeVisible()
    await typist.click(sheet.getByRole("button", { name: "View the items of Core products" }))

    expect(await sheet.findByRole("checkbox", { name: "Widgets" })).toBeDisabled()
    expect(sheet.queryByRole("button", { name: "Save members" })).not.toBeInTheDocument()
    expect(sheet.queryByRole("button", { name: "Select shown" })).not.toBeInTheDocument()
  })

  it("says plainly that a list has no subsets", async () => {
    const typist = userEvent.setup()
    const structure = listsStructure()
    structure.subsets = []
    const { sheet } = await openSheet(typist, { role: "viewer", structure })

    expect(sheet.getByText("This list has no subsets.")).toBeVisible()
  })
})

describe("in production mode", () => {
  it("shows the subsets, says why they are locked and switches the changes off", async () => {
    const typist = userEvent.setup()
    const { sheet } = await openSheet(typist, { mode: "prod" })

    expect(sheet.getByText(/^This model is in production mode/)).toBeVisible()
    expect(sheet.getByRole("textbox", { name: "New subset" })).toBeDisabled()
    expect(sheet.getByRole("button", { name: "Add subset" })).toBeDisabled()
    expect(sheet.getByRole("button", { name: "Delete Core products" })).toBeDisabled()
    expect(sheet.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument()
    await typist.click(sheet.getByRole("button", { name: /^Choose the items of Core/ }))

    expect(await sheet.findByRole("checkbox", { name: "Widgets" })).toBeDisabled()
    expect(sheet.getByRole("button", { name: "Save members" })).toBeDisabled()
  })
})

describe("a subset that is deleted elsewhere", () => {
  it("takes its items off the screen and shows the subsets again", async () => {
    const typist = userEvent.setup()
    const { sheet, store, queryClient } = await openSheet(typist)
    await typist.click(sheet.getByRole("button", { name: /^Choose the items of Core/ }))
    await sheet.findByRole("heading", { name: "Core products" })
    store.structure = { ...store.structure, subsets: [] }
    await queryClient.invalidateQueries({ queryKey: ["models", model.id, "structure"] })

    expect(await sheet.findByText(/^No subsets yet/)).toBeVisible()
    expect(sheet.queryByRole("heading", { name: "Core products" })).not.toBeInTheDocument()
  })
})
