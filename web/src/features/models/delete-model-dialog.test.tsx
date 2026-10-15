import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/client"
import { makeModel } from "@/test/app"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { DeleteModelDialog } from "./delete-model-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const model = makeModel()

describe("DeleteModelDialog", () => {
  it("stays disabled once the model is gone, while the caller is still leaving the page", async () => {
    const deleted = vi.fn()
    server.use(
      http.delete(`/api/v1/models/${model.id}`, () => {
        deleted()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    let leave!: () => void
    const leaving = new Promise<void>((resolve) => {
      leave = resolve
    })
    const onDeleted = vi.fn(() => leaving)
    const onOpenChange = vi.fn()
    const typist = userEvent.setup()
    renderWithProviders(
      <DeleteModelDialog model={model} open onOpenChange={onOpenChange} onDeleted={onDeleted} />,
    )
    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" }))
    await typist.click(dialog.getByRole("button", { name: "Delete model" }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
    // The request is over by now; give the dialog the time to show it, if it is going to.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(dialog.getByRole("button", { name: "Delete model" })).toBeDisabled()
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()

    leave()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(deleted).toHaveBeenCalledOnce()
  })

  it("closes anyway when leaving the page fails after the model is gone", async () => {
    server.use(
      http.delete(`/api/v1/models/${model.id}`, () => new HttpResponse(null, { status: 204 })),
    )
    const onOpenChange = vi.fn()
    const typist = userEvent.setup()
    renderWithProviders(
      <DeleteModelDialog
        model={model}
        open
        onOpenChange={onOpenChange}
        onDeleted={() => Promise.reject(new ApiError(500, "internal", "Could not open the page."))}
      />,
    )
    const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Revenue plan?" }))
    await typist.click(dialog.getByRole("button", { name: "Delete model" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not open the page."))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
