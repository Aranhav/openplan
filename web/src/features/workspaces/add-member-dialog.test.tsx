import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { AddMemberDialog } from "./add-member-dialog"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const membersUrl = `/api/v1/workspaces/${workspace.id}/members`
const grace = {
  user_id: "0192f3a0-0000-7000-8000-000000000020",
  email: "grace@example.com",
  name: "Grace Hopper",
  role: "planner",
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const view = renderWithProviders(
    <AddMemberDialog workspaceId={workspace.id} open onOpenChange={onOpenChange} />,
  )
  return { ...view, onOpenChange }
}

async function openDialog() {
  return screen.findByRole("dialog", { name: "Add member" })
}

describe("AddMemberDialog", () => {
  it("defaults role to Planner", async () => {
    renderDialog()
    const dialog = await openDialog()

    expect(within(dialog).getByRole("combobox", { name: "Role" })).toHaveTextContent("Planner")
  })

  it("offers every role, most privileged first", async () => {
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByRole("combobox", { name: "Role" }))

    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([
      "Admin",
      "Builder",
      "Planner",
      "Viewer",
    ])
  })

  it("shows user_not_found under email", async () => {
    server.use(
      http.post(membersUrl, () =>
        problem(
          404,
          "user.not_found",
          "No user with that email. Ask an instance admin to create the account.",
        ),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Email"), "nobody@example.com")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    expect(
      await within(dialog).findByText(
        "No user with that email. Ask an instance admin to create the account.",
      ),
    ).toBeVisible()
    expect(within(dialog).getByLabelText("Email")).toBeInvalid()
    expect(within(dialog).getByLabelText("Email")).toHaveFocus()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "Add member" })).toBeVisible()
  })

  it("shows member_exists under email", async () => {
    server.use(
      http.post(membersUrl, () =>
        problem(409, "workspace.member_exists", "That user is already a member of this workspace."),
      ),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Email"), "grace@example.com")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    expect(
      await within(dialog).findByText("That user is already a member of this workspace."),
    ).toBeVisible()
    expect(within(dialog).getByLabelText("Email")).toBeInvalid()
  })

  it("asks for a valid email without sending a request", async () => {
    const attempts = vi.fn()
    server.use(
      http.post(membersUrl, () => {
        attempts()
        return HttpResponse.json(grace, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))
    expect(await within(dialog).findByText("Enter an email address.")).toBeVisible()

    await typist.type(within(dialog).getByLabelText("Email"), "not-an-email")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))
    expect(await within(dialog).findByText("Enter a valid email address.")).toBeVisible()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("adds the member with the chosen role and closes", async () => {
    const posted = vi.fn()
    server.use(
      http.post(membersUrl, async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ ...grace, role: "builder" }, { status: 201 })
      }),
      http.get(membersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Email"), "  Grace@Example.com ")
    await typist.click(within(dialog).getByRole("combobox", { name: "Role" }))
    await typist.click(await screen.findByRole("option", { name: "Builder" }))
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(posted).toHaveBeenCalledWith({ email: "Grace@Example.com", role: "builder" })
    expect(toast.success).toHaveBeenCalledWith("Grace Hopper added")
  })

  it("reports any other failure in a toast", async () => {
    server.use(http.post(membersUrl, () => problem(403, "auth.forbidden", "You can't do that.")))
    const typist = userEvent.setup()
    renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Email"), "grace@example.com")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't do that."))
  })

  it("can't be dismissed while the member is being added", async () => {
    server.use(
      http.post(membersUrl, async () => {
        await delay(300)
        return HttpResponse.json(grace, { status: 201 })
      }),
      http.get(membersUrl, () => HttpResponse.json([grace])),
    )
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.type(within(dialog).getByLabelText("Email"), "grace@example.com")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    const submit = within(dialog).getByRole("button", { name: "Add member" })
    expect(submit).toBeDisabled()
    expect(submit.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    await typist.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(onOpenChange).not.toHaveBeenCalled()

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("closes without adding anyone when Cancel is pressed", async () => {
    const typist = userEvent.setup()
    const { onOpenChange } = renderDialog()
    const dialog = await openDialog()
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
