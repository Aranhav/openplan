import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { me, mockSession, renderApp, user } from "@/test/app"
import { renderWithProviders } from "@/test/render"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { ProfilePage } from "./profile-page"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const meUrl = "/api/v1/auth/me"
const passwordUrl = "/api/v1/auth/me/password"

type Typist = ReturnType<typeof userEvent.setup>

async function openCard(title: string) {
  const heading = await screen.findByRole("heading", { level: 2, name: title })
  return within(heading.closest("[data-slot=card]") as HTMLElement)
}

const openProfile = () => openCard("Profile")
const openPassword = () => openCard("Password")

async function fillPasswords(
  typist: Typist,
  card: ReturnType<typeof within>,
  { current = "old-password-123", next = "new-password-456", confirm = "new-password-456" } = {},
) {
  await typist.type(card.getByLabelText("Current password"), current)
  await typist.type(card.getByLabelText("New password"), next)
  await typist.type(card.getByLabelText("Confirm new password"), confirm)
}

describe("the profile page", () => {
  it("has a card for the profile and one for the password", async () => {
    mockSession()
    renderApp("/profile")

    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeVisible()
    expect(document.title).toBe("Profile · OpenPlan")
    const profile = await openProfile()
    expect(profile.getByLabelText("Name")).toHaveValue("Ada Lovelace")
    expect(await openPassword()).toBeDefined()
  })

  it("shows the email but doesn't let it be changed", async () => {
    mockSession()
    renderApp("/profile")
    const profile = await openProfile()

    const email = profile.getByLabelText("Email")
    expect(email).toHaveValue("ada@example.com")
    expect(email).toHaveAttribute("readonly")
  })
})

