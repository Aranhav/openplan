import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel({ name: "Revenue plan", description: "Top-down revenue forecast." })
const modelUrl = `/api/v1/models/${model.id}`

function signedInAs(role: "admin" | "builder" | "planner" | "viewer") {
  return mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
}

async function findSettings() {
  const heading = await screen.findByText("Model settings")
  return within(heading.closest("[data-slot=card]") as HTMLElement)
}

describe("the model page", () => {
  it("shows the model's name and mode above its settings", async () => {
    mockSession()
    serveModels([model])
    renderApp(`/m/${model.id}`)

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue plan" })).toBeVisible()
    const header = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement
    expect(within(header).getByText("Dev")).toBeVisible()
    expect(document.title).toBe("Revenue plan · OpenPlan")
    const settings = await findSettings()
    expect(settings.getByLabelText("Name")).toHaveValue("Revenue plan")
    expect(settings.getByLabelText("Description")).toHaveValue("Top-down revenue forecast.")
    expect(settings.getByRole("switch", { name: "Production mode" })).not.toBeChecked()
    expect(
      settings.getByText("Structural changes are blocked. Changes arrive through ALM sync."),
    ).toBeVisible()
  })

  it("shows a production model's mode", async () => {
    mockSession()
    serveModels([{ ...model, mode: "prod" }])
    renderApp(`/m/${model.id}`)

    const settings = await findSettings()
    expect(settings.getByRole("switch", { name: "Production mode" })).toBeChecked()
    const header = screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement
    expect(within(header).getByText("Production")).toBeVisible()
  })

  it("shows placeholders while the model loads", async () => {
    mockSession()
    server.use(
      http.get(modelUrl, async () => {
        await delay(100)
        return HttpResponse.json(model)
      }),
    )
    renderApp(`/m/${model.id}`)

    expect(await screen.findByRole("status", { name: "Loading model" })).toBeVisible()
    expect(await screen.findByRole("heading", { level: 1, name: "Revenue plan" })).toBeVisible()
    expect(screen.queryByRole("status", { name: "Loading model" })).not.toBeInTheDocument()
  })

  it("keeps Save changes disabled until something changes", async () => {
    mockSession()
    serveModels([model])
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()

    const save = settings.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    await typist.type(settings.getByLabelText("Name"), "!")
    expect(save).toBeEnabled()
    await typist.type(settings.getByLabelText("Name"), "{Backspace}")
    expect(save).toBeDisabled()
  })

  it("saves the changes and shows them", async () => {
    mockSession()
    serveModels([model])
    const patched = vi.fn()
    server.use(
      http.patch(modelUrl, async ({ request }) => {
        const body = (await request.json()) as object
        patched(body)
        return HttpResponse.json({ ...model, ...body })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()
    const name = settings.getByLabelText("Name")
    await typist.clear(name)
    await typist.type(name, "  Revenue forecast ")
    await typist.click(settings.getByRole("switch", { name: "Production mode" }))
    await typist.click(settings.getByRole("button", { name: "Save changes" }))

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue forecast" })).toBeVisible()
    expect(patched).toHaveBeenCalledWith({
      name: "Revenue forecast",
      description: "Top-down revenue forecast.",
      mode: "prod",
    })
    expect(toast.success).toHaveBeenCalledWith("Changes saved")
    expect(settings.getByLabelText("Name")).toHaveValue("Revenue forecast")
    expect(settings.getByRole("button", { name: "Save changes" })).toBeDisabled()
    expect(screen.getByRole("heading", { level: 1 }).parentElement).toHaveTextContent("Production")
  })

  it("disables the button while the changes are being saved", async () => {
    mockSession()
    serveModels([model])
    server.use(
      http.patch(modelUrl, async () => {
        await delay(300)
        return HttpResponse.json({ ...model, name: "Revenue forecast" })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()
    const name = settings.getByLabelText("Name")
    await typist.clear(name)
    await typist.type(name, "Revenue forecast")
    await typist.click(settings.getByRole("button", { name: "Save changes" }))

    const save = settings.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    expect(save.querySelector("svg.animate-spin")).toBeInTheDocument()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Changes saved"))
  })

  it("requires a name", async () => {
    mockSession()
    serveModels([model])
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()
    await typist.clear(settings.getByLabelText("Name"))
    await typist.click(settings.getByRole("button", { name: "Save changes" }))

    expect(await settings.findByText("Model name is required.")).toBeVisible()
  })

  it("shows a name that is taken under the field", async () => {
    mockSession()
    serveModels([model])
    server.use(
      http.patch(modelUrl, () =>
        problem(
          409,
          "model.name_taken",
          "A model with this name already exists in this workspace.",
        ),
      ),
    )
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()
    await typist.type(settings.getByLabelText("Name"), " 2")
    await typist.click(settings.getByRole("button", { name: "Save changes" }))

    expect(
      await settings.findByText("A model with this name already exists in this workspace."),
    ).toBeVisible()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("says so and offers a retry when the model cannot be loaded", async () => {
    mockSession()
    server.use(http.get(modelUrl, () => problem(500, "internal", "The database is starting up.")))
    const typist = userEvent.setup()
    renderApp(`/m/${model.id}`)

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveModels([model])
    await typist.click(screen.getByRole("button", { name: "Retry" }))

    expect(await screen.findByRole("heading", { level: 1, name: "Revenue plan" })).toBeVisible()
  })
})

describe("deleting a model from its page", () => {
  it("asks first, then leaves for the models page and says it is gone", async () => {
    mockSession()
    serveModels([model])
    const typist = userEvent.setup()
    const { router } = renderApp(`/m/${model.id}`)
    let pathWhenToasted: string | undefined
    vi.mocked(toast.success).mockImplementation((message) => {
      if (message === "Model deleted") {
        pathWhenToasted = router.state.location.pathname
      }
      return 1
    })
    const danger = within(
      (await screen.findByText("Danger zone")).closest("[data-slot=card]") as HTMLElement,
    )
    await typist.click(danger.getByRole("button", { name: "Delete model" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" })
    await typist.click(within(dialog).getByRole("button", { name: "Delete model" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}`))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Model deleted"))
    expect(pathWhenToasted).toBe(`/w/${workspace.id}`)
    expect(await screen.findByRole("heading", { name: "No models yet" })).toBeVisible()
  })

  it("stays on the model when the deletion is cancelled", async () => {
    mockSession()
    serveModels([model])
    const typist = userEvent.setup()
    const { router } = renderApp(`/m/${model.id}`)
    const danger = within(
      (await screen.findByText("Danger zone")).closest("[data-slot=card]") as HTMLElement,
    )
    await typist.click(danger.getByRole("button", { name: "Delete model" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" })
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe(`/m/${model.id}`)
    expect(danger.getByRole("button", { name: "Delete model" })).toHaveFocus()
  })
})

describe.each(["planner", "viewer"] as const)("the model page for a %s", (role) => {
  it("shows the settings as plain text, with nothing to change or delete", async () => {
    signedInAs(role)
    serveModels([model])
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()

    expect(settings.getByText("Revenue plan")).toBeVisible()
    expect(settings.getByText("Top-down revenue forecast.")).toBeVisible()
    expect(settings.getByText("Dev")).toBeVisible()
    expect(settings.queryByRole("textbox")).not.toBeInTheDocument()
    expect(settings.queryByRole("switch")).not.toBeInTheDocument()
    expect(settings.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete model" })).not.toBeInTheDocument()
  })

  it("says when a model has no description", async () => {
    signedInAs(role)
    serveModels([{ ...model, description: "" }])
    renderApp(`/m/${model.id}`)
    const settings = await findSettings()

    expect(settings.getByText("No description")).toBeVisible()
  })
})

describe("a model that is not there", () => {
  it("says it was not found and leads back to the models", async () => {
    mockSession()
    serveModels([])
    const typist = userEvent.setup()
    const { router } = renderApp(`/m/${model.id}`)

    expect(await screen.findByRole("heading", { level: 1, name: "Model not found" })).toBeVisible()
    expect(screen.getByText("It may have been deleted, or you don't have access.")).toBeVisible()
    expect(document.title).toBe("Model not found · OpenPlan")
    await typist.click(screen.getByRole("link", { name: "Back to models" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}`))
  })
})
