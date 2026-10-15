import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const listUrl = `/api/v1/workspaces/${workspace.id}/models`
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

const revenue = makeModel({
  id: "0192f3a0-0000-7000-8000-000000000011",
  name: "Revenue plan",
  description: "Top-down revenue forecast for the next fiscal year.",
  updated_at: twoHoursAgo,
})
const headcount = makeModel({
  id: "0192f3a0-0000-7000-8000-000000000012",
  name: "Headcount plan",
  mode: "prod",
  updated_at: twoHoursAgo,
})

type Typist = ReturnType<typeof userEvent.setup>

function signedInAs(role: "admin" | "builder" | "planner" | "viewer") {
  return mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
}

async function openMenu(typist: Typist, modelName: string) {
  await typist.click(await screen.findByRole("button", { name: `Actions for ${modelName}` }))
  return screen.findByRole("menu")
}

describe("the models page", () => {
  it("names the workspace", async () => {
    mockSession()
    serveModels([revenue])
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("heading", { level: 1, name: "Models" })).toBeVisible()
    expect(screen.getByText("Planning models in Acme Corp.")).toBeVisible()
    expect(document.title).toBe("Models · OpenPlan")
  })

  it("shows placeholders while the models load", async () => {
    mockSession()
    server.use(
      http.get(listUrl, async () => {
        await delay(100)
        return HttpResponse.json([revenue])
      }),
    )
    renderApp(`/w/${workspace.id}`)

    const loading = await screen.findByRole("status", { name: "Loading models" })
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(6)
    expect(await screen.findByRole("link", { name: "Revenue plan" })).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading models" })).not.toBeInTheDocument()
  })

  it("lists the models as cards that open the model", async () => {
    mockSession()
    serveModels([
      revenue,
      headcount,
      makeModel({ id: "0192f3a0-0000-7000-8000-000000000013", name: "Cost plan" }),
    ])
    renderApp(`/w/${workspace.id}`)

    const link = await screen.findByRole("link", { name: "Revenue plan" })
    expect(link).toHaveAttribute("href", `/m/${revenue.id}`)
    const card = within(link)
    expect(card.getByText("Top-down revenue forecast for the next fiscal year.")).toBeVisible()
    expect(card.getByText("Dev")).toBeVisible()
    expect(card.getByText("Updated 2 hours ago")).toBeVisible()

    const production = within(screen.getByRole("link", { name: "Headcount plan" }))
    expect(production.getByText("Production")).toBeVisible()
    expect(production.getByText("No description")).toBeVisible()
  })

  it("opens a model when its card is clicked", async () => {
    mockSession()
    serveModels([revenue])
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    await typist.click(
      await screen.findByText("Top-down revenue forecast for the next fiscal year."),
    )

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${revenue.id}`))
  })

  it("offers a first model when there are none", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("heading", { level: 2, name: "No models yet" })).toBeVisible()
    expect(screen.getByText("Create a model to start planning.")).toBeVisible()
    expect(screen.getAllByRole("button", { name: "New model" })).toHaveLength(1)
  })

  it("says why there is no New model button to anyone who cannot build", async () => {
    signedInAs("planner")
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("heading", { name: "No models yet" })).toBeVisible()
    expect(screen.getByText("Ask a workspace admin or builder to create one.")).toBeVisible()
    expect(screen.queryByRole("button", { name: "New model" })).not.toBeInTheDocument()
  })

  it.each(["planner", "viewer"] as const)(
    "leaves a %s to open models but not to change them",
    async (role) => {
      signedInAs(role)
      serveModels([revenue])
      renderApp(`/w/${workspace.id}`)

      expect(await screen.findByRole("link", { name: "Revenue plan" })).toBeVisible()
      expect(screen.queryByRole("button", { name: "New model" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument()
    },
  )

  it("lets a builder create models", async () => {
    signedInAs("builder")
    serveModels([revenue])
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("button", { name: "Actions for Revenue plan" })).toBeVisible()
    expect(screen.getByRole("button", { name: "New model" })).toBeVisible()
  })

  it("creates a model from the New model button and opens it", async () => {
    mockSession()
    const store = serveModels([revenue])
    const created = makeModel({ id: "0192f3a0-0000-7000-8000-000000000099", name: "FY27 Budget" })
    server.use(
      http.post(listUrl, () => {
        store.models = [...store.models, created]
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    await typist.click(await screen.findByRole("button", { name: "New model" }))
    const dialog = await screen.findByRole("dialog", { name: "Create model" })
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${created.id}`))
    expect(toast.success).toHaveBeenCalledWith("Model created")
  })

  it("returns focus to the New model button when the dialog is cancelled", async () => {
    mockSession()
    serveModels([revenue])
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const button = await screen.findByRole("button", { name: "New model" })
    await typist.click(button)
    await typist.click(
      within(await screen.findByRole("dialog", { name: "Create model" })).getByRole("button", {
        name: "Cancel",
      }),
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })

  it("renames a model from its menu without opening it", async () => {
    mockSession()
    serveModels([revenue])
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Rename" }))
    const dialog = await screen.findByRole("dialog", { name: "Rename model" })
    const name = within(dialog).getByLabelText("Name")
    expect(name).toHaveValue("Revenue plan")
    await typist.clear(name)
    await typist.type(name, "Revenue forecast")
    await typist.click(within(dialog).getByRole("button", { name: "Rename model" }))

    expect(await screen.findByRole("link", { name: "Revenue forecast" })).toBeVisible()
    expect(toast.success).toHaveBeenCalledWith("Model renamed")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/w/${workspace.id}`)
  })

  it("keeps the rename dialog open and shows a name that is taken under the field", async () => {
    mockSession()
    serveModels([revenue])
    server.use(
      http.patch(`/api/v1/models/${revenue.id}`, () =>
        problem(
          409,
          "model.name_taken",
          "A model with this name already exists in this workspace.",
        ),
      ),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Rename" }))
    const dialog = await screen.findByRole("dialog", { name: "Rename model" })
    await typist.type(within(dialog).getByLabelText("Name"), " 2")
    await typist.click(within(dialog).getByRole("button", { name: "Rename model" }))

    expect(
      await within(dialog).findByText("A model with this name already exists in this workspace."),
    ).toBeVisible()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("closes the rename dialog without a request when the name did not change", async () => {
    mockSession()
    serveModels([revenue])
    const renamed = vi.fn()
    server.use(
      http.patch(`/api/v1/models/${revenue.id}`, () => {
        renamed()
        return HttpResponse.json(revenue)
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Rename" }))
    const dialog = await screen.findByRole("dialog", { name: "Rename model" })
    await typist.click(within(dialog).getByRole("button", { name: "Rename model" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(renamed).not.toHaveBeenCalled()
  })

  it("asks before deleting a model, then removes it from the list", async () => {
    mockSession()
    serveModels([revenue, headcount])
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" })
    expect(
      within(dialog).getByText(
        "This permanently deletes the model and all its data. This can't be undone.",
      ),
    ).toBeVisible()
    await typist.click(within(dialog).getByRole("button", { name: "Delete model" }))

    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Revenue plan" })).not.toBeInTheDocument(),
    )
    expect(toast.success).toHaveBeenCalledWith("Model deleted")
    expect(screen.getByRole("link", { name: "Headcount plan" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/w/${workspace.id}`)
  })

  it("keeps the model when the deletion is cancelled", async () => {
    mockSession()
    const deleted = vi.fn()
    serveModels([revenue])
    server.use(
      http.delete(`/api/v1/models/${revenue.id}`, () => {
        deleted()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" })
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(deleted).not.toHaveBeenCalled()
    expect(screen.getByRole("link", { name: "Revenue plan" })).toBeVisible()
  })

  it("tells you when a model could not be deleted and keeps the dialog open", async () => {
    mockSession()
    serveModels([revenue])
    server.use(
      http.delete(`/api/v1/models/${revenue.id}`, () =>
        problem(403, "auth.forbidden", "You don't have permission to do that."),
      ),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openMenu(typist, "Revenue plan")
    await typist.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" })
    await typist.click(within(dialog).getByRole("button", { name: "Delete model" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("You don't have permission to do that."),
    )
    expect(screen.getByRole("alertdialog", { name: "Delete Revenue plan?" })).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Delete model" })).toBeEnabled()
  })

  it("says so and offers a retry when the models cannot be loaded", async () => {
    mockSession()
    server.use(http.get(listUrl, () => problem(500, "internal", "The database is starting up.")))
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveModels([revenue])
    await typist.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("link", { name: "Revenue plan" })).toBeVisible()
  })
})

describe("a workspace that is not the user's", () => {
  it("says it was not found instead of showing another workspace", async () => {
    mockSession()
    const listed = vi.fn()
    server.use(
      http.get("/api/v1/workspaces/0192f3a0-0000-7000-8000-0000000000ff/models", () => {
        listed()
        return HttpResponse.json([])
      }),
    )
    renderApp("/w/0192f3a0-0000-7000-8000-0000000000ff")

    expect(
      await screen.findByRole("heading", { level: 1, name: "Workspace not found" }),
    ).toBeVisible()
    expect(screen.getByText("It may have been deleted, or you don't have access.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/")
    expect(screen.queryByRole("heading", { name: "Models" })).not.toBeInTheDocument()
    expect(document.title).toBe("Workspace not found · OpenPlan")
    expect(listed).not.toHaveBeenCalled()
  })

  it("is not found for someone who belongs to no workspace either", async () => {
    mockSession({ me: { ...me, workspaces: [] } })
    renderApp(`/w/${workspace.id}`)

    expect(await screen.findByRole("heading", { name: "Workspace not found" })).toBeVisible()
  })
})
