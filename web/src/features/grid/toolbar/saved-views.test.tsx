import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { violations } from "@/test/axe"
import { problem } from "@/test/problem"
import { createTestQueryClient } from "@/test/render"
import { server } from "@/test/server"
import { MODEL_ID, MODULE_ID } from "@/test/view-query"
import { makeView, serveViews, simpleDefinition } from "@/test/views"
import { HttpResponse, http } from "msw"
import type { SavedView, ViewDefinition } from "../view-types"
import { SavedViews } from "./saved-views"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const forecast = makeView({
  id: "view-forecast",
  module_id: MODULE_ID,
  name: "Forecast",
  is_default: true,
})
const quarterly = makeView({ id: "view-quarterly", module_id: MODULE_ID, name: "Quarterly review" })
const budget = makeView({ id: "view-budget", module_id: MODULE_ID, name: "Budget" })

const changed: ViewDefinition = { ...simpleDefinition, show_summaries: false }

interface Setup {
  views?: SavedView[]
  saved?: SavedView
  modified?: boolean
  canSave?: boolean
  failed?: { retry: () => void }
}

function renderViews({ views = [], saved, modified = false, canSave = true, failed }: Setup = {}) {
  const store = serveViews(views)
  const handlers = {
    onSelect: vi.fn(),
    onDiscard: vi.fn(),
    onDeleting: vi.fn(),
  }
  const ordered = store.views.toSorted(
    (a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name),
  )
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SavedViews
        modelId={MODEL_ID}
        moduleId={MODULE_ID}
        views={ordered}
        failed={failed}
        saved={saved}
        current={changed}
        modified={modified}
        canSave={canSave}
        {...handlers}
      />
    </QueryClientProvider>,
  )
  return { store, ...handlers }
}

async function menu(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "View actions" }))
  await user.click(await screen.findByRole("menuitem", { name }))
  return user
}

describe("the saved views menu", () => {
  it("offers the built-in default first when no saved view is the default, then the views by name", async () => {
    const user = userEvent.setup()
    renderViews({ views: [quarterly, budget] })
    expect(screen.getByRole("combobox", { name: "Saved view" })).toHaveTextContent("Default")

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Default",
      "Budget",
      "Quarterly review",
    ])
  })

  it("puts the saved default first, marked, and offers no built-in one", async () => {
    const user = userEvent.setup()
    renderViews({ views: [quarterly, forecast, budget], saved: forecast })

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Forecast · Default",
      "Budget",
      "Quarterly review",
    ])
  })

  it("switches to a view by its id, and to the default by leaving the view out of the address", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderViews({ views: [quarterly, forecast, budget], saved: quarterly })

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))
    await user.click(await screen.findByRole("option", { name: /^Forecast/ }))
    expect(onSelect).toHaveBeenLastCalledWith(undefined)

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))
    await user.click(await screen.findByRole("option", { name: "Budget" }))
    expect(onSelect).toHaveBeenLastCalledWith("view-budget")
  })

  it("goes back to the built-in default pivot from a saved view", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderViews({ views: [quarterly], saved: quarterly })

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))
    await user.click(await screen.findByRole("option", { name: "Default" }))

    expect(onSelect).toHaveBeenCalledWith(undefined)
  })

  it("marks a view that differs from its saved definition", () => {
    renderViews({ views: [quarterly], saved: quarterly, modified: true })

    expect(screen.getByRole("status")).toHaveTextContent("Modified")
  })

  it("marks nothing for a view as it was saved", () => {
    renderViews({ views: [quarterly], saved: quarterly })

    expect(screen.getByRole("status")).toBeEmptyDOMElement()
  })
})

