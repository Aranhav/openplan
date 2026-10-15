import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { globex, me, meInTwoWorkspaces, mockSession, renderApp, user, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const initech = {
  id: "0192f3a0-0000-7000-8000-000000000004",
  name: "Initech",
  role: "admin" as const,
}

async function openSwitcher(typist: ReturnType<typeof userEvent.setup>) {
  await typist.click(await screen.findByRole("button", { name: /Acme Corp/ }))
  return screen.findByRole("menu")
}

describe("the workspace switcher", () => {
  it("shows the current workspace and the user's role in it", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const trigger = await screen.findByRole("button", { name: /Acme Corp/ })
    expect(trigger).toHaveTextContent("Admin")
  })

  it("lists the user's workspaces, each with a role badge", async () => {
    mockSession({ me: meInTwoWorkspaces })
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)

    const items = within(menu).getAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "Acme CorpAdmin",
      "GlobexViewer",
      "Create workspace",
    ])
  })

  it("switches workspace and remembers the choice", async () => {
    mockSession({ me: meInTwoWorkspaces })
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: /Globex/ }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${globex.id}`))
    const trigger = await screen.findByRole("button", { name: /Globex/ })
    expect(trigger).toHaveTextContent("Viewer")
    expect(window.localStorage.getItem("openplan.lastWorkspace")).toBe(globex.id)
  })

  it("lets an instance admin create a workspace and opens it", async () => {
    const session = mockSession()
    const created = vi.fn()
    server.use(
      http.post("/api/v1/workspaces", async ({ request }) => {
        created(await request.json())
        session.me = { ...session.me, workspaces: [...session.me.workspaces, initech] }
        return HttpResponse.json(initech, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Create workspace" }))
    const dialog = await screen.findByRole("dialog", { name: "Create workspace" })
    await typist.type(within(dialog).getByLabelText("Workspace name"), "  Initech ")
    await typist.click(within(dialog).getByRole("button", { name: "Create workspace" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${initech.id}`))
    expect(created).toHaveBeenCalledWith({ name: "Initech" })
    expect(toast.success).toHaveBeenCalledWith("Workspace created")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(await screen.findByRole("button", { name: /Initech/ })).toBeInTheDocument()
  })

  it("asks for a name without sending anything", async () => {
    mockSession()
    const attempts = vi.fn()
    server.use(
      http.post("/api/v1/workspaces", () => {
        attempts()
        return HttpResponse.json(initech, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Create workspace" }))
    const dialog = await screen.findByRole("dialog", { name: "Create workspace" })
    await typist.click(within(dialog).getByRole("button", { name: "Create workspace" }))

    expect(await within(dialog).findByText("Workspace name is required.")).toBeVisible()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("shows the server's complaint about the name under the field", async () => {
    mockSession()
    server.use(
      http.post("/api/v1/workspaces", () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "name", message: "Name must be at most 80 characters." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Create workspace" }))
    const dialog = await screen.findByRole("dialog", { name: "Create workspace" })
    await typist.type(within(dialog).getByLabelText("Workspace name"), "Initech")
    await typist.click(within(dialog).getByRole("button", { name: "Create workspace" }))

    expect(await within(dialog).findByText("Name must be at most 80 characters.")).toBeVisible()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("disables the button while the workspace is being created", async () => {
    mockSession()
    server.use(
      http.post("/api/v1/workspaces", async () => {
        await delay(300)
        return HttpResponse.json(initech, { status: 201 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Create workspace" }))
    const dialog = await screen.findByRole("dialog", { name: "Create workspace" })
    await typist.type(within(dialog).getByLabelText("Workspace name"), "Initech")
    await typist.click(within(dialog).getByRole("button", { name: "Create workspace" }))

    expect(within(dialog).getByRole("button", { name: "Create workspace" })).toBeDisabled()
  })

  it("does not offer workspace creation to anyone else", async () => {
    mockSession({ me: { ...me, user: { ...user, is_instance_admin: false } } })
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openSwitcher(typist)

    expect(within(menu).getByRole("menuitem", { name: /Acme Corp/ })).toBeVisible()
    expect(
      within(menu).queryByRole("menuitem", { name: "Create workspace" }),
    ).not.toBeInTheDocument()
  })
})
