import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import type { components } from "@/lib/api/schema"
import { me, mockSession, renderApp, user } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { spinning } from "@/test/spinning"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type UserDto = components["schemas"]["UserDto"]

const ada: UserDto = {
  id: user.id,
  email: user.email,
  name: user.name,
  is_instance_admin: true,
  disabled: false,
  created_at: "2026-10-01T09:00:00Z",
}
const grace: UserDto = {
  id: "0192f3a0-0000-7000-8000-000000000020",
  email: "grace@example.com",
  name: "Grace Hopper",
  is_instance_admin: false,
  disabled: false,
  created_at: "2026-10-02T09:00:00Z",
}
const alan: UserDto = {
  id: "0192f3a0-0000-7000-8000-000000000021",
  email: "alan@example.com",
  name: "Alan Turing",
  is_instance_admin: false,
  disabled: true,
  created_at: "2026-10-03T09:00:00Z",
}

const usersUrl = "/api/v1/users"
const pageUrl = "/admin/users"

type Typist = ReturnType<typeof userEvent.setup>

/** Serves the user endpoints from a list that listing, creating and updating keep up to date. */
function serveUsers(initial: UserDto[]) {
  const store = { users: initial }
  server.use(
    http.get(usersUrl, () => HttpResponse.json(store.users)),
    http.post(usersUrl, async ({ request }) => {
      const body = (await request.json()) as Pick<UserDto, "name" | "email" | "is_instance_admin">
      const created = { ...grace, ...body, id: "0192f3a0-0000-7000-8000-000000000099" }
      store.users = [...store.users, created]
      return HttpResponse.json(created, { status: 201 })
    }),
    http.patch(`${usersUrl}/:id`, async ({ params, request }) => {
      const body = (await request.json()) as Partial<UserDto>
      store.users = store.users.map((u) => (u.id === params.id ? { ...u, ...body } : u))
      return HttpResponse.json(store.users.find((u) => u.id === params.id))
    }),
  )
  return store
}

async function rowOf(name: string) {
  return within(await screen.findByRole("row", { name: new RegExp(name) }))
}

async function openMenu(typist: Typist, name: string) {
  await typist.click(await screen.findByRole("button", { name: `Actions for ${name}` }))
  return within(await screen.findByRole("menu"))
}