describe("saving", () => {
  it("saves over the view in use with the view as it is now", async () => {
    const { store, onDiscard } = renderViews({ views: [quarterly], saved: quarterly, modified: true })

    await menu("Save")

    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce())
    expect(store.requests).toEqual([
      { action: "update", id: "view-quarterly", body: { definition: changed } },
    ])
    expect(store.views[0].definition).toEqual(changed)
    expect(toast.success).toHaveBeenCalledWith("View saved")
  })

  it("has nothing to save over a view that is as it was saved", async () => {
    const user = userEvent.setup()
    renderViews({ views: [quarterly], saved: quarterly })

    await user.click(screen.getByRole("button", { name: "View actions" }))

    expect(await screen.findByRole("menuitem", { name: "Save" })).toHaveAttribute("aria-disabled", "true")
  })

  it("has no Save over the built-in default, which is not a saved view, only Save as", async () => {
    const user = userEvent.setup()
    renderViews({ views: [quarterly], modified: true })

    await user.click(screen.getByRole("button", { name: "View actions" }))

    expect(await screen.findByRole("menuitem", { name: "Save as…" })).toBeVisible()
    expect(screen.queryByRole("menuitem", { name: "Save" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Delete view…" })).not.toBeInTheDocument()
  })

  it("reports a refusal in a toast", async () => {
    renderViews({ views: [quarterly], saved: quarterly, modified: true })
    server.use(
      http.patch("/api/v1/models/:id/views/:viewId", () =>
        problem(409, "view.default_conflict", "Another view became the default. Try again."),
      ),
    )

    await menu("Save")

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Another view became the default. Try again."),
    )
  })
})

describe("saving as a new view", () => {
  async function saveAs(name: string, asDefault = false) {
    const user = await menu("Save as…")
    await user.type(await screen.findByRole("textbox", { name: "Name" }), name)
    if (asDefault) {
      await user.click(screen.getByRole("checkbox", { name: "Set as default" }))
    }
    await user.click(screen.getByRole("button", { name: "Save view" }))
    return user
  }

  it("saves the view as it is now under a name, and switches to it", async () => {
    const { store, onSelect, onDiscard } = renderViews({ views: [quarterly], saved: quarterly, modified: true })

    await saveAs("Board pack")

    await waitFor(() => expect(onSelect).toHaveBeenCalled())
    expect(store.requests).toEqual([
      { action: "create", body: { name: "Board pack", is_default: false, definition: changed } },
    ])
    const created = store.views.find((view) => view.name === "Board pack")
    expect(onSelect).toHaveBeenCalledWith(created?.id)
    expect(onDiscard).toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("makes it the default when asked, and then leaves the view out of the address", async () => {
    const { store, onSelect } = renderViews({ views: [forecast], saved: forecast, modified: true })

    await saveAs("Board pack", true)

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(undefined))
    expect(store.views.filter((view) => view.is_default).map((view) => view.name)).toEqual(["Board pack"])
  })

  it("says under the name that it is taken, and stays open", async () => {
    const { onSelect } = renderViews({ views: [quarterly], saved: quarterly, modified: true })

    await saveAs("quarterly review")

    expect(await screen.findByText("A view with that name already exists.")).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInvalid()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("wants a name", async () => {
    const { store } = renderViews({ views: [quarterly], saved: quarterly, modified: true })

    const user = await menu("Save as…")
    await user.click(await screen.findByRole("button", { name: "Save view" }))

    expect(await screen.findByText("Name is required.")).toBeVisible()
    expect(store.requests).toEqual([])
  })

  it("disables its buttons and spins while the view is saved", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderViews({ views: [], saved: undefined, modified: true })
    server.use(
      http.post("/api/v1/models/:id/modules/:moduleId/views", async () => {
        await gate
        return HttpResponse.json(makeView({ id: "view-new", name: "Slow" }), { status: 201 })
      }),
    )

    await saveAs("Slow")

    const submit = await screen.findByRole("button", { name: "Save view" })
    expect(submit).toBeDisabled()
    expect(submit.querySelector("svg.animate-spin")).not.toBeNull()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    release()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})

describe("the default view", () => {
  it("is set from the menu of a view that is not the default", async () => {
    const { store } = renderViews({ views: [forecast, quarterly], saved: quarterly })

    await menu("Set as default")

    await waitFor(() =>
      expect(store.views.find((view) => view.id === "view-quarterly")?.is_default).toBe(true),
    )
    expect(store.requests).toEqual([
      { action: "update", id: "view-quarterly", body: { is_default: true } },
    ])
    expect(toast.success).toHaveBeenCalledWith("Quarterly review is now the default view")
  })

  it("is not offered for the view that is the default already", async () => {
    const user = userEvent.setup()
    renderViews({ views: [forecast], saved: forecast })

    await user.click(screen.getByRole("button", { name: "View actions" }))

    await screen.findByRole("menuitem", { name: "Save as…" })
    expect(screen.queryByRole("menuitem", { name: "Set as default" })).not.toBeInTheDocument()
  })
})

describe("deleting", () => {
  it("asks, deletes the view, and goes to the default", async () => {
    const { store, onSelect, onDeleting } = renderViews({ views: [forecast, quarterly], saved: quarterly })

    const user = await menu("Delete view…")
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this view?" })
    expect(dialog).toHaveTextContent("Quarterly review is deleted for everyone who uses this module.")
    await user.click(within(dialog).getByRole("button", { name: "Delete view" }))

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(undefined))
    expect(onDeleting).toHaveBeenCalledWith("view-quarterly")
    expect(store.views.map((view) => view.id)).toEqual(["view-forecast"])
    expect(toast.success).toHaveBeenCalledWith("View deleted")
  })

  it("leaves the view alone when the dialog is cancelled", async () => {
    const { store, onSelect } = renderViews({ views: [quarterly], saved: quarterly })

    const user = await menu("Delete view…")
    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    expect(store.requests).toEqual([])
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe("someone who may not save views", () => {
  it("can switch views but is offered no way to save, set the default or delete", async () => {
    const user = userEvent.setup()
    renderViews({ views: [forecast, quarterly], saved: quarterly, canSave: false })

    expect(screen.getByRole("combobox", { name: "Saved view" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "View actions" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("combobox", { name: "Saved view" }))
    expect(await screen.findAllByRole("option")).toHaveLength(2)
  })

  it("can still give up changes made on screen", async () => {
    const { onDiscard } = renderViews({ views: [quarterly], saved: quarterly, canSave: false, modified: true })

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "View actions" }))
    expect(screen.queryByRole("menuitem", { name: "Save" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Save as…" })).not.toBeInTheDocument()
    await user.click(await screen.findByRole("menuitem", { name: "Discard changes" }))

    expect(onDiscard).toHaveBeenCalledOnce()
  })
})

describe("when the views cannot be read", () => {
  it("offers to try again in place of the menu", async () => {
    const retry = vi.fn()
    renderViews({ failed: { retry } })

    await userEvent.setup().click(screen.getByRole("button", { name: "Saved views: retry" }))

    expect(retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole("combobox", { name: "Saved view" })).not.toBeInTheDocument()
  })
})

describe("accessibility", () => {
  it("has no violations", async () => {
    renderViews({ views: [forecast, quarterly], saved: quarterly, modified: true })

    await waitFor(async () => expect(await violations({ ignore: ["region"] })).toEqual([]))
  })
})
