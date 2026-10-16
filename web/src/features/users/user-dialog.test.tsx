import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { user as ada } from "@/test/app"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { spinning } from "@/test/spinning"
import { UserDialog } from "./user-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const usersUrl = "/api/v1/users"
const grace = {
  id: "0192f3a0-0000-7000-8000-000000000020",
  email: "grace@example.com",
  name: "Grace Hopper",
  is_instance_admin: false,
  disabled: false,
  created_at: "2026-10-01T09:00:00Z",
}
const adaDto = { ...grace, id: ada.id, email: ada.email, name: ada.name, is_instance_admin: true }

type Typist = ReturnType<typeof userEvent.setup>

function renderDialog(props: { user?: typeof grace; isSelf?: boolean } = {}) {
  const onOpenChange = vi.fn()
  const view = renderWithProviders(<UserDialog {...props} open onOpenChange={onOpenChange} />)
  return { ...view, onOpenChange }
}

async function fillCreateForm(typist: Typist, dialog: ReturnType<typeof within>) {
  await typist.type(dialog.getByLabelText("Name"), "Grace Hopper")
  await typist.type(dialog.getByLabelText("Email"), "grace@example.com")
  await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
}

describe("UserDialog, creating a user", () => {
  async function openDialog() {
    return within(await screen.findByRole("dialog", { name: "Create user" }))
  }

  it("asks for a name, a valid email and a long enough password", async () => {
    const attempts = vi.fn()
    server.use(
      http.post(usersUrl, () => {
        attempts()
        return HttpResponse.json(grace, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    expect(await dialog.findByText("Name is required.")).toBeVisible()
    expect(dialog.getByText("Enter an email address.")).toBeVisible()
    expect(dialog.getByText("Password must be at least 10 characters.")).toBeVisible()
    await typist.type(dialog.getByLabelText("Email"), "not-an-email")
    await typist.type(dialog.getByLabelText("Temporary password"), "short")
    await typist.click(dialog.getByRole("button", { name: "Create user" }))
    expect(await dialog.findByText("Enter a valid email address.")).toBeVisible()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("creates the user and closes", async () => {
    const posted = vi.fn()
    server.use(
      http.post(usersUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(grace, { status: 201 })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("checkbox", { name: /Instance admin/ }))
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(posted).toHaveBeenCalledWith({
      name: "Grace Hopper",
      email: "grace@example.com",
      password: "correct-horse-battery",
      is_instance_admin: true,
    })
    expect(toast.success).toHaveBeenCalledWith("Grace Hopper created")
  })

  it("does not make the new user an instance admin unless asked", async () => {
    const posted = vi.fn()
    server.use(
      http.post(usersUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json(grace, { status: 201 })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    await waitFor(() => expect(posted).toHaveBeenCalledOnce())
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ is_instance_admin: false }))
  })

  it("shows email_taken under email", async () => {
    server.use(
      http.post(usersUrl, () => problem(409, "user.email_taken", "Email is already registered.")),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    expect(await dialog.findByText("Email is already registered.")).toBeVisible()
    expect(dialog.getByLabelText("Email")).toBeInvalid()
    expect(dialog.getByLabelText("Email")).toHaveFocus()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("shows the server's complaint about a field under that field", async () => {
    server.use(
      http.post(usersUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "password", message: "Password is too common." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    expect(await dialog.findByText("Password is too common.")).toBeVisible()
    expect(dialog.getByLabelText("Temporary password")).toBeInvalid()
  })

  it("reports any other failure in a toast", async () => {
    server.use(http.post(usersUrl, () => problem(403, "auth.forbidden", "You can't do that.")))
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't do that."))
  })

  it("can't be dismissed while the user is being created", async () => {
    server.use(
      http.post(usersUrl, async () => {
        await delay(300)
        return HttpResponse.json(grace, { status: 201 })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await fillCreateForm(typist, dialog)
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    const submit = dialog.getByRole("button", { name: "Create user" })
    expect(submit).toBeDisabled()
    expect(spinning(submit)).toBe(true)
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(dialog.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    await typist.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

describe("UserDialog, editing a user", () => {
  async function openDialog() {
    return within(await screen.findByRole("dialog", { name: "Edit user" }))
  }

  it("starts from the user's name and role", async () => {
    renderDialog({ user: { ...grace, is_instance_admin: true } })
    const dialog = await openDialog()

    expect(dialog.getByLabelText("Name")).toHaveValue("Grace Hopper")
    expect(dialog.getByRole("checkbox", { name: /Instance admin/ })).toBeChecked()
    expect(dialog.queryByLabelText("Email")).not.toBeInTheDocument()
    expect(dialog.queryByLabelText("Temporary password")).not.toBeInTheDocument()
  })

  it("sends only what changed", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ ...grace, name: "Grace B. Hopper" })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.clear(dialog.getByLabelText("Name"))
    await typist.type(dialog.getByLabelText("Name"), "  Grace B. Hopper ")
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(patched).toHaveBeenCalledExactlyOnceWith({ name: "Grace B. Hopper" })
    expect(toast.success).toHaveBeenCalledWith("User updated")
  })

  it("sends the instance admin flag when it is what changed", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ ...grace, is_instance_admin: true })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.click(dialog.getByRole("checkbox", { name: /Instance admin/ }))
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(patched).toHaveBeenCalledOnce())
    expect(patched).toHaveBeenCalledWith({ is_instance_admin: true })
  })

  it("can't be dismissed while the changes are being saved", async () => {
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, async () => {
        await delay(300)
        return HttpResponse.json({ ...grace, is_instance_admin: true })
      }),
      http.get(usersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.click(dialog.getByRole("checkbox", { name: /Instance admin/ }))
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(dialog.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    await typist.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("closes without a request when nothing changed", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, () => {
        patched()
        return HttpResponse.json(grace)
      }),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(patched).not.toHaveBeenCalled()
  })

  it("asks for a name", async () => {
    const typist = userEvent.setup()
    renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.clear(dialog.getByLabelText("Name"))
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    expect(await dialog.findByText("Name is required.")).toBeVisible()
  })

  it("shows the server's complaint about a field under that field", async () => {
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [
            { field: "is_instance_admin", message: "You can't change this for your own account." },
          ],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderDialog({ user: grace })
    const dialog = await openDialog()
    await typist.click(dialog.getByRole("checkbox", { name: /Instance admin/ }))
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    expect(await dialog.findByText("You can't change this for your own account.")).toBeVisible()
  })

  it("leaves the instance admin flag of the signed-in user alone", async () => {
    renderDialog({ user: adaDto, isSelf: true })
    const dialog = await openDialog()

    expect(dialog.getByRole("checkbox", { name: /Instance admin/ })).toBeDisabled()
    expect(dialog.getByText("You can't change this for your own account.")).toBeVisible()
  })
})
