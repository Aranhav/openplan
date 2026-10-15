import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import {
  globex,
  makeModel,
  me,
  meInTwoWorkspaces,
  mockSession,
  renderApp,
  user,
  workspace,
} from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

const revenue = makeModel({ id: "0192f3a0-0000-7000-8000-000000000011", name: "Revenue plan" })
const headcount = makeModel({ id: "0192f3a0-0000-7000-8000-000000000012", name: "Headcount plan" })

function mockModels(models = [revenue, headcount]) {
  server.use(
    http.get(`/api/v1/workspaces/${workspace.id}/models`, () => HttpResponse.json(models)),
    http.get("/api/v1/models/:id", ({ params }) =>
      HttpResponse.json(models.find((model) => model.id === params.id)),
    ),
  )
}

async function openPalette(typist: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("button", { name: /^Search/ })
  await typist.keyboard("{Control>}k{/Control}")
  return screen.findByRole("dialog", { name: "Command palette" })
}

describe("the command palette", () => {
  it("adds nothing to the page outline while it is closed", async () => {
    mockSession()
    mockModels()
    renderApp(`/w/${workspace.id}`)
    await screen.findByRole("button", { name: /^Search/ })

    const [first] = screen.getAllByRole("heading")
    expect(first).toHaveAccessibleName("Models")
    expect(first.tagName).toBe("H1")
    expect(screen.queryByRole("heading", { name: "Command palette" })).not.toBeInTheDocument()
    expect(screen.queryByText(/^Search for a page, model or workspace/)).not.toBeInTheDocument()
  })

  it("names itself and says what it is for while it is open", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(palette).toHaveAccessibleDescription(
      "Search for a page, model or workspace, or change the theme.",
    )
    expect(within(palette).getByRole("heading", { name: "Command palette" })).toBeInTheDocument()
  })

  it("keeps its search text at 16px on a phone, so iOS does not zoom in on focus", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(within(palette).getByRole("combobox")).toHaveClass("text-base", "md:text-sm")
  })

  it("opens with Ctrl+K and lists models", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(await within(palette).findByRole("option", { name: "Revenue plan" })).toBeVisible()
    expect(within(palette).getByRole("option", { name: "Headcount plan" })).toBeVisible()
  })

  it("opens from the search button in the header", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    await typist.click(await screen.findByRole("button", { name: /^Search/ }))

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeVisible()
  })

  it("closes when Ctrl+K is pressed again", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    await openPalette(typist)
    await typist.keyboard("{Control>}k{/Control}")

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("selecting a model navigates to /m/<id> and closes the palette", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await typist.click(await within(palette).findByRole("option", { name: "Headcount plan" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${headcount.id}`))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("ignores the shortcut while the keys are held down", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    fireEvent.keyDown(document, { key: "k", ctrlKey: true, repeat: true })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(palette).toBeVisible()
  })

  it("does not open over another dialog", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    await typist.click(await screen.findByRole("button", { name: /Acme Corp/ }))
    await typist.click(await screen.findByRole("menuitem", { name: "Create workspace" }))
    const dialog = await screen.findByRole("dialog", { name: "Create workspace" })
    await typist.keyboard("{Control>}k{/Control}")
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument()
    expect(dialog).toBeVisible()
  })

  it("narrows the results as you type", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await within(palette).findByRole("option", { name: "Revenue plan" })
    await typist.keyboard("headcount")

    expect(within(palette).getByRole("option", { name: "Headcount plan" })).toBeVisible()
    expect(within(palette).queryByRole("option", { name: "Revenue plan" })).not.toBeInTheDocument()
    await typist.keyboard("zzz")
    expect(await within(palette).findByText("No results found.")).toBeVisible()
  })

  it("goes to the pages of the current workspace", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await typist.click(within(palette).getByRole("option", { name: "Members" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}/members`))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("lists the instance pages for an instance admin", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await typist.click(within(palette).getByRole("option", { name: "Users" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"))
  })

  it("leaves out the instance pages for everyone else", async () => {
    mockSession({ me: { ...me, user: { ...user, is_instance_admin: false } } })
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(within(palette).getByRole("option", { name: "Profile" })).toBeVisible()
    expect(within(palette).queryByRole("option", { name: "Users" })).not.toBeInTheDocument()
  })

  it("switches workspace", async () => {
    mockSession({ me: meInTwoWorkspaces })
    mockModels()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await typist.click(within(palette).getByRole("option", { name: /Globex/ }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${globex.id}`))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("marks the current workspace", async () => {
    mockSession({ me: meInTwoWorkspaces })
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(within(palette).getByRole("option", { name: /Acme Corp/ })).toHaveAttribute(
      "aria-current",
      "true",
    )
    expect(within(palette).getByRole("option", { name: /Globex/ })).not.toHaveAttribute(
      "aria-current",
    )
  })

  it("changes the theme", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)
    await typist.click(within(palette).getByRole("option", { name: "Dark" }))

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("says so and offers a retry when the models cannot be loaded", async () => {
    mockSession()
    server.use(
      http.get(`/api/v1/workspaces/${workspace.id}/models`, () =>
        problem(500, "internal", "The database is starting up."),
      ),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const palette = await openPalette(typist)

    expect(await within(palette).findByRole("alert")).toHaveTextContent(
      "The database is starting up.",
    )
    mockModels()
    await typist.click(within(palette).getByRole("button", { name: "Retry" }))

    expect(await within(palette).findByRole("option", { name: "Revenue plan" })).toBeVisible()
  })
})

describe("the command palette's focus", () => {
  it("returns to the element that opened it when it is dismissed", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const members = await screen.findByRole("link", { name: "Members" })
    members.focus()
    await openPalette(typist)
    await typist.keyboard("{Escape}")

    await waitFor(() => expect(members).toHaveFocus())
  })

  it("returns to the search button when it was opened from there", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const search = await screen.findByRole("button", { name: /^Search/ })
    await typist.click(search)
    await screen.findByRole("dialog", { name: "Command palette" })
    await typist.keyboard("{Escape}")

    await waitFor(() => expect(search).toHaveFocus())
  })

  it("goes to the search button when nothing had the focus", async () => {
    mockSession()
    mockModels()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const search = await screen.findByRole("button", { name: /^Search/ })
    expect(document.body).toHaveFocus()
    await openPalette(typist)
    await typist.keyboard("{Escape}")

    await waitFor(() => expect(search).toHaveFocus())
  })

  it("goes to the search button when the page that opened it is gone", async () => {
    mockSession()
    mockModels()
    server.use(http.get(`/api/v1/workspaces/${workspace.id}/members`, () => HttpResponse.json([])))
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const card = await screen.findByRole("link", { name: /Revenue plan/ })
    card.focus()
    const palette = await openPalette(typist)
    await typist.click(within(palette).getByRole("option", { name: "Members" }))

    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspace.id}/members`))
    await waitFor(() => expect(card).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("button", { name: /^Search/ })).toHaveFocus())
  })
})
