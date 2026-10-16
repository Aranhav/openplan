import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import {
  makeModel,
  mockSession,
  renderApp,
  serveModels,
  serveStructure,
  workspace,
} from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import {
  costsModule,
  makeStructure,
  pricingModule,
  revenueModule,
  structure,
} from "@/test/structure"

const model = makeModel()
const structureUrl = `/api/v1/models/${model.id}/structure`

function openApp(path = `/m/${model.id}/modules`) {
  mockSession()
  serveModels([model])
  serveStructure(structure)
  return renderApp(path)
}

async function findBuildNav() {
  return within(await screen.findByRole("navigation", { name: "Build" }))
}

/** The nav once the modules have arrived. */
async function findLoadedNav() {
  const nav = await findBuildNav()
  await nav.findByRole("link", { name: "Pricing" })
  return nav
}

describe("the build navigation", () => {
  it("links to the modules and the settings of the model", async () => {
    openApp()

    const nav = await findBuildNav()
    expect(nav.getByText("Structure")).toBeVisible()
    expect(nav.getByRole("link", { name: "Modules" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules`,
    )
    expect(nav.getByRole("link", { name: "Model settings" })).toHaveAttribute(
      "href",
      `/m/${model.id}/settings`,
    )
  })

  it("lists the modules outside any functional area first, then the areas with theirs", async () => {
    openApp()

    const nav = await findLoadedNav()
    expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Modules",
      "Pricing",
      "Headcount",
      "Revenue",
      "Costs",
      "Hiring plan",
      "Model settings",
    ])
    expect(nav.getByRole("link", { name: "Revenue" })).toHaveAttribute(
      "href",
      `/m/${model.id}/modules/${revenueModule.id}`,
    )
    const order = nav
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter(Boolean)
    expect(order).toEqual(["Toggle modules", "Finance", "People"])
  })

  it("folds the modules of a functional area away and back", async () => {
    const typist = userEvent.setup()
    openApp()
    const nav = await findLoadedNav()
    const finance = nav.getByRole("button", { name: "Finance" })
    expect(finance).toHaveAttribute("aria-expanded", "true")
    await typist.click(finance)

    expect(finance).toHaveAttribute("aria-expanded", "false")
    expect(nav.queryByRole("link", { name: "Revenue" })).not.toBeInTheDocument()
    expect(nav.queryByRole("link", { name: "Costs" })).not.toBeInTheDocument()
    expect(nav.getByRole("link", { name: "Hiring plan" })).toBeVisible()
    await typist.click(finance)

    expect(nav.getByRole("link", { name: "Revenue" })).toBeVisible()
  })

  it("folds every module away from the toggle beside Modules", async () => {
    const typist = userEvent.setup()
    openApp()
    const nav = await findLoadedNav()
    await typist.click(nav.getByRole("button", { name: "Toggle modules" }))

    expect(nav.queryByRole("link", { name: "Pricing" })).not.toBeInTheDocument()
    expect(nav.queryByRole("button", { name: "Finance" })).not.toBeInTheDocument()
    expect(nav.getByRole("link", { name: "Modules" })).toBeVisible()
  })

  it("has no toggle or list under Modules in a model without modules", async () => {
    mockSession()
    serveModels([model])
    serveStructure(makeStructure())
    renderApp(`/m/${model.id}/settings`)

    const nav = await findBuildNav()
    await waitFor(() =>
      expect(nav.queryByRole("status", { name: "Loading modules" })).not.toBeInTheDocument(),
    )
    expect(nav.getByRole("link", { name: "Modules" })).toBeVisible()
    expect(nav.queryByRole("button", { name: "Toggle modules" })).not.toBeInTheDocument()
    expect(document.querySelector("[data-sidebar=menu-sub]")).toBeNull()
  })

  it("highlights Modules on the list of modules and no module", async () => {
    openApp()

    const nav = await findLoadedNav()
    expect(nav.getByRole("link", { name: "Modules" })).toHaveAttribute("data-active", "true")
    expect(nav.getByRole("link", { name: "Modules" })).toHaveAttribute("aria-current", "page")
    expect(nav.getByRole("link", { name: "Pricing" })).toHaveAttribute("data-active", "false")
    expect(nav.getByRole("link", { name: "Model settings" })).toHaveAttribute(
      "data-active",
      "false",
    )
  })

  it("highlights the module you are in, not Modules", async () => {
    openApp(`/m/${model.id}/modules/${costsModule.id}`)

    const nav = await findLoadedNav()
    expect(nav.getByRole("link", { name: "Costs" })).toHaveAttribute("aria-current", "page")
    expect(nav.getByRole("link", { name: "Costs" })).toHaveAttribute("data-active", "true")
    expect(nav.getByRole("link", { name: "Modules" })).toHaveAttribute("data-active", "false")
    expect(nav.getByRole("link", { name: "Revenue" })).toHaveAttribute("data-active", "false")
  })

  it("highlights the settings", async () => {
    openApp(`/m/${model.id}/settings`)

    const nav = await findLoadedNav()
    expect(nav.getByRole("link", { name: "Model settings" })).toHaveAttribute(
      "aria-current",
      "page",
    )
    expect(nav.getByRole("link", { name: "Modules" })).toHaveAttribute("data-active", "false")
  })

  it("shows placeholders where the modules go while they load", async () => {
    mockSession()
    serveModels([model])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get(structureUrl, async () => {
        await gate
        return HttpResponse.json(structure)
      }),
    )
    renderApp(`/m/${model.id}/settings`)

    const nav = await findBuildNav()
    expect(nav.getByRole("status", { name: "Loading modules" })).toBeVisible()
    expect(nav.getByRole("link", { name: "Modules" })).toBeVisible()
    release()

    expect(await nav.findByRole("link", { name: "Pricing" })).toBeVisible()
    expect(nav.queryByRole("status")).not.toBeInTheDocument()
  })

  it("says so and offers a retry when the structure cannot be loaded", async () => {
    const typist = userEvent.setup()
    mockSession()
    serveModels([model])
    server.use(
      http.get(structureUrl, () => problem(500, "internal", "The database is starting up.")),
    )
    renderApp(`/m/${model.id}/settings`)

    const nav = await findBuildNav()
    expect(await nav.findByRole("alert")).toHaveTextContent("The database is starting up.")
    serveStructure(structure)
    await typist.click(nav.getByRole("button", { name: "Retry" }))

    expect(await nav.findByRole("link", { name: "Pricing" })).toBeVisible()
  })

  it("is not there outside a model", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    await screen.findByRole("link", { name: "Members" })
    expect(screen.queryByRole("navigation", { name: "Build" })).not.toBeInTheDocument()
  })

  it("is not there for a model that does not exist", async () => {
    mockSession()
    serveModels([])
    renderApp(`/m/${model.id}/modules`)

    await screen.findByRole("heading", { name: "Model not found" })
    expect(screen.queryByRole("navigation", { name: "Build" })).not.toBeInTheDocument()
  })

  it.each(["Modules", "Model settings"])(
    "keeps a tooltip on the %s link when the sidebar is collapsed to its icons",
    async (name) => {
      document.cookie = "sidebar_state=false; path=/"
      const typist = userEvent.setup()
      openApp()
      const nav = await findBuildNav()
      await waitFor(() =>
        expect(document.querySelector("[data-slot=sidebar]")).toHaveAttribute(
          "data-state",
          "collapsed",
        ),
      )
      await typist.hover(nav.getByRole("link", { name }))

      expect(await screen.findByRole("tooltip")).toHaveTextContent(name)
    },
  )

  it("follows a module you open to the page that is not hidden behind a sheet on a phone", async () => {
    const desktopWidth = window.innerWidth
    window.innerWidth = 375
    try {
      const typist = userEvent.setup()
      const { router } = openApp(`/m/${model.id}/settings`)
      await typist.click(await screen.findByRole("button", { name: "Toggle Sidebar" }))
      const sheet = await screen.findByRole("dialog", { name: "Sidebar" })
      await typist.click(await within(sheet).findByRole("link", { name: "Pricing" }))

      await waitFor(() =>
        expect(router.state.location.pathname).toBe(`/m/${model.id}/modules/${pricingModule.id}`),
      )
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).not.toBeInTheDocument(),
      )
    } finally {
      window.innerWidth = desktopWidth
    }
  })
})
