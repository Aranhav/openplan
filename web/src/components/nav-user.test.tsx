import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { mockSession, renderApp, user, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

async function openUserMenu(typist: ReturnType<typeof userEvent.setup>) {
  await typist.click(await screen.findByRole("button", { name: /Ada Lovelace/ }))
  return screen.findByRole("menu")
}

describe("the user menu", () => {
  it("shows who is signed in", async () => {
    mockSession()
    renderApp(`/w/${workspace.id}`)

    const trigger = await screen.findByRole("button", { name: /Ada Lovelace/ })
    expect(trigger).toHaveTextContent("AL")
    expect(trigger).toHaveTextContent(user.email)
    // The initials are decoration; they must not be read out as part of the name.
    expect(trigger).toHaveAccessibleName(/^Ada Lovelace\s*ada@example\.com$/)
  })

  it("links to the profile", async () => {
    mockSession()
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openUserMenu(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Profile" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/profile"))
  })

  it("marks the current theme and switches to another", async () => {
    mockSession()
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openUserMenu(typist)
    within(menu).getByRole("menuitem", { name: "Theme" }).focus()
    await typist.keyboard("{ArrowRight}")

    expect(await screen.findByRole("menuitemradio", { name: "System" })).toBeChecked()
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).not.toBeChecked()
    await typist.keyboard("{ArrowDown}{Enter}")

    await waitFor(() => expect(document.documentElement).toHaveClass("dark"))
    expect(window.localStorage.getItem("openplan-theme")).toBe("dark")

    const reopened = await openUserMenu(typist)
    within(reopened).getByRole("menuitem", { name: "Theme" }).focus()
    await typist.keyboard("{ArrowRight}")
    expect(await screen.findByRole("menuitemradio", { name: "Dark" })).toBeChecked()
    expect(screen.getByRole("menuitemradio", { name: "System" })).not.toBeChecked()
  })

  it("signs out and goes to the sign-in page", async () => {
    const session = mockSession()
    server.use(
      http.post("/api/v1/auth/logout", () => {
        session.signedIn = false
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openUserMenu(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Sign out" }))

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe("/login")
  })

  it("stays disabled while signing out", async () => {
    const session = mockSession()
    server.use(
      http.post("/api/v1/auth/logout", async () => {
        await delay(300)
        session.signedIn = false
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp(`/w/${workspace.id}`)
    const menu = await openUserMenu(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Sign out" }))

    const signOut = within(menu).getByRole("menuitem", { name: "Sign out" })
    expect(signOut).toHaveAttribute("aria-disabled", "true")
    expect(signOut.querySelector("svg.animate-spin")).toBeInTheDocument()
    // Let it finish, so nothing is still running when the next test starts.
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
  })

  it("explains when signing out fails and lets the user try again", async () => {
    mockSession()
    server.use(
      http.post("/api/v1/auth/logout", () =>
        problem(500, "internal", "The database is starting up."),
      ),
    )
    const typist = userEvent.setup()
    const { router } = renderApp(`/w/${workspace.id}`)
    const menu = await openUserMenu(typist)
    await typist.click(within(menu).getByRole("menuitem", { name: "Sign out" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The database is starting up."))
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(router.state.location.pathname).toBe(`/w/${workspace.id}`)
  })
})