describe("the profile page before the signed-in user is known", () => {
  it("shows placeholders", async () => {
    server.use(
      http.get(meUrl, async () => {
        await delay(100)
        return HttpResponse.json(me)
      }),
    )
    renderWithProviders(<ProfilePage />)

    const loading = await screen.findByRole("status", { name: "Loading profile" })
    expect(loading.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThanOrEqual(5)
    expect(await screen.findByLabelText("Name")).toHaveValue("Ada Lovelace")
    expect(screen.queryByRole("status", { name: "Loading profile" })).not.toBeInTheDocument()
  })
})

describe("the profile card", () => {
  it("saves the name and shows it in the sidebar", async () => {
    mockSession()
    const patched = vi.fn()
    server.use(
      http.patch(meUrl, async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ ...user, name: "Ada King" })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    const save = profile.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    await typist.clear(profile.getByLabelText("Name"))
    await typist.type(profile.getByLabelText("Name"), "  Ada King ")
    expect(save).toBeEnabled()
    await typist.click(save)

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Changes saved"))
    expect(patched).toHaveBeenCalledExactlyOnceWith({ name: "Ada King" })
    expect(profile.getByLabelText("Name")).toHaveValue("Ada King")
    expect(save).toBeDisabled()
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument()
    expect(screen.getAllByText("Ada King").length).toBeGreaterThan(0)
  })

  it("sends nothing when only spaces were added to the name", async () => {
    mockSession()
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    await typist.type(profile.getByLabelText("Name"), "  ")
    await typist.click(profile.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(profile.getByLabelText("Name")).toHaveValue("Ada Lovelace"))
    expect(profile.getByRole("button", { name: "Save changes" })).toBeDisabled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("asks for a name", async () => {
    mockSession()
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    await typist.clear(profile.getByLabelText("Name"))
    await typist.click(profile.getByRole("button", { name: "Save changes" }))

    expect(await profile.findByText("Name is required.")).toBeVisible()
    expect(profile.getByLabelText("Name")).toBeInvalid()
  })

  it("shows the server's complaint under the name", async () => {
    mockSession()
    server.use(
      http.patch(meUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "name", message: "Name is not allowed." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    await typist.type(profile.getByLabelText("Name"), "!")
    await typist.click(profile.getByRole("button", { name: "Save changes" }))

    expect(await profile.findByText("Name is not allowed.")).toBeVisible()
    expect(profile.getByLabelText("Name")).toHaveFocus()
  })

  it("reports any other failure in a toast and keeps what was typed", async () => {
    mockSession()
    server.use(http.patch(meUrl, () => problem(500, "internal", "Something broke.")))
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    await typist.type(profile.getByLabelText("Name"), "!")
    await typist.click(profile.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Something broke."))
    expect(profile.getByLabelText("Name")).toHaveValue("Ada Lovelace!")
  })

  it("disables the button while saving", async () => {
    mockSession()
    server.use(
      http.patch(meUrl, async () => {
        await delay(300)
        return HttpResponse.json({ ...user, name: "Ada Lovelace!" })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const profile = await openProfile()
    await typist.type(profile.getByLabelText("Name"), "!")
    await typist.click(profile.getByRole("button", { name: "Save changes" }))

    const save = profile.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    expect(save.querySelector("svg.animate-spin")).toBeInTheDocument()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("follows the name when it changes elsewhere, unless it is being edited", async () => {
    const session = mockSession()
    const typist = userEvent.setup()
    const { queryClient } = renderApp("/profile")
    const profile = await openProfile()
    session.me = { ...me, user: { ...user, name: "Ada King" } }
    await queryClient.invalidateQueries({ queryKey: ["me"] })
    await waitFor(() => expect(profile.getByLabelText("Name")).toHaveValue("Ada King"))

    await typist.type(profile.getByLabelText("Name"), "!")
    session.me = { ...me, user: { ...user, name: "Ada Byron" } }
    await queryClient.invalidateQueries({ queryKey: ["me"] })
    await waitFor(() => expect(screen.getAllByText("Ada Byron").length).toBeGreaterThan(0))
    expect(profile.getByLabelText("Name")).toHaveValue("Ada King!")
  })
})

describe("the password card", () => {
  it("tells password managers whose password this is", async () => {
    mockSession()
    renderApp("/profile")
    const password = await openPassword()

    const username = password.getByDisplayValue("ada@example.com")
    expect(username).toHaveAttribute("autocomplete", "username")
    expect(username).toHaveAttribute("readonly")
    expect(username).toHaveAttribute("aria-hidden", "true")
    expect(username).toHaveAttribute("tabindex", "-1")
    // The wrapper hides it: on the input itself, its own width classes would win and leave a
    // container-wide box that widens the page.
    expect(username).not.toHaveClass("sr-only")
    expect(username.closest(".sr-only")).not.toBeNull()
    expect(password.queryByLabelText("Email")).not.toBeInTheDocument()
  })

  it("changes the password and clears the form", async () => {
    mockSession()
    const posted = vi.fn()
    server.use(
      http.post(passwordUrl, async ({ request }) => {
        posted(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password)
    await typist.click(password.getByRole("button", { name: "Change password" }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Password changed"))
    expect(posted).toHaveBeenCalledExactlyOnceWith({
      current_password: "old-password-123",
      new_password: "new-password-456",
    })
    expect(password.getByLabelText("Current password")).toHaveValue("")
    expect(password.getByLabelText("New password")).toHaveValue("")
    expect(password.getByLabelText("Confirm new password")).toHaveValue("")
  })

  it("asks for every field and a long enough new password without sending a request", async () => {
    mockSession()
    const attempts = vi.fn()
    server.use(
      http.post(passwordUrl, () => {
        attempts()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await typist.click(password.getByRole("button", { name: "Change password" }))
    expect(await password.findByText("Enter your current password.")).toBeVisible()
    expect(password.getByText("Password must be at least 10 characters.")).toBeVisible()

    await typist.type(password.getByLabelText("Current password"), "old-password-123")
    await typist.type(password.getByLabelText("New password"), "short")
    await typist.click(password.getByRole("button", { name: "Change password" }))
    expect(await password.findByText("Password must be at least 10 characters.")).toBeVisible()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("asks for the new password twice", async () => {
    mockSession()
    const attempts = vi.fn()
    server.use(
      http.post(passwordUrl, () => {
        attempts()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password, { confirm: "something-else-789" })
    await typist.click(password.getByRole("button", { name: "Change password" }))

    expect(await password.findByText("Passwords don't match.")).toBeVisible()
    expect(password.getByLabelText("Confirm new password")).toBeInvalid()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("shows a wrong current password under that field", async () => {
    mockSession()
    server.use(
      http.post(passwordUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "current_password", message: "Current password is incorrect." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password)
    await typist.click(password.getByRole("button", { name: "Change password" }))

    expect(await password.findByText("Current password is incorrect.")).toBeVisible()
    expect(password.getByLabelText("Current password")).toBeInvalid()
    expect(password.getByLabelText("Current password")).toHaveFocus()
    expect(password.getByLabelText("New password")).toHaveValue("new-password-456")
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("shows the server's complaint about the new password under that field", async () => {
    mockSession()
    server.use(
      http.post(passwordUrl, () =>
        problem(422, "validation", "Some fields are invalid.", {
          errors: [{ field: "new_password", message: "Password is too common." }],
        }),
      ),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password)
    await typist.click(password.getByRole("button", { name: "Change password" }))

    expect(await password.findByText("Password is too common.")).toBeVisible()
    expect(password.getByLabelText("New password")).toBeInvalid()
  })

  it.each([
    ["130", "Too many attempts. Try again in 3 minutes."],
    ["20", "Too many attempts. Try again in 1 minute."],
  ])(
    "tells the user how long to wait when rate limited (Retry-After %s)",
    async (seconds, text) => {
      mockSession()
      server.use(
        http.post(passwordUrl, () =>
          problem(429, "auth.rate_limited", "Slow down.", { headers: { "Retry-After": seconds } }),
        ),
      )
      const typist = userEvent.setup()
      renderApp("/profile")
      const password = await openPassword()
      await fillPasswords(typist, password)
      await typist.click(password.getByRole("button", { name: "Change password" }))

      expect(await password.findByRole("alert")).toHaveTextContent(text)
      expect(toast.error).not.toHaveBeenCalled()
    },
  )

  it("reports any other failure in a toast", async () => {
    mockSession()
    server.use(http.post(passwordUrl, () => problem(500, "internal", "Something broke.")))
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password)
    await typist.click(password.getByRole("button", { name: "Change password" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Something broke."))
    expect(password.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("disables the button while the password is being changed", async () => {
    mockSession()
    server.use(
      http.post(passwordUrl, async () => {
        await delay(300)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const typist = userEvent.setup()
    renderApp("/profile")
    const password = await openPassword()
    await fillPasswords(typist, password)
    await typist.click(password.getByRole("button", { name: "Change password" }))

    const submit = password.getByRole("button", { name: "Change password" })
    expect(submit).toBeDisabled()
    expect(submit.querySelector("svg.animate-spin")).toBeInTheDocument()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Password changed"))
  })
})
