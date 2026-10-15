import { screen, waitFor } from "@testing-library/react"
import { HttpResponse, delay, http } from "msw"
import { describe, expect, it } from "vitest"
import {
  globex,
  makeModel,
  me,
  meInTwoWorkspaces,
  mockSession,
  renderApp,
  workspace,
} from "@/test/app"
import { server } from "@/test/server"

const LAST_WORKSPACE_KEY = "openplan.lastWorkspace"

describe("the current workspace", () => {
  it("is the one in the address", async () => {
    mockSession({ me: meInTwoWorkspaces })
    window.localStorage.setItem(LAST_WORKSPACE_KEY, workspace.id)
    renderApp(`/w/${globex.id}/members`)

    expect(await screen.findByRole("button", { name: /Globex/ })).toBeInTheDocument()
  })

  it("is the one a model belongs to, without first showing another", async () => {
    mockSession({ me: meInTwoWorkspaces })
    const model = makeModel({ workspace_id: globex.id })
    server.use(
      http.get(`/api/v1/models/${model.id}`, async () => {
        await delay(200)
        return HttpResponse.json(model)
      }),
    )
    renderApp(`/m/${model.id}`)

    await waitFor(() => expect(screen.getByRole("heading", { name: "Model" })).toBeVisible())
    expect(screen.queryByRole("button", { name: /Acme Corp/ })).not.toBeInTheDocument()
    expect(await screen.findByRole("button", { name: /Globex/ })).toBeInTheDocument()
  })

  it("is remembered for the next visit once you open it", async () => {
    mockSession({ me: meInTwoWorkspaces })
    renderApp(`/w/${globex.id}`)

    await screen.findByRole("button", { name: /Globex/ })
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe(globex.id)
  })

  it("is the last one used when you arrive at the home page", async () => {
    mockSession({ me: meInTwoWorkspaces })
    window.localStorage.setItem(LAST_WORKSPACE_KEY, globex.id)
    const { router } = renderApp("/")

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${globex.id}`))
    expect(router.history.length).toBe(1)
  })

  it("is the last one used when you go home from inside the app", async () => {
    mockSession({ me: meInTwoWorkspaces })
    window.localStorage.setItem(LAST_WORKSPACE_KEY, globex.id)
    const { router } = renderApp("/profile")
    await screen.findByRole("heading", { level: 1, name: "Profile" })
    await router.navigate({ to: "/" })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${globex.id}`))
  })

  it("is the first one when none was used, or the one used is gone", async () => {
    mockSession({ me: meInTwoWorkspaces })
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "0192f3a0-0000-7000-8000-0000000000ff")
    const { router } = renderApp("/")

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}`))
  })

  it("is nothing when the address names a workspace the user is not in", async () => {
    mockSession({ me: meInTwoWorkspaces })
    window.localStorage.setItem(LAST_WORKSPACE_KEY, globex.id)
    renderApp("/w/0192f3a0-0000-7000-8000-0000000000ff")

    expect(await screen.findByRole("button", { name: /No workspace/ })).toBeVisible()
    expect(screen.queryByRole("button", { name: /Globex/ })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe(globex.id)
  })

  it("is nothing for someone who belongs to no workspace", async () => {
    mockSession({ me: { ...me, workspaces: [] } })
    const { router } = renderApp("/")

    expect(
      await screen.findByRole("heading", { level: 1, name: "You're not in any workspace yet" }),
    ).toBeVisible()
    expect(screen.getByText("Ask an admin to add you to a workspace.")).toBeVisible()
    expect(document.title).toBe("No workspace · OpenPlan")
    expect(screen.getByRole("button", { name: /No workspace/ })).toBeVisible()
    expect(router.state.location.pathname).toBe("/")
  })
})
