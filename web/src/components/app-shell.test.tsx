import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it } from "vitest"
import {
  makeModel,
  me,
  meInTwoWorkspaces,
  mockSession,
  renderApp,
  user,
  workspace,
} from "@/test/app"
import { server } from "@/test/server"

const nonAdmin = { ...me, user: { ...user, is_instance_admin: false } }

async function findSidebar() {
  await screen.findByText("Workspace")
  return document.querySelector<HTMLElement>("[data-sidebar=sidebar]")!
}

describe("the sidebar", () => {
  it("links to the models and members of the current workspace", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const nav = await findSidebar()
    expect(within(nav).getByRole("link", { name: "Models" })).toHaveAttribute(
      "href",
      `/w/${workspace.id}`,
    )
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute(
      "href",
      `/w/${workspace.id}/members`,
    )
    expect(within(nav).getByText("Workspace")).toBeVisible()
  })

  it("links instance admins to the user list", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const nav = await findSidebar()
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users")
    expect(within(nav).getByText("Instance")).toBeVisible()
  })

  it("hides the instance pages from everyone else", async () => {
    mockSession({ me: nonAdmin })
    renderApp(`/w/${workspace.id}`)

    const nav = await findSidebar()
    expect(within(nav).queryByRole("link", { name: "Users" })).not.toBeInTheDocument()
    expect(within(nav).queryByText("Instance")).not.toBeInTheDocument()
  })

  it("highlights the page you are on", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}/members`)

    const nav = await findSidebar()
    const members = within(nav).getByRole("link", { name: "Members" })
    expect(members).toHaveAttribute("aria-current", "page")
    expect(members).toHaveAttribute("data-active", "true")
    expect(within(nav).getByRole("link", { name: "Models" })).toHaveAttribute(
      "data-active",
      "false",
    )
  })

  it("keeps Models highlighted while you are in one of its models", async () => {
    mockSession()
    const model = makeModel()
    server.use(http.get(`/api/v1/models/${model.id}`, () => HttpResponse.json(model)))
    renderApp(`/m/${model.id}`)

    expect(await screen.findByRole("link", { name: "Models" })).toHaveAttribute(
      "data-active",
      "true",
    )
  })

  it("shows who is signed in at the bottom", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    expect(within(await findSidebar()).getByText(user.email)).toBeVisible()
  })
})

describe("the header", () => {
  it("names the workspace and the page", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}/members`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(within(crumbs).getByRole("link", { name: "Acme Corp" })).toHaveAttribute(
      "href",
      `/w/${workspace.id}`,
    )
    expect(within(crumbs).getByText("Members")).toHaveAttribute("aria-current", "page")
  })

  it("names the model when you are in one", async () => {
    mockSession({ me: meInTwoWorkspaces })
    const model = makeModel({ name: "Revenue plan" })
    server.use(http.get(`/api/v1/models/${model.id}`, () => HttpResponse.json(model)))
    renderApp(`/m/${model.id}`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(await within(crumbs).findByText("Revenue plan")).toHaveAttribute("aria-current", "page")
    expect(within(crumbs).getByRole("link", { name: "Acme Corp" })).toBeInTheDocument()
  })

  it("does not tie the profile to a workspace", async () => {
    mockSession()
    renderApp("/profile")

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(within(crumbs).getByText("Profile")).toBeVisible()
    expect(within(crumbs).queryByRole("link", { name: "Acme Corp" })).not.toBeInTheDocument()
  })

  it("titles the browser tab after the page", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}/members`)

    await screen.findByRole("heading", { name: "Members" })
    expect(document.title).toBe("Members · OpenPlan")
  })
})

describe("on a phone", () => {
  const desktopWidth = window.innerWidth

  afterEach(() => {
    window.innerWidth = desktopWidth
  })

  it("opens the sidebar as a sheet and closes it once you move on", async () => {
    window.innerWidth = 375
    mockSession()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    await typist.click(await screen.findByRole("button", { name: "Toggle Sidebar" }))
    const sheet = await screen.findByRole("dialog", { name: "Sidebar" })
    await typist.click(within(sheet).getByRole("link", { name: "Members" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}/members`))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
