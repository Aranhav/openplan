import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { ResetPasswordDialog } from "./reset-password-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const grace = { id: "0192f3a0-0000-7000-8000-000000000020", name: "Grace Hopper" }
const userUrl = `/api/v1/users/${grace.id}`

function renderDialog() {
  const onOpenChange = vi.fn()
  const view = renderWithProviders(
    <ResetPasswordDialog user={grace} open onOpenChange={onOpenChange} />,
  )
  return { ...view, onOpenChange }
}

async function openDialog() {
  return within(await screen.findByRole("dialog", { name: "Reset password" }))
}

describe("ResetPasswordDialog", () => {
  it("names the user whose password is being reset", async () => {
    renderDialog()
    const dialog = await openDialog()

    expect(dialog.getByText(/Set a new password for Grace Hopper/)).toBeVisible()
  })

  it("asks for a password of at least 10 characters without sending a request", async () => {
    const attempts = vi.fn()
    server.use(
      http.patch(userUrl, () => {
        attempts()
        return HttpResponse.json(grace)
      }),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(dialog.getByLabelText("Temporary password"), "short")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    expect(await dialog.findByText("Password must be at least 10 characters.")).toBeVisible()
    expect(dialog.getByLabelText("Temporary password")).toBeInvalid()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("sends the new password and closes", async () => {
    const patched = vi.fn()
    server.use(
      http.patch(userUrl, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json(grace)
      }),
      http.get("/api/v1/users", () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(patched).toHaveBeenCalledExactlyOnceWith({ password: "correct-horse-battery" })
    expect(toast.success).toHaveBeenCalledWith("Password reset")
  })

  it("shows the server's complaint under the password", async () => {
    server.use(
      http.patch(userUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "password", message: "Use your profile to change your own password." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    expect(await dialog.findByText("Use your profile to change your own password.")).toBeVisible()
    expect(dialog.getByLabelText("Temporary password")).toHaveFocus()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("reports any other failure in a toast", async () => {
    server.use(http.patch(userUrl, () => problem(403, "auth.forbidden", "You can't do that.")))
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't do that."))
  })

  it("can't be dismissed while the password is being reset", async () => {
    server.use(
      http.patch(userUrl, async () => {
        await delay(300)
        return HttpResponse.json(grace)
      }),
      http.get("/api/v1/users", () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    const submit = dialog.getByRole("button", { name: "Reset password" })
    expect(submit).toBeDisabled()
    expect(submit.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(dialog.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    await typist.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
