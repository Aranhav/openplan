import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "@/test/render"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { LoginForm } from "./login-form"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const user = {
  id: "0192f3a0-0000-7000-8000-000000000001",
  email: "ada@example.com",
  name: "Ada Lovelace",
  is_instance_admin: true,
}

async function signIn(typist: ReturnType<typeof userEvent.setup>) {
  await typist.type(await screen.findByLabelText("Email"), "ada@example.com")
  await typist.type(screen.getByLabelText("Password"), "correct-horse-battery")
  await typist.click(screen.getByRole("button", { name: "Sign in" }))
}

function acceptLogin() {
  server.use(http.post("/api/v1/auth/login", () => HttpResponse.json({ user })))
}

describe("LoginForm", () => {
  it("shows an alert when the credentials are incorrect", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        problem(401, "auth.invalid_credentials", "Invalid credentials."),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await signIn(typist)

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.")
  })

  it("moves focus to the password and selects it after a wrong password", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        problem(401, "auth.invalid_credentials", "Invalid credentials."),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await signIn(typist)
    await screen.findByRole("alert")

    const password = screen.getByLabelText<HTMLInputElement>("Password")
    await waitFor(() => expect(password).toHaveFocus())
    expect(password.selectionStart).toBe(0)
    expect(password.selectionEnd).toBe(password.value.length)
  })

  it("tells the user how many minutes to wait when rate limited", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        problem(429, "auth.rate_limited", "Slow down.", { headers: { "Retry-After": "130" } }),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await signIn(typist)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 3 minutes.",
    )
  })

  it("waits at least one minute, in the singular", async () => {
    server.use(
      http.post("/api/v1/auth/login", () =>
        problem(429, "auth.rate_limited", "Slow down.", { headers: { "Retry-After": "20" } }),
      ),
    )
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await signIn(typist)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 1 minute.",
    )
  })

  it("reports an unreachable server in a toast", async () => {
    server.use(http.post("/api/v1/auth/login", () => HttpResponse.error()))
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await signIn(typist)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Can't reach the server. Check your connection and try again.",
      ),
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("disables the button while the request is pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post("/api/v1/auth/login", async () => {
        await gate
        return HttpResponse.json({ user })
      }),
    )
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<LoginForm />)
    await signIn(typist)

    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled())

    release()
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  })

  it("asks for both fields without sending a request", async () => {
    const attempts = vi.fn()
    server.use(
      http.post("/api/v1/auth/login", () => {
        attempts()
        return HttpResponse.json({ user })
      }),
    )
    const typist = userEvent.setup()
    renderWithProviders(<LoginForm />)
    await typist.click(await screen.findByRole("button", { name: "Sign in" }))

    expect(await screen.findByText("Enter your email.")).toBeInTheDocument()
    expect(screen.getByText("Enter your password.")).toBeInTheDocument()
    expect(attempts).not.toHaveBeenCalled()
  })

  it("goes to the home page after signing in", async () => {
    acceptLogin()
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<LoginForm />)
    await signIn(typist)

    await waitFor(() => expect(router.state.location.href).toBe("/"))
  })

  it("returns to the page the user came from", async () => {
    acceptLogin()
    const typist = userEvent.setup()
    const { router } = renderWithProviders(<LoginForm redirectTo="/models/42?tab=sheet" />)
    await signIn(typist)

    await waitFor(() => expect(router.state.location.href).toBe("/models/42?tab=sheet"))
  })

  it.each(["https://evil.example/steal", "//evil.example", "/\t/evil.example", "models/42"])(
    "ignores the redirect target %s",
    async (target) => {
      acceptLogin()
      const typist = userEvent.setup()
      const { router } = renderWithProviders(<LoginForm redirectTo={target} />)
      await signIn(typist)

      await waitFor(() => expect(router.state.location.href).toBe("/"))
    },
  )

  it("drops cached data from a previous session after signing in", async () => {
    acceptLogin()
    const typist = userEvent.setup()
    const { queryClient, router } = renderWithProviders(<LoginForm />)
    queryClient.setQueryData(["me"], { user: { ...user, name: "Someone else" }, workspaces: [] })
    await signIn(typist)

    await waitFor(() => expect(router.state.location.href).toBe("/"))
    expect(queryClient.getQueryData(["me"])).toBeUndefined()
  })
})