describe("the users page", () => {
  it("lists every user with their role and status", async () => {
    mockSession()
    serveUsers([ada, grace, alan])
    renderApp(pageUrl)

    expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeVisible()
    expect(document.title).toBe("Users · OpenPlan")
    const first = await rowOf("Ada Lovelace")
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Email",
      "Role",
      "Status",
      "Actions",
    ])
    // Narrow screens show the email and badges under the name instead of in columns.
    expect(first.getAllByText("Instance admin")).toHaveLength(2)
    expect(first.getAllByText("Active")).toHaveLength(2)
    expect(first.getByText("(you)")).toBeVisible()
    const second = await rowOf("Grace Hopper")
    expect(second.queryByText("Instance admin")).not.toBeInTheDocument()
    expect(second.getAllByText("Member")).toHaveLength(2)
    expect(second.getAllByText("Active")).toHaveLength(2)
    expect((await rowOf("Alan Turing")).getAllByText("Disabled")).toHaveLength(2)
  })

  it("names the table", async () => {
    mockSession()
    serveUsers([ada, grace])
    renderApp(pageUrl)

    expect(await screen.findByRole("table", { name: "Users" })).toBeVisible()
  })

  it("tells anyone who isn't an instance admin they have no access, without asking for users", async () => {
    const asked = vi.fn()
    mockSession({ me: { ...me, user: { ...user, is_instance_admin: false } } })
    server.use(
      http.get(usersUrl, () => {
        asked()
        return HttpResponse.json([])
      }),
    )
    renderApp(pageUrl)

    expect(
      await screen.findByRole("heading", { level: 1, name: "You don't have access to this page" }),
    ).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/")
    expect(asked).not.toHaveBeenCalled()
  })

  it("shows placeholders, and no New user button, while the users load", async () => {
    mockSession()
    server.use(
      http.get(usersUrl, async () => {
        await delay(100)
        return HttpResponse.json([ada, grace])
      }),
    )
    renderApp(pageUrl)

    const loading = await screen.findByRole("status", { name: "Loading users" })
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(8)
    expect(screen.queryByRole("button", { name: "New user" })).not.toBeInTheDocument()
    const placeholderCells = loading.querySelectorAll("tbody tr:first-child td").length
    expect(await screen.findByText("Grace Hopper")).toBeVisible()
    // The placeholder has the columns of the table it stands in for.
    expect(screen.getByRole("row", { name: /Grace Hopper/ }).querySelectorAll("td")).toHaveLength(
      placeholderCells,
    )
    expect(screen.queryByRole("status", { name: "Loading users" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New user" })).toBeVisible()
  })

  it("offers a retry when the users cannot be loaded", async () => {
    mockSession()
    let failing = true
    server.use(
      http.get(usersUrl, () =>
        failing ? problem(500, "internal", "Something broke.") : HttpResponse.json([ada, grace]),
      ),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)

    expect(await screen.findByText("Something broke.")).toBeVisible()
    failing = false
    await typist.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Grace Hopper")).toBeVisible()
  })

  it("keeps the table when a refresh in the background fails", async () => {
    mockSession()
    let failing = false
    server.use(
      http.get(usersUrl, () =>
        failing ? problem(500, "internal", "Something broke.") : HttpResponse.json([ada, grace]),
      ),
    )
    const { queryClient } = renderApp(pageUrl)
    expect(await screen.findByText("Grace Hopper")).toBeVisible()
    failing = true
    await queryClient.invalidateQueries({ queryKey: ["users"] })

    expect(queryClient.getQueryState(["users"])?.status).toBe("error")
    expect(screen.getByText("Grace Hopper")).toBeVisible()
    expect(screen.queryByText("Something broke.")).not.toBeInTheDocument()
  })

  it("creates a user from the New user button and lists them", async () => {
    mockSession()
    serveUsers([ada])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "New user" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Create user" }))
    await typist.type(dialog.getByLabelText("Name"), "Katherine Johnson")
    await typist.type(dialog.getByLabelText("Email"), "katherine@example.com")
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Create user" }))

    expect(await screen.findByText("Katherine Johnson")).toBeVisible()
    expect(toast.success).toHaveBeenCalledWith("Katherine Johnson created")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "New user" })).toHaveFocus()
  })

  it("edits a user's name from the row menu", async () => {
    mockSession()
    serveUsers([ada, grace])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Edit" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Edit user" }))
    await typist.clear(dialog.getByLabelText("Name"))
    await typist.type(dialog.getByLabelText("Name"), "Grace B. Hopper")
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    expect(await screen.findByText("Grace B. Hopper")).toBeVisible()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Actions for Grace B. Hopper" })).toHaveFocus()
  })

  it("updates the name in the sidebar when users edit their own", async () => {
    mockSession()
    serveUsers([ada, grace])
    server.use(
      http.get("/api/v1/auth/me", () =>
        HttpResponse.json({ ...me, user: { ...user, name: "Ada L." } }),
      ),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Ada Lovelace")
    await typist.click(menu.getByRole("menuitem", { name: "Edit" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Edit user" }))
    await typist.clear(dialog.getByLabelText("Name"))
    await typist.type(dialog.getByLabelText("Name"), "Ada L.")
    await typist.click(dialog.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(await screen.findAllByText("Ada L.")).not.toHaveLength(0)
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument()
  })

  it("keeps what is typed while the user changes elsewhere, and shows fresh values otherwise", async () => {
    mockSession()
    const store = serveUsers([ada, grace])
    const typist = userEvent.setup()
    const { queryClient } = renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Edit" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Edit user" }))
    const checkbox = dialog.getByRole("checkbox", { name: /Instance admin/ })
    expect(checkbox).not.toBeChecked()

    store.users = [ada, { ...grace, name: "Grace M. Hopper", is_instance_admin: true }]
    await queryClient.invalidateQueries({ queryKey: ["users"] })
    await waitFor(() => expect(dialog.getByLabelText("Name")).toHaveValue("Grace M. Hopper"))
    expect(checkbox).toBeChecked()

    await typist.clear(dialog.getByLabelText("Name"))
    await typist.type(dialog.getByLabelText("Name"), "Grace Brewster")
    store.users = [ada, { ...grace, name: "Rear Admiral Hopper", is_instance_admin: false }]
    await queryClient.invalidateQueries({ queryKey: ["users"] })
    await waitFor(() => expect(checkbox).not.toBeChecked())
    expect(dialog.getByLabelText("Name")).toHaveValue("Grace Brewster")
  })

  it("resets a password from the row menu", async () => {
    mockSession()
    serveUsers([ada, grace])
    const patched = vi.fn()
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json(grace)
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Reset password" }))
    const dialog = within(await screen.findByRole("dialog", { name: "Reset password" }))
    await typist.type(dialog.getByLabelText("Temporary password"), "correct-horse-battery")
    await typist.click(dialog.getByRole("button", { name: "Reset password" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(patched).toHaveBeenCalledExactlyOnceWith({ password: "correct-horse-battery" })
    expect(toast.success).toHaveBeenCalledWith("Password reset")
    expect(screen.getByRole("button", { name: "Actions for Grace Hopper" })).toHaveFocus()
  })

  it("asks before disabling a user, then marks them disabled", async () => {
    mockSession()
    serveUsers([ada, grace])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Disable" }))
    const dialog = within(await screen.findByRole("alertdialog", { name: "Disable Grace Hopper?" }))
    expect(
      dialog.getByText(
        "Grace Hopper will be signed out everywhere and can't sign in until you enable the account again.",
      ),
    ).toBeVisible()
    await typist.click(dialog.getByRole("button", { name: "Disable user" }))

    await waitFor(() =>
      expect(screen.getByRole("row", { name: /Grace Hopper/ })).toHaveTextContent("Disabled"),
    )
    expect(toast.success).toHaveBeenCalledWith("Grace Hopper disabled")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Actions for Grace Hopper" })).toHaveFocus()
  })

  it("keeps the user active when the disabling is cancelled", async () => {
    mockSession()
    const patched = vi.fn()
    serveUsers([ada, grace])
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, () => {
        patched()
        return HttpResponse.json(grace)
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Disable" }))
    const dialog = within(await screen.findByRole("alertdialog"))
    await typist.click(dialog.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(patched).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Actions for Grace Hopper" })).toHaveFocus()
  })

  it("can't be dismissed while the user is being disabled", async () => {
    mockSession()
    serveUsers([ada, grace])
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, async () => {
        await delay(300)
        return HttpResponse.json({ ...grace, disabled: true })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Disable" }))
    const dialog = within(await screen.findByRole("alertdialog"))
    await typist.click(dialog.getByRole("button", { name: "Disable user" }))

    const confirm = dialog.getByRole("button", { name: "Disable user" })
    expect(confirm).toBeDisabled()
    expect(spinning(confirm)).toBe(true)
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog")).toBeVisible()

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("keeps the dialog open and says why a user could not be disabled", async () => {
    mockSession()
    serveUsers([ada, grace])
    server.use(
      http.patch(`${usersUrl}/${grace.id}`, () =>
        problem(403, "auth.forbidden", "You can't do that."),
      ),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Grace Hopper")
    await typist.click(menu.getByRole("menuitem", { name: "Disable" }))
    const dialog = within(await screen.findByRole("alertdialog"))
    await typist.click(dialog.getByRole("button", { name: "Disable user" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can't do that."))
    expect(screen.getByRole("alertdialog")).toBeVisible()
    expect(dialog.getByRole("button", { name: "Disable user" })).toBeEnabled()
  })

  it("enables a disabled user straight away", async () => {
    mockSession()
    const store = serveUsers([ada, alan])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Alan Turing")
    expect(menu.queryByRole("menuitem", { name: "Disable" })).not.toBeInTheDocument()
    await typist.click(menu.getByRole("menuitem", { name: "Enable" }))

    await waitFor(() =>
      expect(screen.getByRole("row", { name: /Alan Turing/ })).toHaveTextContent("Active"),
    )
    expect(store.users.find((u) => u.id === alan.id)?.disabled).toBe(false)
    expect(toast.success).toHaveBeenCalledWith("Alan Turing enabled")
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Actions for Alan Turing" })).toHaveFocus()
  })

  it("shows a spinner on Enable while it is saving, and reports a failure", async () => {
    mockSession()
    serveUsers([ada, alan])
    server.use(
      http.patch(`${usersUrl}/${alan.id}`, async () => {
        await delay(200)
        return problem(500, "internal", "Something broke.")
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Alan Turing")
    await typist.click(menu.getByRole("menuitem", { name: "Enable" }))

    const item = screen.getByRole("menuitem", { name: "Enable" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    expect(spinning(item)).toBe(true)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Something broke."))
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Enable" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    )
  })

  it("offers nothing but Edit on the signed-in user's own row", async () => {
    mockSession()
    serveUsers([ada, grace])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const menu = await openMenu(typist, "Ada Lovelace")

    expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit"])
  })
})
