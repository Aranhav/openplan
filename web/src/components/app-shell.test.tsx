import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  makeModel,
  me,
  meInTwoWorkspaces,
  mockSession,
  renderApp,
  serveModels,
  serveStructure,
  user,
  workspace,
} from "@/test/app"
import { server } from "@/test/server"
import { revenueModule, structure } from "@/test/structure"

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

  it("is a navigation landmark of its own, holding the workspace and instance links", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const sidebar = await findSidebar()
    const main = within(sidebar).getByRole("navigation", { name: "Main" })
    expect(
      within(main)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Models", "Members", "Users"])
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

  it("leaves Models to the Build navigation while you are in one of its models", async () => {
    mockSession()
    const model = makeModel()
    server.use(http.get(`/api/v1/models/${model.id}`, () => HttpResponse.json(model)))
    renderApp(`/m/${model.id}`)

    const workspaceNav = within(await screen.findByRole("navigation", { name: "Main" }))
    expect(await workspaceNav.findByRole("link", { name: "Models" })).toHaveAttribute(
      "data-active",
      "false",
    )
    const build = within(screen.getByRole("navigation", { name: "Build" }))
    expect(await build.findByRole("link", { name: "Modules" })).toHaveAttribute(
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

describe("the skip link", () => {
  it("is the first stop for the keyboard and moves focus to the page's content", async () => {
    mockSession()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    await findSidebar()
    await typist.tab()

    const skip = screen.getByRole("link", { name: "Skip to content" })
    expect(skip).toHaveFocus()
    expect(skip).toHaveClass("sr-only", "focus:not-sr-only")
    expect(skip).toHaveAttribute("href", "#content")
    await typist.keyboard("{Enter}")

    // Past the header too, which sits in <main> with the search button.
    const content = document.getElementById("content") as HTMLElement
    expect(content).toHaveFocus()
    expect(screen.getByRole("main")).toContainElement(content)
    expect(content).toContainElement(screen.getByRole("heading", { level: 1, name: "Models" }))
    expect(content).not.toContainElement(screen.getByRole("button", { name: /^Search/ }))
    // Following it is not a navigation: Back still leaves the page.
    expect(router.state.location.hash).toBe("")
  })
})

describe("the sidebar's saved state", () => {
  it("starts open", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    await findSidebar()
    expect(document.querySelector("[data-slot=sidebar]")).toHaveAttribute("data-state", "expanded")
  })

  it("starts collapsed when it was collapsed last time", async () => {
    document.cookie = "sidebar_state=false; path=/"
    mockSession()
    renderApp(`/w/${workspace.id}`)

    await findSidebar()
    expect(document.querySelector("[data-slot=sidebar]")).toHaveAttribute("data-state", "collapsed")
  })

  it("saves a collapse for next time", async () => {
    mockSession()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    await findSidebar()
    await typist.keyboard("{Control>}b{/Control}")

    await waitFor(() => expect(document.cookie).toContain("sidebar_state=false"))
  })
})

describe("the header", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it("keeps the workspace in view on a phone, where the sidebar is hidden", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    const workspaceCrumb = within(crumbs).getByRole("link", { name: "Acme Corp" }).closest("li")
    expect(workspaceCrumb?.className).not.toMatch(/\bhidden\b/)
  })

  it("names the model and the screen when you are in one", async () => {
    mockSession({ me: meInTwoWorkspaces })
    const model = makeModel({ name: "Revenue plan" })
    serveModels([model])
    renderApp(`/m/${model.id}/modules`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(await within(crumbs).findByRole("link", { name: "Revenue plan" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules`,
    )
    expect(within(crumbs).getByRole("link", { name: "Acme Corp" })).toBeInTheDocument()
    expect(within(crumbs).getByText("Modules")).toHaveAttribute("aria-current", "page")
  })

  it("names the settings of the model", async () => {
    mockSession()
    const model = makeModel({ name: "Revenue plan" })
    serveModels([model])
    renderApp(`/m/${model.id}/settings`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(await within(crumbs).findByRole("link", { name: "Revenue plan" })).toBeInTheDocument()
    expect(within(crumbs).getByText("Model settings")).toHaveAttribute("aria-current", "page")
  })

  it("names the module you are in after the modules", async () => {
    mockSession()
    const model = makeModel({ name: "Revenue plan" })
    serveModels([model])
    serveStructure(structure)
    renderApp(`/m/${model.id}/modules/${revenueModule.id}`)

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(
      await within(crumbs).findByText("Revenue", { selector: "[aria-current=page]" }),
    ).toBeVisible()
    expect(within(crumbs).getByRole("link", { name: "Modules" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules`,
    )
    expect(within(crumbs).getByRole("link", { name: "Revenue plan" })).toBeInTheDocument()
  })

  it.each([
    ["Win32", "Ctrl K", "Control+K"],
    ["MacIntel", "⌘K", "Meta+K"],
  ])("tells a %s keyboard the search shortcut", async (platform, hint, keys) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const search = await screen.findByRole("button", { name: /^Search/ })
    expect(search).toHaveTextContent(hint)
    expect(search).toHaveAttribute("aria-keyshortcuts", keys)
  })

  it("does not tie the profile to a workspace", async () => {
    mockSession()
    renderApp("/profile")

    const crumbs = await screen.findByRole("navigation", { name: "breadcrumb" })
    expect(within(crumbs).getByText("Profile")).toBeVisible()
    expect(within(crumbs).queryByRole("link", { name: "Acme Corp" })).not.toBeInTheDocument()
  })

  it("leaves the breadcrumb out for a workspace the user is not in", async () => {
    mockSession()
    renderApp("/w/0192f3a0-0000-7000-8000-0000000000ff")

    expect(await screen.findByRole("heading", { name: "Workspace not found" })).toBeVisible()
    expect(screen.queryByRole("navigation", { name: "breadcrumb" })).not.toBeInTheDocument()
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

  it("closes the sheet on a link to the page you are already on", async () => {
    window.innerWidth = 375
    mockSession()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    await typist.click(await screen.findByRole("button", { name: "Toggle Sidebar" }))
    const sheet = await screen.findByRole("dialog", { name: "Sidebar" })
    await typist.click(within(sheet).getByRole("link", { name: "Models" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe(`/w/${workspace.id}`)
  })
})
