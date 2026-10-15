import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { globex, me, meInTwoWorkspaces, mockSession, renderApp, user, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import type { components } from "@/lib/api/schema"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type MemberDto = components["schemas"]["MemberDto"]
type Role = MemberDto["role"]

const ada: MemberDto = { user_id: user.id, email: user.email, name: user.name, role: "admin" }
const grace: MemberDto = {
  user_id: "0192f3a0-0000-7000-8000-000000000020",
  email: "grace@example.com",
  name: "Grace Hopper",
  role: "planner",
}
const alan: MemberDto = {
  user_id: "0192f3a0-0000-7000-8000-000000000021",
  email: "alan@example.com",
  name: "Alan Turing",
  role: "viewer",
}

const membersUrl = `/api/v1/workspaces/${workspace.id}/members`
const pageUrl = `/w/${workspace.id}/members`

type Typist = ReturnType<typeof userEvent.setup>

/** Serves the member endpoints from a list that listing, changing and removing keep up to date. */
function serveMembers(initial: MemberDto[]) {
  const store = { members: initial, listed: 0 }
  server.use(
    http.get(membersUrl, () => {
      store.listed += 1
      return HttpResponse.json(store.members)
    }),
    http.patch(`${membersUrl}/:userId`, async ({ params, request }) => {
      const { role } = (await request.json()) as { role: Role }
      store.members = store.members.map((m) => (m.user_id === params.userId ? { ...m, role } : m))
      return HttpResponse.json(store.members.find((m) => m.user_id === params.userId))
    }),
    http.delete(`${membersUrl}/:userId`, ({ params }) => {
      store.members = store.members.filter((m) => m.user_id !== params.userId)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return store
}

/** The fixture's user is an instance admin; this is the same person as an ordinary member. */
const ordinaryMe = { ...me, user: { ...user, is_instance_admin: false } }

function signedInAs(role: Role) {
  return mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
}

async function rowOf(name: string) {
  return within(await screen.findByRole("row", { name: new RegExp(name) }))
}

async function chooseRole(typist: Typist, name: string, role: string) {
  await typist.click(await screen.findByRole("combobox", { name: `Role for ${name}` }))
  await typist.click(await screen.findByRole("option", { name: role }))
}

describe("the members page", () => {
  it("names the workspace and lists its members", async () => {
    mockSession()
    serveMembers([ada, grace, alan])
    renderApp(pageUrl)

    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeVisible()
    expect(screen.getByText("People who can access Acme Corp.")).toBeVisible()
    expect(document.title).toBe("Members · OpenPlan")
    const row = await rowOf("Grace Hopper")
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Email",
      "Role",
      "Actions",
    ])
    expect(row.getAllByText("grace@example.com").length).toBeGreaterThan(0)
    expect(row.getByRole("combobox", { name: "Role for Grace Hopper" })).toHaveTextContent(
      "Planner",
    )
  })

  it("marks the signed-in user's own row", async () => {
    mockSession()
    serveMembers([ada, grace])
    renderApp(pageUrl)

    expect((await rowOf("Ada Lovelace")).getByText("(you)")).toBeVisible()
    expect((await rowOf("Grace Hopper")).queryByText("(you)")).not.toBeInTheDocument()
  })

  it("names the table", async () => {
    mockSession()
    serveMembers([ada, grace])
    renderApp(pageUrl)

    expect(await screen.findByRole("table", { name: "Members" })).toBeVisible()
  })

  it.each([
    ["Remove Grace Hopper", "Remove member"],
    ["Leave workspace", "Leave workspace"],
  ])("explains the %s button in a tooltip", async (button, tip) => {
    mockSession()
    serveMembers([ada, grace])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.hover(await screen.findByRole("button", { name: button }))

    expect(await screen.findByRole("tooltip")).toHaveTextContent(tip)
  })

  it("shows placeholders, and no Add member button, while the members load", async () => {
    mockSession()
    server.use(
      http.get(membersUrl, async () => {
        await delay(100)
        return HttpResponse.json([ada, grace])
      }),
    )
    renderApp(pageUrl)

    const loading = await screen.findByRole("status", { name: "Loading members" })
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(6)
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument()
    const placeholderCells = loading.querySelectorAll("tbody tr:first-child td").length
    expect(await screen.findByText("Grace Hopper")).toBeVisible()
    // The placeholder has the columns of the table it stands in for.
    expect(screen.getByRole("row", { name: /Grace Hopper/ }).querySelectorAll("td")).toHaveLength(
      placeholderCells,
    )
    expect(screen.queryByRole("status", { name: "Loading members" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add member" })).toBeVisible()
  })

  it("offers a retry when the members cannot be loaded", async () => {
    mockSession()
    let failing = true
    server.use(
      http.get(membersUrl, () =>
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
      http.get(membersUrl, () =>
        failing ? problem(500, "internal", "Something broke.") : HttpResponse.json([ada, grace]),
      ),
    )
    const { queryClient } = renderApp(pageUrl)
    expect(await screen.findByText("Grace Hopper")).toBeVisible()
    failing = true
    await queryClient.invalidateQueries({ queryKey: ["workspaces", workspace.id, "members"] })

    expect(queryClient.getQueryState(["workspaces", workspace.id, "members"])?.status).toBe("error")
    expect(screen.getByText("Grace Hopper")).toBeVisible()
    expect(screen.queryByText("Something broke.")).not.toBeInTheDocument()
  })

  it("says so when the address names a workspace the user is not in", async () => {
    mockSession()
    renderApp("/w/0192f3a0-0000-7000-8000-0000000000ff/members")

    expect(await screen.findByRole("heading", { name: "Workspace not found" })).toBeVisible()
  })

  it.each(["builder", "planner", "viewer"] as const)(
    "shows a %s the roles as text and offers no way to change anyone",
    async (role) => {
      signedInAs(role)
      serveMembers([ada, grace])
      renderApp(pageUrl)

      const row = await rowOf("Grace Hopper")
      expect(row.getByText("Planner")).toBeVisible()
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument()
      expect(screen.getAllByRole("columnheader")).toHaveLength(3)
    },
  )

  it("adds a member from the header and lists them", async () => {
    mockSession()
    const store = serveMembers([ada])
    server.use(
      http.post(membersUrl, () => {
        store.members = [...store.members, grace]
        return HttpResponse.json(grace, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Add member" }))
    const dialog = await screen.findByRole("dialog", { name: "Add member" })
    await typist.type(within(dialog).getByLabelText("Email"), "grace@example.com")
    await typist.click(within(dialog).getByRole("button", { name: "Add member" }))

    expect(await screen.findByText("Grace Hopper")).toBeVisible()
    expect(toast.success).toHaveBeenCalledWith("Grace Hopper added")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Add member" })).toHaveFocus()
  })

  it("changes a member's role", async () => {
    mockSession()
    serveMembers([ada, grace])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Grace Hopper", "Builder")

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Role updated"))
    expect(screen.getByRole("combobox", { name: "Role for Grace Hopper" })).toHaveTextContent(
      "Builder",
    )
  })

  it("keeps the role select enabled while saving, and ignores another choice until it is done", async () => {
    mockSession()
    const store = serveMembers([ada, grace])
    const patched = vi.fn()
    let finish!: () => void
    const saving = new Promise<void>((resolve) => {
      finish = resolve
    })
    server.use(
      http.patch(`${membersUrl}/${grace.user_id}`, async ({ request }) => {
        patched(await request.json())
        await saving
        store.members = [ada, { ...grace, role: "builder" }]
        return HttpResponse.json({ ...grace, role: "builder" })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Grace Hopper", "Builder")

    const select = screen.getByRole("combobox", { name: "Role for Grace Hopper" })
    expect(select).toBeEnabled()
    expect(select).toHaveTextContent("Builder")
    expect(select.parentElement?.querySelector("svg.animate-spin")).toBeInTheDocument()
    await chooseRole(typist, "Grace Hopper", "Viewer")
    finish()

    await waitFor(() => expect(toast.success).toHaveBeenCalledOnce())
    expect(patched).toHaveBeenCalledExactlyOnceWith({ role: "builder" })
    expect(screen.getByRole("combobox", { name: "Role for Grace Hopper" })).toHaveTextContent(
      "Builder",
    )
  })

  it("asks before you change your own role, and changes nothing if you cancel", async () => {
    mockSession()
    const patched = vi.fn()
    serveMembers([ada, grace])
    server.use(
      http.patch(`${membersUrl}/${user.id}`, () => {
        patched()
        return HttpResponse.json(ada)
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Ada Lovelace", "Viewer")
    const dialog = await screen.findByRole("alertdialog", { name: "Change your own role?" })
    expect(
      within(dialog).getByText("You may lose the ability to manage this workspace."),
    ).toBeVisible()
    expect(patched).not.toHaveBeenCalled()
    // The page behind the dialog is hidden from assistive technology, but still shows the saved role.
    expect(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace", hidden: true }),
    ).toHaveTextContent("Admin")
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(patched).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox", { name: "Role for Ada Lovelace" })).toHaveFocus()
  })

  it("puts the role back and shows the server's reason when the last admin is demoted", async () => {
    mockSession()
    serveMembers([ada, grace])
    server.use(
      http.patch(`${membersUrl}/${user.id}`, () =>
        problem(409, "workspace.last_admin", "A workspace needs at least one admin."),
      ),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Ada Lovelace", "Viewer")
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Change role" }),
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A workspace needs at least one admin."),
    )
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    const select = screen.getByRole("combobox", { name: "Role for Ada Lovelace" })
    expect(select).toHaveTextContent("Admin")
    expect(select).toHaveFocus()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("can't be dismissed while your own role is being changed", async () => {
    mockSession()
    serveMembers([ada, grace])
    server.use(
      http.patch(`${membersUrl}/${user.id}`, async () => {
        await delay(300)
        return HttpResponse.json({ ...ada, role: "builder" })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Ada Lovelace", "Builder")
    const dialog = await screen.findByRole("alertdialog", { name: "Change your own role?" })
    await typist.click(within(dialog).getByRole("button", { name: "Change role" }))

    const confirm = within(dialog).getByRole("button", { name: "Change role" })
    expect(confirm).toBeDisabled()
    expect(confirm.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog")).toBeVisible()

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("lets an admin demote themselves, then shows the page as read-only with focus on its heading", async () => {
    const session = mockSession()
    const store = serveMembers([ada, grace])
    server.use(
      http.patch(`${membersUrl}/${user.id}`, () => {
        store.members = [{ ...ada, role: "builder" }, grace]
        session.me = { ...me, workspaces: [{ ...workspace, role: "builder" }] }
        return HttpResponse.json({ ...ada, role: "builder" })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await chooseRole(typist, "Ada Lovelace", "Builder")
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Change role" }),
    )

    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument())
    expect(await (await rowOf("Ada Lovelace")).findByText("Builder")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith("Role updated")
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Members" })).toHaveFocus(),
    )
  })

  it("asks before removing a member, then takes them off the list", async () => {
    mockSession()
    serveMembers([ada, grace, alan])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Remove Grace Hopper" }))
    const dialog = await screen.findByRole("alertdialog", {
      name: "Remove Grace Hopper from Acme Corp?",
    })
    expect(
      within(dialog).getByText(
        "Grace Hopper will lose access to this workspace and its models. You can add them again later.",
      ),
    ).toBeVisible()
    await typist.click(within(dialog).getByRole("button", { name: "Remove member" }))

    await waitFor(() => expect(screen.queryByText("Grace Hopper")).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith("Grace Hopper removed")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByText("Alan Turing")).toBeVisible()
  })

  it("moves focus to the next row once a member is removed", async () => {
    mockSession()
    serveMembers([ada, grace, alan])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Remove Grace Hopper" }))
    await typist.click(await screen.findByRole("button", { name: "Remove member" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Alan Turing" })).toHaveFocus(),
    )
  })

  it("moves focus to the previous row when the last one is removed", async () => {
    mockSession()
    serveMembers([ada, grace, alan])
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Remove Alan Turing" }))
    await typist.click(await screen.findByRole("button", { name: "Remove member" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Grace Hopper" })).toHaveFocus(),
    )
  })

  it("keeps the member and returns focus to the button when the removal is cancelled", async () => {
    mockSession()
    const removed = vi.fn()
    serveMembers([ada, grace])
    server.use(
      http.delete(`${membersUrl}/${grace.user_id}`, () => {
        removed()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    const button = await screen.findByRole("button", { name: "Remove Grace Hopper" })
    await typist.click(button)
    const dialog = await screen.findByRole("alertdialog")
    await typist.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(removed).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  it("keeps the dialog open and says why when the last admin leaves", async () => {
    mockSession()
    serveMembers([ada, grace])
    server.use(
      http.delete(`${membersUrl}/${user.id}`, () =>
        problem(409, "workspace.last_admin", "A workspace needs at least one admin."),
      ),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Leave workspace" }))
    const dialog = await screen.findByRole("alertdialog")
    await typist.click(within(dialog).getByRole("button", { name: "Leave workspace" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A workspace needs at least one admin."),
    )
    expect(screen.getByRole("alertdialog")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Leave workspace" })).toBeEnabled()
  })

  it("can't be dismissed while the member is being removed", async () => {
    mockSession()
    serveMembers([ada, grace])
    server.use(
      http.delete(`${membersUrl}/${grace.user_id}`, async () => {
        await delay(300)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Remove Grace Hopper" }))
    const dialog = await screen.findByRole("alertdialog")
    await typist.click(within(dialog).getByRole("button", { name: "Remove member" }))

    const confirm = within(dialog).getByRole("button", { name: "Remove member" })
    expect(confirm).toBeDisabled()
    expect(confirm.querySelector("svg.animate-spin")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()
    await typist.keyboard("{Escape}")
    expect(screen.getByRole("alertdialog")).toBeVisible()

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
  })

  it("lets an instance admin leave a workspace without being sent away", async () => {
    mockSession()
    serveMembers([ada, grace, alan])
    const typist = userEvent.setup()
    const { router } = renderApp(pageUrl)
    expect(await screen.findByRole("button", { name: "Remove Grace Hopper" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Remove Ada Lovelace" })).not.toBeInTheDocument()
    await typist.click(screen.getByRole("button", { name: "Leave workspace" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Leave Acme Corp?" })
    expect(
      within(dialog).getByText(
        "You'll stay an instance admin, so you can still open this workspace.",
      ),
    ).toBeVisible()
    await typist.click(within(dialog).getByRole("button", { name: "Leave workspace" }))

    await waitFor(() => expect(screen.queryByText("(you)")).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith("You left Acme Corp")
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe(pageUrl)
    expect(screen.getByRole("heading", { level: 1, name: "Members" })).toBeVisible()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Grace Hopper" })).toHaveFocus(),
    )
  })

  it("takes the user home after they leave their only workspace", async () => {
    const session = mockSession({ me: ordinaryMe })
    const store = serveMembers([ada, grace])
    server.use(
      http.delete(`${membersUrl}/${user.id}`, () => {
        store.members = [grace]
        session.me = { ...ordinaryMe, workspaces: [] }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Leave workspace" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Leave Acme Corp?" })
    expect(
      within(dialog).getByText(
        "You'll lose access to this workspace and its models. Another admin can add you back.",
      ),
    ).toBeVisible()
    await typist.click(within(dialog).getByRole("button", { name: "Leave workspace" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
    expect(
      await screen.findByRole("heading", { name: "You're not in any workspace yet" }),
    ).toBeVisible()
    expect(toast.success).toHaveBeenCalledWith("You left Acme Corp")
  })

  it("moves a user who leaves a workspace to another one without ever saying not found", async () => {
    const session = mockSession({ me: { ...ordinaryMe, workspaces: meInTwoWorkspaces.workspaces } })
    const store = serveMembers([ada, grace])
    server.use(
      http.delete(`${membersUrl}/${user.id}`, () => {
        store.members = [grace]
        session.me = { ...ordinaryMe, workspaces: [globex] }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(pageUrl)
    await typist.click(await screen.findByRole("button", { name: "Leave workspace" }))
    const listedBefore = store.listed
    let sawNotFound = false
    const watcher = new MutationObserver(() => {
      sawNotFound ||= /not found/i.test(document.body.textContent ?? "")
    })
    watcher.observe(document.body, { childList: true, subtree: true, characterData: true })
    await typist.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Leave workspace",
      }),
    )

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${globex.id}`))
    await waitFor(() => expect(session.meRequests).toBeGreaterThan(1))
    expect(await screen.findByText("Planning models in Globex.")).toBeVisible()
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Models" })).toHaveFocus(),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    watcher.disconnect()
    expect(sawNotFound).toBe(false)
    expect(store.listed).toBe(listedBefore)
    expect(toast.success).toHaveBeenCalledWith("You left Acme Corp")
  })
})
