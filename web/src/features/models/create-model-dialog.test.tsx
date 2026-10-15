import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { makeModel, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { CreateModelDialog } from "./create-model-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const listUrl = `/api/v1/workspaces/${workspace.id}/models`
const created = makeModel({ id: "0192f3a0-0000-7000-8000-000000000099", name: "FY27 Budget" })

function renderDialog() {
  const onOpenChange = vi.fn()
  const view = renderWithProviders(
    <CreateModelDialog workspaceId={workspace.id} open onOpenChange={onOpenChange} />,
  )
  return { ...view, onOpenChange }
}

async function openDialog() {
  return screen.findByRole("dialog", { name: "Create model" })
}

describe("CreateModelDialog", () => {
  it("requires a name", async () => {
    const attempts = vi.fn()
    server.use(
      http.post(listUrl, () => {
        attempts()
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    expect(await within(dialog).findByText("Model name is required.")).toBeVisible()
    expect(within(dialog).getByLabelText("Name")).toBeInvalid()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("keeps the name to 80 characters and the description to 500", async () => {
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByLabelText("Name"))
    await typist.paste("n".repeat(81))
    await typist.click(within(dialog).getByLabelText("Description"))
    await typist.paste("d".repeat(501))
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    expect(
      await within(dialog).findByText("Model name must be at most 80 characters."),
    ).toBeVisible()
    expect(within(dialog).getByText("Description must be at most 500 characters.")).toBeVisible()
  })

  it("shows name_taken error under name", async () => {
    server.use(
      http.post(listUrl, () =>
        problem(
          409,
          "model.name_taken",
          "A model with this name already exists in this workspace.",
        ),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    expect(
      await within(dialog).findByText("A model with this name already exists in this workspace."),
    ).toBeVisible()
    expect(within(dialog).getByLabelText("Name")).toBeInvalid()
    expect(within(dialog).getByLabelText("Name")).toHaveFocus()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Create model" })).toBeVisible()
  })

  it("shows the server's complaint about a field under that field", async () => {
    server.use(
      http.post(listUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "description", message: "Description is too long." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    expect(await within(dialog).findByText("Description is too long.")).toBeVisible()
    expect(within(dialog).getByLabelText("Description")).toBeInvalid()
  })

  it("reports any other failure in a toast", async () => {
    server.use(http.post(listUrl, () => problem(403, "auth.forbidden", "You can't do that.")))
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't do that."))
  })

  it("navigates to model on success", async () => {
    const posted = vi.fn()
    server.use(
      http.post(listUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get(listUrl, () => HttpResponse.json([created])),
    )
    const typist = userEvent.setup()
    const { router, onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "  FY27 Budget ")
    await typist.type(within(dialog).getByLabelText("Description"), "Next year's budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${created.id}`))
    expect(posted).toHaveBeenCalledWith({ name: "FY27 Budget", description: "Next year's budget" })
    expect(toast.success).toHaveBeenCalledWith("Model created")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("disables the button while the model is being created", async () => {
    server.use(
      http.post(listUrl, async () => {
        await delay(300)
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get(listUrl, () => HttpResponse.json([created])),
    )
    const typist = userEvent.setup()
    const { router } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    const submit = within(dialog).getByRole("button", { name: "Create model" })
    expect(submit).toBeDisabled()
    expect(submit.querySelector("svg.animate-spin")).toBeInTheDocument()
    // Let the request finish, so nothing is still running when the next test starts.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${created.id}`))
  })

  it("cannot be closed while the model is being created", async () => {
    server.use(
      http.post(listUrl, async () => {
        await delay(300)
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get(listUrl, () => HttpResponse.json([created])),
    )
    const typist = userEvent.setup()
    const { router, onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))

    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    await typist.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Create model" })).toBeVisible()
    // The dialog closes itself once the model exists.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${created.id}`))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("can be closed again after a failed attempt", async () => {
    server.use(http.post(listUrl, () => problem(403, "auth.forbidden", "You can't do that.")))
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Name"), "FY27 Budget")
    await typist.click(within(dialog).getByRole("button", { name: "Create model" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await typist.keyboard("{Escape}")

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes without creating anything when Cancel is pressed", async () => {
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
